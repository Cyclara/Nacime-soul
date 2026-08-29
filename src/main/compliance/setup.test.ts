// src/main/compliance/setup.test.ts
// P3C1-08：合规 composition root--规则编译拒绝路径 / gate 工厂（真门 vs Null Object）/
// turns 行落库与 kill switch / writeSamples 全链路（hook 触发）/
// 审计回填（faux 常量 provider）/ dislike 补审 / 无 key 降级 / 快照 / 启动清理。
// 依据：F5-001 §5（setupCompliance 必须真实接线）+ 裁定 1.4 #4 / 1.8 / §3.10。

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import type { Logger, LogFields } from '@shared/observability/types'
import type {
  AppConfigV1,
  ComplianceAuditConfig,
  ComplianceGateConfig,
  ConfigStore
} from '@shared/config/types'
import type { SecretStore } from '../security/secret-store'
import { DEFAULT_CONFIG_V1 } from '../config/defaults'
import { createMetrics } from '../observability/metrics'
import { createMemorySessionStore } from '../chat/session-store'
import { createMemoryPromptLoader } from '../prompts/loader'
import { clearHooks } from '../hooks/registry'
import { setHookRunnerLogger } from '../hooks/runner'
import { LifecycleEvent } from '../hooks/lifecycle'
import type { ChatMessage } from '@shared/chat/types'
import type { ComplianceDecisionRecord } from '@shared/compliance/types'
import { COMPLIANCE_RULES, type ComplianceRule } from './rules'
import { migration as m009 } from '../migrations/scripts/009_compliance_history'
import { setupCompliance, type ComplianceInfrastructure } from './setup'
import type { ChatComplianceIntegration } from '../chat/service'
import type { ExtractionProvider } from '../memory/extraction/provider'

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

const DAY = 24 * 3600 * 1000

/** 可变配置桩：默认出厂配置 + persona.compliance 覆写 + 运行时可改（kill switch 测试）。 */
function makeConfigStore(
  compliance?: Partial<{
    gate: Partial<ComplianceGateConfig>
    audit: Partial<ComplianceAuditConfig>
    disabledRuleIds: string[]
  }>
): {
  store: ConfigStore
  setGate: (gate: Partial<ComplianceGateConfig>) => void
  notifyConfigChanged: () => void
} {
  const base = JSON.parse(JSON.stringify(DEFAULT_CONFIG_V1)) as AppConfigV1
  if (compliance) {
    if (compliance.gate) Object.assign(base.persona.compliance.gate, compliance.gate)
    if (compliance.audit) Object.assign(base.persona.compliance.audit, compliance.audit)
    if (compliance.disabledRuleIds) {
      base.persona.compliance.disabledRuleIds = compliance.disabledRuleIds
    }
  }
  let current = base
  const listeners = new Set<(event: { domain: 'persona'; config: Readonly<AppConfigV1> }) => void>()
  function notifyConfigChanged(): void {
    for (const listener of listeners) listener({ domain: 'persona', config: current })
  }
  return {
    store: {
      setup: () => ({ ok: true, healed: false, warnings: [] }),
      get: () => current,
      update: async () => current,
      resetDomain: async () => current,
      subscribe: (listener) => {
        listeners.add(
          listener as (event: { domain: 'persona'; config: Readonly<AppConfigV1> }) => void
        )
        return () =>
          listeners.delete(
            listener as (event: { domain: 'persona'; config: Readonly<AppConfigV1> }) => void
          )
      }
    } as unknown as ConfigStore,
    setGate: (gate) => {
      current = JSON.parse(JSON.stringify(current)) as AppConfigV1
      Object.assign(current.persona.compliance.gate, gate)
    },
    notifyConfigChanged
  }
}

function makeSecretStore(key: string | null): SecretStore {
  return {
    setup: () => {},
    get: () => key,
    set: () => {},
    delete: () => {},
    has: () => key !== null
  }
}

const dbs: Database.Database[] = []
function makeDb(): Database.Database {
  const db = new Database(':memory:')
  dbs.push(db)
  m009.up({ db, dataDir: '.', log: noopLogger(), dryRun: false })
  return db
}

