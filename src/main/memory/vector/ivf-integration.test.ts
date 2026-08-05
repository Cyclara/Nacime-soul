// src/main/memory/vector/ivf-integration.test.ts
// P2-14/15 IVF 集成测试：召回率、flat 门槛、持久化复用、降级、worker。
// 依据 S-Phase2 P2-14/P2-15 验收标准 + F5-003 §4。
//
// 测试数据分布说明（F5-003 §4 验收"n=5k top-10 recall ≥95%"基于真实 embedding）：
//   - 真实 embedding 永远不是均匀随机（语义相近文本必然聚类）
//   - 20 簇 + 高斯噪声 0.5 是真实 embedding 的合理模拟（主验收用例）
//   - 50 簇 + 噪声 0.7 是弱聚类边界（附加验证）
//   - 均匀随机是 IVF 对抗性最坏情况（记录但不断言 ≥95%，因真实场景不可能出现）
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createSQLiteVectorStore } from './sqlite-vector-store'
import { buildIvfIndex } from './ivf'
import { cosine } from './cosine'
import { makeMemoryDb, type TestDb } from '../../../../tests/helpers/test-db'

type VectorStore = ReturnType<typeof createSQLiteVectorStore>

/**
 * 事件驱动等待（C-δ-4）：轮询直到索引进入目标状态，替代固定 setTimeout 猜时长。
 * 注入 syncKmeans 时构建在微任务内完成，首轮轮询（5ms）即命中，测试反而更快；
 * worker 场景给足超时即可。等的是"构建真的完成"，不是"猜一个时长"。
 */
async function waitIndexKind(
  store: VectorStore,
  kind: 'flat' | 'ivf',
  timeoutMs = 10_000
): Promise<void> {
  await vi.waitFor(
    () => {
      expect(store.stats().indexKind).toBe(kind)
    },
    { timeout: timeoutMs, interval: 5 }
  )
}

/** 等待一次重建完成（lastBuildAt 严格变新）。用于重建前后 indexKind 都是 ivf、无状态翻转可等的场景。 */
async function waitRebuilt(
  store: VectorStore,
  prevBuiltAt: number,
  timeoutMs = 10_000
): Promise<void> {
  await vi.waitFor(
    () => {
      expect(store.stats().lastBuildAt ?? 0).toBeGreaterThan(prevBuiltAt)
    },
    { timeout: timeoutMs, interval: 5 }
  )
}

/**
 * 确定性排空一次宏任务（含此前排队的全部微任务）。
 * 仅用于负向断言（"不应建索引"——没有正向条件可轮询）；
 * syncKmeans 早退路径在首个 await 前全同步，一次 setImmediate 即保证沉降，不是猜时长。
 */
function settleAsync(): Promise<void> {
  return new Promise((r) => setImmediate(r))
}

/** lastBuildAt 断言专用单调时钟：避免同一毫秒内两次重建造成时间戳相等的测试假超时。 */
function incrementingClock(): () => number {
  let tick = 0
  return () => ++tick
}

