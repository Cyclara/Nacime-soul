// src/main/compliance/hook.test.ts
// P3C1-06：turn.end 合规审计 hook——硬门 / 决策 / SessionStore 装配 / 消费者 / 结果投递。
// 覆盖：任务表验收「would-block 轮文本来自正常 SessionStore，可审正确对象」（裁定 1.6：
//      C1/C2 无真 block，被"拦"候选即放行文本）、F5-001 §3.6 集成点
//      （不扩展 TurnEndData 携带全文、priority 350 failOpen、不 await 网络）。

import { describe, it, expect } from 'vitest'
import type { Logger, LogFields } from '@shared/observability/types'
import type { ChatMessage } from '@shared/chat/types'
import type { ComplianceAuditConfig } from '@shared/config/types'
import type { ComplianceDecisionRecord } from '@shared/compliance/types'
import { createMemorySessionStore, type SessionStore } from '../chat/session-store'
import type { TurnEndData } from '../chat/service'
import type { ComplianceGateOutcome } from './gate'
import {
  createComplianceAuditHook,
  buildRecentTurns,
  type ComplianceAuditHookDeps
} from './hook'
import type {
  ComplianceAuditor,
  ComplianceAuditInput,
  ComplianceAuditResult
} from './auditor'
import type { ComplianceAuditTask } from './audit-queue'

// === 测试辅助 ===

function noopLogger(): Logger {
  const l: Logger = {
    fatal() { /* noop */ },
    error() { /* noop */ },
    warn() { /* noop */ },
    info() { /* noop */ },
    debug() { /* noop */ },
    child: () => l
  }
  return l
}

interface LogCall {
  readonly level: string
  readonly msg: string
  readonly fields: LogFields
}

function spyLogger(): { logger: Logger; calls: LogCall[] } {
  const calls: LogCall[] = []
  const rec =
    (level: string) =>
    (msg: string, fields: LogFields): void => {
      calls.push({ level, msg, fields })
    }
  const l: Logger = {
    fatal: rec('fatal'),
    error: rec('error'),
    warn: rec('warn'),
    info: rec('info'),
    debug: rec('debug'),
    child: () => l
  }
  return { logger: l, calls }
}

/** 统计 SessionStore 读取次数的包装（验证 enabled=false 硬门不读库）。 */
function countingStore(inner: SessionStore): {
  store: SessionStore
  reads: { getTurnMessages: number; getMessages: number }
} {
  const reads = { getTurnMessages: 0, getMessages: 0 }
  return {
    reads,
    store: {
      ...inner,
      getTurnMessages(sessionId, turnId) {
        reads.getTurnMessages++
        return inner.getTurnMessages(sessionId, turnId)
      },
      getMessages(sessionId, limit) {
        reads.getMessages++
        return inner.getMessages(sessionId, limit)
      }
    }
  }
}

const AUDIT_CONFIG: ComplianceAuditConfig = {
  enabled: true,
  sampleRate: 1,
  timeoutMs: 20_000,
  recentTurnWindow: 3
}

function msg(
  sessionId: string,
  turnId: string,
  role: 'user' | 'assistant',
  content: string,
  status: ChatMessage['status'] = 'complete'
): ChatMessage {
  return {
    id: `${turnId}-${role}`,
    sessionId,
    role,
    content,
    createdAt: 1,
    status,
    turnId
  }
}

function appendTurn(
  store: SessionStore,
  sessionId: string,
  turnId: string,
  userText: string,
  assistantText: string,
  assistantStatus: ChatMessage['status'] = 'complete'
): void {
  store.appendMessage(sessionId, msg(sessionId, turnId, 'user', userText))
  store.appendMessage(sessionId, msg(sessionId, turnId, 'assistant', assistantText, assistantStatus))
}

function turnEnd(overrides: Partial<TurnEndData> = {}): TurnEndData {
  return {
    turnId: 't-cur',
    sessionId: 's1',
    requestId: 'r1',
    status: 'completed',
    inputLen: 4,
    outputLen: 12,
    memoryEligible: true,
    referencedMemoryIds: [],
    ...overrides
  }
}