function record(ruleId = 'R-MR-01', turnId = 't-1'): ComplianceDecisionRecord {
  return {
    candidateId: 'cand-1',
    turnId,
    attemptIndex: 0,
    segmentIndex: 0,
    ruleId,
    span: { start: 0, length: 4 },
    confidence: 0.97,
    declaredAction: 'flag',
    effectiveAction: 'flag',
    counterfactualAction: 'block',
    wouldBlockUnderFirstSegmentPolicy: true,
    blockIneligibleReason: undefined,
    releasedCharsBefore: 0,
    shadowPolicyVersion: 'shadow-v1'
  }
}

/** 会话里放一轮完整对话（turn-1：user + assistant complete）。 */
function seedTurn(store: ReturnType<typeof createMemorySessionStore>, turnId = 't-1'): string {
  const sessionId = store.createSession()
  for (const [role, id] of [
    ['user', `u-${turnId}`],
    ['assistant', `a-${turnId}`]
  ] as const) {
    store.appendMessage(sessionId, {
      id,
      sessionId,
      role,
      // R-MR-01 的 pattern 要求「一个」与 AI 相邻（无空格）。
      content: role === 'user' ? '在吗' : '作为一个AI助手我会帮你。',
      createdAt: 1,
      status: 'complete',
      turnId
    } satisfies ChatMessage)
  }
  return sessionId
}

interface FixtureOpts {
  compliance?: Parameters<typeof makeConfigStore>[0]
  apiKey?: string | null
  rules?: readonly ComplianceRule[]
  logger?: Logger
  auditProviderForTest?: ExtractionProvider
  now?: () => number
}

interface Fixture {
  infra: ComplianceInfrastructure
  db: Database.Database
  store: ReturnType<typeof createMemorySessionStore>
  sessionId: string
  integration: ChatComplianceIntegration
  setGate: (gate: Partial<ComplianceGateConfig>) => void
  notifyConfigChanged: () => void
  /** 触发 TURN_END hook（compliance-audit 350） */
  emitTurnEnd: (
    turnId: string,
    opts?: { records?: readonly ComplianceDecisionRecord[]; status?: 'completed' | 'failed' }
  ) => Promise<void>
  turnsRow: (turnId: string) => Record<string, unknown> | undefined
  samplesRows: () => Record<string, unknown>[]
}

function makeFixture(opts: FixtureOpts = {}): Fixture {
  const db = makeDb()
  const store = createMemorySessionStore()
  const sessionId = seedTurn(store)
  const { store: configStore, setGate, notifyConfigChanged } = makeConfigStore(opts.compliance)
  const infra = setupCompliance({
    db,
    configStore,
    secretStore: makeSecretStore(opts.apiKey ?? null),
    sessionStore: store,
    promptLoader: createMemoryPromptLoader({
      'identity.md': '她是 Nacime。',
      'soul.md': '温暖好奇。'
    }),
    logger: opts.logger ?? noopLogger(),
    metrics: createMetrics(),
    isDev: false,
    ...(opts.rules ? { rules: opts.rules } : {}),
    ...(opts.auditProviderForTest ? { auditProviderForTest: opts.auditProviderForTest } : {}),
    ...(opts.now ? { now: opts.now } : {})
  })
  return {
    infra,
    db,
    store,
    sessionId,
    integration: infra.chatIntegration,
    setGate,
    notifyConfigChanged,
    emitTurnEnd: async (turnId, e = {}) => {
      await (
        await import('../hooks/lifecycle')
      ).emitLifecycle(
        LifecycleEvent.TURN_END,
        {
          event: LifecycleEvent.TURN_END,
          turnId,
          sessionId,
          requestId: 'r1'
        },
        {
          turnId,
          sessionId,
          requestId: 'r1',
          status: e.status ?? 'completed',
          inputLen: 2,
          outputLen: 12,
          memoryEligible: true,
          referencedMemoryIds: [],
          ...(e.records ? { complianceRecords: e.records } : {})
        }
      )
    },
    turnsRow: (turnId) =>
      db.prepare(`SELECT * FROM compliance_turns WHERE turn_id = ?`).get(turnId) as
        Record<string, unknown> | undefined,
    samplesRows: () =>
      db.prepare(`SELECT * FROM compliance_samples ORDER BY id`).all() as Record<string, unknown>[]
  }
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}

// === 测试 ===

