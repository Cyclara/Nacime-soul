// src/shared/ipc/validators.ts
// IPC 校验工具函数 + event 通道 validator
// 依据：S-003 §3.5/§3.6/§3.7
//
// 设计要点：
//   1. 此文件放 shared：preload 和 main 都需要 event validator（S-003 §3.7）
//      preload 无法 import main 模块，所以 event validator 必须在 shared
//   2. 纯函数，不依赖 electron 或 main-only 模块
//   3. helper 函数同时被 main 的 invoke validator 复用（main/ipc/validators.ts import）

import type { IpcEventChannel } from './channels'
import type { IpcEventMap } from './contracts'
import type { MemoryUpdatedEvent } from '../memory/types'
import type { UpdateStatus } from '../update/types'

// === 工具函数（main 的 invoke validator 也复用）===

export function isUndefined(value: unknown): value is undefined {
  return value === undefined
}

export function isString(
  value: unknown,
  opts?: { minLen?: number; maxLen?: number }
): value is string {
  if (typeof value !== 'string') return false
  if (opts?.minLen !== undefined && value.length < opts.minLen) return false
  if (opts?.maxLen !== undefined && value.length > opts.maxLen) return false
  return true
}

export function isNumber(
  value: unknown,
  opts?: { min?: number; max?: number; integer?: boolean }
): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false
  if (opts?.integer && !Number.isInteger(value)) return false
  if (opts?.min !== undefined && value < opts.min) return false
  if (opts?.max !== undefined && value > opts.max) return false
  return true
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

/** 检查值是纯对象（非 null、非数组）。依据 S-003 §3.5 "对象非 null/非数组" */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 检查对象只有指定的 key。依据 S-003 §3.5 "hasOnlyKeys() 拒绝多余字段" */
export function hasOnlyKeys(obj: Record<string, unknown>, allowedKeys: string[]): boolean {
  const objKeys = Object.keys(obj)
  return objKeys.every((k) => allowedKeys.includes(k))
}

/**
 * SessionId / RequestId / MessageId 格式校验。
 * 依据 S-003 §3.5：^[A-Za-z0-9._:-]+$，1..200 字符
 */
export function isId(value: unknown, opts?: { maxLen?: number }): value is string {
  if (typeof value !== 'string') return false
  const maxLen = opts?.maxLen ?? 200
  if (value.length < 1 || value.length > maxLen) return false
  return /^[A-Za-z0-9._:-]+$/.test(value)
}

/** URL 校验：必须是有效 URL。协议由调用方检查 */
export function isUrlString(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

/**
 * 验证 partial 对象：只检查存在的字段，拒绝多余字段。
 * 用于 ConfigUpdateRequest.domains 内的各域（Partial<...>）。
 */
export function validatePartialFields(
  value: unknown,
  fieldValidators: Record<string, (v: unknown) => boolean>
): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false
  const allowedKeys = Object.keys(fieldValidators)
  if (!hasOnlyKeys(value, allowedKeys)) return false
  for (const [key, validator] of Object.entries(fieldValidators)) {
    if (key in value && !validator(value[key])) return false
  }
  return true
}

// === event 通道 validator（preload 的 typedSubscribe 使用）===

/** IpcError 结构验证（ChatStreamEvent.failed.error 用） */
function isIpcErrorLike(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['code', 'message', 'retryable', 'requestId'])) return false
  if (typeof value.code !== 'string') return false
  if (typeof value.message !== 'string') return false
  if (typeof value.retryable !== 'boolean') return false
  if ('requestId' in value && value.requestId !== undefined) {
    if (typeof value.requestId !== 'string') return false
  }
  return true
}

