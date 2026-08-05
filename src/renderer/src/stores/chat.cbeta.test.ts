// @vitest-environment jsdom
// C-β：chat store 会话恢复、订阅幂等、发送锁与 started 幂等回归测试。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from './chat'
import type { ChatSendAck, ChatStreamEvent } from '@shared/chat/types'
import type { IpcResult } from '@shared/ipc/contracts'

type StreamCallback = (event: ChatStreamEvent) => void

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function setupChatApi(): {
  chat: Record<string, ReturnType<typeof vi.fn>>
  emit: (event: ChatStreamEvent) => void
  listenerCount: () => number
} {
  const listeners = new Set<StreamCallback>()
  const chat = {
    createSession: vi.fn(async () => ({ ok: true, data: { sessionId: 'created-session' } })),
    // P2-43 默认模拟空库；需要恢复的测试单独 override
    getLastSession: vi.fn(async () => ({ ok: true, data: { sessionId: null } })),
    list: vi.fn(async ({ sessionId }: { sessionId: string }) => ({
      ok: true,
      data: { sessionId, messages: [] }
    })),
    send: vi.fn(),
    cancel: vi.fn(async () => ({ ok: true, data: undefined })),
    retry: vi.fn(async () => ({ ok: true, data: { requestId: 'retry-request' } })),
    onStream: vi.fn((cb: StreamCallback) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    })
  }

  ;(window as unknown as { companion: unknown }).companion = { chat }
  return {
    chat,
    emit(event) {
      for (const listener of [...listeners]) listener(event)
    },
    listenerCount: () => listeners.size
  }
}

describe('C-β chat store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('hydrate() 复用已有 sessionId，不新建会话，并刷新 messages', async () => {
    const { chat } = setupChatApi()
    chat.list.mockResolvedValue({
      ok: true,
      data: {
        sessionId: 'session-existing',
        messages: [
          {
            id: 'm1',
            role: 'user',
            content: '旧会话消息',
            createdAt: 1,
            status: 'complete'
          }
        ]
      }
    })
    const store = useChatStore()
    store.state.sessionId = 'session-existing'

    await store.hydrate()

    expect(chat.getLastSession).not.toHaveBeenCalled()
    expect(chat.createSession).not.toHaveBeenCalled()
    expect(chat.list).toHaveBeenCalledWith({ sessionId: 'session-existing', limit: 500 })
    expect(store.state.messages.map((m) => m.id)).toEqual(['m1'])
  })

  it('P2-43 hydrate() 无 renderer session 时恢复 main 最近会话，不新建', async () => {
    const { chat } = setupChatApi()
    chat.getLastSession.mockResolvedValue({
      ok: true,
      data: { sessionId: 'persisted-session' }
    })
    chat.list.mockResolvedValue({
      ok: true,
      data: {
        sessionId: 'persisted-session',
        messages: [
          {
            id: 'persisted-message',
            role: 'assistant',
            content: '跨重启历史',
            createdAt: 1,
            status: 'complete'
          }
        ]
      }
    })
    const store = useChatStore()

    await store.hydrate()

    expect(chat.getLastSession).toHaveBeenCalledTimes(1)
    expect(chat.createSession).not.toHaveBeenCalled()
    expect(chat.list).toHaveBeenCalledWith({ sessionId: 'persisted-session', limit: 500 })
    expect(store.state.sessionId).toBe('persisted-session')
    expect(store.state.messages.map((m) => m.id)).toEqual(['persisted-message'])
  })

  it('P2-43 hydrate() main 空库返回 null 时才 createSession', async () => {
    const { chat } = setupChatApi()
    const store = useChatStore()

    await store.hydrate()

    expect(chat.getLastSession).toHaveBeenCalledTimes(1)
    expect(chat.createSession).toHaveBeenCalledTimes(1)
    expect(chat.list).toHaveBeenCalledWith({ sessionId: 'created-session', limit: 500 })
    expect(store.state.sessionId).toBe('created-session')
  })

  it('P2-43 hydrate() 查询最近会话失败时不伪装空库、不创建新会话', async () => {
    const { chat } = setupChatApi()
    chat.getLastSession.mockResolvedValue({
      ok: false,
      error: { code: 'IPC_INTERNAL', message: '查询失败', retryable: true }
    })
    const store = useChatStore()

    await store.hydrate()

    expect(chat.getLastSession).toHaveBeenCalledTimes(1)
    expect(chat.createSession).not.toHaveBeenCalled()
    expect(chat.list).not.toHaveBeenCalled()
    expect(store.state.sessionId).toBeNull()
    expect(store.state.isHydrating).toBe(false)
  })

  it('subscribe() 重复调用只保留一个 listener；旧 teardown 不拆新订阅；当前 teardown 后不再更新', () => {
    const { emit, listenerCount } = setupChatApi()
    const store = useChatStore()

    const teardown1 = store.subscribe()
    const teardown2 = store.subscribe()
    expect(listenerCount()).toBe(1)

    teardown1()
    expect(listenerCount()).toBe(1)

    emit({
      type: 'started',
      requestId: 'r1',
      sessionId: 's1',
      assistantMessageId: 'a1',
      sequence: 0
    })
    expect(store.state.messages.map((m) => m.id)).toEqual(['a1'])

    teardown2()
    expect(listenerCount()).toBe(0)
    emit({ type: 'chunk', requestId: 'r1', sequence: 1, delta: '不应写入' })
    expect(store.state.messages[0].content).toBe('')
  })

  it('同一 started 事件重复投递只创建一个 assistant placeholder', () => {
    setupChatApi()
    const store = useChatStore()
    const started: ChatStreamEvent = {
      type: 'started',
      requestId: 'r1',
      sessionId: 's1',
      assistantMessageId: 'a1',
      sequence: 0
    }

    store.applyStream(started)
    store.applyStream(started)

    expect(store.state.messages.filter((m) => m.id === 'a1')).toHaveLength(1)
  })

  it('ACK 在途时发送锁同步置位：即使重新输入草稿，同步第二次 send 也不发 IPC', async () => {
    const { chat } = setupChatApi()
    const pending = deferred<IpcResult<ChatSendAck>>()
    chat.send.mockReturnValue(pending.promise)
    const store = useChatStore()
    store.state.sessionId = 's1'
    store.setDraft('第一条')

    const first = store.send()
    store.setDraft('第二条')
    const second = store.send()

    expect(chat.send).toHaveBeenCalledTimes(1)
    expect(store.canSend).toBe(false)

    pending.resolve({ ok: true, data: { requestId: 'r1', userMessageId: 'u1' } })
    await Promise.all([first, second])
  })

  it('send 返回业务失败后释放发送锁，下一次发送可正常发出', async () => {
    const { chat } = setupChatApi()
    chat.send
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'LLM_AUTH', message: '认证失败', retryable: false }
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { requestId: 'r2', userMessageId: 'u2' }
      })
    const store = useChatStore()
    store.state.sessionId = 's1'
    store.setDraft('第一次')

    await store.send()
    expect(store.state.draft).toBe('第一次')

    store.setDraft('第二次')
    expect(store.canSend).toBe(true)
    await store.send()

    expect(chat.send).toHaveBeenCalledTimes(2)
  })
})