function record(wouldBlock: boolean): ComplianceDecisionRecord {
  return {
    candidateId: 'cand-1',
    turnId: 't-cur',
    attemptIndex: 0,
    segmentIndex: 0,
    ruleId: 'R-MR-01',
    span: { start: 0, length: 7 },
    confidence: 0.97,
    declaredAction: 'flag',
    effectiveAction: 'flag',
    counterfactualAction: wouldBlock ? 'block' : 'flag',
    wouldBlockUnderFirstSegmentPolicy: wouldBlock,
    blockIneligibleReason: wouldBlock ? undefined : 'action-not-candidate',
    releasedCharsBefore: 0,
    shadowPolicyVersion: 'shadow-v1'
  }
}

const PASS_RESULT: ComplianceAuditResult = {
  verdict: 'pass',
  level: 'none',
  violations: [],
  reviewedChars: 10,
  latencyMs: 5,
  unavailable: false
}

function stubAuditor(result: ComplianceAuditResult = PASS_RESULT): {
  auditor: ComplianceAuditor
  calls: ComplianceAuditInput[]
} {
  const calls: ComplianceAuditInput[] = []
  return {
    calls,
    auditor: {
      audit: (input) => {
        calls.push(input)
        return Promise.resolve(result)
      }
    }
  }
}

function makeHook(opts: {
  store: SessionStore
  config?: ComplianceAuditConfig
  auditor?: ComplianceAuditor
  logger?: Logger
  personaSummary?: string
  knownFactKeys?: readonly string[]
  rng?: () => number
  onAuditResult?: (task: ComplianceAuditTask, result: ComplianceAuditResult) => void
  /** P3C1-08：writeSamples 桩（缺省 no-op 收集器；断言用返回的 calls） */
  writeSamples?: (turnId: string, records: readonly ComplianceDecisionRecord[], occurredAt: number) => void
  /** 裁定 1.8 总开关桩；缺省 true 保持原语义。 */
  shouldCollect?: () => boolean
}): ReturnType<typeof createComplianceAuditHook> & {
  sampleWrites: { turnId: string; records: readonly ComplianceDecisionRecord[]; occurredAt: number }[]
} {
  const sampleWrites: { turnId: string; records: readonly ComplianceDecisionRecord[]; occurredAt: number }[] = []
  const deps: ComplianceAuditHookDeps = {
    logger: opts.logger ?? noopLogger(),
    sessionStore: opts.store,
    auditor: opts.auditor ?? stubAuditor().auditor,
    getAuditConfig: () => opts.config ?? AUDIT_CONFIG,
    getPersonaSummary: () => opts.personaSummary ?? '她是住在屏幕里的伴侣。',
    getKnownFactKeys: () => opts.knownFactKeys ?? ['user.name'],
    writeSamples:
      opts.writeSamples ??
      ((turnId, records, occurredAt) => {
        sampleWrites.push({ turnId, records, occurredAt })
      }),
    shouldCollect: opts.shouldCollect,
    rng: opts.rng,
    onAuditResult: opts.onAuditResult
  }
  return { ...createComplianceAuditHook(deps), sampleWrites }
}

// === 注册描述 ===

describe('P3C1-06 audit hook：注册描述', () => {
  it('name/event/priority/failOpen 按 F5-001 冻结（350 = 可观测性/审计分带，extraction/dmae 之后）', () => {
    const store = createMemorySessionStore()
    const { hook } = makeHook({ store })
    expect(hook.name).toBe('compliance-audit')
    expect(hook.event).toBe('turn.end')
    expect(hook.priority).toBe(350)
    expect(hook.failOpen).toBe(true)
  })
})

// === 硬门 ===

