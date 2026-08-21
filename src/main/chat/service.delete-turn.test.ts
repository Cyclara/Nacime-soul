// src/main/chat/service.delete-turn.test.ts
// 验收反馈⑥：deleteTurn 按轮删除（用户自助清理残留/发错的对话）。
// 核心语义：
//   - 按被点消息的 turnId 删除整轮（user + assistant，任何状态，含 CHAT_INTERRUPTED 占位）
//   - 无 turnId 的遗产行回退为单条删除
//   - 目标不存在容错返回空列表（不抛错）
//   - 流式进行中拒绝（CHAT_BUSY）
//   - 删除后该轮退出 prompt 历史（getTurnMessages 取不到配对）

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createChatService, type ChatService, type ChatEventSink } from './service'
import { createMemorySessionStore, type SessionStore } from './session-store'
import { createFauxProvider, type FauxProviderHandle } from '../llm/providers/faux'
import { createMemoryPromptLoader } from '../prompts/loader'
import { registerHook, clearHooks } from '../hooks/registry'
import { setHookRunnerLogger } from '../hooks/runner'
import { sanitizeMessageHook } from '../hooks/builtin/sanitize-message'
import type { Logger } from '@shared/observability/types'
import type { ChatMessage, ChatStreamEvent } from '@shared/chat/types'

function noopLogger(): Logger {
  const l: Logger = {
    fatal() {
      /* noop */
    },
    error() {
      /* noop */
    },
    warn() {
      /* noop */
    },
    info() {
      /* noop */
    },
    debug() {
      /* noop */
    },
    child() {
      return l
    }
  }
  return l
}

function makeTestLoader(): ReturnType<typeof createMemoryPromptLoader> {
  return createMemoryPromptLoader({
    'seed.md': 'You are Nacime.',
    'system.md': 'Speak naturally.',
    'identity.md': 'Name: Nacime',
    'soul.md': 'Curious and warm.',
    'styles/casual.md': 'Casual tone.'
  })
}

function makeCollector(): {
  events: ChatStreamEvent[]
  sink: ChatEventSink
  done: Promise<void>
} {
  const events: ChatStreamEvent[] = []
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  const sink: ChatEventSink = (event) => {
    events.push(event)
    if (event.type === 'completed' || event.type === 'failed' || event.type === 'cancelled') {
      resolveDone()
    }
  }
  return { events, sink, done }
}

function makeService(faux: FauxProviderHandle, sessionStore: SessionStore): ChatService {
  return createChatService({
    logger: noopLogger(),
    promptLoader: makeTestLoader(),
    sessionStore,
    providerFactory: () => ({
      provider: faux,
      capabilities: { contextWindow: 64000, maxOutputTokens: 2048 }
    })
  })
}

function row(
  id: string,
  sessionId: string,
  turnId: string | undefined,
  role: 'user' | 'assistant',
  content: string,
  status: ChatMessage['status'],
  errorCode?: ChatMessage['errorCode']
): ChatMessage {
  return {
    id,
    sessionId,
    role,
    content,
    createdAt: 1_000,
    status,
    ...(errorCode ? { errorCode } : {}),
    ...(turnId ? { turnId } : {})
  }
}

