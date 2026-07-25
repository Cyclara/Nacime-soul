// @vitest-environment jsdom
// src/renderer/src/stores/chat.integration.test.ts
// P1-26: Chat 流式集成测试
// 依据: S-004 #36 "E2E：启动→输入→Faux 流式回复→完成"
//       S-004 合同门禁 #6 "首次体验 E2E"
//
// 本测试在 jsdom 环境下模拟完整聊天流，不依赖真实 Electron。
// Playwright Electron E2E 测试见 tests/e2e/.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useChatStore } from './chat'
import type { ChatStreamEvent, ChatSendAck } from '@shared/chat/types'
import type { IpcResult } from '@shared/ipc/contracts'

// === 构建 fake companion API ===

type StreamCallback = (event: ChatStreamEvent) => void

function createFakeCompanion(): {
  chat: {
    list: ReturnType<typeof vi.fn>
    createSession: ReturnType<typeof vi.fn>
    send: ReturnType<typeof vi.fn>
    cancel: ReturnType<typeof vi.fn>
    retry: ReturnType<typeof vi.fn>
    onStream: ReturnType<typeof vi.fn>
  }
  _getStreamCb: () => StreamCallback | null
} {
  let streamCallback: StreamCallback | null = null

  return {
    chat: {
      list: vi.fn(),
      createSession: vi.fn(),
      send: vi.fn(),
      cancel: vi.fn(),
      retry: vi.fn(),
      onStream: vi.fn((cb: StreamCallback) => {
        streamCallback = cb
        return () => {
          streamCallback = null
        }
      })
    },
    /** 获取当前注册的 stream 回调，用于测试中模拟事件 */
    _getStreamCb(): StreamCallback | null {
      return streamCallback
    }
  }
}

// === 测试 ===

