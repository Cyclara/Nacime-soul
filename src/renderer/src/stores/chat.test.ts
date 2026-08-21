// @vitest-environment jsdom
// src/renderer/src/stores/chat.test.ts
// P1-24 chat store 测试
// 依据：S-004 #28-#30（旧 requestId 丢弃、重复/逆序 sequence 丢弃、completed/failed/cancelled 清 activeTurn）

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from './chat'

describe('chat store applyStream state machine', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  // S-004 #28: 旧 requestId chunk 被丢弃
  it('discards chunks with old requestId', () => {
    const store = useChatStore()

    // 正常 started
    store.applyStream({
      type: 'started',
      requestId: 'r1',
      sessionId: 's1',
      assistantMessageId: 'a1',
      sequence: 0
    })
    expect(store.state.activeTurn).not.toBeNull()
    expect(store.state.activeTurn!.requestId).toBe('r1')

    // 正常 chunk（r1）
    store.applyStream({
      type: 'chunk',
      requestId: 'r1',
      sequence: 1,
      delta: 'hello'
    })
    const assistantMsg = store.state.messages.find((m) => m.id === 'a1')
    expect(assistantMsg!.content).toBe('hello')

    // 旧 requestId 的 chunk -> 丢弃
    store.applyStream({
      type: 'chunk',
      requestId: 'old-request',
      sequence: 2,
      delta: 'should be discarded'
    })
    expect(assistantMsg!.content).toBe('hello') // 不变

    // 旧 requestId 的 completed -> 丢弃（不清 activeTurn）
    store.applyStream({
      type: 'completed',
      requestId: 'old-request',
      sequence: 3
    })
    expect(store.state.activeTurn).not.toBeNull() // 仍 active
  })

  // S-004 #29: 重复/逆序 sequence 被丢弃
  it('discards duplicate or reverse sequence chunks', () => {
    const store = useChatStore()

    store.applyStream({
      type: 'started',
      requestId: 'r1',
      sessionId: 's1',
      assistantMessageId: 'a1',
      sequence: 0
    })

    // seq=1 正常追加
    store.applyStream({ type: 'chunk', requestId: 'r1', sequence: 1, delta: 'A' })
    expect(store.state.messages.find((m) => m.id === 'a1')!.content).toBe('A')

    // seq=1 重复 -> 丢弃
    store.applyStream({ type: 'chunk', requestId: 'r1', sequence: 1, delta: 'B' })
    expect(store.state.messages.find((m) => m.id === 'a1')!.content).toBe('A')

    // seq=0 逆序 -> 丢弃
    store.applyStream({ type: 'chunk', requestId: 'r1', sequence: 0, delta: 'C' })
    expect(store.state.messages.find((m) => m.id === 'a1')!.content).toBe('A')

    // seq=2 正常追加
    store.applyStream({ type: 'chunk', requestId: 'r1', sequence: 2, delta: 'D' })
    expect(store.state.messages.find((m) => m.id === 'a1')!.content).toBe('AD')

    expect(store.state.activeTurn!.lastSequence).toBe(2)
  })

  // reasoning 事件：累积到 assistant 消息的 reasoning 字段，不影响 content
  it('appends reasoning delta to msg.reasoning, not content', () => {
    const store = useChatStore()

    store.applyStream({
      type: 'started',
      requestId: 'r1',
      sessionId: 's1',
      assistantMessageId: 'a1',
      sequence: 0
    })
    store.applyStream({ type: 'reasoning', requestId: 'r1', sequence: 1, delta: '先想' })
    store.applyStream({ type: 'reasoning', requestId: 'r1', sequence: 2, delta: '再想' })
    store.applyStream({ type: 'chunk', requestId: 'r1', sequence: 3, delta: '正文' })

    const msg = store.state.messages.find((m) => m.id === 'a1')
    expect(msg!.reasoning).toBe('先想再想')
    expect(msg!.content).toBe('正文')
  })

  it('discards out-of-order reasoning events (sequence <= lastSequence)', () => {
    const store = useChatStore()

    store.applyStream({
      type: 'started',
      requestId: 'r1',
      sessionId: 's1',
      assistantMessageId: 'a1',
      sequence: 0
    })
    store.applyStream({ type: 'reasoning', requestId: 'r1', sequence: 2, delta: 'B' })
    store.applyStream({ type: 'reasoning', requestId: 'r1', sequence: 1, delta: 'A' })

    const msg = store.state.messages.find((m) => m.id === 'a1')
    expect(msg!.reasoning).toBe('B')
  })

  it('preserves reasoning after completed', () => {
    const store = useChatStore()

    store.applyStream({
      type: 'started',
      requestId: 'r1',
      sessionId: 's1',
      assistantMessageId: 'a1',
      sequence: 0
    })
    store.applyStream({ type: 'reasoning', requestId: 'r1', sequence: 1, delta: '推理' })
    store.applyStream({ type: 'chunk', requestId: 'r1', sequence: 2, delta: '答复' })
    store.applyStream({ type: 'completed', requestId: 'r1', sequence: 3 })

    const msg = store.state.messages.find((m) => m.id === 'a1')
    expect(msg!.status).toBe('complete')
    expect(msg!.reasoning).toBe('推理')
    expect(msg!.content).toBe('答复')
  })

  // S-004 #30: completed/failed/cancelled 均清 activeTurn
  it('clears activeTurn on completed', () => {
    const store = useChatStore()

    store.applyStream({
      type: 'started',
      requestId: 'r1',
      sessionId: 's1',
      assistantMessageId: 'a1',
      sequence: 0
    })
    store.applyStream({ type: 'chunk', requestId: 'r1', sequence: 1, delta: 'text' })
    expect(store.state.activeTurn).not.toBeNull()

    store.applyStream({ type: 'completed', requestId: 'r1', sequence: 2 })
    expect(store.state.activeTurn).toBeNull()
    const msg = store.state.messages.find((m) => m.id === 'a1')
    expect(msg!.status).toBe('complete')
    expect(msg!.content).toBe('text')
  })

  it('clears activeTurn on failed', () => {
    const store = useChatStore()

    store.applyStream({
      type: 'started',
      requestId: 'r1',
      sessionId: 's1',
      assistantMessageId: 'a1',
      sequence: 0
    })
    store.applyStream({ type: 'chunk', requestId: 'r1', sequence: 1, delta: 'partial' })

    store.applyStream({
      type: 'failed',
      requestId: 'r1',
      sequence: 2,
      error: { code: 'LLM_SERVER', message: 'server error', retryable: true }
    })
    expect(store.state.activeTurn).toBeNull()
    const msg = store.state.messages.find((m) => m.id === 'a1')
    expect(msg!.status).toBe('failed')
    expect(msg!.errorCode).toBe('LLM_SERVER')
    expect(store.state.lastError).not.toBeNull()
    expect(store.state.lastError!.code).toBe('LLM_SERVER')
  })

  it('clears activeTurn on cancelled', () => {
    const store = useChatStore()

    store.applyStream({
      type: 'started',
      requestId: 'r1',
      sessionId: 's1',
      assistantMessageId: 'a1',
      sequence: 0
    })
    store.applyStream({ type: 'chunk', requestId: 'r1', sequence: 1, delta: 'partial' })

    store.applyStream({ type: 'cancelled', requestId: 'r1', sequence: 2 })
    expect(store.state.activeTurn).toBeNull()
    const msg = store.state.messages.find((m) => m.id === 'a1')
    expect(msg!.status).toBe('cancelled')
  })

  // canSend 计算属性
  it('canSend is false when draft is empty', () => {
    const store = useChatStore()
    store.setDraft('')
    expect(store.canSend).toBe(false)
  })

  it('canSend is false when streaming', () => {
    const store = useChatStore()
    store.setDraft('hello')
    expect(store.canSend).toBe(true)

    store.applyStream({
      type: 'started',
      requestId: 'r1',
      sessionId: 's1',
      assistantMessageId: 'a1',
      sequence: 0
    })
    expect(store.canSend).toBe(false)
  })

  it('canSend is true when draft has text and not streaming', () => {
    const store = useChatStore()
    store.setDraft('  hello  ')
    expect(store.canSend).toBe(true)
  })

  // started 添加 assistant 占位消息
  it('adds assistant placeholder message on started', () => {
    const store = useChatStore()
    const initialCount = store.state.messages.length

    store.applyStream({
      type: 'started',
      requestId: 'r1',
      sessionId: 's1',
      assistantMessageId: 'a1',
      sequence: 0
    })

    expect(store.state.messages.length).toBe(initialCount + 1)
    const msg = store.state.messages[store.state.messages.length - 1]
    expect(msg.role).toBe('assistant')
    expect(msg.content).toBe('')
    expect(msg.status).toBe('streaming')
  })

  // reset 清空所有状态
  it('reset clears all state', () => {
    const store = useChatStore()

    store.setDraft('hello')
    store.applyStream({
      type: 'started',
      requestId: 'r1',
      sessionId: 's1',
      assistantMessageId: 'a1',
      sequence: 0
    })

    store.reset()
    expect(store.state.sessionId).toBeNull()
    expect(store.state.messages).toEqual([])
    expect(store.state.draft).toBe('')
    expect(store.state.activeTurn).toBeNull()
  })
})