describe('ChatService.deleteTurn（验收反馈⑥：按轮删除对话）', () => {
  let store: SessionStore
  let sessionId: string
  let service: ChatService

  beforeEach(() => {
    clearHooks()
    setHookRunnerLogger(noopLogger())
    registerHook(sanitizeMessageHook)
    store = createMemorySessionStore()
    sessionId = store.createSession()
    service = makeService(createFauxProvider(), store)
  })

  afterEach(() => {
    clearHooks()
  })

  it('删除完整轮：点 user 或 assistant 都删整轮，其他轮不受影响', () => {
    store.appendMessage(sessionId, row('u1', sessionId, 't1', 'user', '早点睡', 'complete'))
    store.appendMessage(sessionId, row('a1', sessionId, 't1', 'assistant', '晚安', 'complete'))
    store.appendMessage(sessionId, row('u2', sessionId, 't2', 'user', '我喜欢打游戏', 'complete'))
    store.appendMessage(sessionId, row('a2', sessionId, 't2', 'assistant', '玩什么呀', 'complete'))

    // 点 t2 的 assistant 气泡
    const r1 = service.deleteTurn(sessionId, 'a2')
    expect(r1.deletedIds.sort()).toEqual(['a2', 'u2'])
    expect(store.getMessages(sessionId, 100).map((m) => m.id)).toEqual(['u1', 'a1'])

    // 点 t1 的 user 气泡
    const r2 = service.deleteTurn(sessionId, 'u1')
    expect(r2.deletedIds.sort()).toEqual(['a1', 'u1'])
    expect(store.getMessages(sessionId, 100)).toHaveLength(0)
  })

  it('M-47 现场：zombie user + CHAT_INTERRUPTED 占位同 turnId，点占位一次删干净', () => {
    // 验收当晚残留：seq [完整轮 t1, zombie user(t2), 占位 assistant(t2, CHAT_INTERRUPTED)]
    store.appendMessage(sessionId, row('u1', sessionId, 't1', 'user', '问', 'complete'))
    store.appendMessage(sessionId, row('a1', sessionId, 't1', 'assistant', '答', 'complete'))
    store.appendMessage(sessionId, row('u2', sessionId, 't2', 'user', '我是你的制造者', 'complete'))
    store.appendMessage(
      sessionId,
      row('ph', sessionId, 't2', 'assistant', '', 'failed', 'CHAT_INTERRUPTED')
    )

    const result = service.deleteTurn(sessionId, 'ph')
    expect(result.deletedIds.sort()).toEqual(['ph', 'u2'])

    const msgs = store.getMessages(sessionId, 100)
    expect(msgs.map((m) => m.id)).toEqual(['u1', 'a1']) // 完整轮原样保留
  })

  it('无 turnId 的遗产行：回退为只删被点的那一条', () => {
    store.appendMessage(sessionId, row('legacy', sessionId, undefined, 'user', '老消息', 'complete'))
    store.appendMessage(sessionId, row('u1', sessionId, 't1', 'user', '新消息', 'complete'))

    const result = service.deleteTurn(sessionId, 'legacy')
    expect(result.deletedIds).toEqual(['legacy'])
    expect(store.getMessages(sessionId, 100).map((m) => m.id)).toEqual(['u1'])
  })

  it('目标消息不存在 -> 空列表（容错，不抛错）', () => {
    const result = service.deleteTurn(sessionId, 'ghost')
    expect(result.deletedIds).toEqual([])
  })

  it('有 active turn 时拒绝：CHAT_BUSY', async () => {
    store.appendMessage(sessionId, row('u1', sessionId, 't1', 'user', '问', 'complete'))
    store.appendMessage(sessionId, row('a1', sessionId, 't1', 'assistant', '答', 'complete'))

    const faux = createFauxProvider()
    faux.setResponses([{ type: 'text', text: '慢回复', delayMs: 500 }])
    service = makeService(faux, store)
    const collector = makeCollector()
    await service.send({ sessionId, text: '进行中', clientRequestId: 'c1' }, collector.sink)

    expect(() => service.deleteTurn(sessionId, 'a1')).toThrowError(
      expect.objectContaining({ code: 'CHAT_BUSY' })
    )
    // 被拒后消息原样还在
    expect(store.getMessages(sessionId, 100).map((m) => m.id)).toContain('a1')

    await collector.done
  })

  it('删除后该轮退出历史：getTurnMessages 取不到配对（不再进入 prompt/记忆提取源）', () => {
    store.appendMessage(sessionId, row('u1', sessionId, 't1', 'user', '我喜欢打游戏', 'complete'))
    store.appendMessage(sessionId, row('a1', sessionId, 't1', 'assistant', '玩什么呀', 'complete'))

    expect(store.getTurnMessages(sessionId, 't1')).not.toBeNull()
    service.deleteTurn(sessionId, 'a1')
    expect(store.getTurnMessages(sessionId, 't1')).toBeNull()
    expect(store.getMessages(sessionId, 100)).toHaveLength(0)
  })
})

