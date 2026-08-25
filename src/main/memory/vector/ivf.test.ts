// src/main/memory/vector/ivf.test.ts
// P2-14 IVF kmeans++ 纯函数测试：确定性、聚类质量、findNearestCentroids。
import { describe, it, expect } from 'vitest'
import { buildIvfIndex, findNearestCentroids, buildInvertedLists, kmeansPlusPlusInit } from './ivf'

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

describe('P2-14 IVF kmeans++ pure functions', () => {
  it('kmeansPlusPlusInit returns K*dim centroids, normalized', () => {
    const dim = 8
    const n = 100
    const rnd = mulberry32(42)
    const vectors = new Float32Array(n * dim)
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < dim; j++) vectors[i * dim + j] = rnd() * 2 - 1
    }
    const centroids = kmeansPlusPlusInit({
      vectors,
      dim,
      K: 5,
      maxIterations: 10,
      seed: 42
    })
    expect(centroids.length).toBe(5 * dim)
    // 每个质心应归一化（模长 ≈ 1）
    for (let k = 0; k < 5; k++) {
      let s = 0
      for (let j = 0; j < dim; j++) s += centroids[k * dim + j] ** 2
      expect(Math.sqrt(s)).toBeCloseTo(1, 4)
    }
  })

  it('buildIvfIndex is deterministic for same seed', () => {
    const dim = 8
    const n = 200
    const rnd = mulberry32(99)
    const vectors = new Float32Array(n * dim)
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < dim; j++) vectors[i * dim + j] = rnd() * 2 - 1
    }
    const r1 = buildIvfIndex({ vectors, dim, K: 10, maxIterations: 10, seed: 99 })
    const r2 = buildIvfIndex({ vectors, dim, K: 10, maxIterations: 10, seed: 99 })
    expect(Array.from(r1.centroids)).toEqual(Array.from(r2.centroids))
    expect(Array.from(r1.assignments)).toEqual(Array.from(r2.assignments))
  })

  it('buildIvfIndex assigns clustered data correctly', () => {
    // 构造 3 个明显的簇
    const dim = 4
    const clusterSize = 50
    const vectors = new Float32Array(clusterSize * 3 * dim)
    const centers = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0]
    ]
    // C-δ-4：用 seeded PRNG 替换 Math.random，保证测试数据确定性（其余测试已用 mulberry32）
    const rnd = mulberry32(7)
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < clusterSize; i++) {
        for (let j = 0; j < dim; j++) {
          vectors[(c * clusterSize + i) * dim + j] = centers[c][j] + (rnd() - 0.5) * 0.1
        }
      }
    }
    const result = buildIvfIndex({
      vectors,
      dim,
      K: 3,
      maxIterations: 10,
      seed: 1
    })
    // 同一簇的向量应分配到同一质心
    const cluster0Assignments = result.assignments.slice(0, clusterSize)
    const cluster1Assignments = result.assignments.slice(clusterSize, clusterSize * 2)
    const cluster2Assignments = result.assignments.slice(clusterSize * 2, clusterSize * 3)
    // 每个输入簇应主要分配到一个质心
    const unique0 = new Set(cluster0Assignments)
    const unique1 = new Set(cluster1Assignments)
    const unique2 = new Set(cluster2Assignments)
    expect(unique0.size).toBe(1)
    expect(unique1.size).toBe(1)
    expect(unique2.size).toBe(1)
    // 三个簇应分配到不同质心
    expect(unique0.values().next().value).not.toBe(unique1.values().next().value)
    expect(unique0.values().next().value).not.toBe(unique2.values().next().value)
  })

  it('buildIvfIndex handles n < K (fewer vectors than clusters)', () => {
    const dim = 4
    const n = 3
    const vectors = new Float32Array(n * dim)
    vectors.set([1, 0, 0, 0], 0)
    vectors.set([0, 1, 0, 0], dim)
    vectors.set([0, 0, 1, 0], dim * 2)
    const result = buildIvfIndex({ vectors, dim, K: 10, maxIterations: 5, seed: 1 })
    expect(result.K).toBe(3) // 降为 n
    expect(result.assignments.length).toBe(3)
    expect(result.assignments[0]).toBe(0)
    expect(result.assignments[1]).toBe(1)
    expect(result.assignments[2]).toBe(2)
  })

  it('findNearestCentroids returns nprobe closest centroid indices', () => {
    const dim = 4
    const K = 5
    // 质心：e1, e2, e3, e4, e5（单位向量）
    const centroids = new Float32Array(K * dim)
    for (let k = 0; k < K; k++) {
      centroids[k * dim + k] = 1
    }
    // 查询接近 e2
    const query = new Float32Array([0.1, 1, 0.1, 0.1])
    const nearest = findNearestCentroids(query, centroids, K, dim, 2)
    expect(nearest.length).toBe(2)
    expect(nearest[0]).toBe(1) // e2 最近
  })

  it('buildInvertedLists groups vector indices by cluster', () => {
    const assignments = new Int32Array([0, 1, 0, 2, 1, 0])
    const lists = buildInvertedLists(assignments, 3)
    expect(lists[0]).toEqual([0, 2, 5])
    expect(lists[1]).toEqual([1, 4])
    expect(lists[2]).toEqual([3])
  })
})
