// @vitest-environment jsdom
// src/renderer/src/stores/chat.test.ts
// P1-24 chat store 测试
// 依据：S-004 #28-#30（旧 requestId 丢弃、重复/逆序 sequence 丢弃、completed/failed/cancelled 清 activeTurn）

import { describe, it, expect, beforeEach } from 'vitest'
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