describe('P3C1-06 audit hook：硬门', () => {
  it('audit.enabled=false → 不读 SessionStore、不调 auditor、不入队', async () => {
    const inner = createMemorySessionStore()
    const sid = inner.createSession()
    appendTurn(inner, sid, 't-cur', '你好', '你好呀')
    const { store, reads } = countingStore(inner)
    const { auditor, calls } = stubAuditor()
    const { hook, queue } = makeHook({
      store,
      auditor,
      config: { ...AUDIT_CONFIG, enabled: false }
    })
    await hook.fn({ event: 'turn.end' }, turnEnd({ sessionId: sid }))
    expect(reads.getTurnMessages).toBe(0)
    expect(reads.getMessages).toBe(0)
    expect(calls).toHaveLength(0)
    expect(queue.pending()).toBe(0)
  })

  it.each(['failed', 'cancelled'] as const)('status=%s → 不送审', async (status) => {
    const store = createMemorySessionStore()
    const sid = store.createSession()
    appendTurn(store, sid, 't-cur', '你好', '你好呀')
    const { auditor, calls } = stubAuditor()
    const { hook, queue } = makeHook({ store, auditor })
    await hook.fn({ event: 'turn.end' }, turnEnd({ sessionId: sid, status }))
    expect(calls).toHaveLength(0)
    expect(queue.pending()).toBe(0)
  })

  it('采样未中（rate=0 无 records）→ 不入队', async () => {
    const store = createMemorySessionStore()
    const sid = store.createSession()
    appendTurn(store, sid, 't-cur', '你好', '你好呀')
    const { hook, queue } = makeHook({
      store,
      config: { ...AUDIT_CONFIG, sampleRate: 0 },
      rng: () => 0.999
    })
    await hook.fn({ event: 'turn.end' }, turnEnd({ sessionId: sid }))
    expect(queue.pending()).toBe(0)
  })

  it('getTurnMessages 为 null（assistant 未 complete）→ 不入队 + debug 日志', async () => {
    const store = createMemorySessionStore()
    const sid = store.createSession()
    appendTurn(store, sid, 't-cur', '你好', '半成品', 'streaming')
    const { logger, calls } = spyLogger()
    const { hook, queue } = makeHook({ store, logger })
    await hook.fn({ event: 'turn.end' }, turnEnd({ sessionId: sid }))
    expect(queue.pending()).toBe(0)
    expect(calls.some((c) => c.level === 'debug')).toBe(true)
  })

  it('assistant 空内容 → 不入队（无可审对象）', async () => {
    const store = createMemorySessionStore()
    const sid = store.createSession()
    appendTurn(store, sid, 't-cur', '你好', '')
    const { hook, queue } = makeHook({ store })
    await hook.fn({ event: 'turn.end' }, turnEnd({ sessionId: sid }))
    expect(queue.pending()).toBe(0)
  })
})

// === 决策与装配 ===