describe('ChatService.deleteMessage（验收反馈⑥c：单条删除，粒度控制）', () => {
  let store: SessionStore
  let sessionId: string
  let service: ChatService

  beforeEach(() => {
    clearHooks()
    setHookRunnerLogger(noopLogger())
    registerHook(sanitizeMessageHook)
    store = createMemorySessionStore()
    sessionId = store.createSession()
    service = makeService(createFauxProvider(), store)
  })

  afterEach(() => {
    clearHooks()
  })

  it('只删被点的 assistant：同轮 user 行保留（孤儿 user，重启动时由 M-39 补占位）', () => {
    store.appendMessage(sessionId, row('u1', sessionId, 't1', 'user', '问', 'complete'))
    store.appendMessage(sessionId, row('a1', sessionId, 't1', 'assistant', '答', 'complete'))

    const result = service.deleteMessage(sessionId, 'a1')
    expect(result.deletedIds).toEqual(['a1'])

    const msgs = store.getMessages(sessionId, 100)
    expect(msgs.map((m) => m.id)).toEqual(['u1']) // 兄弟行不动
    expect(store.getTurnMessages(sessionId, 't1')).toBeNull() // 配对已破
  })

  it('只删被点的 user：同轮 assistant 行保留（孤立 assistant 退出 prompt 装配）', () => {
    store.appendMessage(sessionId, row('u1', sessionId, 't1', 'user', '问', 'complete'))
    store.appendMessage(sessionId, row('a1', sessionId, 't1', 'assistant', '答', 'complete'))

    const result = service.deleteMessage(sessionId, 'u1')
    expect(result.deletedIds).toEqual(['u1'])
    expect(store.getMessages(sessionId, 100).map((m) => m.id)).toEqual(['a1'])
  })

  it('目标不存在 -> 空列表（容错，不抛错）', () => {
    expect(service.deleteMessage(sessionId, 'ghost').deletedIds).toEqual([])
  })

  it('有 active turn 时拒绝：CHAT_BUSY（防删到在途轮 streaming 行）', async () => {
    store.appendMessage(sessionId, row('u1', sessionId, 't1', 'user', '问', 'complete'))

    const faux = createFauxProvider()
    faux.setResponses([{ type: 'text', text: '慢回复', delayMs: 500 }])
    service = makeService(faux, store)
    const collector = makeCollector()
    await service.send({ sessionId, text: '进行中', clientRequestId: 'c1' }, collector.sink)

    expect(() => service.deleteMessage(sessionId, 'u1')).toThrowError(
      expect.objectContaining({ code: 'CHAT_BUSY' })
    )
    expect(store.getMessages(sessionId, 100).map((m) => m.id)).toContain('u1')

    await collector.done
  })
})