describe('P3C1-08 setupCompliance', () => {
  beforeEach(() => {
    clearHooks()
    setHookRunnerLogger(noopLogger())
    process.env['COMPANION_TEST_MODE'] = 'faux'
  })

  afterEach(() => {
    clearHooks()
    delete process.env['COMPANION_TEST_MODE']
    delete process.env['COMPANION_FAUX_COMPLIANCE_AUDIT']
    for (const db of dbs.splice(0)) {
      try {
        db.close()
      } catch {
        /* best-effort */
      }
    }
  })

  // ── 快照初始态 ──

  it('出厂规则全编译通过；快照初始态：ruleHits 全规则键为 0、派生率 null、gateEnabled=true', () => {
    const f = makeFixture()
    const snap = f.infra.getSnapshot()
    expect(snap.rejectedRules).toEqual([])
    expect(Object.keys(snap.ruleHits)).toHaveLength(COMPLIANCE_RULES.length)
    expect(Object.values(snap.ruleHits).every((n) => n === 0)).toBe(true)
    expect(snap.gateEnabled).toBe(true)
    expect(snap.gateScope).toBe('observe')
    expect(snap.approxFalsePositiveRate).toBeNull()
    expect(snap.approxEscapeRate).toBeNull()
    expect(snap.recentViolations).toEqual([])
  })

  it('坏规则 -> CMPL_RULE_INVALID warn + rejectedRules 进快照 + 有效子集继续（拒绝但应用可启动）', () => {
    const { logger, calls } = spyLogger()
    const badRule: ComplianceRule = {
      ...COMPLIANCE_RULES[0]!,
      id: 'R-XX-99',
      pattern: /(a+)+/ // ReDoS 嵌套量词
    }
    const f = makeFixture({ rules: [...COMPLIANCE_RULES, badRule], apiKey: 'k', logger })
    const snap = f.infra.getSnapshot()
    expect(snap.rejectedRules).toHaveLength(1)
    expect(snap.rejectedRules[0]!.id).toBe('R-XX-99')
    expect(calls.some((c) => c.level === 'warn' && c.fields.code === 'CMPL_RULE_INVALID')).toBe(
      true
    )
    // 有效子集继续：gate 仍创建并可工作
    const gate = f.integration.createGate('t-x', 'c-x')
    expect(gate.push('hi').releaseText).toBe('hi')
  })

  // ── gate 工厂 ──

  it('createGate（observe）：push 直通 + 命中文本产 records + outcome.ruleIds', () => {
    const f = makeFixture()
    const gate = f.integration.createGate('t-g', 'c-g')
    const e1 = gate.push('作为一个AI助手。')
    // observe：releaseText === delta 逐字直通（裁定 1.1）
    expect(e1.releaseText).toBe('作为一个AI助手。')
    expect(e1.abort).toBe(false)
    const e2 = gate.flush()
    expect(e2.releaseText).toBe('')
    const records = gate.takeRecords()
    expect(records.length).toBeGreaterThan(0)
    expect(records.every((r) => r.turnId === 't-g' && r.candidateId === 'c-g')).toBe(true)
    expect(gate.outcome().ruleIds.length).toBeGreaterThan(0)
  })

  it('kill switch（enabled=false）：Null Object 直通、无 records、recordTurnEnd 不建行（裁定 1.8）', () => {
    const f = makeFixture()
    f.setGate({ enabled: false })
    const gate = f.integration.createGate('t-off', 'c-off')
    expect(gate.push('作为一个 AI 助手。').releaseText).toBe('作为一个 AI 助手。')
    expect(gate.flush().releaseText).toBe('')
    expect(gate.takeRecords()).toEqual([])
    const outcome = gate.outcome()
    expect(outcome.blocked).toBe(false)
    expect(outcome.ruleIds).toEqual([])
    // recordTurnEnd：kill switch 下不建行（不采集）
    f.integration.recordTurnEnd({
      turnId: 't-off',
      outcome,
      providerFirstDeltaMs: null,
      gateHoldMs: null
    })
    expect(f.turnsRow('t-off')).toBeUndefined()
  })

  it("scope='off' 运行时等价 enabled=false（裁定 1.8）：Null Object + 不建行", () => {
    const f = makeFixture()
    f.setGate({ scope: 'off' })
    const gate = f.integration.createGate('t-scope-off', 'c1')
    expect(gate.push('作为一个 AI 助手。').releaseText).toBe('作为一个 AI 助手。')
    expect(gate.takeRecords()).toEqual([])
    f.integration.recordTurnEnd({
      turnId: 't-scope-off',
      outcome: gate.outcome(),
      providerFirstDeltaMs: null,
      gateHoldMs: null
    })
    expect(f.turnsRow('t-scope-off')).toBeUndefined()
  })

  it('全局 kill switch（enabled=false）即使有 API key 也不写 samples、不调审计、不建 turns 行', async () => {
    process.env['COMPANION_FAUX_COMPLIANCE_AUDIT'] = JSON.stringify({
      verdict: 'block',
      level: 'overt',
      violations: []
    })
    const f = makeFixture({ apiKey: 'k', compliance: { gate: { enabled: false } } })
    const gate = f.integration.createGate('t-1', 'c-1')
    f.integration.recordTurnEnd({
      turnId: 't-1',
      outcome: gate.outcome(),
      providerFirstDeltaMs: null,
      gateHoldMs: null
    })
    await f.emitTurnEnd('t-1', { records: [record()] })
    await new Promise((r) => setTimeout(r, 50))
    expect(f.turnsRow('t-1')).toBeUndefined()
    expect(f.samplesRows()).toEqual([])
    // dislike 同样是 no-op（不读取会话、不调用 LLM；无可观测网络 side effect）
    f.infra.onDislike('t-1', f.sessionId, 'a-t-1')
    await new Promise((r) => setTimeout(r, 50))
    expect(f.samplesRows()).toEqual([])
  })

  // ── recordTurnEnd ──

  it('recordTurnEnd -> compliance_turns 行（gate_scope + 时序遥测两列；§3.11 纪律 1）', () => {
    const f = makeFixture()
    const gate = f.integration.createGate('t-1', 'c-1')
    gate.push('你好。')
    gate.flush()
    f.integration.recordTurnEnd({
      turnId: 't-1',
      outcome: gate.outcome(),
      providerFirstDeltaMs: 123,
      gateHoldMs: 0
    })
    const row = f.turnsRow('t-1')
    expect(row).toBeDefined()
    expect(row!['gate_scope']).toBe('observe')
    expect(row!['gate_blocked']).toBe(0)
    expect(row!['provider_first_delta_ms']).toBe(123)
    expect(row!['gate_hold_ms']).toBe(0)
    expect(row!['audited']).toBe(0)
    // candidate_audit 预留列 C1 恒 NULL（裁定 1.6 #3）
    expect(row!['candidate_audit_status']).toBeNull()
  })

  // ── writeSamples + 审计全链路（faux 常量 provider + apiKey）──

  it('TURN_END 触发：samples 批写 + ruleHits 计数 + recentViolations 环 + 审计回填（faux block verdict）', async () => {
    process.env['COMPANION_FAUX_COMPLIANCE_AUDIT'] = JSON.stringify({
      verdict: 'block',
      level: 'overt',
      violations: [
        { type: 'meta-reference', severity: 'critical', confidence: 0.9, rationale: '自称模型' }
      ]
    })
    const f = makeFixture({ apiKey: 'k', compliance: { audit: { sampleRate: 1 } } })
    // 先建 turns 行（ChatService 时点），再触发 hook（350 时点）
    f.integration.recordTurnEnd({
      turnId: 't-1',
      outcome: {
        blocked: false,
        regenerations: 0,
        degradedPass: false,
        ruleIds: ['R-MR-01'],
        checkedSegments: 1,
        totalMs: 1,
        degraded: false
      },
      providerFirstDeltaMs: 50,
      gateHoldMs: 0
    })
    await f.emitTurnEnd('t-1', { records: [record()] })

    // samples：regex 来源行（含反事实列）
    await waitFor(() => f.samplesRows().length >= 2)
    const rows = f.samplesRows()
    const regexRow = rows.find((r) => r['detection_method'] === 'regex')
    expect(regexRow).toBeDefined()
    expect(regexRow!['rule_id']).toBe('R-MR-01')
    expect(regexRow!['would_block_first_segment']).toBe(1)
    expect(regexRow!['shadow_policy_version']).toBe('shadow-v1')
    // llm 来源行（审计补写；rule_id NULL）
    const llmRow = rows.find((r) => r['detection_method'] === 'llm')
    expect(llmRow).toBeDefined()
    expect(llmRow!['rule_id']).toBeNull()
    expect(llmRow!['type']).toBe('meta-reference')

    // turns 行审计回填
    await waitFor(() => (f.turnsRow('t-1')!['audited'] as number) === 1)
    expect(f.turnsRow('t-1')!['audit_verdict']).toBe('block')
    expect(f.turnsRow('t-1')!['audit_level']).toBe('overt')

    // 快照：ruleHits 计数 + 环形缓冲（regex + llm 各一条）+ 漏报率
    const snap = f.infra.getSnapshot()
    expect(snap.ruleHits['R-MR-01']).toBe(1)
    expect(snap.recentViolations).toHaveLength(2)
    expect(snap.recentViolations[0]!.detectionMethod).toBe('regex')
    expect(snap.recentViolations[1]!.detectionMethod).toBe('llm')
    // verdict=block 且 gate 未拦 -> escaped；findings=1 -> escape rate = 1
    expect(snap.approxEscapeRate).toBe(1)
    // C1 无 blocked -> 误报率 null
    expect(snap.approxFalsePositiveRate).toBeNull()
  })

  it('恶意 audit rationale 即使回显用户/回复，也绝不进入 snapshot（IPC 红线）', async () => {
    const secret = 'SECRET-USER-AND-ASSISTANT-TEXT'
    process.env['COMPANION_FAUX_COMPLIANCE_AUDIT'] = JSON.stringify({
      verdict: 'flag',
      level: 'overt',
      violations: [
        { type: 'meta-reference', severity: 'critical', confidence: 0.9, rationale: secret }
      ]
    })
    const f = makeFixture({ apiKey: 'k', compliance: { audit: { sampleRate: 1 } } })
    f.integration.recordTurnEnd({
      turnId: 't-1',
      outcome: {
        blocked: false,
        regenerations: 0,
        degradedPass: false,
        ruleIds: [],
        checkedSegments: 1,
        totalMs: 0,
        degraded: false
      },
      providerFirstDeltaMs: null,
      gateHoldMs: null
    })
    await f.emitTurnEnd('t-1')
    await waitFor(() => (f.turnsRow('t-1')!['audited'] as number) === 1)
    const snapshotSerialized = JSON.stringify(f.infra.getSnapshot())
    expect(snapshotSerialized).not.toContain(secret)
    expect(snapshotSerialized).not.toContain('rationale')
  })

  it('审计 unavailable 空壳也入账：audit_unavailable=1、verdict NULL、不入任何分母', async () => {
    process.env['COMPANION_FAUX_COMPLIANCE_AUDIT'] = 'not-json{{'
    const f = makeFixture({ apiKey: 'k', compliance: { audit: { sampleRate: 1 } } })
    f.integration.recordTurnEnd({
      turnId: 't-1',
      outcome: {
        blocked: false,
        regenerations: 0,
        degradedPass: false,
        ruleIds: [],
        checkedSegments: 1,
        totalMs: 0,
        degraded: false
      },
      providerFirstDeltaMs: null,
      gateHoldMs: null
    })
    await f.emitTurnEnd('t-1')
    await waitFor(() => (f.turnsRow('t-1')!['audited'] as number) === 1)
    expect(f.turnsRow('t-1')!['audit_unavailable']).toBe(1)
    expect(f.turnsRow('t-1')!['audit_verdict']).toBeNull()
    const snap = f.infra.getSnapshot()
    expect(snap.approxEscapeRate).toBeNull() // 无分母
  })

  // ── 无 API key 降级 ──

  it('无 API key：不注册审计 hook（emit TURN_END 无回填）、onDislike no-op、warn LLM_AUTH', async () => {
    const { logger, calls } = spyLogger()
    const f = makeFixture({ apiKey: null, logger, compliance: { audit: { sampleRate: 1 } } })
    f.integration.recordTurnEnd({
      turnId: 't-1',
      outcome: {
        blocked: false,
        regenerations: 0,
        degradedPass: false,
        ruleIds: [],
        checkedSegments: 1,
        totalMs: 0,
        degraded: false
      },
      providerFirstDeltaMs: null,
      gateHoldMs: null
    })
    expect(f.turnsRow('t-1')).toBeDefined() // 门控数据照常（不需要网络）
    await f.emitTurnEnd('t-1')
    await new Promise((r) => setTimeout(r, 50))
    expect(f.turnsRow('t-1')!['audited']).toBe(0) // 无审计
    expect(calls.some((c) => c.level === 'warn' && c.fields.code === 'LLM_AUTH')).toBe(true)
    // onDislike no-op（反馈落库在 P3C1-07 service 内，与此无关）
    expect(() => f.infra.onDislike('t-1', f.sessionId, 'a-t-1')).not.toThrow()
    // writeSamples 也不运行（samples 落库者 = 审计 hook，裁定 1.4 #4 的已知边界）
    expect(f.samplesRows()).toEqual([])
  })

  // ── dislike 补审 ──

  it('onDislike -> 强制补审（sampleRate=0 也不受影响）-> turns 行回填', async () => {
    process.env['COMPANION_FAUX_COMPLIANCE_AUDIT'] = JSON.stringify({
      verdict: 'flag',
      level: 'subtle',
      violations: []
    })
    const f = makeFixture({ apiKey: 'k', compliance: { audit: { sampleRate: 0 } } })
    f.integration.recordTurnEnd({
      turnId: 't-1',
      outcome: {
        blocked: false,
        regenerations: 0,
        degradedPass: false,
        ruleIds: ['R-MR-01'],
        checkedSegments: 1,
        totalMs: 0,
        degraded: false
      },
      providerFirstDeltaMs: null,
      gateHoldMs: null
    })
    // 采样率 0：常规轮不审
    await f.emitTurnEnd('t-1')
    await new Promise((r) => setTimeout(r, 50))
    expect(f.turnsRow('t-1')!['audited']).toBe(0)
    // dislike 强制补审（§3.7）
    f.infra.onDislike('t-1', f.sessionId, 'a-t-1')
    await waitFor(() => (f.turnsRow('t-1')!['audited'] as number) === 1)
    expect(f.turnsRow('t-1')!['audit_verdict']).toBe('flag')
  })

  it('onDislike 补审输入带 gateOutcome（lastOutcomes 回看）', async () => {
    process.env['COMPANION_FAUX_COMPLIANCE_AUDIT'] = JSON.stringify({
      verdict: 'pass',
      level: 'none',
      violations: []
    })
    const f = makeFixture({ apiKey: 'k', compliance: { audit: { sampleRate: 0 } } })
    const outcome = {
      blocked: true,
      regenerations: 0 as const,
      degradedPass: false,
      ruleIds: ['R-MR-01'],
      checkedSegments: 2,
      totalMs: 1,
      degraded: false
    }
    f.integration.recordTurnEnd({
      turnId: 't-1',
      outcome,
      providerFirstDeltaMs: null,
      gateHoldMs: null
    })
    // 真实流程先走 TURN_END hook；sampleRate=0，所以常规采样不会审计。
    await f.emitTurnEnd('t-1')
    expect(f.turnsRow('t-1')!['audited']).toBe(0)
    // dislike 补审把 lastOutcomes 的 gateOutcome 放入审计 input。审计 pass 后：
    // blockedTurns=1 且 blockedPassedAudits=1；若 gateOutcome 未传，分子会保持 0。
    f.infra.onDislike('t-1', f.sessionId, 'a-t-1')
    await waitFor(() => (f.turnsRow('t-1')!['audited'] as number) === 1)
    const snap = f.infra.getSnapshot()
    expect(snap.approxFalsePositiveRate).toBe(1)
  })

  // ── 90 天启动清理 ──

  it('启动时 purgeStale：超期 turns 行被清（§3.11 纪律 3）', () => {
    const now = 100 * DAY
    const db = makeDb()
    db.prepare(
      `INSERT INTO compliance_turns (turn_id, occurred_at, gate_scope) VALUES ('t-stale', ?, 'observe')`
    ).run(now - 91 * DAY)
    db.prepare(
      `INSERT INTO compliance_turns (turn_id, occurred_at, gate_scope) VALUES ('t-fresh', ?, 'observe')`
    ).run(now - 10 * DAY)
    const store = createMemorySessionStore()
    const { store: configStore } = makeConfigStore()
    setupCompliance({
      db,
      configStore,
      secretStore: makeSecretStore(null),
      sessionStore: store,
      promptLoader: createMemoryPromptLoader({ 'identity.md': 'x', 'soul.md': 'y' }),
      logger: noopLogger(),
      metrics: createMetrics(),
      isDev: false,
      now: () => now
    })
    const remaining = db.prepare(`SELECT turn_id FROM compliance_turns ORDER BY turn_id`).all() as {
      turn_id: string
    }[]
    expect(remaining.map((r) => r.turn_id)).toEqual(['t-fresh'])
  })

  it('开关在第一条审计 in-flight 后关闭：abort 在飞、清 pending；重新开启后队列可恢复', async () => {
    let providerCalls = 0
    let resolveFirst!: (value: string) => void
    const provider: ExtractionProvider = {
      complete: () => {
        providerCalls++
        return new Promise<string>((resolve) => {
          resolveFirst = resolve
        })
      }
    }
    // 动态 config：setGate + notify 会触发 setup 的 collection revocation subscription。
    const f = makeFixture({
      apiKey: 'k',
      compliance: { audit: { sampleRate: 1 } },
      auditProviderForTest: provider
    })
    const firstOutcome = {
      blocked: false,
      regenerations: 0 as const,
      degradedPass: false,
      ruleIds: [],
      checkedSegments: 1,
      totalMs: 0,
      degraded: false
    }
    f.integration.recordTurnEnd({
      turnId: 't-1',
      outcome: firstOutcome,
      providerFirstDeltaMs: null,
      gateHoldMs: null
    })
    await f.emitTurnEnd('t-1')
    await waitFor(() => providerCalls === 1)

    // 新增第二轮消息 + parent row + audit task；第一条仍 in-flight，第二条仅 pending。
    const turn2 = 't-2'
    f.store.appendMessage(f.sessionId, {
      id: 'u-t-2',
      sessionId: f.sessionId,
      role: 'user',
      content: 'u2',
      createdAt: 2,
      status: 'complete',
      turnId: turn2
    })
    f.store.appendMessage(f.sessionId, {
      id: 'a-t-2',
      sessionId: f.sessionId,
      role: 'assistant',
      content: 'a2',
      createdAt: 3,
      status: 'complete',
      turnId: turn2
    })
    f.integration.recordTurnEnd({
      turnId: turn2,
      outcome: firstOutcome,
      providerFirstDeltaMs: null,
      gateHoldMs: null
    })
    await f.emitTurnEnd(turn2)

    // 撤销：应 abort first、清 second。provider 故意无视 AbortSignal，稍后仍 resolve。
    f.setGate({ enabled: false })
    f.notifyConfigChanged()
    resolveFirst(JSON.stringify({ verdict: 'pass', level: 'none', violations: [] }))
    await new Promise((r) => setTimeout(r, 30))
    expect(providerCalls).toBe(1) // pending t-2 未被发送
    expect(f.turnsRow('t-1')!['audited']).toBe(0) // late first 结果未回填
    expect(f.turnsRow('t-2')!['audited']).toBe(0)

    // 重新启用：新的完成轮仍可正常进入同一个（未 close）队列。
    f.setGate({ enabled: true })
    f.notifyConfigChanged()
    const turn3 = 't-3'
    f.store.appendMessage(f.sessionId, {
      id: 'u-t-3',
      sessionId: f.sessionId,
      role: 'user',
      content: 'u3',
      createdAt: 4,
      status: 'complete',
      turnId: turn3
    })
    f.store.appendMessage(f.sessionId, {
      id: 'a-t-3',
      sessionId: f.sessionId,
      role: 'assistant',
      content: 'a3',
      createdAt: 5,
      status: 'complete',
      turnId: turn3
    })
    f.integration.recordTurnEnd({
      turnId: turn3,
      outcome: firstOutcome,
      providerFirstDeltaMs: null,
      gateHoldMs: null
    })
    await f.emitTurnEnd(turn3)
    await waitFor(() => providerCalls === 2)
    resolveFirst(JSON.stringify({ verdict: 'pass', level: 'none', violations: [] }))
    await waitFor(() => (f.turnsRow(turn3)!['audited'] as number) === 1)
  })

  // ── cleanup ──

  it('cleanup 幂等可调（停消费者）', () => {
    const f = makeFixture({ apiKey: 'k' })
    expect(() => {
      f.infra.cleanup()
      f.infra.cleanup()
    }).not.toThrow()
  })
})