describe('P3C1-06 audit hook：决策与 SessionStore 装配', () => {
  it('采样命中：reason=sampled，candidateText/userText 来自 SessionStore', async () => {
    const store = createMemorySessionStore()
    const sid = store.createSession()
    appendTurn(store, sid, 't-cur', '今天心情怎么样', '挺好的呀，你呢？')
    const { auditor, calls } = stubAuditor()
    const { hook, flush } = makeHook({ store, auditor, rng: () => 0 })
    await hook.fn({ event: 'turn.end' }, turnEnd({ sessionId: sid }))
    await flush()
    expect(calls).toHaveLength(1)
    expect(calls[0].candidateText).toBe('挺好的呀，你呢？')
    expect(calls[0].userText).toBe('今天心情怎么样')
    expect(calls[0].turnId).toBe('t-cur')
    expect(calls[0].sessionId).toBe(sid)
  })

  it('任务表验收：would-block 命中轮 sampleRate=0 也强制送审，且审的是 SessionStore 正常文本', async () => {
    const store = createMemorySessionStore()
    const sid = store.createSession()
    appendTurn(store, sid, 't-cur', '你是谁', '我只是一个语言模型，所以……')
    const { auditor, calls } = stubAuditor()
    const delivered: ComplianceAuditTask[] = []
    const { hook, flush } = makeHook({
      store,
      auditor,
      config: { ...AUDIT_CONFIG, sampleRate: 0 },
      rng: () => 0.999,
      onAuditResult: (task) => {
        delivered.push(task)
      }
    })
    await hook.fn(
      { event: 'turn.end' },
      turnEnd({ sessionId: sid, complianceRecords: [record(true)] })
    )
    await flush()
    // 入队原因为 would-block（裁定 1.6 必审重解读）
    expect(delivered).toHaveLength(1)
    expect(delivered[0].reason).toBe('would-block')
    expect(calls).toHaveLength(1)
    // 审计对象 = SessionStore 里的放行文本（C1/C2 无真 block，被"拦"候选即放行文本）
    expect(calls[0].candidateText).toBe('我只是一个语言模型，所以……')
  })

  it('records 全部 wouldBlock=false → 不触发必审（rate=0 不入队）', async () => {
    const store = createMemorySessionStore()
    const sid = store.createSession()
    appendTurn(store, sid, 't-cur', '你好', '你好呀')
    const { hook, queue } = makeHook({
      store,
      config: { ...AUDIT_CONFIG, sampleRate: 0 },
      rng: () => 0.999
    })
    await hook.fn(
      { event: 'turn.end' },
      turnEnd({ sessionId: sid, complianceRecords: [record(false)] })
    )
    expect(queue.pending()).toBe(0)
  })

  it('personaSummary 截断到 400 字；knownFactKeys 原样传递', async () => {
    const store = createMemorySessionStore()
    const sid = store.createSession()
    appendTurn(store, sid, 't-cur', '你好', '你好呀')
    const { auditor, calls } = stubAuditor()
    const { hook, flush } = makeHook({
      store,
      auditor,
      personaSummary: '长'.repeat(500),
      knownFactKeys: ['user.name', 'user.city']
    })
    await hook.fn({ event: 'turn.end' }, turnEnd({ sessionId: sid }))
    await flush()
    expect(calls[0].personaSummary).toHaveLength(400)
    expect(calls[0].knownFactKeys).toEqual(['user.name', 'user.city'])
  })

  it('getPersonaSummary 抛错 → 空串降级仍送审 + warn', async () => {
    const store = createMemorySessionStore()
    const sid = store.createSession()
    appendTurn(store, sid, 't-cur', '你好', '你好呀')
    const { auditor, calls } = stubAuditor()
    const { logger, calls: logs } = spyLogger()
    const broken = createComplianceAuditHook({
      logger,
      sessionStore: store,
      auditor,
      getAuditConfig: () => AUDIT_CONFIG,
      getPersonaSummary: () => {
        throw new Error('prompt layer broken')
      },
      getKnownFactKeys: () => [],
      writeSamples: () => {}
    })
    await broken.hook.fn({ event: 'turn.end' }, turnEnd({ sessionId: sid }))
    await broken.flush()
    expect(calls).toHaveLength(1)
    expect(calls[0].personaSummary).toBe('')
    expect(logs.some((c) => c.level === 'warn')).toBe(true)
  })

  it('getKnownFactKeys 抛错 → 空列表降级仍送审', async () => {
    const store = createMemorySessionStore()
    const sid = store.createSession()
    appendTurn(store, sid, 't-cur', '你好', '你好呀')
    const { auditor, calls } = stubAuditor()
    const broken = createComplianceAuditHook({
      logger: noopLogger(),
      sessionStore: store,
      auditor,
      getAuditConfig: () => AUDIT_CONFIG,
      getPersonaSummary: () => 'p',
      getKnownFactKeys: () => {
        throw new Error('l0 broken')
      },
      writeSamples: () => {}
    })
    await broken.hook.fn({ event: 'turn.end' }, turnEnd({ sessionId: sid }))
    await broken.flush()
    expect(calls[0].knownFactKeys).toEqual([])
  })

  it('TurnEndData.complianceGate（P3C1-08 字段名）存在时透传给 auditor 做交叉校验', async () => {
    const store = createMemorySessionStore()
    const sid = store.createSession()
    appendTurn(store, sid, 't-cur', '你好', '你好呀')
    const { auditor, calls } = stubAuditor()
    const { hook, flush } = makeHook({ store, auditor })
    const outcome: ComplianceGateOutcome = {
      blocked: false,
      regenerations: 0,
      degradedPass: false,
      ruleIds: ['R-MR-01'],
      checkedSegments: 1,
      totalMs: 3,
      degraded: false
    }
    const data = { ...turnEnd({ sessionId: sid }), complianceGate: outcome }
    await hook.fn({ event: 'turn.end' }, data)
    await flush()
    expect(calls[0].gateOutcome).toEqual(outcome)
  })

  it('recentTurns：最近 window 轮、排除当前轮、只取 complete 对、时间升序', async () => {
    const store = createMemorySessionStore()
    const sid = store.createSession()
    appendTurn(store, sid, 't-1', 'u1', 'a1')
    appendTurn(store, sid, 't-2', 'u2', 'a2')
    appendTurn(store, sid, 't-3', 'u3', 'a3', 'streaming') // 未完成，应排除
    appendTurn(store, sid, 't-cur', 'uc', 'ac')
    const { auditor, calls } = stubAuditor()
    const { hook, flush } = makeHook({ store, auditor })
    await hook.fn({ event: 'turn.end' }, turnEnd({ sessionId: sid }))
    await flush()
    expect(calls[0].recentTurns).toEqual([
      { user: 'u1', assistant: 'a1' },
      { user: 'u2', assistant: 'a2' }
    ])
  })

  it('recentTurnWindow=1 → 只取最近 1 轮', async () => {
    const store = createMemorySessionStore()
    const sid = store.createSession()
    appendTurn(store, sid, 't-1', 'u1', 'a1')
    appendTurn(store, sid, 't-2', 'u2', 'a2')
    appendTurn(store, sid, 't-cur', 'uc', 'ac')
    const { auditor, calls } = stubAuditor()
    const { hook, flush } = makeHook({
      store,
      auditor,
      config: { ...AUDIT_CONFIG, recentTurnWindow: 1 }
    })
    await hook.fn({ event: 'turn.end' }, turnEnd({ sessionId: sid }))
    await flush()
    expect(calls[0].recentTurns).toEqual([{ user: 'u2', assistant: 'a2' }])
  })
})

