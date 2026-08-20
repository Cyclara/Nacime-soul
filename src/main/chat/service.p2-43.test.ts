// src/main/chat/service.p2-43.test.ts
// P2-43: ChatService + SQLiteSessionStore + 幂等账本跨重启集成。
// 依据：S-002-补充-P2-43 §5 #4/#5/#7。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'node:path'
import { createChatService, type ChatEventSink, type ChatService } from './service'
import type { SessionStore } from './session-store'
import { createSQLiteSessionStore } from './sqlite-session-store'
import {
  createIdempotencyLedger,
  hashIdempotencyText,
  type IdempotencyLedger
} from './idempotency-ledger'
import { createFauxProvider, type FauxProviderHandle } from '../llm/providers/faux'
import { createMemoryPromptLoader } from '../prompts/loader'
import { registerHook, clearHooks } from '../hooks/registry'
import { setHookRunnerLogger } from '../hooks/runner'
import { sanitizeMessageHook } from '../hooks/builtin/sanitize-message'
import type { ChatStreamEvent } from '@shared/chat/types'
import { makeMemoryDb, testNoopLogger, type TestDb } from '../../../tests/helpers/test-db'

let t: TestDb

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
  sessionStore: SessionStore,
  idempotencyLedger: IdempotencyLedger
): ChatService {
  return createChatService({
    logger: testNoopLogger,
    promptLoader: makeTestLoader(),
    sessionStore,
    idempotencyLedger,
    providerFactory: () => ({
      provider: faux,
      capabilities: { contextWindow: 64_000, maxOutputTokens: 2_048 }
    })
  })
}

beforeEach(async () => {
  t = await makeMemoryDb()
  clearHooks()
  setHookRunnerLogger(testNoopLogger)
  registerHook(sanitizeMessageHook)
})
afterEach(() => {
  clearHooks()
  t.cleanup()
})

describe('P2-43 ChatService 跨重启幂等', () => {
  it('completed 记录跨实例重放原 ACK：不写第二条用户消息、provider 0 调用', async () => {
    const ledgerPath = join(t.dataDir, 'chat-idempotency.json')
    const store1 = createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    const ledger1 = createIdempotencyLedger({ filePath: ledgerPath, logger: testNoopLogger })
    const faux1 = createFauxProvider()
    faux1.setResponses([{ type: 'text', text: '第一次完成' }])
    const service1 = makeService(faux1, store1, ledger1)
    const sessionId = service1.createSession()
    const request = { sessionId, text: '同一请求', clientRequestId: 'client-persisted' }
    const collector1 = makeCollector()

    const ack1 = await service1.send(request, collector1.sink)
    await collector1.done
    await vi.waitFor(() => expect(ledger1.get('client-persisted')?.state).toBe('completed'))
    expect(faux1.callCount()).toBe(1)
    const messagesBeforeRestart = store1.getMessages(sessionId, 100)
    expect(messagesBeforeRestart.filter((m) => m.role === 'user')).toHaveLength(1)

    // M-28：put 走防抖写盘，重启前 flushNow 落盘
    ledger1.flushNow()

    // 模拟 main 重启：新 ChatService + 新账本实例（进程内 clientRequests 已空）
    const store2 = createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    const ledger2 = createIdempotencyLedger({ filePath: ledgerPath, logger: testNoopLogger })
    const faux2 = createFauxProvider()
    faux2.setResponses([{ type: 'text', text: '绝不应调用' }])
    const service2 = makeService(faux2, store2, ledger2)
    const replayEvents: ChatStreamEvent[] = []

    const ack2 = await service2.send(request, (event) => replayEvents.push(event))

    expect(ack2).toEqual(ack1)
    expect(faux2.callCount()).toBe(0)
    expect(replayEvents).toEqual([]) // 终态重放不伪造第二条流
    const messagesAfterRestart = store2.getMessages(sessionId, 100)
    expect(messagesAfterRestart).toEqual(messagesBeforeRestart)
    expect(messagesAfterRestart.filter((m) => m.role === 'user')).toHaveLength(1)
  })

  it('failed 记录跨实例走逃生门：删除死记录并真实重跑', async () => {
    const ledgerPath = join(t.dataDir, 'chat-idempotency.json')
    const store1 = createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    const ledger1 = createIdempotencyLedger({ filePath: ledgerPath, logger: testNoopLogger })
    const faux1 = createFauxProvider()
    faux1.setResponses([{ type: 'error', code: 'NET_TIMEOUT', afterChars: 0 }])
    const service1 = makeService(faux1, store1, ledger1)
    const sessionId = service1.createSession()
    const request = { sessionId, text: '失败后重试', clientRequestId: 'client-failed' }
    const collector1 = makeCollector()

    const ack1 = await service1.send(request, collector1.sink)
    await collector1.done
    await vi.waitFor(() => expect(ledger1.get('client-failed')?.state).toBe('failed'))
    // M-28：防抖写盘，重启前 flushNow 落盘（否则 ledger2 看不到 failed 记录，逃生门测不到）
    ledger1.flushNow()

    // 模拟重启后用同 clientRequestId 重试：failed 不能返回死 ACK，必须真实跑一轮
    const store2 = createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    const ledger2 = createIdempotencyLedger({ filePath: ledgerPath, logger: testNoopLogger })
    const faux2 = createFauxProvider()
    faux2.setResponses([{ type: 'text', text: '重试成功' }])
    const service2 = makeService(faux2, store2, ledger2)
    const collector2 = makeCollector()

    const ack2 = await service2.send(request, collector2.sink)
    await collector2.done
    await vi.waitFor(() => expect(ledger2.get('client-failed')?.state).toBe('completed'))

    expect(ack2.requestId).not.toBe(ack1.requestId)
    expect(faux2.callCount()).toBe(1)
    // retry 本来就是新一轮语义：旧失败 user + 新 retry user 各一条
    expect(store2.getMessages(sessionId, 100).filter((m) => m.role === 'user')).toHaveLength(2)
  })

  it('持久记录 key 被不同 session/text 复用 -> IPC_VALIDATION（不误重放）', async () => {
    const ledgerPath = join(t.dataDir, 'chat-idempotency.json')
    const store = createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    const ledger = createIdempotencyLedger({ filePath: ledgerPath, logger: testNoopLogger })
    ledger.put('same-key', {
      sessionId: 's-original',
      textHash: hashIdempotencyText('原文'),
      ack: { requestId: 'r1', userMessageId: 'u1', assistantMessageId: 'a1' },
      state: 'completed',
      createdAt: 1
    })
    const faux = createFauxProvider()
    const service = makeService(faux, store, ledger)

    await expect(
      service.send({ sessionId: 's-other', text: '不同', clientRequestId: 'same-key' }, () => {})
    ).rejects.toMatchObject({ code: 'IPC_VALIDATION' })
    expect(faux.callCount()).toBe(0)
  })
})

