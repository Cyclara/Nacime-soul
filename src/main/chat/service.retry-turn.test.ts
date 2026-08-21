// src/main/chat/service.retry-turn.test.ts
// 验收反馈④c：retryTurn 重试不增消息。
// 核心语义：
//   - 不写新 user 行、复用原 turnId，新 assistant 行落回原轮
//   - 终局删除同轮被取代的 assistant 行（failed/cancelled/CHAT_INTERRUPTED 占位）
//   - 按被点气泡的 turnId 精确定位目标轮（M-47 回归：表尾占位属于更早的孤儿轮，
//     旧 walk-back 会错拿它前面那条完整轮的 user 重发）
//   - 幂等与 send 同一套进程内账本

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

function makeService(
  faux: FauxProviderHandle,
  sessionStore: SessionStore
): ChatService {
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
  turnId: string,
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
    turnId
  }
}

describe('ChatService.retryTurn（验收反馈④c：重试不增消息）', () => {
  let store: SessionStore
  let sessionId: string

  beforeEach(() => {
    clearHooks()
    setHookRunnerLogger(noopLogger())
    registerHook(sanitizeMessageHook)
    store = createMemorySessionStore()
    sessionId = store.createSession()
  })

  afterEach(() => {
    clearHooks()
  })

  it('失败轮重试成功：无新 user 行、同 turnId、旧 failed 行被删、只留最新 assistant', async () => {
    store.appendMessage(sessionId, row('u1', sessionId, 't1', 'user', '昨晚那句', 'complete'))
    store.appendMessage(sessionId, row('a1', sessionId, 't1', 'assistant', '', 'failed', 'NET_TIMEOUT'))

    const faux = createFauxProvider()
    faux.setResponses([{ type: 'text', text: '重新回答' }])
    const service = makeService(faux, store)
    const collector = makeCollector()

    const ack = await service.retryTurn(
      { sessionId, messageId: 'a1', clientRequestId: 'retry-a1' },
      collector.sink
    )
    await collector.done

    expect(ack).not.toBeNull()
    expect(ack!.userMessageId).toBe('u1') // 复用原 user 行
    expect(faux.callCount()).toBe(1)

    const msgs = store.getMessages(sessionId, 100)
    expect(msgs.filter((m) => m.role === 'user')).toHaveLength(1) // 无新 user 行
    const assistants = msgs.filter((m) => m.role === 'assistant')
    expect(assistants).toHaveLength(1) // 旧 failed 行被删
    expect(assistants[0].id).toBe(ack!.assistantMessageId)
    expect(assistants[0].status).toBe('complete')
    expect(assistants[0].content).toBe('重新回答')
    expect(assistants[0].turnId).toBe('t1') // 落回原轮

    // 事件流完整
    expect(collector.events[0].type).toBe('started')
    expect(collector.events[collector.events.length - 1].type).toBe('completed')
  })

  it('M-47 回归：表尾占位属于更早孤儿轮，按 turnId 重试的是那一轮而不是它前面那条完整轮', async () => {
    // 现场复刻：seq 顺序 [u1,a1(完整轮 t1), u2(孤儿轮 t2), placeholder(t2, CHAT_INTERRUPTED)]
    store.appendMessage(sessionId, row('u1', sessionId, 't1', 'user', '早点睡', 'complete'))
    store.appendMessage(sessionId, row('a1', sessionId, 't1', 'assistant', '晚安', 'complete'))
    store.appendMessage(sessionId, row('u2', sessionId, 't2', 'user', '我是你的制造者', 'complete'))
    store.appendMessage(
      sessionId,
      row('ph', sessionId, 't2', 'assistant', '', 'failed', 'CHAT_INTERRUPTED')
    )

    const faux = createFauxProvider()
    faux.setResponses([{ type: 'text', text: '制造者你好呀' }])
    const service = makeService(faux, store)
    const collector = makeCollector()

    const ack = await service.retryTurn(
      { sessionId, messageId: 'ph', clientRequestId: 'retry-ph' },
      collector.sink
    )
    await collector.done

    // 重试的是 t2 轮的 u2，不是表尾前面那条 t1 轮的 u1
    expect(ack!.userMessageId).toBe('u2')
    const sent = faux.calls()[0].messages
    const lastUser = [...sent].reverse().find((m) => m.role === 'user')
    expect(lastUser!.content).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] 我是你的制造者$/)

    const msgs = store.getMessages(sessionId, 100)
    // 完整轮 t1 原样保留；t2 只剩 user + 新 assistant
    expect(msgs.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', ack!.assistantMessageId])
    expect(msgs[3].turnId).toBe('t2')
    expect(msgs[3].status).toBe('complete')
  })

  it('幂等：进行中同 clientRequestId 重投返回同一 ACK；终局后旧气泡已删 -> null', async () => {
    store.appendMessage(sessionId, row('u1', sessionId, 't1', 'user', '问', 'complete'))
    store.appendMessage(sessionId, row('a1', sessionId, 't1', 'assistant', '', 'failed', 'NET_TIMEOUT'))

    const faux = createFauxProvider()
    faux.setResponses([{ type: 'text', text: '答', delayMs: 300 }])
    const service = makeService(faux, store)
    const collector = makeCollector()

    // 第一轮还在流式（delayMs），同 clientRequestId 重投 -> 同一 ACK，不重复真跑
    const [ack1, ack2] = await Promise.all([
      service.retryTurn({ sessionId, messageId: 'a1', clientRequestId: 'retry-a1' }, collector.sink),
      service.retryTurn({ sessionId, messageId: 'a1', clientRequestId: 'retry-a1' }, makeCollector().sink)
    ])
    expect(ack2).toEqual(ack1)
    await collector.done
    expect(faux.callCount()).toBe(1)

    // 终局后旧失败行已被清理删除：再点同一气泡 -> null（目标不存在），不再真跑
    const ack3 = await service.retryTurn(
      { sessionId, messageId: 'a1', clientRequestId: 'retry-a1' },
      makeCollector().sink
    )
    expect(ack3).toBeNull()
    expect(faux.callCount()).toBe(1)
  })

  it('目标消息不存在 -> null（容错，不抛错不占轮）', async () => {
    const faux = createFauxProvider()
    const service = makeService(faux, store)
    const ack = await service.retryTurn(
      { sessionId, messageId: 'ghost', clientRequestId: 'retry-ghost' },
      makeCollector().sink
    )
    expect(ack).toBeNull()
    expect(faux.callCount()).toBe(0)
    expect(service.hasActiveTurn(sessionId)).toBe(false)
  })

  it('有 active turn 时拒绝：CHAT_BUSY', async () => {
    store.appendMessage(sessionId, row('u1', sessionId, 't1', 'user', '问', 'complete'))
    store.appendMessage(sessionId, row('a1', sessionId, 't1', 'assistant', '', 'failed', 'NET_TIMEOUT'))

    const faux = createFauxProvider()
    // 第一轮 send 延迟 500ms，保证 retryTurn 撞 active
    faux.setResponses([
      { type: 'text', text: '慢回复', delayMs: 500 },
      { type: 'text', text: '重试回复' }
    ])
    const service = makeService(faux, store)
    const collector = makeCollector()
    await service.send({ sessionId, text: '进行中', clientRequestId: 'c1' }, collector.sink)

    await expect(
      service.retryTurn({ sessionId, messageId: 'a1', clientRequestId: 'retry-a1' }, makeCollector().sink)
    ).rejects.toMatchObject({ code: 'CHAT_BUSY' })

    await collector.done
  })

  it('重试再失败：旧失败行同样被删，一轮只留最新失败行（可继续点重试）', async () => {
    store.appendMessage(sessionId, row('u1', sessionId, 't1', 'user', '问', 'complete'))
    store.appendMessage(sessionId, row('a1', sessionId, 't1', 'assistant', '', 'failed', 'NET_TIMEOUT'))

    const faux = createFauxProvider()
    faux.setResponses([{ type: 'error', code: 'NET_TIMEOUT', afterChars: 0 }])
    const service = makeService(faux, store)
    const collector = makeCollector()

    const ack = await service.retryTurn(
      { sessionId, messageId: 'a1', clientRequestId: 'retry-a1' },
      collector.sink
    )
    await collector.done

    const msgs = store.getMessages(sessionId, 100)
    expect(msgs.filter((m) => m.role === 'user')).toHaveLength(1)
    const assistants = msgs.filter((m) => m.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0].id).toBe(ack!.assistantMessageId)
    expect(assistants[0].status).toBe('failed')
  })

  it('重试成功后 getTurnMessages 能取到配对（记忆提取不被旧失败行挡住）', async () => {
    store.appendMessage(sessionId, row('u1', sessionId, 't1', 'user', '我喜欢打游戏', 'complete'))
    store.appendMessage(sessionId, row('a1', sessionId, 't1', 'assistant', '', 'failed', 'NET_TIMEOUT'))

    const faux = createFauxProvider()
    faux.setResponses([{ type: 'text', text: '你平时玩什么呀' }])
    const service = makeService(faux, store)
    const collector = makeCollector()

    await service.retryTurn({ sessionId, messageId: 'a1', clientRequestId: 'retry-a1' }, collector.sink)
    await collector.done

    const pair = store.getTurnMessages(sessionId, 't1')
    expect(pair).not.toBeNull()
    expect(pair!.user.content).toBe('我喜欢打游戏')
    expect(pair!.assistant.content).toBe('你平时玩什么呀')
  })
})
