// src/main/chat/service.test.ts
// P1-23 ChatService 测试
// 依据：S-004 #25-#27（执行顺序、空输入不调 provider、active turn 拒绝）
//       S-001 P1-23 验收（单一 turnId、失败只终止当前轮、用户 role 不变、事件顺序固定）

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createChatService,
  releaseSessionTurnOwnership,
  type ChatService,
  type ChatEventSink
} from './service'
import { createMemorySessionStore } from './session-store'
import { createFauxProvider, type FauxProviderHandle } from '../llm/providers/faux'
import { createMemoryPromptLoader } from '../prompts/loader'
import { registerHook, clearHooks } from '../hooks/registry'
import { setHookRunnerLogger } from '../hooks/runner'
import { sanitizeMessageHook } from '../hooks/builtin/sanitize-message'
import { LifecycleEvent } from '../hooks/lifecycle'
import { isAppError } from '@shared/errors'
import type { Logger } from '@shared/observability/types'
import type { ChatStreamEvent } from '@shared/chat/types'

// === 测试辅助 ===

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

/** 创建测试用 prompt loader（含全部 5 层） */
function makeTestLoader(): ReturnType<typeof createMemoryPromptLoader> {
  return createMemoryPromptLoader({
    'seed.md': 'You are Nacime.',
    'system.md': 'Speak naturally.',
    'identity.md': 'Name: Nacime',
    'soul.md': 'Curious and warm.',
    'styles/casual.md': 'Casual tone.'
  })
}

/** 事件收集器：收集所有事件，done 在轮次结束时 resolve */
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

/** 创建测试用 ChatService */
function makeChatService(
  faux: FauxProviderHandle,
  opts?: { contextWindow?: number; maxOutputTokens?: number }
): ChatService {
  return createChatService({
    logger: noopLogger(),
    promptLoader: makeTestLoader(),
    sessionStore: createMemorySessionStore(),
    providerFactory: () => ({
      provider: faux,
      capabilities: {
        contextWindow: opts?.contextWindow ?? 64000,
        maxOutputTokens: opts?.maxOutputTokens ?? 2048
      }
    })
  })
}

// === 测试 ===

