// src/main/memory/vector/ivf.ts
// IVF（Inverted File Index）kmeans++ 聚类纯函数 + 检索辅助。
// 依据 F5-003 §3 IVF_POLICY 常量 + §4 实现路线图。
//
// 设计要点：
//   1. 纯函数、无 IO、无 worker 依赖--可在测试中直接调用，也可被 worker 包装
//   2. 余弦距离聚类：先归一化所有向量，再用点积作为相似度（归一化后点积=余弦）
//   3. kmeans++ 初始化：第一个质心随机选，后续按到最近质心的平方距离加权抽样
//   4. Lloyd 迭代：分配（每点归到最近质心）+ 更新（质心取簇内均值再归一化）
//   5. 返回归一化质心 + 每个向量的簇分配索引
//
// 不在主线程跑（F5-003 §5 红线）：SQLiteVectorStore 通过可注入的 kmeansBuilder
// 在生产环境把本模块放到 worker_thread 执行；测试直接同步调用。

import { dot, norm } from './cosine'

export interface IvfBuildResult {
  /** 归一化质心矩阵 K*dim，float32 连续存储 */
  centroids: Float32Array
  /** 每个向量分配到的质心索引，长度 = 向量数 */
  assignments: Int32Array
  K: number
  dim: number
}

export interface IvfBuildInput {
  /** n*dim 连续存储的向量矩阵 */
  vectors: Float32Array
  dim: number
  K: number
  maxIterations: number
  /** 确定性 PRNG 种子（S-004 V-系列要求 seeded） */
  seed: number
}

// === 确定性 PRNG（mulberry32，同 sqlite-vector-store.test.ts）===

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

/** 归一化一个向量（原地修改并返回） */
function normalizeInPlace(v: Float32Array): Float32Array {
  const n = norm(v)
  if (n === 0) return v
  for (let i = 0; i < v.length; i++) v[i] /= n
  return v
}

/**
 * kmeans++ 初始化：选择 K 个初始质心。
 * 第一个随机选；后续按到最近已有质心的平方距离加权抽样。
 * 返回 K*dim 的质心矩阵（已归一化）。
 */
export function kmeansPlusPlusInit(input: IvfBuildInput): Float32Array {
  const { vectors, dim, K, seed } = input
  const n = vectors.length / dim
  const rnd = mulberry32(seed)

  const centroids = new Float32Array(K * dim)
  // 预归一化所有向量（不修改原数组）
  const normalized = new Float32Array(vectors.length)
  for (let i = 0; i < n; i++) {
    const slice = vectors.subarray(i * dim, (i + 1) * dim)
    const nrm = norm(slice)
    if (nrm === 0) {
      // 零向量保持原样
      normalized.set(slice, i * dim)
    } else {
      for (let j = 0; j < dim; j++) normalized[i * dim + j] = slice[j] / nrm
    }
  }

  // 选第一个质心（随机）
  const firstIdx = Math.floor(rnd() * n)
  centroids.set(normalized.subarray(firstIdx * dim, (firstIdx + 1) * dim), 0)

  // 每个点到最近质心的平方距离
  const minDistSq = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const v = normalized.subarray(i * dim, (i + 1) * dim)
    const c = centroids.subarray(0, dim)
    // 归一化向量的余弦相似度 = 点积；距离 = 1 - 相似度（范围 [0, 2]）
    const sim = dot(v, c)
    minDistSq[i] = 1 - sim
  }

  // 选剩余 K-1 个质心
  for (let k = 1; k < K; k++) {
    // 计算累积分布
    let total = 0
    for (let i = 0; i < n; i++) total += minDistSq[i]
    if (total === 0) {
      // 所有点都与已有质心重合，随机选一个
      const idx = Math.floor(rnd() * n)
      centroids.set(normalized.subarray(idx * dim, (idx + 1) * dim), k * dim)
    } else {
      const threshold = rnd() * total
      let cum = 0
      let chosen = n - 1
      for (let i = 0; i < n; i++) {
        cum += minDistSq[i]
        if (cum >= threshold) {
          chosen = i
          break
        }
      }
      centroids.set(normalized.subarray(chosen * dim, (chosen + 1) * dim), k * dim)
    }
    // 更新 minDistSq
    const newCentroid = centroids.subarray(k * dim, (k + 1) * dim)
    for (let i = 0; i < n; i++) {
      const v = normalized.subarray(i * dim, (i + 1) * dim)
      const sim = dot(v, newCentroid)
      const dist = 1 - sim
      if (dist < minDistSq[i]) minDistSq[i] = dist
    }
  }

  return centroids
}