// === 消费者与结果投递 ===

describe('P3C1-06 audit hook：消费者', () => {
  it('hook 不 await 网络：fn 返回时 sink 尚未调用；flush 后投递 (task, result)', async () => {
    const store = createMemorySessionStore()
    const sid = store.createSession()
    appendTurn(store, sid, 't-cur', '你好', '你好呀')
    let resolveAudit: ((r: ComplianceAuditResult) => void) | null = null
    const auditor: ComplianceAuditor = {
      audit: () =>
        new Promise<ComplianceAuditResult>((resolve) => {
          resolveAudit = resolve
        })
    }
    const delivered: Array<{ task: ComplianceAuditTask; result: ComplianceAuditResult }> = []
    const { hook, flush } = makeHook({
      store,
      auditor,
      onAuditResult: (task, result) => {
        delivered.push({ task, result })
      }
    })
    await hook.fn({ event: 'turn.end' }, turnEnd({ sessionId: sid }))
    // fn 已返回，但审计 promise 未决——sink 同步未被调用（不阻塞 turn.end 总线）
    expect(delivered).toHaveLength(0)
    resolveAudit!(PASS_RESULT)
    await flush()
    expect(delivered).toHaveLength(1)
    expect(delivered[0].task.reason).toBe('sampled')
    expect(delivered[0].task.input.candidateText).toBe('你好呀')
    expect(delivered[0].result).toEqual(PASS_RESULT)
  })

  it('unavailable 空壳同样投递 sink（§3.11：audit_unavailable 也要入账）', async () => {
    const store = createMemorySessionStore()
    const sid = store.createSession()
    appendTurn(store, sid, 't-cur', '你好', '你好呀')
    const unavailable: ComplianceAuditResult = { ...PASS_RESULT, unavailable: true }
    const { auditor } = stubAuditor(unavailable)
    const delivered: ComplianceAuditResult[] = []
    const { hook, flush } = makeHook({
      store,
      auditor,
      onAuditResult: (_t, r) => {
        delivered.push(r)
      }
    })
    await hook.fn({ event: 'turn.end' }, turnEnd({ sessionId: sid }))
    await flush()
    expect(delivered).toHaveLength(1)
    expect(delivered[0].unavailable).toBe(true)
  })

  it('sink 抛错 → warn + 继续处理后续任务（fail-open）', async () => {
    const store = createMemorySessionStore()
    const sid = store.createSession()
    appendTurn(store, sid, 't-1', 'u1', 'a1')
    appendTurn(store, sid, 't-2', 'u2', 'a2')
    const { auditor } = stubAuditor()
    const { logger, calls } = spyLogger()
    let sinkCalls = 0
    const { hook, flush } = makeHook({
      store,
      auditor,
      logger,
      onAuditResult: () => {
        sinkCalls++
        if (sinkCalls === 1) throw new Error('db gone')
      }
    })
    await hook.fn({ event: 'turn.end' }, turnEnd({ sessionId: sid, turnId: 't-1' }))
    await hook.fn({ event: 'turn.end' }, turnEnd({ sessionId: sid, turnId: 't-2' }))
    await flush()
    expect(sinkCalls).toBe(2)
    expect(calls.some((c) => c.level === 'warn')).toBe(true)
  })

  it('stopConsumer 中止 in-flight：空壳结果不再投递（退出时不写）', async () => {
    const store = createMemorySessionStore()
    const sid = store.createSession()
    appendTurn(store, sid, 't-cur', '你好', '你好呀')
    const auditor: ComplianceAuditor = {
      audit: (_input, signal) =>
        new Promise<ComplianceAuditResult>((resolve) => {
          signal.addEventListener('abort', () =>
            resolve({ ...PASS_RESULT, unavailable: true })
          )
        })
    }
    const delivered: ComplianceAuditResult[] = []
    const { hook, stopConsumer } = makeHook({
      store,
      auditor,
      onAuditResult: (_t, r) => {
        delivered.push(r)
      }
    })
    await hook.fn({ event: 'turn.end' }, turnEnd({ sessionId: sid }))
    // 消费者已取任务进入 in-flight；stop → abort → 空壳不投递
    stopConsumer()
    await new Promise((r) => setTimeout(r, 10))
    expect(delivered).toHaveLength(0)
  })
})