/** ChatStreamEvent 联合类型验证。依据 S-003 §3.8 */
function isChatStreamEvent(value: unknown): value is IpcEventMap['companion:event:chat-stream'] {
  if (!isPlainObject(value)) return false
  if (typeof value.type !== 'string') return false
  switch (value.type) {
    case 'started':
      if (
        !hasOnlyKeys(value, ['type', 'requestId', 'sessionId', 'assistantMessageId', 'sequence'])
      ) {
        return false
      }
      return (
        isId(value.requestId) &&
        isId(value.sessionId) &&
        isId(value.assistantMessageId) &&
        value.sequence === 0
      )
    case 'chunk':
    case 'reasoning':
      if (!hasOnlyKeys(value, ['type', 'requestId', 'sequence', 'delta'])) return false
      return (
        isId(value.requestId) &&
        isNumber(value.sequence, { min: 0, integer: true }) &&
        typeof value.delta === 'string'
      )
    case 'completed':
      if (!hasOnlyKeys(value, ['type', 'requestId', 'sequence', 'usage'])) return false
      if (!isId(value.requestId)) return false
      if (!isNumber(value.sequence, { min: 0, integer: true })) return false
      if ('usage' in value && value.usage !== undefined) {
        if (!isPlainObject(value.usage)) return false
        if (!hasOnlyKeys(value.usage, ['inputTokens', 'outputTokens'])) return false
        if (!isNumber(value.usage.inputTokens, { min: 0, integer: true })) return false
        if (!isNumber(value.usage.outputTokens, { min: 0, integer: true })) return false
      }
      return true
    case 'failed':
      if (!hasOnlyKeys(value, ['type', 'requestId', 'sequence', 'error'])) return false
      return (
        isId(value.requestId) &&
        isNumber(value.sequence, { min: 0, integer: true }) &&
        isIpcErrorLike(value.error)
      )
    case 'cancelled':
      if (!hasOnlyKeys(value, ['type', 'requestId', 'sequence'])) return false
      return isId(value.requestId) && isNumber(value.sequence, { min: 0, integer: true })
    default:
      return false
  }
}

/** PublicAppError 验证 */
function isPublicAppError(value: unknown): value is IpcEventMap['companion:event:app-error'] {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['code', 'message', 'severity', 'retryable'])) return false
  if (typeof value.code !== 'string') return false
  if (typeof value.message !== 'string') return false
  if (value.severity !== 'fatal' && value.severity !== 'error' && value.severity !== 'warn') {
    return false
  }
  if (typeof value.retryable !== 'boolean') return false
  return true
}

/** window-state payload 验证 */
function isWindowStatePayload(
  value: unknown
): value is IpcEventMap['companion:event:window-state'] {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['maximized'])) return false
  if (typeof value.maximized !== 'boolean') return false
  return true
}

const MEMORY_HINTS = new Set(['l0', 'l1', 'l2', 'dmae', 'growth', 'bulk'])

/** MemoryUpdatedEvent 验证。依据 S-003-补充 §3.2、S-022 §1.4 */
function isMemoryUpdatedEvent(value: unknown): value is MemoryUpdatedEvent {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['revision', 'hint', 'ts'])) return false
  if (!isNumber(value.revision, { min: 0, integer: true })) return false
  if (typeof value.hint !== 'string' || !MEMORY_HINTS.has(value.hint)) return false
  if (!isNumber(value.ts, { min: 0, integer: true })) return false
  return true
}

/** M-50：UpdateStatus 联合验证（companion:event:update-status 载荷） */
function isUpdateStatus(value: unknown): value is UpdateStatus {
  if (!isPlainObject(value)) return false
  if (typeof value.state !== 'string') return false
  switch (value.state) {
    case 'idle':
      return hasOnlyKeys(value, ['state'])
    case 'checking':
    case 'not-available':
      return hasOnlyKeys(value, ['state', 'userInitiated']) && isBoolean(value.userInitiated)
    case 'available':
    case 'downloaded':
      return hasOnlyKeys(value, ['state', 'version']) && isString(value.version, { minLen: 1 })
    case 'downloading':
      return (
        hasOnlyKeys(value, ['state', 'version', 'percent']) &&
        isString(value.version, { minLen: 1 }) &&
        isNumber(value.percent, { min: 0, max: 100 })
      )
    case 'error':
      return (
        hasOnlyKeys(value, ['state', 'message', 'userInitiated']) &&
        isString(value.message, { minLen: 1, maxLen: 500 }) &&
        isBoolean(value.userInitiated)
      )
    default:
      return false
  }
}

/**
 * 校验 event 通道 payload。
 * 依据 S-003 §3.7：subscribe 中的 validateEventPayload。
 * preload 的 typedSubscribe 调用此函数验证 main->renderer 事件载荷（纵深防御）。
 */
export function validateEventPayload<K extends IpcEventChannel>(
  channel: K,
  payload: unknown
): payload is IpcEventMap[K] {
  switch (channel) {
    case 'companion:event:chat-stream':
      return isChatStreamEvent(payload)
    case 'companion:event:app-error':
      return isPublicAppError(payload)
    case 'companion:event:window-state':
      return isWindowStatePayload(payload)
    case 'companion:event:memory-updated':
      return isMemoryUpdatedEvent(payload)
    case 'companion:event:update-status':
      return isUpdateStatus(payload)
    default:
      return false
  }
}