// 验收反馈④c：重试不增消息——终局事件摘除被取代的旧失败气泡
describe('chat store retry（验收反馈④c：终局摘除旧失败气泡）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    Object.defineProperty(window, 'companion', {
      value: {
        chat: {
          retry: vi.fn(async () => ({ ok: true, data: { requestId: 'r2' } }))
        }
      },
      writable: true,
      configurable: true
    })
  })

  function seedFailedTurn(store: ReturnType<typeof useChatStore>): void {
    store.state.sessionId = 's1'
    store.state.messages.push(
      { id: 'u1', role: 'user', content: '问', createdAt: 1, status: 'complete' },
      {
        id: 'a-old',
        role: 'assistant',
        content: '',
        createdAt: 2,
        status: 'failed',
        errorCode: 'NET_TIMEOUT'
      }
    )
  }

  it('completed 终局摘除旧失败气泡，列表只留 user + 新回答', async () => {
    const store = useChatStore()
    seedFailedTurn(store)

    await store.retry('a-old')
    expect(window.companion.chat.retry).toHaveBeenCalledWith({ sessionId: 's1', messageId: 'a-old' })

    store.applyStream({
      type: 'started',
      requestId: 'r2',
      sessionId: 's1',
      assistantMessageId: 'a-new',
      sequence: 0
    })
    store.applyStream({ type: 'chunk', requestId: 'r2', sequence: 1, delta: '答' })
    store.applyStream({ type: 'completed', requestId: 'r2', sequence: 2 })

    expect(store.state.messages.map((m) => m.id)).toEqual(['u1', 'a-new'])
    expect(store.state.messages[1].status).toBe('complete')
    expect(store.state.messages[1].content).toBe('答')
  })

  it('failed 终局同样摘除旧气泡（只剩最新失败气泡，可继续点重试）', async () => {
    const store = useChatStore()
    seedFailedTurn(store)

    await store.retry('a-old')
    store.applyStream({
      type: 'started',
      requestId: 'r2',
      sessionId: 's1',
      assistantMessageId: 'a-new',
      sequence: 0
    })
    store.applyStream({
      type: 'failed',
      requestId: 'r2',
      sequence: 1,
      error: { code: 'NET_TIMEOUT', message: '超时', retryable: true, requestId: 'r2' }
    })

    expect(store.state.messages.map((m) => m.id)).toEqual(['u1', 'a-new'])
    expect(store.state.messages[1].status).toBe('failed')
  })

  it('retry 目标已不存在（requestId 为空）时不摘任何气泡', async () => {
    const store = useChatStore()
    seedFailedTurn(store)
    ;(window.companion.chat.retry as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      data: { requestId: '' }
    })

    await store.retry('a-old')
    // 之后任何无关轮次的终局都不得误摘 a-old
    store.applyStream({
      type: 'started',
      requestId: 'r9',
      sessionId: 's1',
      assistantMessageId: 'a9',
      sequence: 0
    })
    store.applyStream({ type: 'completed', requestId: 'r9', sequence: 1 })

    expect(store.state.messages.find((m) => m.id === 'a-old')).toBeDefined()
  })
})

