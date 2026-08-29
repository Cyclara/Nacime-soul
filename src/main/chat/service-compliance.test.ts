// src/main/chat/service-compliance.test.ts
// P3C1-08：ChatService 合规门控集成--observe 字节级直通（C1 验收⑧）/
// TurnEndData.complianceGate+complianceRecords 装配（裁定 1.4 #2/#3）/
// 时序遥测两列 / turns 行先落（§3.11 纪律 1）/ 单轮恰好一个 compliance.review span。
// 依据：F5-001 §3.5 改动点 3/4/5 + §5 边界条件 + 开工裁定 1.1/1.2。

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Logger } from '@shared/observability/types'
import { createMetrics } from '../observability/metrics'
import { createTracer, configureTracer, getTracer } from '../observability/tracer'
import { createMemorySessionStore } from './session-store'
import { createFauxProvider } from '../llm/providers/faux'
import type { LLMProvider } from '../llm/types'
import { createMemoryPromptLoader } from '../prompts/loader'
import { registerHook, clearHooks } from '../hooks/registry'
import { setHookRunnerLogger } from '../hooks/runner'
import { sanitizeMessageHook } from '../hooks/builtin/sanitize-message'
import { LifecycleEvent } from '../hooks/lifecycle'
import {
  createChatService,
  type ChatService,
  type ChatEventSink,
  type ChatComplianceIntegration,
  type TurnEndData
} from './service'
import type { ComplianceRule } from '../compliance/rules'
import { compileComplianceRules } from '../compliance/compile'
import { createComplianceCircuit } from '../compliance/circuit'
import { createComplianceGate } from '../compliance/gate'
import { COMPLIANCE_RECORDS_MAX_PER_TURN } from '../compliance/gate'
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
    child: () => l
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