describe('Chat 流式集成 (E2E-simulated)', () => {
  let fake: ReturnType<typeof createFakeCompanion>

  beforeEach(() => {
    setActivePinia(createPinia())
    fake = createFakeCompanion()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).companion = fake
  })

  describe('完整发送→流式回复→完成', () => {
    it('正常流式聊天：发送→started→chunk→completed', async () => {
      const store = useChatStore()

      // 注册流式事件
      const unsubscribe = store.subscribe()
      store.state.sessionId = 'test-session'
      store.setDraft('你好')

      // 模拟 send 返回 ACK
      fake.chat.send.mockResolvedValue({
        ok: true,
        data: { requestId: 'req-1', userMessageId: 'msg-u1' }
      } satisfies IpcResult<ChatSendAck>)

      await store.send()

      // 用户消息已添加
      expect(store.state.messages.length).toBe(1)
      expect(store.state.messages[0].role).toBe('user')
      expect(store.state.messages[0].content).toBe('你好')

      // 草稿已清空
      expect(store.state.draft).toBe('')

      // 模拟流式事件
      const cb = fake._getStreamCb()
      expect(cb).not.toBeNull()

      const streamEvents: ChatStreamEvent[] = [
        {
          type: 'started',
          requestId: 'req-1',
          sessionId: 'test-session',
          assistantMessageId: 'msg-a1',
          sequence: 0
        },
        { type: 'chunk', requestId: 'req-1', sequence: 1, delta: '你好' },
        { type: 'chunk', requestId: 'req-1', sequence: 2, delta: '！' },
        {
          type: 'completed',
          requestId: 'req-1',
          sequence: 3,
          usage: { inputTokens: 10, outputTokens: 5 }
        }
      ]

      for (const event of streamEvents) {
        cb!(event)
      }

      // 助手消息已添加并完成
      expect(store.state.messages.length).toBe(2)
      expect(store.state.messages[1].role).toBe('assistant')
      expect(store.state.messages[1].content).toBe('你好！')
      expect(store.state.messages[1].status).toBe('complete')

      // activeTurn 已清除
      expect(store.state.activeTurn).toBeNull()
      expect(store.isStreaming).toBe(false)

      unsubscribe()
    })

    it('取消流式：发送→started→chunk→cancel', async () => {
      const store = useChatStore()
      const unsubscribe = store.subscribe()
      store.state.sessionId = 'test-session'
      store.setDraft('hello')

      fake.chat.send.mockResolvedValue({
        ok: true,
        data: { requestId: 'req-1', userMessageId: 'msg-u1' }
      } satisfies IpcResult<ChatSendAck>)

      await store.send()

      const cb = fake._getStreamCb()!

      cb({
        type: 'started',
        requestId: 'req-1',
        sessionId: 'test-session',
        assistantMessageId: 'msg-a1',
        sequence: 0
      })
      cb({ type: 'chunk', requestId: 'req-1', sequence: 1, delta: 'hel' })

      // 取消
      cb({ type: 'cancelled', requestId: 'req-1', sequence: 2 })

      expect(store.state.messages[1].status).toBe('cancelled')
      expect(store.state.activeTurn).toBeNull()

      unsubscribe()
    })

    it('流式失败：发送→started→chunk→failed', async () => {
      const store = useChatStore()
      const unsubscribe = store.subscribe()
      store.state.sessionId = 'test-session'
      store.setDraft('test')

      fake.chat.send.mockResolvedValue({
        ok: true,
        data: { requestId: 'req-1', userMessageId: 'msg-u1' }
      } satisfies IpcResult<ChatSendAck>)

      await store.send()

      const cb = fake._getStreamCb()!

      cb({
        type: 'started',
        requestId: 'req-1',
        sessionId: 'test-session',
        assistantMessageId: 'msg-a1',
        sequence: 0
      })
      cb({ type: 'chunk', requestId: 'req-1', sequence: 1, delta: 'partial' })

      cb({
        type: 'failed',
        requestId: 'req-1',
        sequence: 2,
        error: { code: 'LLM_SERVER', message: '服务器错误', retryable: true }
      })

      expect(store.state.messages[1].status).toBe('failed')
      expect(store.state.messages[1].errorCode).toBe('LLM_SERVER')
      expect(store.state.activeTurn).toBeNull()
      expect(store.state.lastError).not.toBeNull()

      unsubscribe()
    })
  })

  describe('发送失败回滚', () => {
    it('send 失败时移除乐观消息并恢复草稿', async () => {
      const store = useChatStore()
      store.state.sessionId = 'test-session'
      store.setDraft('will fail')

      fake.chat.send.mockResolvedValue({
        ok: false,
        error: { code: 'LLM_AUTH', message: 'API Key 无效', retryable: false }
      } satisfies IpcResult<ChatSendAck>)

      await store.send()

      // 乐观消息被移除
      expect(store.state.messages.length).toBe(0)
      // 草稿恢复
      expect(store.state.draft).toBe('will fail')
      // 错误信息保存
      expect(store.state.lastError).not.toBeNull()
      expect(store.state.lastError?.code).toBe('LLM_AUTH')
    })
  })

  describe('canSend 状态', () => {
    it('流式中 canSend=false', () => {
      const store = useChatStore()
      store.state.sessionId = 'test'
      store.setDraft('hello')
      store.state.activeTurn = {
        requestId: 'r1',
        assistantMessageId: 'a1',
        lastSequence: 0,
        startedAt: Date.now()
      }
      expect(store.canSend).toBe(false)
    })

    it('草稿为空时 canSend=false', () => {
      const store = useChatStore()
      store.state.sessionId = 'test'
      store.setDraft('')
      expect(store.canSend).toBe(false)
    })

    it('正常状态 canSend=true', () => {
      const store = useChatStore()
      store.state.sessionId = 'test'
      store.setDraft('hello')
      expect(store.canSend).toBe(true)
    })

    it('isHydrating 时 canSend=false', () => {
      const store = useChatStore()
      store.state.sessionId = 'test'
      store.setDraft('hello')
      store.state.isHydrating = true
      expect(store.canSend).toBe(false)
    })
  })
})
