// src/main/memory/vector/cosine.ts
// f32 向量的点积 / 模长 / 余弦。计算路径永远用 f32 数据、f64 累加。

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}

export function norm(v: Float32Array): number {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i] * v[i]
  return Math.sqrt(s)
}

/** 余弦相似度；任一模长为 0 时返回 0 */
export function cosine(a: Float32Array, b: Float32Array): number {
  const denom = norm(a) * norm(b)
  return denom === 0 ? 0 : dot(a, b) / denom
}