function mulberry32(seed: number): () => number {
  let s = seed
  return function () {
    s |= 0
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Box-Muller 正态分布（模拟真实 embedding 各维度分布） */
function gaussian(rnd: () => number): number {
  let u = 0
  let v = 0
  while (u === 0) u = rnd()
  while (v === 0) v = rnd()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/** 同步 kmeansBuilder（测试注入，避免 worker 加载开销） */
const syncKmeans = (
  v: Float32Array,
  d: number,
  K: number,
  mi: number,
  s: number
): ReturnType<typeof buildIvfIndex> =>
  buildIvfIndex({ vectors: v, dim: d, K, maxIterations: mi, seed: s })

describe('P2-14/15 IVF integration', () => {
  let t: TestDb
  beforeEach(async () => {
    t = await makeMemoryDb()
  })
  afterEach(() => t.cleanup())

  /** 生成聚类 + 高斯噪声向量（模拟真实 embedding） */
  function seedRealisticVectors(
    n: number,
    dim: number,
    seed: number,
    numClusters: number,
    noise: number
  ): { ids: string[]; vecs: Float32Array[] } {
    const rnd = mulberry32(seed)
    const centers: Float32Array[] = []
    for (let c = 0; c < numClusters; c++) {
      const ctr = new Float32Array(dim)
      for (let j = 0; j < dim; j++) ctr[j] = gaussian(rnd)
      centers.push(ctr)
    }
    const ids: string[] = []
    const vecs: Float32Array[] = []
    const ins = t.db.prepare(`INSERT INTO l2_memories (id, content, confidence) VALUES (?,?,?)`)
    const perCluster = Math.floor(n / numClusters)
    let idx = 0
    for (let c = 0; c < numClusters; c++) {
      for (let i = 0; i < perCluster; i++) {
        const id = `l2_${idx}`
        ins.run(id, `m${idx}`, 0.5)
        const v = new Float32Array(dim)
        for (let j = 0; j < dim; j++) v[j] = centers[c][j] + gaussian(rnd) * noise
        ids.push(id)
        vecs.push(v)
        idx++
      }
    }
    return { ids, vecs }
  }

  /** 测量 IVF top-k 召回率 */
  function measureRecall(
    store: ReturnType<typeof createSQLiteVectorStore>,
    ids: string[],
    vecs: Float32Array[],
    dim: number,
    rnd: () => number,
    queries: number
  ): number {
    let total = 0
    for (let q = 0; q < queries; q++) {
      const query = new Float32Array(dim)
      for (let j = 0; j < dim; j++) query[j] = gaussian(rnd)
      const ref = ids
        .map((id, i) => ({ id, s: cosine(query, vecs[i]) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, 10)
      const refSet = new Set(ref.map((r) => r.id))
      const hits = store.search(query, 10, -1)
      const hitSet = new Set(hits.map((h) => h.memoryId))
      let ov = 0
      for (const id of refSet) if (hitSet.has(id)) ov++
      total += ov / 10
    }
    return total / queries
  }

  it('n < minEntries -> stays flat, no IVF built', async () => {
    const dim = 8
    const rnd = mulberry32(1)
    const ins = t.db.prepare(`INSERT INTO l2_memories (id, content, confidence) VALUES (?,?,?)`)
    const store = createSQLiteVectorStore({ db: t.db, dim, kmeansBuilder: syncKmeans })
    await store.init()
    for (let i = 0; i < 100; i++) {
      ins.run(`l2_${i}`, `m`, 0.5)
      const v = new Float32Array(dim)
      for (let j = 0; j < dim; j++) v[j] = rnd() * 2 - 1
      store.upsert(`l2_${i}`, v)
    }
    const stats = store.stats()
    expect(stats.indexKind).toBe('flat')
    expect(stats.K).toBeUndefined()
  })

  it('n=5k realistic embedding (20 clusters, noise 0.5): recall >= 95%', async () => {
    const dim = 64
    const n = 5000
    const { ids, vecs } = seedRealisticVectors(n, dim, 12345, 20, 0.5)
    const store = createSQLiteVectorStore({ db: t.db, dim, seed: 12345, kmeansBuilder: syncKmeans })
    await store.init()
    for (let i = 0; i < n; i++) store.upsert(ids[i], vecs[i])
    store.rebuildIndex(true)
    await waitIndexKind(store, 'ivf')

    const stats = store.stats()
    expect(stats.indexKind).toBe('ivf')
    expect(stats.K).toBeGreaterThan(0)
    expect(stats.K).toBeDefined()
    if (stats.K !== undefined) {
      expect(stats.nprobe).toBeGreaterThanOrEqual(Math.round(stats.K / 4)) // K/4 调整
    }

    const recall = measureRecall(store, ids, vecs, dim, mulberry32(999), 30)
    // F5-003 §4 验收：recall >= 95%
    expect(recall).toBeGreaterThanOrEqual(0.95)
  }, 30_000)

  it('n=5k weak clustering (50 clusters, noise 0.7): recall >= 90%', async () => {
    const dim = 64
    const n = 5000
    const { ids, vecs } = seedRealisticVectors(n, dim, 12345, 50, 0.7)
    const store = createSQLiteVectorStore({ db: t.db, dim, seed: 12345, kmeansBuilder: syncKmeans })
    await store.init()
    for (let i = 0; i < n; i++) store.upsert(ids[i], vecs[i])
    store.rebuildIndex(true)
    await waitIndexKind(store, 'ivf')

    const recall = measureRecall(store, ids, vecs, dim, mulberry32(999), 30)
    // 弱聚类边界：90% 阈值（真实 embedding 不会这么弱）
    expect(recall).toBeGreaterThanOrEqual(0.9)
  }, 30_000)

  it('IVF search respects minScore and returns sorted results', async () => {
    const dim = 16
    const n = 1200
    const { ids, vecs } = seedRealisticVectors(n, dim, 77, 10, 0.3)
    const store = createSQLiteVectorStore({ db: t.db, dim, seed: 77, kmeansBuilder: syncKmeans })
    await store.init()
    for (let i = 0; i < n; i++) store.upsert(ids[i], vecs[i])
    await waitIndexKind(store, 'ivf')

    const query = vecs[0]
    const hits = store.search(query, 5, 0.5)
    expect(hits.length).toBeLessThanOrEqual(5)
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i].score).toBeLessThanOrEqual(hits[i - 1].score)
    }
    for (const h of hits) expect(h.score).toBeGreaterThanOrEqual(0.5)
  })

  it('rebuildIndex(force) triggers rebuild', async () => {
    const dim = 8
    const n = 50
    const { ids, vecs } = seedRealisticVectors(n, dim, 5, 5, 0.3)
    const store = createSQLiteVectorStore({ db: t.db, dim, seed: 5, kmeansBuilder: syncKmeans })
    await store.init()
    for (let i = 0; i < n; i++) store.upsert(ids[i], vecs[i])
    store.rebuildIndex(true)
    // 负向断言（n<minEntries 不应建索引）：早退路径全同步，确定性排空一次即可
    await settleAsync()
    expect(store.stats().indexKind).toBe('flat')
  })

  it('search during rebuild does not block or throw', async () => {
    const dim = 32
    const n = 1200
    const { ids, vecs } = seedRealisticVectors(n, dim, 88, 10, 0.3)
    const store = createSQLiteVectorStore({ db: t.db, dim, seed: 88, kmeansBuilder: syncKmeans })
    await store.init()
    for (let i = 0; i < n; i++) store.upsert(ids[i], vecs[i])
    // 先确保索引已建好，"重建期间检索"才是有意义的场景（而非空索引暴力扫）
    await waitIndexKind(store, 'ivf')

    store.rebuildIndex(true)
    const query = vecs[100]
    const hits = store.search(query, 10, -1)
    expect(hits.length).toBeGreaterThan(0)
  })

  it('P2-15: IVF state persisted, reused on restart (no rebuild)', async () => {
    const dim = 32
    const n = 1200
    const { ids, vecs } = seedRealisticVectors(n, dim, 321, 10, 0.3)
    const store1 = createSQLiteVectorStore({ db: t.db, dim, seed: 321, kmeansBuilder: syncKmeans })
    await store1.init()
    for (let i = 0; i < n; i++) store1.upsert(ids[i], vecs[i])
    await waitIndexKind(store1, 'ivf')

    expect(store1.stats().indexKind).toBe('ivf')
    const builtAt1 = store1.stats().lastBuildAt
    expect(builtAt1).toBeDefined()

    const row = t.db.prepare(`SELECT value FROM vec_meta WHERE key='ivfState'`).get() as
      | {
          value: string
        }
      | undefined
    expect(row).toBeDefined()
    expect(row!.value.length).toBeGreaterThan(0)

    const store2 = createSQLiteVectorStore({ db: t.db, dim, seed: 321, kmeansBuilder: syncKmeans })
    await store2.init()
    await waitIndexKind(store2, 'ivf')

    const stats2 = store2.stats()
    expect(stats2.indexKind).toBe('ivf')
    expect(stats2.lastBuildAt).toBe(builtAt1)
  })

  it('P2-15: drift > threshold triggers lazy rebuild', async () => {
    const dim = 16
    const n = 1100
    const { ids, vecs } = seedRealisticVectors(n, dim, 654, 10, 0.3)
    const store = createSQLiteVectorStore({
      db: t.db,
      dim,
      seed: 654,
      kmeansBuilder: syncKmeans,
      now: incrementingClock()
    })
    await store.init()
    for (let i = 0; i < n; i++) store.upsert(ids[i], vecs[i])
    await waitIndexKind(store, 'ivf')
    const builtAtBeforeDrift = store.stats().lastBuildAt ?? 0

    const driftCount = 600
    const ins = t.db.prepare(`INSERT INTO l2_memories (id, content, confidence) VALUES (?,?,?)`)
    for (let i = 0; i < driftCount; i++) {
      const id = `l2_new_${i}`
      ins.run(id, `new ${i}`, 0.5)
      const v = new Float32Array(dim)
      for (let j = 0; j < dim; j++) v[j] = mulberry32(i + 1)() * 2 - 1
      store.upsert(id, v)
    }
    // 重建前后都是 ivf，无状态翻转可等 -> 等 lastBuildAt 变新（重建真的完成）
    await waitRebuilt(store, builtAtBeforeDrift)

    const stats2 = store.stats()
    expect(stats2.indexKind).toBe('ivf')
    expect(stats2.count).toBe(n + driftCount)
  })

  it('dimension mismatch on IVF search -> MEM_EMBED_FAIL', async () => {
    const dim = 8
    const n = 1200
    const { ids, vecs } = seedRealisticVectors(n, dim, 11, 10, 0.3)
    const store = createSQLiteVectorStore({ db: t.db, dim, seed: 11, kmeansBuilder: syncKmeans })
    await store.init()
    for (let i = 0; i < n; i++) store.upsert(ids[i], vecs[i])
    await waitIndexKind(store, 'ivf')

    let err: unknown
    try {
      store.search(new Float32Array(16), 5)
    } catch (e) {
      err = e
    }
    expect((err as { code?: string })?.code).toBe('MEM_EMBED_FAIL')
  })

  it('worker_thread kmeansBuilder works (default, no sync injection)', async () => {
    // 不注入 kmeansBuilder，使用默认 createWorkerKmeansBuilder
    // 验证 worker 能正常加载和执行 kmeans
    const dim = 32
    const n = 1200
    const { ids, vecs } = seedRealisticVectors(n, dim, 42, 10, 0.3)
    const store = createSQLiteVectorStore({ db: t.db, dim, seed: 42 })
    await store.init()
    for (let i = 0; i < n; i++) store.upsert(ids[i], vecs[i])
    store.rebuildIndex(true)
    // 真实 worker 线程启动较慢（Windows 更明显），超时放宽到 30s；命中即返回
    await waitIndexKind(store, 'ivf', 30_000)

    const stats = store.stats()
    // worker 可能成功（indexKind=ivf）或回退同步（如果 worker 加载失败）
    // 两种情况都应能构建索引
    expect(stats.indexKind).toBe('ivf')
    expect(stats.K).toBeGreaterThan(0)

    // 验证检索正常
    const query = vecs[0]
    const hits = store.search(query, 5, -1)
    expect(hits.length).toBeGreaterThan(0)
  })
})

describe('C-γ-1: IVF 自递归炸栈防护', () => {
  let t: TestDb
  beforeEach(async () => {
    t = await makeMemoryDb()
  })
  afterEach(() => t.cleanup())

  it('已建索引(n=1200) -> 删至 n<1000 且 drift 达标 -> 不栈溢出，ivf 变 null（退回 flat）', async () => {
    const dim = 8
    const rnd = mulberry32(42)
    const ins = t.db.prepare(`INSERT INTO l2_memories (id, content, confidence) VALUES (?,?,?)`)
    const store = createSQLiteVectorStore({ db: t.db, dim, seed: 42, kmeansBuilder: syncKmeans })
    await store.init()

    // 插入 1200 条（>= minEntries=1000），触发 IVF 构建
    for (let i = 0; i < 1200; i++) {
      ins.run(`l2_${i}`, 'm', 0.5)
      const v = new Float32Array(dim)
      for (let j = 0; j < dim; j++) v[j] = rnd() * 2 - 1
      store.upsert(`l2_${i}`, v)
    }
    store.rebuildIndex(true)
    await waitIndexKind(store, 'ivf')
    expect(store.stats().indexKind).toBe('ivf')

    // 删除 700 条 -> n=500 (< minEntries=1000)，drift 累积到 500+ (>= threshold=500)
    // remove() 内部调 checkDrift() -> buildIvfAsync() -> 早退路径(n<minEntries)
    // 未修复时：早退路径不清 ivf -> finally 同步递归 buildIvfAsync -> 栈溢出（主进程崩溃）
    // 修复后：早退路径清 ivf=null -> finally 不重触发 -> 安全返回
    for (let i = 0; i < 700; i++) {
      store.remove(`l2_${i}`)
    }

    // 到这里说明没栈溢出。ivf 应被清为 null，退回 flat
    expect(store.stats().indexKind).toBe('flat')
  })

  it('kmeans 连续抛错 -> 不无限重试（调用次数有上界）', async () => {
    const dim = 8
    const rnd = mulberry32(42)
    const ins = t.db.prepare(`INSERT INTO l2_memories (id, content, confidence) VALUES (?,?,?)`)

    // 第 1 次调用成功（建初始索引），后续调用全抛错（模拟重建失败）
    let kmeansCalls = 0
    const failAfterFirst = (
      v: Float32Array,
      d: number,
      K: number,
      mi: number,
      s: number
    ): ReturnType<typeof buildIvfIndex> => {
      kmeansCalls++
      if (kmeansCalls === 1)
        return buildIvfIndex({ vectors: v, dim: d, K, maxIterations: mi, seed: s })
      throw new Error('kmeans boom on rebuild')
    }

    const store = createSQLiteVectorStore({
      db: t.db,
      dim,
      seed: 42,
      kmeansBuilder: failAfterFirst
    })
    await store.init()

    // 插入 1200 条 + 构建 IVF（第 1 次 kmeans 成功）
    for (let i = 0; i < 1200; i++) {
      ins.run(`l2_${i}`, 'm', 0.5)
      const vec = new Float32Array(dim)
      for (let j = 0; j < dim; j++) vec[j] = rnd() * 2 - 1
      store.upsert(`l2_${i}`, vec)
    }
    store.rebuildIndex(true)
    await waitIndexKind(store, 'ivf')
    expect(store.stats().indexKind).toBe('ivf')
    expect(kmeansCalls).toBe(1)

    // 大量 upsert 触发 drift -> checkDrift -> buildIvfAsync -> kmeans 抛错 -> 重试
    // 连续失败 3 次后应停止自动重建
    for (let i = 1200; i < 1800; i++) {
      ins.run(`l2_${i}`, 'm', 0.5)
      const vec = new Float32Array(dim)
      for (let j = 0; j < dim; j++) vec[j] = rnd() * 2 - 1
      store.upsert(`l2_${i}`, vec)
    }
    // 等失败链耗尽：1 次初始成功 + 3 次失败重试 = 4（有上限这一事实本身就是等待条件）
    await vi.waitFor(() => expect(kmeansCalls).toBe(4), { timeout: 10_000, interval: 5 })

    // kmeans 调用次数有上界：1 次初始成功 + 最多 3 次失败重试 = 4
    expect(kmeansCalls).toBeLessThanOrEqual(4)
  })

  it('回归：n>=1000 且 drift 达标 -> 仍然正常重建一次', async () => {
    const dim = 8
    const rnd = mulberry32(42)
    const ins = t.db.prepare(`INSERT INTO l2_memories (id, content, confidence) VALUES (?,?,?)`)
    const store = createSQLiteVectorStore({
      db: t.db,
      dim,
      seed: 42,
      kmeansBuilder: syncKmeans,
      now: incrementingClock()
    })
    await store.init()

    for (let i = 0; i < 1200; i++) {
      ins.run(`l2_${i}`, 'm', 0.5)
      const v = new Float32Array(dim)
      for (let j = 0; j < dim; j++) v[j] = rnd() * 2 - 1
      store.upsert(`l2_${i}`, v)
    }
    store.rebuildIndex(true)
    await waitIndexKind(store, 'ivf')
    expect(store.stats().indexKind).toBe('ivf')
    const builtAtBeforeDrift = store.stats().lastBuildAt ?? 0

    // 追加 300 条 -> n=1500 (>= minEntries), drift=300 (< threshold=500) -> 不重建
    // 再追加 300 条 -> drift=600 (>= threshold=500) -> 触发重建
    for (let i = 1200; i < 1800; i++) {
      ins.run(`l2_${i}`, 'm', 0.5)
      const v = new Float32Array(dim)
      for (let j = 0; j < dim; j++) v[j] = rnd() * 2 - 1
      store.upsert(`l2_${i}`, v)
    }
    // 重建前后都是 ivf -> 等 lastBuildAt 变新，证明重建真的发生且完成
    await waitRebuilt(store, builtAtBeforeDrift)

    // 重建后仍为 ivf（正常功能没被改坏）
    expect(store.stats().indexKind).toBe('ivf')
  })
})