/**
 * 执行 kmeans 聚类（kmeans++ 初始化 + Lloyd 迭代）。
 * 返回归一化质心 + 每个向量的簇分配索引。
 */
export function buildIvfIndex(input: IvfBuildInput): IvfBuildResult {
  const { vectors, dim, K, maxIterations } = input
  const n = vectors.length / dim

  if (n < K) {
    // 向量数少于簇数：每个向量自成一群，质心就是向量本身（归一化）
    const centroids = new Float32Array(n * dim)
    const assignments = new Int32Array(n)
    for (let i = 0; i < n; i++) {
      const slice = vectors.subarray(i * dim, (i + 1) * dim)
      const copy = Float32Array.from(slice)
      normalizeInPlace(copy)
      centroids.set(copy, i * dim)
      assignments[i] = i
    }
    return { centroids, assignments, K: n, dim }
  }

  // kmeans++ 初始化
  let centroids = kmeansPlusPlusInit(input)

  // 预归一化所有向量
  const normalized = new Float32Array(vectors.length)
  for (let i = 0; i < n; i++) {
    const slice = vectors.subarray(i * dim, (i + 1) * dim)
    const nrm = norm(slice)
    if (nrm === 0) {
      normalized.set(slice, i * dim)
    } else {
      for (let j = 0; j < dim; j++) normalized[i * dim + j] = slice[j] / nrm
    }
  }

  const assignments = new Int32Array(n)

  // Lloyd 迭代
  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = false

    // 分配步：每个点归到最近质心（最大点积）
    for (let i = 0; i < n; i++) {
      const v = normalized.subarray(i * dim, (i + 1) * dim)
      let bestK = 0
      let bestSim = -Infinity
      for (let k = 0; k < K; k++) {
        const c = centroids.subarray(k * dim, (k + 1) * dim)
        const sim = dot(v, c)
        if (sim > bestSim) {
          bestSim = sim
          bestK = k
        }
      }
      if (assignments[i] !== bestK) {
        assignments[i] = bestK
        changed = true
      }
    }

    // 更新步：质心 = 簇内均值，再归一化
    const newCentroids = new Float32Array(K * dim)
    const counts = new Int32Array(K)
    for (let i = 0; i < n; i++) {
      const k = assignments[i]
      const v = normalized.subarray(i * dim, (i + 1) * dim)
      for (let j = 0; j < dim; j++) newCentroids[k * dim + j] += v[j]
      counts[k]++
    }
    for (let k = 0; k < K; k++) {
      if (counts[k] > 0) {
        const c = newCentroids.subarray(k * dim, (k + 1) * dim)
        for (let j = 0; j < dim; j++) c[j] /= counts[k]
        normalizeInPlace(c)
      } else {
        // 空簇：保留旧质心
        newCentroids.set(centroids.subarray(k * dim, (k + 1) * dim), k * dim)
      }
    }
    centroids = newCentroids

    if (!changed && iter > 0) break // 收敛
  }

  return { centroids, assignments, K, dim }
}

/**
 * 找到查询向量最近的 nprobe 个质心索引。
 * 质心已归一化，查询也需归一化后比较点积。
 */
export function findNearestCentroids(
  query: Float32Array,
  centroids: Float32Array,
  K: number,
  dim: number,
  nprobe: number
): number[] {
  // 归一化查询
  const qn = norm(query)
  if (qn === 0) return []
  const q = new Float32Array(dim)
  for (let j = 0; j < dim; j++) q[j] = query[j] / qn

  // 计算与所有质心的点积
  const sims: Array<{ idx: number; sim: number }> = []
  for (let k = 0; k < K; k++) {
    const c = centroids.subarray(k * dim, (k + 1) * dim)
    sims.push({ idx: k, sim: dot(q, c) })
  }
  // 降序取前 nprobe
  sims.sort((a, b) => b.sim - a.sim)
  return sims.slice(0, Math.min(nprobe, K)).map((s) => s.idx)
}

/**
 * 构建倒排列表：质心索引 -> 向量索引数组。
 * 用于 IVF 检索时只扫描对应桶的向量。
 */
export function buildInvertedLists(assignments: Int32Array, K: number): Array<number[]> {
  const lists: Array<number[]> = Array.from({ length: K }, () => [])
  for (let i = 0; i < assignments.length; i++) {
    lists[assignments[i]].push(i)
  }
  return lists
}
