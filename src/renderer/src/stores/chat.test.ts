// @vitest-environment jsdom
// src/renderer/src/stores/chat.test.ts
// P1-24 chat store 测试
// 依据：S-004 #28-#30（旧 requestId 丢弃、重复/逆序 sequence 丢弃、completed/failed/cancelled 清 activeTurn）

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick } from 'vue'
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
    expect(window.companion.chat.retry).toHaveBeenCalledWith({
      sessionId: 's1',
      messageId: 'a-old'
    })

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

// 验收反馈⑥c：单条删除——只摘被点那一条，兄弟气泡保留
describe('chat store deleteMessage（验收反馈⑥c：单条删除）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    Object.defineProperty(window, 'companion', {
      value: {
        chat: {
          deleteMessage: vi.fn(async () => ({ ok: true, data: { deletedIds: ['a1'] } }))
        }
      },
      writable: true,
      configurable: true
    })
  })

  it('删除成功：只摘除被点气泡，同轮 user 保留', async () => {
    const store = useChatStore()
    store.state.sessionId = 's1'
    store.state.messages.push(
      { id: 'u1', role: 'user', content: '问', createdAt: 1, status: 'complete' },
      { id: 'a1', role: 'assistant', content: '答', createdAt: 2, status: 'complete' }
    )

    await store.deleteMessage('a1')
    expect(window.companion.chat.deleteMessage).toHaveBeenCalledWith({
      sessionId: 's1',
      messageId: 'a1'
    })
    expect(store.state.messages.map((m) => m.id)).toEqual(['u1'])
  })

  it('流式进行中（activeTurn 非空）：不调 IPC 直接返回', async () => {
    const store = useChatStore()
    store.state.sessionId = 's1'
    store.state.messages.push({
      id: 'u1',
      role: 'user',
      content: '问',
      createdAt: 1,
      status: 'complete'
    })
    store.state.activeTurn = {
      requestId: 'r1',
      assistantMessageId: 'a9',
      lastSequence: 0,
      startedAt: 1
    }

    await store.deleteMessage('u1')
    expect(window.companion.chat.deleteMessage).not.toHaveBeenCalled()
    expect(store.state.messages).toHaveLength(1)
  })
})

// M-49 回归：乐观 user 气泡的 id 必须回填为 ACK 的真实 userMessageId——
// 否则对刚发出的消息做删除会拿 clientRequestId 查库，main 查不到 -> 静默删不掉
describe('chat store M-49（乐观气泡 id 回填 + 删除失败不静默）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    Object.defineProperty(window, 'companion', {
      value: {
        chat: {
          send: vi.fn(async () => ({
            ok: true,
            data: { requestId: 'r1', userMessageId: 'u-real' }
          })),
          deleteTurn: vi.fn(async () => ({ ok: true, data: { deletedIds: ['u-real'] } })),
          deleteMessage: vi.fn(async () => ({ ok: true, data: { deletedIds: ['u-real'] } }))
        }
      },
      writable: true,
      configurable: true
    })
  })

  it('send 成功后乐观气泡 id 回填为 userMessageId，随后删除按真实 id 发起', async () => {
    const store = useChatStore()
    store.state.sessionId = 's1'
    store.setDraft('刚发出的一句')

    await store.send()

    const bubble = store.state.messages.find((m) => m.role === 'user')
    expect(bubble).toBeDefined()
    expect(bubble!.id).toBe('u-real') // 不再是 clientRequestId

    await store.deleteTurn('u-real')
    expect(window.companion.chat.deleteTurn).toHaveBeenCalledWith({
      sessionId: 's1',
      messageId: 'u-real'
    })
    expect(store.state.messages.find((m) => m.role === 'user')).toBeUndefined()
  })

  it('send 失败：乐观气泡被移除，谈不上回填', async () => {
    const store = useChatStore()
    store.state.sessionId = 's1'
    ;(window.companion.chat.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'NET_OFFLINE',
        message: '网络连接失败',
        severity: 'error',
        retryable: true
      }
    })
    store.setDraft('发不出去')

    await store.send()
    expect(store.state.messages).toHaveLength(0)
    expect(store.state.draft).toBe('发不出去') // 草稿恢复
  })

  it('删除 IPC 失败：不静默——lastError 置为返回的错误', async () => {
    const store = useChatStore()
    store.state.sessionId = 's1'
    store.state.messages.push({
      id: 'u1',
      role: 'user',
      content: '问',
      createdAt: 1,
      status: 'complete'
    })
    ;(window.companion.chat.deleteTurn as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'CHAT_BUSY',
        message: '她还在回复中，等回复结束后再删除',
        severity: 'error',
        retryable: false
      }
    })

    await store.deleteTurn('u1')
    expect(store.state.messages).toHaveLength(1)
    expect(store.state.lastError).not.toBeNull()
    expect(store.state.lastError!.code).toBe('CHAT_BUSY')
  })
})

