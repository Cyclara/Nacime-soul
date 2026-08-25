// src/main/memory/vector/f16.ts
// Float16 编解码。签名现在定死，实现体是 Phase 4+ 的存储层迁移（F5-003 §3 预留扩展点）。
// Phase 2 向量以 f32 落盘；切到 f16 时零接口变更。

/** f32 数组 → f16 字节（2B/维）。舍入：round-to-nearest-even。【Phase 4 实现】 */
export function f32ToF16Bytes(vec: Float32Array): Uint8Array {
  void vec
  throw new Error('f16 encoding is a Phase 4+ storage migration; not implemented in Phase 2')
}

/** f16 字节 → f32 数组（计算路径永远用返回值）。【Phase 4 实现】 */
export function f16BytesToF32(bytes: Uint8Array, dim: number): Float32Array {
  void bytes
  void dim
  throw new Error('f16 decoding is a Phase 4+ storage migration; not implemented in Phase 2')
}