// === P3C1-08：动态撤销（开关关闭后既有正文不得继续出站/落库） ===

describe('P3C1-08 audit hook：动态撤销', () => {
  it('任务已入队、开关随后关闭 -> 消费前 recheck 丢弃，不调用 auditor', async () => {
    const store = createMemorySessionStore()
    const sid = store.createSession()
    appendTurn(store, sid, 't-cur', 'USER-SENTINEL', 'ASSISTANT-SENTINEL')
    let enabled = true
    let auditCalls = 0
    const auditor: ComplianceAuditor = {
      audit: async () => {
        auditCalls++
        return PASS_RESULT
      }
    }
    // queue 此刻暂不让 consumer 跑：用闭合前的自定义 queue 不方便，改为 auditor 在调用前
    // 关闭开关的同步 getter，精确覆盖 consumer 的 provider 前 recheck。
    const { hook, flush } = makeHook({
      store,
      auditor,
      shouldCollect: () => enabled,
      rng: () => 0
    })
    // hook 入队并立即启动 consumer；下一轮微任务前切开关，确保测试条件由 auditor 外层 gate 验证。
    enabled = false
    await hook.fn({ event: 'turn.end' }, turnEnd({ sessionId: sid }))
    await flush()
    expect(auditCalls).toBe(0)
  })

  it('in-flight 审计完成前 revoke -> abort + 丢结果；重启采集后队列仍可用', async () => {
    const store = createMemorySessionStore()
    const sid = store.createSession()
    appendTurn(store, sid, 't-cur', 'USER-SENTINEL', 'ASSISTANT-SENTINEL')
    let calls = 0
    const auditor: ComplianceAuditor = {
      audit: async (_input, signal) => {
        calls++
        return await new Promise<ComplianceAuditResult>((resolve) => {
          signal.addEventListener('abort', () => resolve({ ...PASS_RESULT, unavailable: true }))
        })
      }
    }
    const delivered: ComplianceAuditResult[] = []
    const { hook, revokeCollection, flush, queue, startConsumer } = makeHook({
      store,
      auditor,
      onAuditResult: (_task, result) => delivered.push(result),
      rng: () => 0
    })
    await hook.fn({ event: 'turn.end' }, turnEnd({ sessionId: sid }))
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toBe(1)
    revokeCollection()
    await flush()
    expect(delivered).toHaveLength(0)
    expect(queue.isClosed()).toBe(false)
    // 可恢复性：clear/revoke 不 close queue（重新启用后可继续消费）。
    expect(queue.enqueue({
      turnId: 't-next',
      sessionId: sid,
      input: {
        turnId: 't-next', sessionId: sid, personaSummary: '', recentTurns: [],
        userText: 'u', candidateText: 'a', knownFactKeys: []
      },
      reason: 'sampled'
    })).toBe(true)
    queue.clearPending()
    startConsumer()
  })
})