describe('ChatService.deleteSelected（验收反馈⑦：批量按轮删除）', () => {
  let store: SessionStore
  let sessionId: string
  let service: ChatService

  beforeEach(() => {
    clearHooks()
    setHookRunnerLogger(noopLogger())
    registerHook(sanitizeMessageHook)
    store = createMemorySessionStore()
    sessionId = store.createSession()
    service = makeService(createFauxProvider(), store)
  })

  afterEach(() => {
    clearHooks()
  })

  function seedThreeTurns(): void {
    store.appendMessage(sessionId, row('u1', sessionId, 't1', 'user', '问一', 'complete'))
    store.appendMessage(sessionId, row('a1', sessionId, 't1', 'assistant', '答一', 'complete'))
    store.appendMessage(sessionId, row('u2', sessionId, 't2', 'user', '问二', 'complete'))
    store.appendMessage(sessionId, row('a2', sessionId, 't2', 'assistant', '答二', 'complete'))
    store.appendMessage(sessionId, row('u3', sessionId, 't3', 'user', '问三', 'complete'))
    store.appendMessage(sessionId, row('a3', sessionId, 't3', 'assistant', '答三', 'complete'))
  }

  it('勾选同轮两个 id：解析到同一 turnId 去重，该轮只删一次', () => {
    seedThreeTurns()

    const result = service.deleteSelected(sessionId, ['u2', 'a2'])
    expect(result.deletedIds.sort()).toEqual(['a2', 'u2'])
    expect(store.getMessages(sessionId, 100).map((m) => m.id)).toEqual(['u1', 'a1', 'u3', 'a3'])
  })

  it('勾选跨多轮：每轮整轮删除（删除单位永远是轮）', () => {
    seedThreeTurns()

    // 勾 t1 的 assistant + t3 的 user——各自整轮删除，t2 原样保留
    const result = service.deleteSelected(sessionId, ['a1', 'u3'])
    expect(result.deletedIds.sort()).toEqual(['a1', 'a3', 'u1', 'u3'])
    expect(store.getMessages(sessionId, 100).map((m) => m.id)).toEqual(['u2', 'a2'])
  })

  it('混合遗产行：无 turnId 的按单条删，有 turnId 的按轮删', () => {
    store.appendMessage(sessionId, row('legacy', sessionId, undefined, 'user', '老消息', 'complete'))
    store.appendMessage(sessionId, row('u1', sessionId, 't1', 'user', '问', 'complete'))
    store.appendMessage(sessionId, row('a1', sessionId, 't1', 'assistant', '答', 'complete'))

    const result = service.deleteSelected(sessionId, ['legacy', 'a1'])
    expect(result.deletedIds.sort()).toEqual(['a1', 'legacy', 'u1'])
    expect(store.getMessages(sessionId, 100)).toHaveLength(0)
  })

  it('含未知 id：静默跳过，已知 id 照常删除（幂等容错）', () => {
    seedThreeTurns()

    const result = service.deleteSelected(sessionId, ['ghost', 'u1'])
    expect(result.deletedIds.sort()).toEqual(['a1', 'u1'])
  })

  it('空数组/全部未知：空结果，不动任何消息', () => {
    seedThreeTurns()

    expect(service.deleteSelected(sessionId, []).deletedIds).toEqual([])
    expect(service.deleteSelected(sessionId, ['ghost']).deletedIds).toEqual([])
    expect(store.getMessages(sessionId, 100)).toHaveLength(6)
  })

  it('有 active turn 时拒绝：CHAT_BUSY', async () => {
    seedThreeTurns()

    const faux = createFauxProvider()
    faux.setResponses([{ type: 'text', text: '慢回复', delayMs: 500 }])
    service = makeService(faux, store)
    const collector = makeCollector()
    await service.send({ sessionId, text: '进行中', clientRequestId: 'c1' }, collector.sink)

    expect(() => service.deleteSelected(sessionId, ['u1', 'u2'])).toThrowError(
      expect.objectContaining({ code: 'CHAT_BUSY' })
    )
    expect(store.getMessages(sessionId, 100).map((m) => m.id)).toContain('u1')

    await collector.done
  })
})

describe('ChatService.clearSession（验收反馈⑦：删除所有对话）', () => {
  let store: SessionStore
  let sessionId: string
  let service: ChatService

  beforeEach(() => {
    clearHooks()
    setHookRunnerLogger(noopLogger())
    registerHook(sanitizeMessageHook)
    store = createMemorySessionStore()
    sessionId = store.createSession()
    service = makeService(createFauxProvider(), store)
  })

  afterEach(() => {
    clearHooks()
  })

  it('清空全部消息并返回 removed 计数；会话本身保留可继续用', () => {
    store.appendMessage(sessionId, row('u1', sessionId, 't1', 'user', '问', 'complete'))
    store.appendMessage(sessionId, row('a1', sessionId, 't1', 'assistant', '答', 'complete'))
    store.appendMessage(sessionId, row('legacy', sessionId, undefined, 'user', '老', 'complete'))

    const result = service.clearSession(sessionId)
    expect(result.removed).toBe(3)
    expect(store.getMessages(sessionId, 100)).toHaveLength(0)

    // 会话保留：清空后还能继续写
    store.appendMessage(sessionId, row('u2', sessionId, 't2', 'user', '新开始', 'complete'))
    expect(store.getMessages(sessionId, 100).map((m) => m.id)).toEqual(['u2'])
  })

  it('空会话：removed = 0，不抛错', () => {
    expect(service.clearSession(sessionId).removed).toBe(0)
  })

  it('有 active turn 时拒绝：CHAT_BUSY（防清掉在途轮）', async () => {
    store.appendMessage(sessionId, row('u1', sessionId, 't1', 'user', '问', 'complete'))

    const faux = createFauxProvider()
    faux.setResponses([{ type: 'text', text: '慢回复', delayMs: 500 }])
    service = makeService(faux, store)
    const collector = makeCollector()
    await service.send({ sessionId, text: '进行中', clientRequestId: 'c1' }, collector.sink)

    expect(() => service.clearSession(sessionId)).toThrowError(
      expect.objectContaining({ code: 'CHAT_BUSY' })
    )
    expect(store.getMessages(sessionId, 100).length).toBeGreaterThan(0)

    await collector.done
  })
})