function makeCollector(): { events: ChatStreamEvent[]; sink: ChatEventSink; done: Promise<void> } {
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

/** 测试用规则：命中「作为」开头的助手式自指（R-MR-01 的极简版）。 */
function testRule(id = 'R-MR-01'): ComplianceRule {
  return {
    id,
    type: 'meta-reference',
    severity: 'critical',
    confidence: 0.97,
    pattern: /作为/,
    scope: 'anywhere',
    action: 'flag',
    description: 'test rule',
    knownFalsePositives: [],
    examples: { hit: ['作为 AI'], miss: ['作为朋友'] }
  }
}

interface TurnRecord {
  turnId: string
  outcome: {
    blocked: boolean
    ruleIds: readonly string[]
    checkedSegments: number
    degraded: boolean
  }
  providerFirstDeltaMs: number | null
  gateHoldMs: number | null
}

/** 构造合规集成（真 gate：observe scope + 注入规则；recordTurnEnd 记录进数组）。 */
function makeCompliance(
  rules: readonly ComplianceRule[],
  opts?: { scope?: 'observe' | 'first-segment' | 'all-segments' | 'off' }
): { integration: ChatComplianceIntegration; turns: TurnRecord[] } {
  const compiled = compileComplianceRules(rules)
  const circuit = createComplianceCircuit({}, noopLogger(), createMetrics())
  const turns: TurnRecord[] = []
  return {
    turns,
    integration: {
      createGate(turnId, candidateId) {
        return createComplianceGate({
          rules: compiled.rules,
          options: { scope: opts?.scope ?? 'observe', turnId, candidateId },
          circuit,
          logger: noopLogger(),
          metrics: createMetrics()
        })
      },
      recordTurnEnd(input) {
        turns.push({
          turnId: input.turnId,
          outcome: input.outcome,
          providerFirstDeltaMs: input.providerFirstDeltaMs,
          gateHoldMs: input.gateHoldMs
        })
      }
    }
  }
}

function makeChatService(faux: LLMProvider, compliance?: ChatComplianceIntegration): ChatService {
  return createChatService({
    logger: noopLogger(),
    promptLoader: makeTestLoader(),
    sessionStore: createMemorySessionStore(),
    providerFactory: () => ({
      provider: faux,
      capabilities: { contextWindow: 64_000, maxOutputTokens: 2048 }
    }),
    ...(compliance ? { compliance } : {})
  })
}

/** 注册捕获 TurnEndData 的 turn.end hook。 */
function captureTurnEnd(): { data: TurnEndData[]; unregister: () => void } {
  const data: TurnEndData[] = []
  registerHook({
    name: 'capture-turn-end',
    event: LifecycleEvent.TURN_END,
    priority: 500,
    fn: (_ctx, d) => {
      data.push(d as TurnEndData)
      return {}
    }
  })
  return { data, unregister: () => clearHooks() }
}

/** 全部 chunk 事件的 delta 拼接（用户实际看到的文本）。 */
function releasedText(events: readonly ChatStreamEvent[]): string {
  return events
    .filter((e) => e.type === 'chunk')
    .map((e) => (e as { delta: string }).delta)
    .join('')
}

// === 测试 ===

describe('ChatService P3C1-08 合规门控集成', () => {
  beforeEach(() => {
    clearHooks()
    setHookRunnerLogger(noopLogger())
    registerHook(sanitizeMessageHook)
    // 独立 tracer：断言 span 数（全局单例换新实例防串扰）
    configureTracer(createTracer())
  })

  afterEach(() => {
    clearHooks()
  })

  it('observe 直通：sink 的 delta 拼接与 provider 全文字节级相等，且恰好一次（C1 验收⑧）', async () => {
    const text = '你好呀。我今天想聊聊。作为一个 AI 助手，我可以帮你。'
    const faux = createFauxProvider()
    faux.setResponses([{ type: 'text', text, chunkSize: 7 }])
    const { integration } = makeCompliance([testRule()])
    const service = makeChatService(faux, integration)
    const { events, sink, done } = makeCollector()
    const { data } = captureTurnEnd()

    await service.send(
      { sessionId: service.createSession(), text: '在吗', clientRequestId: 'req-1' },
      sink
    )
    await done
    await new Promise((r) => setTimeout(r, 10)) // 等 turn.end hook

    // 逐字直通：拼接 === 原文，无增删改（裁定 1.1）
    expect(releasedText(events)).toBe(text)
    // 每个非空 delta 恰好 sink 一次（无重复、无丢失）
    const chunkEvents = events.filter((e) => e.type === 'chunk')
    expect(chunkEvents.length).toBe(Math.ceil(text.length / 7))
    // 持久化内容（accumulated）也是全文
    expect(data[0].outputLen).toBe(text.length)
  })

  it('命中规则：TurnEndData 带 complianceGate（outcome）+ complianceRecords（裁定 1.4 #2/#3）', async () => {
    const text = '作为一个 AI 助手我会帮你。这句话作为开头。'
    const faux = createFauxProvider()
    faux.setResponses([{ type: 'text', text, chunkSize: 10 }])
    const { integration, turns } = makeCompliance([testRule()])
    const service = makeChatService(faux, integration)
    const { sink, done } = makeCollector()
    const { data } = captureTurnEnd()

    await service.send(
      { sessionId: service.createSession(), text: '在吗', clientRequestId: 'req-1' },
      sink
    )
    await done
    await new Promise((r) => setTimeout(r, 10))

    const turnEnd = data[0]
    // outcome：observe 下命中被记录但零干预
    expect(turnEnd.complianceGate).toBeDefined()
    expect(turnEnd.complianceGate?.blocked).toBe(false)
    expect(turnEnd.complianceGate?.ruleIds).toContain('R-MR-01')
    expect(turnEnd.complianceGate?.checkedSegments).toBeGreaterThan(0)
    // records：无正文，只有 id/偏移/枚举/时序计数
    expect(turnEnd.complianceRecords).toBeDefined()
    expect(turnEnd.complianceRecords!.length).toBeGreaterThan(0)
    for (const r of turnEnd.complianceRecords!) {
      expect(r.ruleId).toBe('R-MR-01')
      expect(r.turnId).toBe(ack_turnId(turnEnd))
      expect(r.span.start).toBeGreaterThanOrEqual(0)
      expect(r.shadowPolicyVersion).toBe('shadow-v1')
      expect(JSON.stringify(r)).not.toContain('作为') // 无正文（§3.11 红线）
    }
    // observe 下 effective 恒 'flag'（C1 验收⑥）
    expect(turnEnd.complianceRecords!.every((r) => r.effectiveAction === 'flag')).toBe(true)
    // recordTurnEnd 在 TURN_END 时点被调（turns 行先 INSERT，§3.11 纪律 1）
    expect(turns).toHaveLength(1)
    expect(turns[0].turnId).toBe(turnEnd.turnId)
    expect(turns[0].outcome.ruleIds).toContain('R-MR-01')
  })

  it('空首 delta 后延迟正文：provider 等待不误记为 gateHold（observe 仍为 0）', async () => {
    const delayedProvider: LLMProvider = {
      async *stream() {
        yield { type: 'delta' as const, text: '' }
        await new Promise((resolve) => setTimeout(resolve, 20))
        yield { type: 'delta' as const, text: '你好呀。' }
      }
    }
    const { integration, turns } = makeCompliance([testRule()])
    const service = makeChatService(delayedProvider, integration)
    const { events, sink, done } = makeCollector()

    await service.send(
      { sessionId: service.createSession(), text: '在吗', clientRequestId: 'empty-first-delta' },
      sink
    )
    await done
    await new Promise((r) => setTimeout(r, 10))

    expect(releasedText(events)).toBe('你好呀。')
    expect(turns).toHaveLength(1)
    expect(turns[0].providerFirstDeltaMs).not.toBeNull()
    expect(turns[0].gateHoldMs).toBe(0)
  })

  it('时序遥测：providerFirstDeltaMs 非空、gateHoldMs 恒 0（observe 零持留，裁定 1.2）', async () => {
    const faux = createFauxProvider()
    faux.setResponses([{ type: 'text', text: '你好呀。今天也要加油哦。', chunkSize: 5 }])
    const { integration, turns } = makeCompliance([testRule()])
    const service = makeChatService(faux, integration)
    const { sink, done } = makeCollector()

    await service.send(
      { sessionId: service.createSession(), text: '在吗', clientRequestId: 'req-1' },
      sink
    )
    await done
    await new Promise((r) => setTimeout(r, 10))

    expect(turns).toHaveLength(1)
    expect(turns[0].providerFirstDeltaMs).not.toBeNull()
    expect(turns[0].providerFirstDeltaMs!).toBeGreaterThanOrEqual(0)
    // observe 构造上零持留：gateHold === 0
    expect(turns[0].gateHoldMs).toBe(0)
  })

  it('单轮恰好一个 compliance.review span（F5-001 §3.9：绝不能每 segment 一个）', async () => {
    const faux = createFauxProvider()
    faux.setResponses([{ type: 'text', text: '第一段。第二段。第三段。第四段。', chunkSize: 3 }])
    const { integration } = makeCompliance([testRule()])
    const service = makeChatService(faux, integration)
    const { sink, done } = makeCollector()

    await service.send(
      { sessionId: service.createSession(), text: '在吗', clientRequestId: 'req-1' },
      sink
    )
    await done
    await new Promise((r) => setTimeout(r, 10))

    const traces = getTracer().snapshot()
    expect(traces).toHaveLength(1)
    const spans = traces[0].spans.filter((s) => s.name === 'compliance.review')
    expect(spans).toHaveLength(1)
    expect(spans[0].ok).toBe(true)
  })

  it('records 超单轮上限截断并计数（裁定 1.4 #3：上限 64）', async () => {
    // 70 个句号 + segmentMaxChars=1 -> 每 segment 一次命中 -> 70 条 records -> 截 64
    const text = '。'.repeat(70)
    const faux = createFauxProvider()
    faux.setResponses([{ type: 'text', text }])
    // 命中句号本身的规则：70 段各命中一次
    const compiled = compileComplianceRules([{ ...testRule(), pattern: /。/ }])
    const circuit = createComplianceCircuit({}, noopLogger(), createMetrics())
    const integration: ChatComplianceIntegration = {
      createGate(turnId, candidateId) {
        return createComplianceGate({
          rules: compiled.rules,
          options: {
            scope: 'observe',
            firstSegmentMinChars: 1,
            segmentMaxChars: 1,
            turnId,
            candidateId
          },
          circuit,
          logger: noopLogger(),
          metrics: createMetrics()
        })
      },
      recordTurnEnd: () => {}
    }
    const service = makeChatService(faux, integration)
    const { sink, done } = makeCollector()
    const { data } = captureTurnEnd()

    await service.send(
      { sessionId: service.createSession(), text: '在吗', clientRequestId: 'req-1' },
      sink
    )
    await done
    await new Promise((r) => setTimeout(r, 10))

    expect(data[0].complianceRecords).toHaveLength(COMPLIANCE_RECORDS_MAX_PER_TURN)
    expect(data[0].complianceRecordsTruncated).toBe(70 - COMPLIANCE_RECORDS_MAX_PER_TURN)
  })

  it('provider 失败轮：finally 照常收尾（outcome/records/recordTurnEnd 不丢）', async () => {
    const faux = createFauxProvider()
    faux.setResponses([{ type: 'error', code: 'LLM_SERVER', afterChars: 6 }])
    const { integration, turns } = makeCompliance([testRule()])
    const service = makeChatService(faux, integration)
    const { sink, done } = makeCollector()
    const { data } = captureTurnEnd()

    await service.send(
      { sessionId: service.createSession(), text: '在吗', clientRequestId: 'req-1' },
      sink
    )
    await done
    await new Promise((r) => setTimeout(r, 10))

    expect(data[0].status).toBe('failed')
    // 门控收尾在 failed 轮也执行（turns 行照写，§3.11「仅门控启用的轮」）
    expect(turns).toHaveLength(1)
    expect(data[0].complianceGate).toBeDefined()
  })

  it('连续 200 轮 observe：输出逐字一致、零 block/降级、gateHold 全为 0（C1 验收③/⑧）', async () => {
    const turnsTarget = 200
    const textFor = (n: number): string => `第${n}轮：你好呀。作为一个AI助手这只是观测样本。`
    const faux = createFauxProvider()
    faux.setResponses(
      Array.from({ length: turnsTarget }, (_, index) => ({
        type: 'text' as const,
        text: textFor(index),
        chunkSize: 6
      }))
    )
    const { integration, turns } = makeCompliance([testRule()])
    const service = makeChatService(faux, integration)

    for (let index = 0; index < turnsTarget; index++) {
      const { events, sink, done } = makeCollector()
      await service.send(
        {
          sessionId: service.createSession(),
          text: `用户第${index}轮`,
          clientRequestId: `observe-200-${index}`
        },
        sink
      )
      await done
      // completed 事件先于 finally；让 TURN_END/recordTurnEnd 收尾后再断言下一轮。
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(releasedText(events)).toBe(textFor(index))
    }

    expect(turns).toHaveLength(turnsTarget)
    expect(turns.every((t) => t.outcome.blocked === false)).toBe(true)
    expect(turns.every((t) => t.outcome.degraded === false)).toBe(true)
    expect(turns.every((t) => t.gateHoldMs === 0)).toBe(true)
    expect(turns.every((t) => t.providerFirstDeltaMs !== null)).toBe(true)
  })

  it('未注入 compliance（可选依赖）：行为与 Phase 1 完全一致（无 gate 无记录）', async () => {
    const text = '你好呀。作为 AI 我帮你。'
    const faux = createFauxProvider()
    faux.setResponses([{ type: 'text', text, chunkSize: 5 }])
    const service = makeChatService(faux) // 无 compliance
    const { events, sink, done } = makeCollector()
    const { data } = captureTurnEnd()

    await service.send(
      { sessionId: service.createSession(), text: '在吗', clientRequestId: 'req-1' },
      sink
    )
    await done
    await new Promise((r) => setTimeout(r, 10))

    expect(releasedText(events)).toBe(text)
    expect(data[0].complianceGate).toBeUndefined()
    expect(data[0].complianceRecords).toBeUndefined()
  })

  it('空串 delta 跳过 sink（F5-001 §3.5 改动点 3：空串不产生 chunk 事件）', async () => {
    const faux = createFauxProvider()
    // chunkSize 使末尾产生空串分块的场景用整段文本验证：无空 chunk 事件
    faux.setResponses([{ type: 'text', text: '一句话。' }])
    const { integration } = makeCompliance([testRule()])
    const service = makeChatService(faux, integration)
    const { events, sink, done } = makeCollector()

    await service.send(
      { sessionId: service.createSession(), text: '在吗', clientRequestId: 'req-1' },
      sink
    )
    await done
    await new Promise((r) => setTimeout(r, 10))

    const chunks = events.filter((e) => e.type === 'chunk')
    expect(chunks.every((e) => (e as { delta: string }).delta.length > 0)).toBe(true)
    expect(releasedText(events)).toBe('一句话。')
  })
})

/** 从 TurnEndData 取 turnId（测试辅助）。 */
function ack_turnId(data: TurnEndData): string {
  return data.turnId
}
