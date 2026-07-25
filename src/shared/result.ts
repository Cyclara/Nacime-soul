// src/shared/result.ts
// 通用 Result 类型（用于非 IPC 操作结果）
// IPC 结果用 IpcResult（见 ipc/contracts.ts）

export type Result<T, E = Error> = { ok: true; data: T } | { ok: false; error: E }

export function ok<T>(data: T): Result<T, never> {
  return { ok: true, data }
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error }
}

export function isOk<T, E>(result: Result<T, E>): result is { ok: true; data: T } {
  return result.ok
}

export function isErr<T, E>(result: Result<T, E>): result is { ok: false; error: E } {
  return !result.ok
}