// 验收反馈⑦：选择模式——相邻配对联动勾选（渲染层没有 turnId，所见即所删靠配对规则）、
// 批量按轮删除、清空会话、流式开始自动退出
describe('chat store 选择模式（验收反馈⑦：批量按轮删除）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    Object.defineProperty(window, 'companion', {
      value: {
        chat: {
          deleteSelected: vi.fn(async () => ({ ok: true, data: { deletedIds: ['u1', 'a1'] } })),
          clearSession: vi.fn(async () => ({ ok: true, data: { removed: 4 } }))
        }
      },
      writable: true,
      configurable: true
    })
  })

  function seed(store: ReturnType<typeof useChatStore>): void {
    store.state.sessionId = 's1'
    // 完整轮 t1 + 孤儿 user（单删她的回复后的现场）+ 完整轮 t3
    store.state.messages.push(
      { id: 'u1', role: 'user', content: '问一', createdAt: 1, status: 'complete' },
      { id: 'a1', role: 'assistant', content: '答一', createdAt: 2, status: 'complete' },
      { id: 'u2', role: 'user', content: '孤儿问', createdAt: 3, status: 'complete' },
      { id: 'u3', role: 'user', content: '问三', createdAt: 4, status: 'complete' },
      { id: 'a3', role: 'assistant', content: '答三', createdAt: 5, status: 'complete' }
    )
  }

  it('进入选择模式并预勾被点气泡所在轮（user 配紧随的 assistant）', () => {
    const store = useChatStore()
    seed(store)

    store.enterSelection('a1')
    expect(store.selectionMode).toBe(true)
    // 点 assistant 配紧邻的前置 user——t1 整轮预勾
    expect([...store.selectedIds].sort()).toEqual(['a1', 'u1'])
  })

  it('孤儿 user 自成一组：预勾/切换只影响自己', () => {
    const store = useChatStore()
    seed(store)

    store.enterSelection('u2')
    expect([...store.selectedIds]).toEqual(['u2'])

    store.toggleSelect('u2')
    expect(store.selectedIds.size).toBe(0)
  })

  it('勾选联动：点轮中任一条，整轮一起勾/一起消', () => {
    const store = useChatStore()
    seed(store)
    store.enterSelection()

    store.toggleSelect('u3')
    expect([...store.selectedIds].sort()).toEqual(['a3', 'u3'])

    // 再点同轮的 assistant：整轮取消
    store.toggleSelect('a3')
    expect(store.selectedIds.size).toBe(0)
  })

  it('全选/取消全选；selectedCount/allSelected 派生正确', () => {
    const store = useChatStore()
    seed(store)
    store.enterSelection()

    expect(store.selectedCount).toBe(0)
    expect(store.allSelected).toBe(false)

    store.toggleSelectAll()
    expect(store.selectedCount).toBe(5)
    expect(store.allSelected).toBe(true)

    store.toggleSelectAll()
    expect(store.selectedCount).toBe(0)
  })

  it('删除所选：把勾选 id 发给 main，按返回 deletedIds 摘除并退出选择模式', async () => {
    const store = useChatStore()
    seed(store)
    store.enterSelection('a1') // 预勾 t1 整轮

    await store.deleteSelected()
    expect(window.companion.chat.deleteSelected).toHaveBeenCalledWith({
      sessionId: 's1',
      messageIds: expect.arrayContaining(['u1', 'a1'])
    })
    expect(store.state.messages.map((m) => m.id)).toEqual(['u2', 'u3', 'a3'])
    expect(store.selectionMode).toBe(false)
    expect(store.selectedIds.size).toBe(0)
  })

  it('删除所选为空：不调 IPC 直接返回', async () => {
    const store = useChatStore()
    seed(store)
    store.enterSelection()

    await store.deleteSelected()
    expect(window.companion.chat.deleteSelected).not.toHaveBeenCalled()
  })

  it('删除所选 IPC 失败：保留选择模式可重试，lastError 有说法', async () => {
    const store = useChatStore()
    seed(store)
    store.enterSelection('u1')
    ;(window.companion.chat.deleteSelected as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'CHAT_BUSY',
        message: '她还在回复中，等回复结束后再删除',
        severity: 'error',
        retryable: false
      }
    })

    await store.deleteSelected()
    expect(store.selectionMode).toBe(true)
    expect(store.selectedIds.size).toBe(2)
    expect(store.state.lastError!.code).toBe('CHAT_BUSY')
  })

  it('删除所有对话：清空气泡并退出选择模式', async () => {
    const store = useChatStore()
    seed(store)
    store.enterSelection('u1')

    await store.clearSession()
    expect(window.companion.chat.clearSession).toHaveBeenCalledWith({ sessionId: 's1' })
    expect(store.state.messages).toEqual([])
    expect(store.selectionMode).toBe(false)
  })

  it('删除所有对话 IPC 失败：气泡保留，lastError 有说法', async () => {
    const store = useChatStore()
    seed(store)
    store.enterSelection()
    ;(window.companion.chat.clearSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'CHAT_BUSY',
        message: '她还在回复中，等回复结束后再清空',
        severity: 'error',
        retryable: false
      }
    })

    await store.clearSession()
    expect(store.state.messages).toHaveLength(5)
    expect(store.state.lastError!.code).toBe('CHAT_BUSY')
  })

  it('流式开始自动退出选择模式（防删到在途轮）', async () => {
    const store = useChatStore()
    seed(store)
    store.enterSelection('u1')
    expect(store.selectionMode).toBe(true)

    store.applyStream({
      type: 'started',
      requestId: 'r1',
      sessionId: 's1',
      assistantMessageId: 'a9',
      sequence: 0
    })
    await nextTick() // activeTurn 的 watch 是异步 flush

    expect(store.selectionMode).toBe(false)
    expect(store.selectedIds.size).toBe(0)
  })
})
