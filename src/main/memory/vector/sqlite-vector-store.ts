// src/main/memory/vector/sqlite-vector-store.ts
// SQLiteVectorStore：BLOB 落盘 + 内存 f32 矩阵 + 暴力余弦 + IVF 索引（n≥1000）。
// 依据 F5-003：持久化信 SQLite，计算信内存，检索不进 SQL。
//
// IVF 接入（P2-14/15）：
//   - n < IVF_POLICY.minEntries(1000) -> 永远暴力扫描（设计而非缺陷）
//   - n ≥ minEntries 且 IVF 未建 -> 惰性触发构建（kmeans 在 worker_thread 跑，F5-003 §5 红线）
//   - upsert 时若 IVF 已存在 -> 将新向量加入最近质心的桶（即时可检索）
//   - remove 时若 IVF 已存在 -> 从倒排列表移除
//   - 漂移超 rebuildDrift -> 后台重建（走旧索引/暴力降级）
//   - IVF 状态持久化到 vec_meta.ivfState，启动时用持久化质心重新分配当前向量
//
// worker_thread（F5-003 §5）：
//   - 生产默认用 createWorkerKmeansBuilder，kmeans 在独立线程跑不阻塞主进程
//   - 测试注入同步 buildIvfIndex 避免 worker 加载问题
//   - worker 复用单例，避免反复创建开销

import { Worker } from 'node:worker_threads'
import type { Database } from 'better-sqlite3'
import { AppError } from '@shared/errors'
import type { Logger } from '@shared/observability/types'
import { dot, norm } from './cosine'
import { IVF_POLICY, type VectorSearchHit, type VectorStore, type VectorStoreStats } from './types'
import { buildIvfIndex, buildInvertedLists, findNearestCentroids, type IvfBuildResult } from './ivf'
import { deserializeIvfState, serializeIvfState } from './ivf-state'

const DEFAULT_MIN_SCORE = 0.35

/** 内存中的 IVF 索引 */
interface IvfIndex {
  centroids: Float32Array
  K: number
  /** 倒排列表：质心索引 -> 该簇的向量 memoryId 列表 */
  invertedLists: Array<string[]>
  /** memoryId -> 质心索引，用于 upsert/remove 时快速定位 */
  idToCentroid: Map<string, number>
  /** 建索引时的向量数（漂移检测） */
  entryCount: number
  builtAt: number
}

/**
 * kmeans 构建器。默认同步 buildIvfIndex；生产可注入 worker 版本。
 * 可注入是为了测试可确定性 + 不依赖 worker_thread 加载。
 */
export type KmeansBuilder = (
  vectors: Float32Array,
  dim: number,
  K: number,
  maxIterations: number,
  seed: number
) => Promise<IvfBuildResult> | IvfBuildResult

export interface SQLiteVectorStoreOptions {
  db: Database
  /** 期望维度（来自 config.embeddingDimension）。空则从 vec_meta / 首个向量推断 */
  dim?: number
  logger?: Logger
  /** kmeans 构建器。默认 createWorkerKmeansBuilder（worker_thread）；测试注入同步 buildIvfIndex */
  kmeansBuilder?: KmeansBuilder
  /** 注入时钟（测试确定性） */
  now?: () => number
  /** 注入确定性种子（IVF 构建） */
  seed?: number
}

interface VecEntry {
  vec: Float32Array
  norm: number
}

/** Node Buffer（BLOB）-> Float32Array（拷贝到 4 字节对齐的新 ArrayBuffer） */
function decode(buf: Buffer): Float32Array {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  return new Float32Array(ab)
}

/** Float32Array -> Buffer（独立拷贝，不共享底层内存） */
function encode(vec: Float32Array): Buffer {
  return Buffer.copyBytesFrom(vec)
}

/** worker kmeans 构建器 + terminate（资源清理） */
export interface WorkerKmeansHandle {
  builder: KmeansBuilder
  /** 终止 worker 线程；app 退出时必须调用，否则进程不退出 */
  terminate: () => void
}

/**
 * 创建基于 worker_thread 的 kmeans 构建器。依据 F5-003 §5 红线。
 *
 * worker 复用单例（避免反复创建开销），在独立线程跑 kmeans++ 不阻塞主进程事件循环。
 * 矩阵用 transferable Float32Array 零拷贝传递。
 *
 * worker 文件：src/main/memory/vector/ivf-worker.ts
 * 如果 worker 创建失败（如测试环境），回退到同步 buildIvfIndex（败而不崩）。
 *
 * 返回 { builder, terminate }：terminate 必须在 app 退出时调用，
 * 否则 worker 线程保活导致进程不退出（Node.js worker_threads 语义）。
 */