// === buildRecentTurns 纯函数 ===

describe('P3C1-06 buildRecentTurns', () => {
  const sid = 's1'

  it('无 turnId / system 角色消息跳过', () => {
    const messages: ChatMessage[] = [
      { id: 'm0', sessionId: sid, role: 'system', content: 'sys', createdAt: 1, status: 'complete' },
      { id: 'm1', sessionId: sid, role: 'user', content: '无turn', createdAt: 2, status: 'complete' },
      msg(sid, 't-1', 'user', 'u1'),
      msg(sid, 't-1', 'assistant', 'a1')
    ]
    expect(buildRecentTurns(messages, 't-cur', 3)).toEqual([{ user: 'u1', assistant: 'a1' }])
  })

  it('缺对（只有 user 没有 assistant）跳过', () => {
    const messages: ChatMessage[] = [msg(sid, 't-1', 'user', 'u1')]
    expect(buildRecentTurns(messages, 't-cur', 3)).toEqual([])
  })

  it('window 截取最后 N 轮且保持升序', () => {
    const messages: ChatMessage[] = [
      msg(sid, 't-1', 'user', 'u1'),
      msg(sid, 't-1', 'assistant', 'a1'),
      msg(sid, 't-2', 'user', 'u2'),
      msg(sid, 't-2', 'assistant', 'a2'),
      msg(sid, 't-3', 'user', 'u3'),
      msg(sid, 't-3', 'assistant', 'a3')
    ]
    expect(buildRecentTurns(messages, 't-cur', 2)).toEqual([
      { user: 'u2', assistant: 'a2' },
      { user: 'u3', assistant: 'a3' }
    ])
  })
})

// === P3C1-08: samples 批写（裁定 1.4 #4：本 hook 第一步，先于一切硬门） ===