describe('ChatService', () => {
  beforeEach(() => {
    clearHooks()
    setHookRunnerLogger(noopLogger())
    // 注册 sanitize hook（生产环境在 main 入口注册）
    registerHook(sanitizeMessageHook)
  })

  afterEach(() => {
    clearHooks()
  })

  // S-004 #25: 执行顺序 sanitize->prompt->params->provider->turn.end
  it('executes hooks and provider in fixed order: sanitize -> params -> provider -> turn.end', async () => {
    const faux = createFauxProvider()
    const order: string[] = []

    // 跟踪 sanitize（priority 200，在 sanitize-message hook 之后）
    registerHook({
      name: 'track-sanitize',
      event: LifecycleEvent.CHAT_MESSAGE,
      priority: 200,
      fn: () => {
        order.push('sanitize')
        return {}
      }
    })

    // 跟踪 params
    registerHook({
      name: 'track-params',
      event: LifecycleEvent.CHAT_PARAMS,
      priority: 200,
      fn: () => {
        order.push('params')
        return {}
      }
    })

    // 跟踪 turn.end
    registerHook({
      name: 'track-turn-end',
      event: LifecycleEvent.TURN_END,
      priority: 200,
      fn: () => {
        order.push('turn-end')
        return {}
      }
    })

    // 跟踪 provider 调用（函数响应）
    faux.setResponses([
      () => {
        order.push('provider')
        return { type: 'text', text: 'response' }
      }
    ])

    const service = makeChatService(faux)
    const sessionId = service.createSession()
    const collector = makeCollector()

    const ack = await service.send(
      { sessionId, text: 'hello', clientRequestId: 'c1' },
      collector.sink
    )
    await collector.done

    expect(order).toEqual(['sanitize', 'params', 'provider', 'turn-end'])
    expect(ack.requestId).toBeTruthy()
  })

  // S-004 #26: 输入只有危险字符、清理后为空时不调用 provider
  it('does not call provider when input is only dangerous chars (empty after sanitize)', async () => {
    const faux = createFauxProvider()
    faux.setResponses([{ type: 'text', text: 'should not be called' }])

    const service = makeChatService(faux)
    const sessionId = service.createSession()
    const collector = makeCollector()

    // 零宽空格 + 方向覆盖字符 + BOM + 软连字符（sanitize 后为空）
    // 注意：ZWJ(U+200D) 和 ZWNJ(U+200C) 被 unicode.ts 明确保留，不在此用
    const dangerousInput = '​‪‮﻿­⁠'

    await service.send({ sessionId, text: dangerousInput, clientRequestId: 'c1' }, collector.sink)
    await collector.done

    // provider 未被调用
    expect(faux.callCount()).toBe(0)

    // 仍发射了 started -> completed 事件
    expect(collector.events[0].type).toBe('started')
    expect(collector.events[collector.events.length - 1].type).toBe('completed')
  })

  // S-004 #27: 同 session 有 active turn 时拒绝第二次 send
  it('rejects second send when session has active turn', async () => {
    const faux = createFauxProvider()
    // 延迟响应，确保第一轮仍在进行
    faux.setResponses([{ type: 'text', text: 'response', delayMs: 500 }])

    const service = makeChatService(faux)
    const sessionId = service.createSession()
    const collector1 = makeCollector()

    // 第一轮 send
    await service.send({ sessionId, text: 'first', clientRequestId: 'c1' }, collector1.sink)

    // 第一轮仍在 active，第二轮应被拒绝
    await expect(
      service.send({ sessionId, text: 'second', clientRequestId: 'c2' }, makeCollector().sink)
    ).rejects.toThrow()

    // 等待第一轮完成
    await collector1.done
  })

  // S-001 P1-23: 单一 turnId（requestId）贯穿全轮
  it('uses single requestId throughout all events', async () => {
    const faux = createFauxProvider()
    faux.setResponses([
      { type: 'text', text: 'Hello ', chunkSize: 3 },
      { type: 'text', text: 'world' }
    ])
    // 上面的 setResponses 会把两个 step 都放入队列，但我们只需一个响应
    // 修正：只放一个 text step
    faux.setResponses([{ type: 'text', text: 'Hello world', chunkSize: 5 }])

    const service = makeChatService(faux)
    const sessionId = service.createSession()
    const collector = makeCollector()

    const ack = await service.send({ sessionId, text: 'hi', clientRequestId: 'c1' }, collector.sink)
    await collector.done

    // 所有事件的 requestId 一致
    const requestIds = new Set(collector.events.map((e) => e.requestId))
    expect(requestIds.size).toBe(1)
    expect(collector.events[0].requestId).toBe(ack.requestId)

    // 事件顺序：started(0) -> chunk(1...) -> completed(N)
    expect(collector.events[0].type).toBe('started')
    expect((collector.events[0] as { sequence: number }).sequence).toBe(0)

    const chunkEvents = collector.events.filter((e) => e.type === 'chunk')
    expect(chunkEvents.length).toBeGreaterThan(0)

    // sequence 单调递增
    let prevSeq = -1
    for (const ev of collector.events) {
      const seq = (ev as { sequence: number }).sequence
      expect(seq).toBeGreaterThan(prevSeq)
      prevSeq = seq
    }

    // 最后一个事件是 completed
    const lastEvent = collector.events[collector.events.length - 1]
    expect(lastEvent.type).toBe('completed')
  })

  // S-001 P1-23: 失败只终止当前轮，后续可正常发送
  it('failure terminates only current turn; next send works', async () => {
    const faux = createFauxProvider()

    const service = makeChatService(faux)
    const sessionId = service.createSession()

    // 第一轮：provider 错误
    faux.setResponses([{ type: 'error', code: 'LLM_SERVER' }])
    const collector1 = makeCollector()
    await service.send({ sessionId, text: 'first', clientRequestId: 'c1' }, collector1.sink)
    await collector1.done

    // 第一轮 failed
    expect(collector1.events[collector1.events.length - 1].type).toBe('failed')

    // active turn 已清除
    expect(service.hasActiveTurn(sessionId)).toBe(false)

    // 第二轮：正常
    faux.setResponses([{ type: 'text', text: 'recovered' }])
    const collector2 = makeCollector()
    await service.send({ sessionId, text: 'second', clientRequestId: 'c2' }, collector2.sink)
    await collector2.done

    expect(collector2.events[collector2.events.length - 1].type).toBe('completed')
  })

  // S-001 P1-23: 用户消息始终保持 user role
  it('preserves user message role as user in LlmRequest', async () => {
    const faux = createFauxProvider()
    faux.setResponses([{ type: 'text', text: 'response' }])

    const service = makeChatService(faux)
    const sessionId = service.createSession()
    const collector = makeCollector()

    await service.send({ sessionId, text: '你好世界', clientRequestId: 'c1' }, collector.sink)
    await collector.done

    // 验证 provider 收到的请求
    const calls = faux.calls()
    expect(calls.length).toBe(1)
    const messages = calls[0].messages

    // 第一条是 system prompt
    expect(messages[0].role).toBe('system')

    // 最后一条是用户消息，role=user（content 带 `[YYYY-MM-DD HH:MM] ` 时间前缀——datetime-prefix）
    const lastMsg = messages[messages.length - 1]
    expect(lastMsg.role).toBe('user')
    expect(lastMsg.content).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] 你好世界$/)

    // 用户消息不出现在 system 内容中（冻结合同 §1.0）
    expect(messages[0].content).not.toContain('你好世界')
  })

  // S-001 P1-23: 事件顺序固定 started -> chunk -> completed
  it('emits events in fixed order: started -> chunks -> completed', async () => {
    const faux = createFauxProvider()
    faux.setResponses([{ type: 'text', text: 'abc', chunkSize: 1 }])

    const service = makeChatService(faux)
    const sessionId = service.createSession()
    const collector = makeCollector()

    await service.send({ sessionId, text: 'hi', clientRequestId: 'c1' }, collector.sink)
    await collector.done

    const types = collector.events.map((e) => e.type)
    expect(types[0]).toBe('started')
    expect(types[types.length - 1]).toBe('completed')
    // 中间全是 chunk
    for (let i = 1; i < types.length - 1; i++) {
      expect(types[i]).toBe('chunk')
    }
  })

  // reasoning chunk：emit reasoning 事件 + 保存到消息 reasoning 字段
  it('emits reasoning events and stores reasoning on assistant message', async () => {
    // 自定义 provider：交替产生 reasoning 和 delta chunk
    const reasoningProvider: import('../llm/types').LLMProvider = {
      async *stream() {
        yield { type: 'reasoning', text: '用户在' }
        yield { type: 'reasoning', text: '问好，' }
        yield { type: 'reasoning', text: '我应该热情回应。' }
        yield { type: 'delta', text: '你好！' }
        yield { type: 'usage', inputTokens: 10, outputTokens: 5 }
      }
    }

    const service = createChatService({
      logger: noopLogger(),
      promptLoader: makeTestLoader(),
      sessionStore: createMemorySessionStore(),
      providerFactory: () => ({
        provider: reasoningProvider,
        capabilities: { contextWindow: 64000, maxOutputTokens: 2048 }
      })
    })
    const sessionId = service.createSession()
    const collector = makeCollector()

    await service.send({ sessionId, text: 'hi', clientRequestId: 'c1' }, collector.sink)
    await collector.done

    // 事件顺序：started -> reasoning*3 -> chunk -> completed
    const types = collector.events.map((e) => e.type)
    expect(types[0]).toBe('started')
    expect(types[1]).toBe('reasoning')
    expect(types[2]).toBe('reasoning')
    expect(types[3]).toBe('reasoning')
    expect(types[4]).toBe('chunk')
    expect(types[types.length - 1]).toBe('completed')

    // reasoning 内容完整保存到消息
    const snapshot = service.list(sessionId, 10)
    const assistantMsg = snapshot.messages.find((m) => m.role === 'assistant')
    expect(assistantMsg?.reasoning).toBe('用户在问好，我应该热情回应。')
    expect(assistantMsg?.content).toBe('你好！')
  })

  it('does not include reasoning field when provider sends no reasoning', async () => {
    const faux = createFauxProvider()
    faux.setResponses([{ type: 'text', text: 'plain' }])

    const service = makeChatService(faux)
    const sessionId = service.createSession()
    const collector = makeCollector()

    await service.send({ sessionId, text: 'hi', clientRequestId: 'c1' }, collector.sink)
    await collector.done

    const snapshot = service.list(sessionId, 10)
    const assistantMsg = snapshot.messages.find((m) => m.role === 'assistant')
    expect(assistantMsg?.reasoning).toBeUndefined()
    expect(assistantMsg?.content).toBe('plain')
  })

  // 取消：发射 cancelled 事件
  it('emits cancelled event when cancel is called during streaming', async () => {
    const faux = createFauxProvider()
    faux.setResponses([{ type: 'text', text: 'long response', chunkSize: 1, delayMs: 100 }])

    const service = makeChatService(faux)
    const sessionId = service.createSession()
    const collector = makeCollector()

    const ack = await service.send({ sessionId, text: 'hi', clientRequestId: 'c1' }, collector.sink)

    // 等一小段时间让 started 发射，然后取消
    await new Promise((r) => setTimeout(r, 50))
    service.cancel(ack.requestId)

    await collector.done

    const lastEvent = collector.events[collector.events.length - 1]
    expect(lastEvent.type).toBe('cancelled')
    expect(service.hasActiveTurn(sessionId)).toBe(false)
  })

  // provider 错误：发射 failed 事件，保留已接收文本
  it('emits failed event with error code on provider error', async () => {
    const faux = createFauxProvider()
    faux.setResponses([{ type: 'error', code: 'LLM_AUTH', afterChars: 5 }])

    const service = makeChatService(faux)
    const sessionId = service.createSession()
    const collector = makeCollector()

    await service.send({ sessionId, text: 'hi', clientRequestId: 'c1' }, collector.sink)
    await collector.done

    const failedEvent = collector.events.find((e) => e.type === 'failed')
    expect(failedEvent).toBeDefined()
    if (failedEvent && failedEvent.type === 'failed') {
      expect(failedEvent.error.code).toBe('LLM_AUTH')
      expect(failedEvent.error.message).toBeTruthy()
      expect(failedEvent.error.retryable).toBe(false)
    }
  })

  // turn.end 始终执行（即使失败）
  it('runs turn.end hook even on failure', async () => {
    const faux = createFauxProvider()
    faux.setResponses([{ type: 'error', code: 'LLM_SERVER' }])

    let turnEndCalled = false
    let turnEndStatus = ''
    registerHook({
      name: 'track-turn-end-fail',
      event: LifecycleEvent.TURN_END,
      priority: 200,
      fn: (_ctx, data) => {
        turnEndCalled = true
        turnEndStatus = (data as { status: string }).status
        return {}
      }
    })

    const service = makeChatService(faux)
    const sessionId = service.createSession()
    const collector = makeCollector()

    await service.send({ sessionId, text: 'hi', clientRequestId: 'c1' }, collector.sink)
    await collector.done

    expect(turnEndCalled).toBe(true)
    expect(turnEndStatus).toBe('failed')
  })

  // turn.end 始终执行（取消时）
  it('runs turn.end hook even on cancel', async () => {
    const faux = createFauxProvider()
    faux.setResponses([{ type: 'text', text: 'long', delayMs: 200 }])

    let turnEndCalled = false
    let turnEndStatus = ''
    registerHook({
      name: 'track-turn-end-cancel',
      event: LifecycleEvent.TURN_END,
      priority: 200,
      fn: (_ctx, data) => {
        turnEndCalled = true
        turnEndStatus = (data as { status: string }).status
        return {}
      }
    })

    const service = makeChatService(faux)
    const sessionId = service.createSession()
    const collector = makeCollector()

    const ack = await service.send({ sessionId, text: 'hi', clientRequestId: 'c1' }, collector.sink)

    await new Promise((r) => setTimeout(r, 50))
    service.cancel(ack.requestId)
    await collector.done

    expect(turnEndCalled).toBe(true)
    expect(turnEndStatus).toBe('cancelled')
  })

  // 多轮对话：历史正确传递
  it('passes conversation history to provider across turns', async () => {
    const faux = createFauxProvider()
    faux.setResponses([{ type: 'text', text: 'first response' }])

    const service = makeChatService(faux)
    const sessionId = service.createSession()
    const collector1 = makeCollector()

    await service.send(
      { sessionId, text: 'first question', clientRequestId: 'c1' },
      collector1.sink
    )
    await collector1.done

    // 第二轮
    faux.setResponses([{ type: 'text', text: 'second response' }])
    const collector2 = makeCollector()
    await service.send(
      { sessionId, text: 'second question', clientRequestId: 'c2' },
      collector2.sink
    )
    await collector2.done

    // 第二轮的请求应包含第一轮的 user + assistant 消息
    const calls = faux.calls()
    expect(calls.length).toBe(2)
    const secondMessages = calls[1].messages

    // system + user1 + assistant1 + user2
    // user 消息带 `[YYYY-MM-DD HH:MM] ` 时间前缀（datetime-prefix，仅装配时附加）
    const userMessages = secondMessages.filter((m) => m.role === 'user')
    expect(userMessages.length).toBe(2)
    expect(userMessages[0].content).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] first question$/)
    expect(userMessages[1].content).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] second question$/)

    const assistantMessages = secondMessages.filter((m) => m.role === 'assistant')
    expect(assistantMessages.length).toBe(1)
    expect(assistantMessages[0].content).toBe('first response')
  })

  // list 返回会话消息
  it('list returns session messages as views', async () => {
    const faux = createFauxProvider()
    faux.setResponses([{ type: 'text', text: 'response' }])

    const service = makeChatService(faux)
    const sessionId = service.createSession()
    const collector = makeCollector()

    await service.send({ sessionId, text: 'hello', clientRequestId: 'c1' }, collector.sink)
    await collector.done

    const history = service.list(sessionId, 100)
    expect(history.sessionId).toBe(sessionId)
    // user + assistant = 2 messages
    expect(history.messages.length).toBe(2)
    expect(history.messages[0].role).toBe('user')
    expect(history.messages[0].content).toBe('hello')
    expect(history.messages[0].status).toBe('complete')
    expect(history.messages[1].role).toBe('assistant')
    expect(history.messages[1].content).toBe('response')
    expect(history.messages[1].status).toBe('complete')
  })

  // cancel 不存在的 requestId 返回 false
  it('cancel returns false for unknown requestId', () => {
    const faux = createFauxProvider()
    const service = makeChatService(faux)

    expect(service.cancel('nonexistent-id')).toBe(false)
  })

  // ACK 在 started 事件之前返回
  it('returns ACK before started event is emitted', async () => {
    const faux = createFauxProvider()
    faux.setResponses([{ type: 'text', text: 'response', delayMs: 100 }])

    const service = makeChatService(faux)
    const sessionId = service.createSession()

    let startedReceived = false
    const sink: ChatEventSink = (event) => {
      if (event.type === 'started') {
        startedReceived = true
      }
    }

    const ack = await service.send({ sessionId, text: 'hi', clientRequestId: 'c1' }, sink)

    // ACK 已返回，但 started 尚未发射（因为 send 在 started 之前返回）
    expect(ack.requestId).toBeTruthy()
    // 给一点时间让 started 发射
    await new Promise((r) => setTimeout(r, 10))
    expect(startedReceived).toBe(true)

    // 等待完成以清理 active turn
    await new Promise((r) => setTimeout(r, 200))
  })

  // AppError 被正确抛出（active turn 拒绝）
  it('throws AppError with CHAT_BUSY when active turn exists', async () => {
    const faux = createFauxProvider()
    faux.setResponses([{ type: 'text', text: 'response', delayMs: 500 }])

    const service = makeChatService(faux)
    const sessionId = service.createSession()
    const collector = makeCollector()

    await service.send({ sessionId, text: 'first', clientRequestId: 'c1' }, collector.sink)

    try {
      await service.send({ sessionId, text: 'second', clientRequestId: 'c2' }, makeCollector().sink)
      expect.fail('should have thrown')
    } catch (err) {
      expect(isAppError(err)).toBe(true)
      if (isAppError(err)) {
        expect(err.code).toBe('CHAT_BUSY')
      }
    }

    await collector.done
  })

  // C-β R-3：必须真正并发，串行测试无法覆盖 busy-check 与登记之间的 TOCTOU。
  it('concurrent sends for one session allow exactly one and reject the other with CHAT_BUSY', async () => {
    const faux = createFauxProvider()
    faux.setResponses([
      { type: 'text', text: 'first response', delayMs: 20 },
      { type: 'text', text: 'second response', delayMs: 20 }
    ])
    const service = makeChatService(faux)
    const sessionId = service.createSession()
    const collector1 = makeCollector()
    const collector2 = makeCollector()

    const results = await Promise.all([
      service.send({ sessionId, text: 'first', clientRequestId: 'c1' }, collector1.sink).then(
        (value) => ({ ok: true as const, value, collector: collector1 }),
        (error: unknown) => ({ ok: false as const, error, collector: collector1 })
      ),
      service.send({ sessionId, text: 'second', clientRequestId: 'c2' }, collector2.sink).then(
        (value) => ({ ok: true as const, value, collector: collector2 }),
        (error: unknown) => ({ ok: false as const, error, collector: collector2 })
      )
    ])

    const fulfilled = results.filter((r) => r.ok)
    const rejected = results.filter((r) => !r.ok)
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(isAppError(rejected[0].error)).toBe(true)
    if (isAppError(rejected[0].error)) {
      expect(rejected[0].error.code).toBe('CHAT_BUSY')
    }

    await Promise.all(fulfilled.map((r) => r.collector.done))
  })

  it('duplicate clientRequestId returns the same ACK and creates only one turn', async () => {
    const faux = createFauxProvider()
    faux.setResponses([
      { type: 'text', text: 'only response', delayMs: 10 },
      { type: 'text', text: 'must not run', delayMs: 10 }
    ])
    const service = makeChatService(faux)
    const sessionId = service.createSession()
    const collector = makeCollector()
    const duplicateCollector = makeCollector()
    const request = { sessionId, text: 'same request', clientRequestId: 'client-same' }

    const [ack1, ack2] = await Promise.all([
      service.send(request, collector.sink),
      service.send(request, duplicateCollector.sink)
    ])

    expect(ack2).toEqual(ack1)
    const historyAtAck = service.list(sessionId, 100)
    expect(historyAtAck.messages.filter((m) => m.role === 'user')).toHaveLength(1)

    await collector.done
    expect(faux.callCount()).toBe(1)
  })

  it('迟到的旧轮次 release 不得删除新轮次的 session 所有权', () => {
    const owners = new Map<string, string>([['s1', 'request-B']])

    releaseSessionTurnOwnership(owners, 's1', 'request-A')

    expect(owners.get('s1')).toBe('request-B')
  })
})