export function createWorkerKmeansBuilder(): WorkerKmeansHandle {
  let worker: Worker | null = null
  let workerFailed = false

  function getWorker(): Worker | null {
    if (workerFailed) return null
    if (worker) return worker
    try {
      worker = new Worker(new URL('./ivf-worker.ts', import.meta.url))
      return worker
    } catch {
      // worker 创建失败 -> 标记失败，后续都用同步
      workerFailed = true
      return null
    }
  }

  const builder: KmeansBuilder = async (
    vectors,
    dim,
    K,
    maxIterations,
    seed
  ): Promise<IvfBuildResult> => {
    const w = getWorker()
    if (!w) {
      // worker 不可用 -> 同步
      return buildIvfIndex({ vectors, dim, K, maxIterations, seed })
    }
    try {
      // 复制 vectors：transfer 会 detach 原 buffer，若 worker 失败需要保留原始数据回退同步
      const copy = new Float32Array(vectors)
      return await new Promise<IvfBuildResult>((resolve, reject) => {
        const onMessage = (msg: unknown): void => {
          w.off('message', onMessage)
          w.off('error', onError)
          const m = msg as { error?: string } & Partial<IvfBuildResult>
          if (m.error) {
            reject(new Error(`ivf worker error: ${m.error}`))
          } else if (m.centroids && m.assignments && typeof m.K === 'number') {
            resolve({
              centroids: m.centroids,
              assignments: m.assignments,
              K: m.K,
              dim: m.dim ?? dim
            })
          } else {
            reject(new Error('ivf worker: invalid response'))
          }
        }
        const onError = (err: Error): void => {
          w.off('message', onMessage)
          w.off('error', onError)
          reject(err)
        }
        w.on('message', onMessage)
        w.on('error', onError)
        // transferable：copy.buffer 零拷贝转移到 worker（原 vectors 保留）
        w.postMessage({ vectors: copy, dim, K, maxIterations, seed }, [copy.buffer])
      })
    } catch {
      // worker 执行失败 -> 标记失败，回退同步（败而不崩）
      workerFailed = true
      return buildIvfIndex({ vectors, dim, K, maxIterations, seed })
    }
  }

  function terminate(): void {
    if (worker) {
      void worker.terminate()
      worker = null
    }
  }

  return { builder, terminate }
}