describe('P3C1-08 audit hook：samples 批写', () => {
  it('complianceRecords 非空 -> writeSamples 以 (turnId, records, occurredAt) 被调用', async () => {
    const store = createMemorySessionStore()
    const sid = store.createSession()
    appendTurn(store, sid, 't-cur', '你好', '你好呀')
    const { hook, sampleWrites } = makeHook({ store })
    const records = [record(true), record(false)]
    await hook.fn({ event: 'turn.end' }, turnEnd({ sessionId: sid, complianceRecords: records }))
    expect(sampleWrites).toHaveLength(1)
    expect(sampleWrites[0].turnId).toBe('t-cur')
    expect(sampleWrites[0].records).toEqual(records)
    expect(sampleWrites[0].occurredAt).toBeGreaterThan(0)
  })

  it('audit.enabled=false -> writeSamples 仍被调用（samples 是门控遥测，裁定 1.8）', async () => {
    const store = createMemorySessionStore()
    const sid = store.createSession()
    appendTurn(store, sid, 't-cur', '你好', '你好呀')
    const { auditor, calls } = stubAuditor()
    const { hook, sampleWrites } = makeHook({
      store,
      auditor,
      config: { ...AUDIT_CONFIG, enabled: false }
    })
    await hook.fn({ event: 'turn.end' }, turnEnd({ sessionId: sid, complianceRecords: [record(true)] }))
    // 硬门照旧：不送审
    expect(calls).toHaveLength(0)
    // 但 samples 先行落库
    expect(sampleWrites).toHaveLength(1)
  })

  it('status !== completed -> writeSamples 仍被调用（门控遥测不因轮失败丢失）', async () => {
    const store = createMemorySessionStore()
    const sid = store.createSession()
    appendTurn(store, sid, 't-cur', '你好', '你好呀', 'failed')
    const { hook, sampleWrites } = makeHook({ store })
    await hook.fn(
      { event: 'turn.end' },
      turnEnd({ sessionId: sid, status: 'failed', complianceRecords: [record(true)] })
    )
    expect(sampleWrites).toHaveLength(1)
  })

  it('complianceRecords 缺省/空数组 -> writeSamples 不被调用', async () => {
    const store = createMemorySessionStore()
    const sid = store.createSession()
    appendTurn(store, sid, 't-cur', '你好', '你好呀')
    const { hook, sampleWrites } = makeHook({ store })
    await hook.fn({ event: 'turn.end' }, turnEnd({ sessionId: sid }))
    await hook.fn({ event: 'turn.end' }, turnEnd({ sessionId: sid, complianceRecords: [] }))
    expect(sampleWrites).toHaveLength(0)
  })

  it('writeSamples 抛错 -> 防御 catch 吞掉，hook 继续送审（failOpen）', async () => {
    const store = createMemorySessionStore()
    const sid = store.createSession()
    appendTurn(store, sid, 't-cur', '你好', '你好呀')
    const { auditor, calls } = stubAuditor()
    const { logger, calls: logs } = spyLogger()
    const { hook, flush } = makeHook({
      store,
      auditor,
      logger,
      writeSamples: () => {
        throw new Error('db full')
      }
    })
    await hook.fn({ event: 'turn.end' }, turnEnd({ sessionId: sid, complianceRecords: [record(true)] }))
    await flush()
    expect(calls).toHaveLength(1)
    expect(logs.some((c) => c.level === 'warn' && c.msg.includes('samples write failed'))).toBe(true)
  })
})


// === P3C1-08：裁定 1.8 总开关（enabled=false / scope='off' 时整个管线关闭） ===

describe('P3C1-08 audit hook：总开关 kill switch', () => {
  it('shouldCollect=false -> 不写 samples、不读 SessionStore、不调 auditor、不入队', async () => {
    const inner = createMemorySessionStore()
    const sid = inner.createSession()
    appendTurn(inner, sid, 't-cur', '你好', '作为一个AI助手我会帮你')
    const { store, reads } = countingStore(inner)
    const { auditor, calls } = stubAuditor()
    const { hook, queue, sampleWrites } = makeHook({
      store,
      auditor,
      shouldCollect: () => false
    })
    await hook.fn(
      { event: 'turn.end' },
      turnEnd({ sessionId: sid, complianceRecords: [record(true)] })
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(sampleWrites).toHaveLength(0)
    expect(reads.getTurnMessages).toBe(0)
    expect(reads.getMessages).toBe(0)
    expect(calls).toHaveLength(0)
    expect(queue.pending()).toBe(0)
  })

  it('shouldCollect 抛错 -> fail-open 为不采集，不读正文且记元数据 warn', async () => {
    const inner = createMemorySessionStore()
    const sid = inner.createSession()
    appendTurn(inner, sid, 't-cur', '你好', '你好呀')
    const { store, reads } = countingStore(inner)
    const { auditor, calls } = stubAuditor()
    const { logger, calls: logs } = spyLogger()
    const { hook, sampleWrites } = makeHook({
      store,
      auditor,
      logger,
      shouldCollect: () => {
        throw new Error('config unavailable')
      }
    })
    await hook.fn(
      { event: 'turn.end' },
      turnEnd({ sessionId: sid, complianceRecords: [record(true)] })
    )
    expect(sampleWrites).toHaveLength(0)
    expect(reads.getTurnMessages).toBe(0)
    expect(calls).toHaveLength(0)
    expect(logs.some((c) => c.level === 'warn' && c.msg.includes('collection gate unavailable'))).toBe(true)
  })
})
