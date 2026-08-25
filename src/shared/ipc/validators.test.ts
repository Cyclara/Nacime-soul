// src/shared/ipc/validators.test.ts
// P2-45：共享 validators 直接单测（isUndefined/isString/isNumber/isId/isUrlString/
//   validatePartialFields + 4 个 event 通道 validator + validateEventPayload 兜底）。
// 依据 S-004-补充 §3.3：每 validator 的接受/拒绝/边界三组，关键模块 100% branch。
import { describe, it, expect } from 'vitest'
import {
  isUndefined,
  isString,
  isNumber,
  isBoolean,
  isPlainObject,
  hasOnlyKeys,
  isId,
  isUrlString,
  validatePartialFields,
  validateEventPayload
} from './validators'

describe('P2-45 shared helper validators（接受/拒绝/边界）', () => {
  describe('isUndefined', () => {
    it('undefined 通过，其他拒绝', () => {
      expect(isUndefined(undefined)).toBe(true)
      expect(isUndefined(null)).toBe(false)
      expect(isUndefined('x')).toBe(false)
      expect(isUndefined(0)).toBe(false)
    })
  })

  describe('isString', () => {
    it('普通字符串通过', () => {
      expect(isString('hello')).toBe(true)
      expect(isString('')).toBe(true) // 无 minLen 时空串通过
    })
    it('非字符串拒绝', () => {
      expect(isString(123)).toBe(false)
      expect(isString(null)).toBe(false)
    })
    it('minLen 边界', () => {
      expect(isString('ab', { minLen: 2 })).toBe(true)
      expect(isString('a', { minLen: 2 })).toBe(false)
    })
    it('maxLen 边界', () => {
      expect(isString('abc', { maxLen: 3 })).toBe(true)
      expect(isString('abcd', { maxLen: 3 })).toBe(false)
    })
  })

  describe('isNumber', () => {
    it('普通数字通过，非数字/NaN/Infinity 拒绝', () => {
      expect(isNumber(1)).toBe(true)
      expect(isNumber(0)).toBe(true)
      expect(isNumber(NaN)).toBe(false)
      expect(isNumber(Infinity)).toBe(false)
      expect(isNumber('1')).toBe(false)
    })
    it('integer 选项', () => {
      expect(isNumber(3, { integer: true })).toBe(true)
      expect(isNumber(3.5, { integer: true })).toBe(false)
    })
    it('min/max 边界', () => {
      expect(isNumber(5, { min: 5 })).toBe(true)
      expect(isNumber(4, { min: 5 })).toBe(false)
      expect(isNumber(5, { max: 5 })).toBe(true)
      expect(isNumber(6, { max: 5 })).toBe(false)
    })
  })

  describe('isBoolean / isPlainObject / hasOnlyKeys', () => {
    it('isBoolean', () => {
      expect(isBoolean(true)).toBe(true)
      expect(isBoolean(false)).toBe(true)
      expect(isBoolean(1)).toBe(false)
    })
    it('isPlainObject', () => {
      expect(isPlainObject({})).toBe(true)
      expect(isPlainObject(null)).toBe(false)
      expect(isPlainObject([])).toBe(false)
      expect(isPlainObject('x')).toBe(false)
    })
    it('hasOnlyKeys', () => {
      expect(hasOnlyKeys({ a: 1 }, ['a'])).toBe(true)
      expect(hasOnlyKeys({ a: 1, b: 2 }, ['a'])).toBe(false)
      expect(hasOnlyKeys({}, ['a'])).toBe(true)
    })
  })

  describe('isId', () => {
    it('合法 ID 通过（字母数字._:-）', () => {
      expect(isId('sess_01JG.test:abc-123')).toBe(true)
      expect(isId('a')).toBe(true)
    })
    it('空串/超长拒绝', () => {
      expect(isId('')).toBe(false)
      expect(isId('x'.repeat(201))).toBe(false)
    })
    it('非法字符拒绝（空格/中文/符号）', () => {
      expect(isId('has space')).toBe(false)
      expect(isId('中文')).toBe(false)
      expect(isId('a/b')).toBe(false)
      expect(isId(123)).toBe(false)
    })
    it('maxLen 选项', () => {
      expect(isId('ab', { maxLen: 2 })).toBe(true)
      expect(isId('abc', { maxLen: 2 })).toBe(false)
    })
  })

  describe('isUrlString', () => {
    it('合法 URL 通过', () => {
      expect(isUrlString('https://api.example.com/v1')).toBe(true)
    })
    it('非法 URL / 非字符串拒绝', () => {
      expect(isUrlString('not-a-url')).toBe(false)
      expect(isUrlString('')).toBe(false)
      expect(isUrlString(123)).toBe(false)
    })
  })

  describe('validatePartialFields', () => {
    const validators = { a: (v: unknown) => isNumber(v), b: (v: unknown) => isBoolean(v) }
    it('合法 partial 通过', () => {
      expect(validatePartialFields({ a: 1 }, validators)).toBe(true)
      expect(validatePartialFields({}, validators)).toBe(true)
      expect(validatePartialFields({ a: 1, b: true }, validators)).toBe(true)
    })
    it('非对象拒绝', () => {
      expect(validatePartialFields(null, validators)).toBe(false)
      expect(validatePartialFields([], validators)).toBe(false)
      expect(validatePartialFields('x', validators)).toBe(false)
    })
    it('多余字段拒绝', () => {
      expect(validatePartialFields({ a: 1, extra: 2 }, validators)).toBe(false)
    })
    it('字段值不合法拒绝', () => {
      expect(validatePartialFields({ a: 'x' }, validators)).toBe(false)
      expect(validatePartialFields({ b: 1 }, validators)).toBe(false)
    })
  })
})