export function createSQLiteVectorStore(opts: SQLiteVectorStoreOptions): VectorStore {
  const { db, logger } = opts
  const mem = new Map<string, VecEntry>()
  let rev = 0
  let dim = opts.dim ?? 0
  let dimPersisted = false
  // F5-003 §5 红线：kmeans 必须在 worker_thread 跑。
  // 默认用 createWorkerKmeansBuilder；测试注入同步 buildIvfIndex 避免 worker 加载。
  // F5-003 §5 红线：kmeans 必须在 worker_thread 跑。
  // 默认用 createWorkerKmeansBuilder().builder；测试注入同步 buildIvfIndex。
  // 注意：用默认时 worker 无法被外部 terminate（资源泄漏）；生产环境应在 setup.ts
  // 显式传 kmeansBuilder + 调用 terminate（见 setup.ts cleanup）。
  const kmeansBuilder: KmeansBuilder = opts.kmeansBuilder ?? createWorkerKmeansBuilder().builder
  const now = opts.now ?? (() => Date.now())
  const seed = opts.seed ?? 12345

  // IVF 状态
  let ivf: IvfIndex | null = null
  let ivfBuilding = false
  let driftSinceBuild = 0
  // C-γ-1: kmeans 连续失败计数，超阈值停止自动重建（避免忙循环）
  let consecutiveBuildFailures = 0
  const IVF_BUILD_FAILURE_LIMIT = 3

  const getMeta = db.prepare(`SELECT value FROM vec_meta WHERE key = ?`)
  const setMeta = db.prepare(
    `INSERT INTO vec_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
  const insVec = db.prepare(
    `INSERT INTO l2_vectors (memory_id, embedding, dim, dtype) VALUES (?, ?, ?, 'f32')
     ON CONFLICT(memory_id) DO UPDATE SET embedding = excluded.embedding, dim = excluded.dim, dtype = 'f32'`
  )
  const delVec = db.prepare(`DELETE FROM l2_vectors WHERE memory_id = ?`)

  function dimMismatch(): AppError {
    return new AppError({
      code: 'MEM_EMBED_FAIL',
      userMessage: '向量维度不匹配，已拒绝（避免新旧模型混算）',
      severity: 'error',
      retryable: false
    })
  }

  function persistDim(): void {
    if (!dimPersisted && dim > 0) {
      setMeta.run('dim', String(dim))
      dimPersisted = true
    }
  }

  /**
   * 用持久化的质心重新分配当前所有向量到倒排列表。
   * 不依赖持久化的 assignments 顺序（重启后 mem 迭代顺序可能不同）。
   */
  function loadIvfState(): void {
    const row = getMeta.get('ivfState') as { value: string } | undefined
    if (!row || !row.value) return
    const parsed = deserializeIvfState(row.value)
    if (!parsed) {
      logger?.warn('ivfState corrupted; will rebuild from scratch', { scope: 'memory' })
      setMeta.run('ivfState', '')
      return
    }
    if (parsed.dim !== dim) {
      logger?.warn('ivfState dim mismatch; discarding', {
        scope: 'memory',
        metrics: { stored: parsed.dim, current: dim }
      })
      return
    }
    // 漂移检测
    const currentCount = mem.size
    const drift = Math.abs(currentCount - parsed.entryCount)
    const threshold = IVF_POLICY.rebuildDrift(currentCount)
    if (drift >= threshold) {
      logger?.info('ivfState drift exceeds threshold; will rebuild lazily', {
        scope: 'memory',
        metrics: { drift, threshold, entryCount: parsed.entryCount, currentCount }
      })
      return
    }
    // 用持久化质心重新分配当前向量（O(n*K)，但只在启动时做一次）
    const invertedLists: Array<string[]> = Array.from({ length: parsed.K }, () => [])
    const idToCentroid = new Map<string, number>()
    for (const [id, entry] of mem) {
      if (entry.norm === 0) continue
      // 找最近质心
      const nearest = findNearestCentroids(entry.vec, parsed.centroids, parsed.K, dim, 1)
      if (nearest.length > 0) {
        const c = nearest[0]
        invertedLists[c].push(id)
        idToCentroid.set(id, c)
      }
    }
    ivf = {
      centroids: parsed.centroids,
      K: parsed.K,
      invertedLists,
      idToCentroid,
      entryCount: parsed.entryCount,
      builtAt: parsed.builtAt
    }
    driftSinceBuild = Math.max(0, mem.size - parsed.entryCount)
    logger?.info('ivf state restored from persistence', {
      scope: 'memory',
      metrics: { K: parsed.K, entryCount: parsed.entryCount, vectors: mem.size }
    })
  }

  /** 惰性触发 IVF 构建（当向量数达到门槛且无索引时） */
  async function maybeBuildIvf(): Promise<void> {
    if (ivf || ivfBuilding) return
    const n = mem.size
    if (n < IVF_POLICY.minEntries) return
    await buildIvfAsync()
  }

  /** 异步构建 IVF 索引（不阻塞检索，构建期间走暴力扫描） */
  async function buildIvfAsync(): Promise<void> {
    if (ivfBuilding) return
    // C-γ-1: 连续失败超阈值 -> 不再尝试（避免 checkDrift 每次都触发无意义的 kmeans 调用）
    if (consecutiveBuildFailures >= IVF_BUILD_FAILURE_LIMIT) return
    ivfBuilding = true
    const nAtBuildStart = mem.size
    try {
      if (nAtBuildStart < IVF_POLICY.minEntries) {
        // C-γ-1: 条目数已低于建索引门槛 -> 作废旧索引，退回暴力扫描。
        // 必须清 ivf/driftSinceBuild/ivfState：否则 finally 的 if(ivf && drift>=threshold)
        // 在首个 await 之前同步递归 buildIvfAsync -> 栈溢出（主进程崩溃）。
        ivf = null
        driftSinceBuild = 0
        setMeta.run('ivfState', '')
        return
      }
      const K = IVF_POLICY.K(nAtBuildStart)
      // 收集所有向量到连续矩阵
      const ids = [...mem.keys()]
      const vectors = new Float32Array(nAtBuildStart * dim)
      for (let i = 0; i < nAtBuildStart; i++) {
        const entry = mem.get(ids[i])
        if (!entry) continue
        vectors.set(entry.vec, i * dim)
      }
      const result = await kmeansBuilder(vectors, dim, K, IVF_POLICY.maxIterations, seed)
      // 构建倒排列表
      const lists = buildInvertedLists(result.assignments, result.K)
      const invertedLists = lists.map((indices) => indices.map((idx) => ids[idx]))
      const idToCentroid = new Map<string, number>()
      for (let i = 0; i < ids.length; i++) {
        idToCentroid.set(ids[i], result.assignments[i])
      }
      const newIvf: IvfIndex = {
        centroids: result.centroids,
        K: result.K,
        invertedLists,
        idToCentroid,
        entryCount: nAtBuildStart,
        builtAt: now()
      }
      // 原子替换
      ivf = newIvf
      // 漂移 = 构建期间新增的向量数（它们不在倒排列表中，需要后续 rebuild 或增量加入）
      driftSinceBuild = Math.max(0, mem.size - nAtBuildStart)
      // 持久化
      const stateJson = serializeIvfState(result, nAtBuildStart, newIvf.builtAt)
      setMeta.run('ivfState', stateJson)
      // C-γ-1: 构建成功 -> 重置连续失败计数
      consecutiveBuildFailures = 0
      logger?.info('ivf index built', {
        scope: 'memory',
        metrics: { K: result.K, n: nAtBuildStart, driftAfter: driftSinceBuild }
      })
    } catch (e) {
      // C-γ-1: 连续失败计数，超阈值后 finally 不再自动重触发（避免忙循环）
      consecutiveBuildFailures++
      logger?.warn('ivf build failed; staying flat', {
        scope: 'memory',
        metrics: { consecutiveBuildFailures },
        detail: e instanceof Error ? e.message : String(e)
      })
    } finally {
      ivfBuilding = false
      // C-γ-1: 防抖 + 退避
      // 1. 重新检查条目数 >= minEntries（早退路径已清 ivf=null，这里不会误触发）
      // 2. 连续失败超阈值 -> 停止自动重建
      if (
        ivf &&
        mem.size >= IVF_POLICY.minEntries &&
        driftSinceBuild >= IVF_POLICY.rebuildDrift(ivf.entryCount)
      ) {
        if (consecutiveBuildFailures < IVF_BUILD_FAILURE_LIMIT) {
          void buildIvfAsync()
        } else {
          logger?.warn('ivf rebuild stopped: consecutive failure limit reached', {
            scope: 'memory',
            metrics: { consecutiveBuildFailures, limit: IVF_BUILD_FAILURE_LIMIT }
          })
        }
      }
    }
  }

  /** 检查是否需要重建（漂移超限） */
  function checkDrift(): void {
    if (!ivf || ivfBuilding) return
    const threshold = IVF_POLICY.rebuildDrift(ivf.entryCount)
    if (driftSinceBuild >= threshold) {
      void buildIvfAsync()
    }
  }

  /** 将新向量加入最近质心的桶（IVF 已存在时） */
  function addToIvf(memoryId: string, vec: Float32Array): void {
    if (!ivf || ivfBuilding) return
    if (ivf.idToCentroid.has(memoryId)) {
      // 已存在（upsert 更新）：先从旧桶移除
      const oldC = ivf.idToCentroid.get(memoryId)!
      const list = ivf.invertedLists[oldC]
      const idx = list.indexOf(memoryId)
      if (idx >= 0) list.splice(idx, 1)
    }
    const nearest = findNearestCentroids(vec, ivf.centroids, ivf.K, dim, 1)
    if (nearest.length > 0) {
      const c = nearest[0]
      ivf.invertedLists[c].push(memoryId)
      ivf.idToCentroid.set(memoryId, c)
    }
  }

  /** 从 IVF 倒排列表移除 */
  function removeFromIvf(memoryId: string): void {
    if (!ivf) return
    const c = ivf.idToCentroid.get(memoryId)
    if (c === undefined) return
    const list = ivf.invertedLists[c]
    const idx = list.indexOf(memoryId)
    if (idx >= 0) list.splice(idx, 1)
    ivf.idToCentroid.delete(memoryId)
  }

  /**
   * IVF 检索：只扫描 nprobe 个最近簇的向量。
   *
   * nprobe 调参依据 F5-003 §5：
   *   "实测 top-10 召回率在 IVF 下 <95% -> 停，回来调 nprobe（先升到 K/4）"
   * 实测 K/8 在均匀随机数据上 recall ~40%（远低 95%），按 F5-003 指示升至 K/4。
   * IVF_POLICY.nprobe (K/8) 保留为冻结常量，不改动；实际检索用 adjustedNprobe。
   */
  function adjustedNprobe(K: number): number {
    return Math.max(IVF_POLICY.nprobe(K), Math.round(K / 4))
  }

  /** IVF 检索：只扫描 nprobe 个最近簇的向量 */
  function searchIvf(query: Float32Array, k: number, minScore: number): VectorSearchHit[] {
    if (!ivf) return []
    const nprobe = adjustedNprobe(ivf.K)
    const nearestCentroids = findNearestCentroids(query, ivf.centroids, ivf.K, dim, nprobe)
    const qn = norm(query)
    if (qn === 0) return []
    const hits: VectorSearchHit[] = []
    for (const centroidIdx of nearestCentroids) {
      const bucket = ivf.invertedLists[centroidIdx]
      if (!bucket) continue
      for (const id of bucket) {
        const entry = mem.get(id)
        if (!entry || entry.norm === 0) continue
        const score = dot(query, entry.vec) / (qn * entry.norm)
        if (score >= minScore) hits.push({ memoryId: id, score })
      }
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, k)
  }

  return {
    async init() {
      mem.clear()
      const metaDim = getMeta.get('dim') as { value: string } | undefined
      if (metaDim) {
        const parsed = parseInt(metaDim.value, 10)
        if (Number.isInteger(parsed) && parsed > 0) {
          dim = parsed
          dimPersisted = true
        }
      }
      const rows = db.prepare(`SELECT memory_id, embedding, dtype FROM l2_vectors`).all() as Array<{
        memory_id: string
        embedding: Buffer
        dtype: string
      }>
      for (const r of rows) {
        if (r.dtype !== 'f32') {
          logger?.warn('skipping non-f32 vector on load', {
            scope: 'memory',
            tags: { dtype: r.dtype }
          })
          continue
        }
        const vec = decode(r.embedding)
        if (dim === 0) dim = vec.length
        mem.set(r.memory_id, { vec, norm: norm(vec) })
      }
      persistDim()
      // 尝试加载持久化的 IVF 状态
      if (dim > 0 && mem.size >= IVF_POLICY.minEntries) {
        loadIvfState()
      }
      rev++
    },

    upsert(memoryId, embedding) {
      if (dim === 0) {
        dim = embedding.length
      } else if (embedding.length !== dim) {
        throw dimMismatch()
      }
      persistDim()
      insVec.run(memoryId, encode(embedding), dim)
      const copy = Float32Array.from(embedding)
      mem.set(memoryId, { vec: copy, norm: norm(copy) })
      // IVF 已存在 -> 增量加入最近质心的桶（即时可检索）
      addToIvf(memoryId, copy)
      driftSinceBuild++
      rev++
      // 检查是否需要构建或重建 IVF（惰性，不阻塞）
      void maybeBuildIvf().then(() => checkDrift())
    },

    remove(memoryId) {
      delVec.run(memoryId)
      mem.delete(memoryId)
      removeFromIvf(memoryId)
      driftSinceBuild++
      rev++
      checkDrift()
    },

    search(query, k, minScore = DEFAULT_MIN_SCORE) {
      if (dim !== 0 && query.length !== dim) throw dimMismatch()
      const qn = norm(query)
      if (qn === 0 || k <= 0) return []
      // IVF 路径：有索引且不在重建中
      if (ivf && !ivfBuilding) {
        const ivfHits = searchIvf(query, k, minScore)
        if (ivfHits.length > 0) return ivfHits
        // IVF 未命中 -> 不降级到暴力（降级会让 IVF 失去意义）
        return ivfHits
      }
      // 暴力扫描（flat 阶段 / IVF 重建中 / IVF 未建）
      const hits: VectorSearchHit[] = []
      for (const [id, e] of mem) {
        if (e.norm === 0) continue
        const score = dot(query, e.vec) / (qn * e.norm)
        if (score >= minScore) hits.push({ memoryId: id, score })
      }
      hits.sort((a, b) => b.score - a.score)
      return hits.slice(0, k)
    },

    count() {
      return mem.size
    },

    revision() {
      return rev
    },

    rebuildIndex(force = false) {
      if (ivfBuilding) return
      if (!force && mem.size < IVF_POLICY.minEntries) return
      void buildIvfAsync()
    },

    stats(): VectorStoreStats {
      const indexKind: 'flat' | 'ivf' = ivf ? 'ivf' : 'flat'
      return {
        count: mem.size,
        dim,
        dtype: 'f32',
        indexKind,
        K: ivf?.K,
        nprobe: ivf ? adjustedNprobe(ivf.K) : undefined,
        lastBuildAt: ivf?.builtAt,
        memBytes: mem.size * dim * 4
      }
    }
  }
}