describe('V-03a 复现：流式中段关闭 sessionDb（模拟 before-quit）的写盘行为', () => {
  // 审计待验证项 V-03a（修复清单第四部分，index.ts:497-502）：
  //   before-quit 同步执行 sessionDb.close()，不等待 in-flight turn。
  //   本测试在流式中段关闭 DB，存档"终态写盘撞上已关闭连接"的当前行为。
  it('终态写盘撞上已关闭 DB：completed/failed 均未送达 sink（当前行为存档）', async () => {
    const ledgerPath = join(t.dataDir, 'chat-idempotency-v03a.json')
    const store = createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    const ledger = createIdempotencyLedger({ filePath: ledgerPath, logger: testNoopLogger })
    const faux = createFauxProvider()
    // 慢流：小 chunk + 延迟，保证能在流中段关库（500 字符 / 4 = 125 chunks × 5ms ≈ 0.6s）
    faux.setResponses([{ type: 'text', text: '很长的回复'.repeat(100), chunkSize: 4, delayMs: 5 }])
    const service = makeService(faux, store, ledger)
    const sessionId = service.createSession()
    const collector = makeCollector()

    await service.send(
      { sessionId, text: '中途退出', clientRequestId: 'client-quit-v03a' },
      collector.sink
    )
    // 等流确实开始（首个 chunk 到达）
    await vi.waitFor(() => expect(collector.events.some((e) => e.type === 'chunk')).toBe(true))

    // 模拟 before-quit（index.ts:500 sessionDb.close()）
    t.db.close()

    // 给流留出收尾时间（终态事件到达或超时——预测无终态事件，故必然等满）
    await Promise.race([collector.done, new Promise((r) => setTimeout(r, 1500))])

    const types = collector.events.map((e) => e.type)
    // ⚠️ 当前行为存档（V-03a 确认）：
    //   provider 流正常产出完毕，但 completion 写盘撞上已关闭的 DB 抛 SqliteError；
    //   外层 catch 的 failed 标记写盘（service.ts:665）同样抛错，导致 sink 的
    //   failed 事件（:684）被跳过——renderer 收不到任何终态事件（表现为永远"转圈"），
    //   只能靠 send() 的 .catch 安全网（:316）记日志。
    //   真实退出时进程随 quit 结束：影响 = 该轮回复正文未落盘 + 无终态事件；
    //   下次启动由幂等账本的 failed/残留路径兜底重跑。
    expect(types).toContain('chunk')
    expect(types).not.toContain('completed')
    expect(types).not.toContain('failed')
  })
})