// === event 通道 validator ===

describe('P2-45 shared event validator（接受/拒绝/边界）', () => {
  describe('chat-stream: isIpcErrorLike（failed.error 用）', () => {
    it('合法 error（无 requestId）通过', () => {
      expect(
        validateEventPayload('companion:event:chat-stream', {
          type: 'failed',
          requestId: 'req_1',
          sequence: 1,
          error: { code: 'LLM_AUTH', message: '认证失败', retryable: false }
        })
      ).toBe(true)
    })
    it('合法 error（含 requestId）通过', () => {
      expect(
        validateEventPayload('companion:event:chat-stream', {
          type: 'failed',
          requestId: 'req_1',
          sequence: 1,
          error: { code: 'X', message: 'm', retryable: false, requestId: 'req_0' }
        })
      ).toBe(true)
    })
    it('requestId 非字符串拒绝', () => {
      expect(
        validateEventPayload('companion:event:chat-stream', {
          type: 'failed',
          requestId: 'req_1',
          sequence: 1,
          error: { code: 'X', message: 'm', retryable: false, requestId: 123 }
        })
      ).toBe(false)
    })
    it('retryable 非布尔拒绝', () => {
      expect(
        validateEventPayload('companion:event:chat-stream', {
          type: 'failed',
          requestId: 'req_1',
          sequence: 1,
          error: { code: 'X', message: 'm', retryable: 'yes' }
        })
      ).toBe(false)
    })
    it('多余字段拒绝', () => {
      expect(
        validateEventPayload('companion:event:chat-stream', {
          type: 'failed',
          requestId: 'req_1',
          sequence: 1,
          error: { code: 'X', message: 'm', retryable: false, extra: 1 }
        })
      ).toBe(false)
    })
    it('code/message 非字符串拒绝', () => {
      expect(
        validateEventPayload('companion:event:chat-stream', {
          type: 'failed',
          requestId: 'req_1',
          sequence: 1,
          error: { code: 1, message: 'm', retryable: false }
        })
      ).toBe(false)
      expect(
        validateEventPayload('companion:event:chat-stream', {
          type: 'failed',
          requestId: 'req_1',
          sequence: 1,
          error: { code: 'X', message: 2, retryable: false }
        })
      ).toBe(false)
    })
    it('error 非对象拒绝', () => {
      expect(
        validateEventPayload('companion:event:chat-stream', {
          type: 'failed',
          requestId: 'req_1',
          sequence: 1,
          error: 'not-an-object'
        })
      ).toBe(false)
      expect(
        validateEventPayload('companion:event:chat-stream', {
          type: 'failed',
          requestId: 'req_1',
          sequence: 1,
          error: null
        })
      ).toBe(false)
    })
  })

  describe('chat-stream: 各事件非法分支', () => {
    it('非对象拒绝', () => {
      expect(validateEventPayload('companion:event:chat-stream', 'chunk')).toBe(false)
      expect(validateEventPayload('companion:event:chat-stream', null)).toBe(false)
    })
    it('type 非字符串拒绝', () => {
      expect(validateEventPayload('companion:event:chat-stream', { type: 1, requestId: 'r' })).toBe(
        false
      )
    })
    it('started 多余字段拒绝', () => {
      expect(
        validateEventPayload('companion:event:chat-stream', {
          type: 'started',
          requestId: 'r',
          sessionId: 's',
          assistantMessageId: 'a',
          sequence: 0,
          extra: 1
        })
      ).toBe(false)
    })
    it('started 缺字段拒绝（requestId 非法）', () => {
      expect(
        validateEventPayload('companion:event:chat-stream', {
          type: 'started',
          requestId: 'bad request',
          sessionId: 's',
          assistantMessageId: 'a',
          sequence: 0
        })
      ).toBe(false)
    })
    it('chunk: requestId/sequence/delta 非法拒绝', () => {
      expect(
        validateEventPayload('companion:event:chat-stream', {
          type: 'chunk',
          requestId: 'bad request',
          sequence: 1,
          delta: 'x'
        })
      ).toBe(false)
      expect(
        validateEventPayload('companion:event:chat-stream', {
          type: 'chunk',
          requestId: 'r',
          sequence: -1,
          delta: 'x'
        })
      ).toBe(false)
      expect(
        validateEventPayload('companion:event:chat-stream', {
          type: 'chunk',
          requestId: 'r',
          sequence: 1,
          delta: 123
        })
      ).toBe(false)
    })
    it('completed: requestId/sequence 非法拒绝', () => {
      expect(
        validateEventPayload('companion:event:chat-stream', {
          type: 'completed',
          requestId: 'bad request',
          sequence: 1
        })
      ).toBe(false)
      expect(
        validateEventPayload('companion:event:chat-stream', {
          type: 'completed',
          requestId: 'r',
          sequence: 1.5
        })
      ).toBe(false)
    })
    it('completed: 缺字段（hasOnlyKeys 假分支）拒绝', () => {
      expect(
        validateEventPayload('companion:event:chat-stream', {
          type: 'completed',
          requestId: 'r'
          // 缺 sequence
        })
      ).toBe(false)
      expect(
        validateEventPayload('companion:event:chat-stream', {
          type: 'completed',
          requestId: 'r',
          sequence: 1,
          usage: { inputTokens: 1 },
          extra: 'x'
        })
      ).toBe(false)
    })
    it('completed: 合法（含 usage）通过', () => {
      expect(
        validateEventPayload('companion:event:chat-stream', {
          type: 'completed',
          requestId: 'r',
          sequence: 1,
          usage: { inputTokens: 10, outputTokens: 5 }
        })
      ).toBe(true)
    })
    it('未知 type 拒绝（switch default 分支）', () => {
      expect(
        validateEventPayload('companion:event:chat-stream', {
          type: 'evil',
          requestId: 'r',
          sequence: 1
        })
      ).toBe(false)
    })
    it('completed: usage 非法拒绝（非对象/多余字段/值非法）', () => {
      const base = { type: 'completed', requestId: 'r', sequence: 1 }
      expect(validateEventPayload('companion:event:chat-stream', { ...base, usage: 'x' })).toBe(
        false
      )
      expect(
        validateEventPayload('companion:event:chat-stream', {
          ...base,
          usage: { inputTokens: 1, outputTokens: 2, extra: 3 }
        })
      ).toBe(false)
      expect(
        validateEventPayload('companion:event:chat-stream', {
          ...base,
          usage: { inputTokens: -1, outputTokens: 2 }
        })
      ).toBe(false)
      expect(
        validateEventPayload('companion:event:chat-stream', {
          ...base,
          usage: { inputTokens: 1, outputTokens: 2.5 }
        })
      ).toBe(false)
    })
    it('failed: 多余字段拒绝', () => {
      expect(
        validateEventPayload('companion:event:chat-stream', {
          type: 'failed',
          requestId: 'r',
          sequence: 1,
          error: { code: 'X', message: 'm', retryable: false },
          extra: 1
        })
      ).toBe(false)
    })
    it('cancelled: requestId/sequence 非法 + 多余字段拒绝', () => {
      expect(
        validateEventPayload('companion:event:chat-stream', {
          type: 'cancelled',
          requestId: 'bad request',
          sequence: 1
        })
      ).toBe(false)
      expect(
        validateEventPayload('companion:event:chat-stream', {
          type: 'cancelled',
          requestId: 'r',
          sequence: 1.5
        })
      ).toBe(false)
      expect(
        validateEventPayload('companion:event:chat-stream', {
          type: 'cancelled',
          requestId: 'r',
          sequence: 1,
          extra: 1
        })
      ).toBe(false)
    })
  })

  describe('app-error', () => {
    it('合法 PublicAppError 通过', () => {
      expect(
        validateEventPayload('companion:event:app-error', {
          code: 'LLM_AUTH',
          message: '认证失败',
          severity: 'fatal',
          retryable: false
        })
      ).toBe(true)
    })
    it('非对象拒绝', () => {
      expect(validateEventPayload('companion:event:app-error', null)).toBe(false)
    })
    it('code/message 非字符串拒绝', () => {
      expect(
        validateEventPayload('companion:event:app-error', {
          code: 1,
          message: 'm',
          severity: 'error',
          retryable: false
        })
      ).toBe(false)
      expect(
        validateEventPayload('companion:event:app-error', {
          code: 'X',
          message: 2,
          severity: 'error',
          retryable: false
        })
      ).toBe(false)
    })
    it('retryable 非布尔拒绝', () => {
      expect(
        validateEventPayload('companion:event:app-error', {
          code: 'X',
          message: 'm',
          severity: 'error',
          retryable: 1
        })
      ).toBe(false)
    })
  })

  describe('window-state', () => {
    it('合法 payload 通过', () => {
      expect(validateEventPayload('companion:event:window-state', { maximized: true })).toBe(true)
    })
    it('非对象/非布尔拒绝', () => {
      expect(validateEventPayload('companion:event:window-state', null)).toBe(false)
      expect(validateEventPayload('companion:event:window-state', { maximized: 1 })).toBe(false)
      expect(
        validateEventPayload('companion:event:window-state', { maximized: true, extra: 1 })
      ).toBe(false)
    })
  })

  describe('memory-updated', () => {
    const base = { revision: 1, hint: 'l2', ts: 100 }
    it('合法通过', () => {
      expect(validateEventPayload('companion:event:memory-updated', base)).toBe(true)
    })
    it('非对象/多余字段拒绝', () => {
      expect(validateEventPayload('companion:event:memory-updated', null)).toBe(false)
      expect(validateEventPayload('companion:event:memory-updated', { ...base, extra: 1 })).toBe(
        false
      )
    })
    it('revision 非法拒绝', () => {
      expect(
        validateEventPayload('companion:event:memory-updated', { ...base, revision: -1 })
      ).toBe(false)
      expect(
        validateEventPayload('companion:event:memory-updated', { ...base, revision: 1.5 })
      ).toBe(false)
    })
    it('hint 非白名单拒绝', () => {
      expect(
        validateEventPayload('companion:event:memory-updated', { ...base, hint: 'evil' })
      ).toBe(false)
    })
    it('ts 非法拒绝', () => {
      expect(validateEventPayload('companion:event:memory-updated', { ...base, ts: -1 })).toBe(
        false
      )
    })
  })

  describe('M-50 update-status', () => {
    it('全部 7 个状态的合法载荷通过', () => {
      expect(validateEventPayload('companion:event:update-status', { state: 'idle' })).toBe(true)
      expect(
        validateEventPayload('companion:event:update-status', {
          state: 'checking',
          userInitiated: true
        })
      ).toBe(true)
      expect(
        validateEventPayload('companion:event:update-status', {
          state: 'available',
          version: '1.1.0'
        })
      ).toBe(true)
      expect(
        validateEventPayload('companion:event:update-status', {
          state: 'not-available',
          userInitiated: false
        })
      ).toBe(true)
      expect(
        validateEventPayload('companion:event:update-status', {
          state: 'downloading',
          version: '1.1.0',
          percent: 55
        })
      ).toBe(true)
      expect(
        validateEventPayload('companion:event:update-status', {
          state: 'downloaded',
          version: '1.1.0'
        })
      ).toBe(true)
      expect(
        validateEventPayload('companion:event:update-status', {
          state: 'error',
          message: '后台更新检查失败',
          userInitiated: false
        })
      ).toBe(true)
    })
    it('未知状态/多余字段/缺字段拒绝', () => {
      expect(validateEventPayload('companion:event:update-status', { state: 'evil' })).toBe(false)
      expect(validateEventPayload('companion:event:update-status', null)).toBe(false)
      expect(
        validateEventPayload('companion:event:update-status', { state: 'idle', extra: 1 })
      ).toBe(false)
      expect(validateEventPayload('companion:event:update-status', { state: 'available' })).toBe(
        false
      )
      expect(
        validateEventPayload('companion:event:update-status', {
          state: 'checking',
          userInitiated: 'yes'
        })
      ).toBe(false)
    })
    it('downloading percent 越界 / error message 超长拒绝', () => {
      expect(
        validateEventPayload('companion:event:update-status', {
          state: 'downloading',
          version: '1.1.0',
          percent: 101
        })
      ).toBe(false)
      expect(
        validateEventPayload('companion:event:update-status', {
          state: 'downloading',
          version: '1.1.0',
          percent: -1
        })
      ).toBe(false)
      expect(
        validateEventPayload('companion:event:update-status', {
          state: 'error',
          message: 'x'.repeat(501),
          userInitiated: true
        })
      ).toBe(false)
    })
  })

  describe('validateEventPayload 未知通道兜底', () => {
    it('未知通道拒绝', () => {
      expect(validateEventPayload('companion:event:unknown' as never, {})).toBe(false)
    })
  })
})