// 验收反馈⑥：按轮删除——main 返回被删行 id，store 同步摘除气泡
describe('chat store deleteTurn（验收反馈⑥：按轮删除对话）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    Object.defineProperty(window, 'companion', {
      value: {
        chat: {
          deleteTurn: vi.fn(async () => ({ ok: true, data: { deletedIds: ['u2', 'a2'] } }))
        }
      },
      writable: true,
      configurable: true
    })
  })

  function seedTwoTurns(store: ReturnType<typeof useChatStore>): void {
    store.state.sessionId = 's1'
    store.state.messages.push(
      { id: 'u1', role: 'user', content: '问一', createdAt: 1, status: 'complete' },
      { id: 'a1', role: 'assistant', content: '答一', createdAt: 2, status: 'complete' },
      { id: 'u2', role: 'user', content: '问二', createdAt: 3, status: 'complete' },
      { id: 'a2', role: 'assistant', content: '答二', createdAt: 4, status: 'complete' }
    )
  }

  it('删除成功：按 deletedIds 摘除气泡，其他轮保留', async () => {
    const store = useChatStore()
    seedTwoTurns(store)

    await store.deleteTurn('a2')
    expect(window.companion.chat.deleteTurn).toHaveBeenCalledWith({
      sessionId: 's1',
      messageId: 'a2'
    })
    expect(store.state.messages.map((m) => m.id)).toEqual(['u1', 'a1'])
  })

  it('空删除列表：不动任何气泡', async () => {
    const store = useChatStore()
    seedTwoTurns(store)
    ;(window.companion.chat.deleteTurn as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      data: { deletedIds: [] }
    })

    await store.deleteTurn('ghost')
    expect(store.state.messages).toHaveLength(4)
  })

  it('IPC 失败：不动任何气泡', async () => {
    const store = useChatStore()
    seedTwoTurns(store)
    ;(window.companion.chat.deleteTurn as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'CHAT_BUSY',
        message: '忙',
        userMessage: '她还在回复中',
        severity: 'error',
        retryable: false
      }
    })

    await store.deleteTurn('a2')
    expect(store.state.messages).toHaveLength(4)
  })

  it('流式进行中（activeTurn 非空）：不调 IPC 直接返回', async () => {
    const store = useChatStore()
    seedTwoTurns(store)
    store.state.activeTurn = {
      requestId: 'r1',
      assistantMessageId: 'a9',
      lastSequence: 0,
      startedAt: 1
    }

    await store.deleteTurn('a2')
    expect(window.companion.chat.deleteTurn).not.toHaveBeenCalled()
    expect(store.state.messages).toHaveLength(4)
  })
})
