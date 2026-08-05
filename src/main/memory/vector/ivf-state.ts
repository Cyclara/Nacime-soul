// src/main/memory/vector/ivf-state.ts
// IVF 状态序列化/反序列化。依据 F5-003 §3 vec_meta.ivfState。
//
// ivfState 持久化为 vec_meta 表的 'ivfState' 键，JSON 格式：
//   { centroids: base64(f32), assignments: number[], entryCount, builtAt, K, dim }
//
// 启动时校验 entryCount 漂移 < rebuildDrift -> 直接复用；否则后台重建。

import type { IvfBuildResult } from './ivf'

export interface IvfState {
  /** 归一化质心矩阵 K*dim，base64 编码的 f32 字节 */
  centroids: string // base64
  K: number
  dim: number
  /** 每个向量分配到的质心索引（按向量在构建时的顺序） */
  assignments: number[]
  /** 建索引时的向量总数（漂移检测用） */
  entryCount: number
  /** 建索引的时间戳（epoch ms） */
  builtAt: number
}

/**
 * 将 IvfBuildResult 序列化为可存入 vec_meta 的 JSON 字符串。
 * centroids Float32Array -> base64。
 */
export function serializeIvfState(
  result: IvfBuildResult,
  entryCount: number,
  builtAt: number
): string {
  const state: IvfState = {
    centroids: bufferToBase64(result.centroids),
    K: result.K,
    dim: result.dim,
    assignments: Array.from(result.assignments),
    entryCount,
    builtAt
  }
  return JSON.stringify(state)
}

/**
 * 从 vec_meta 的 JSON 字符串反序列化 IVF 状态。
 * 返回 IvfBuildResult（centroids 为 Float32Array）+ entryCount + builtAt。
 * 损坏/格式不正确返回 null。
 */
export function deserializeIvfState(
  json: string
): (IvfBuildResult & { entryCount: number; builtAt: number }) | null {
  try {
    const parsed = JSON.parse(json) as IvfState
    if (
      typeof parsed.centroids !== 'string' ||
      typeof parsed.K !== 'number' ||
      typeof parsed.dim !== 'number' ||
      !Array.isArray(parsed.assignments) ||
      typeof parsed.entryCount !== 'number' ||
      typeof parsed.builtAt !== 'number'
    ) {
      return null
    }
    const centroids = base64ToFloat32(parsed.centroids)
    if (centroids.length !== parsed.K * parsed.dim) return null
    return {
      centroids,
      assignments: Int32Array.from(parsed.assignments),
      K: parsed.K,
      dim: parsed.dim,
      entryCount: parsed.entryCount,
      builtAt: parsed.builtAt
    }
  } catch {
    return null
  }
}

/** Float32Array -> base64 字符串 */
function bufferToBase64(arr: Float32Array): string {
  // 拷贝到独立 Buffer（不共享底层内存）
  const buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
  return buf.toString('base64')
}

/** base64 字符串 -> Float32Array */
function base64ToFloat32(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64')
  // 拷贝到 4 字节对齐的新 ArrayBuffer（同 sqlite-vector-store decode）
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  return new Float32Array(ab)
}
