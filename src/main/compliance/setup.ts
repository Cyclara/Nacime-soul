// src/main/compliance/setup.ts
// 合规基础设施接线（F5-001 §5 + 裁定 1.4/1.8；P3C1-08 落地）。
//
// setupCompliance 是统一 composition root：编译规则、创建熔断器/persistence、
// 构造 ChatService 注入的集成对象（gate 工厂 + TURN_END 落库）、创建**独立**
// 审计 provider 与审计 hook 并注册。**必须在 main/index.ts 里被真实调用**
// （F5-001 §5 反模式：「测试绿但根本没启用采集」--P2 记忆基础设施踩过的坑）。
//
// 关键合同：
//   - 规则编译启动时一次、结果缓存（F5-001 §5）；rejected 记 CMPL_RULE_INVALID warn
//     并以有效子集继续（「拒绝但应用可启动」，P3C1-02 验收）。
//   - gate.enabled=false / scope='off'（裁定 1.8 kill switch）-> Null Object gate +
//     recordTurnEnd no-op：不采集、无 turns 行、无 samples。ChatService 因此不写分支。
//   - 审计 provider 实例独立（硬 composition 合同，auditor.ts 文件头）：不复用
//     ChatService 的 providerFactory，不复用 extraction 实例。无 API key ->
//     不注册审计 hook（门控不受影响，它不需要网络）。
//   - E2E faux 模式（COMPANION_TEST_MODE=faux）：审计 provider 换常量响应
//     （COMPANION_FAUX_COMPLIANCE_AUDIT 可脚本化；缺省 pass 空壳），不触发真实网络。
//   - dislike 补审（§3.7）：feedback service 的 onDislike 回调接到审计队列
//     （reason='dislike'）；无审计轨道时跳过（反馈落库 + 计数不受影响，P3C1-07）。
//
// 失败语义：全链路 fail-open。规则编译永不抛；落库失败 warn 不影响聊天；
// 补审装配失败 warn。唯一硬失败 = deps 缺失（编程错误，就该炸）。
//
// 日志红线（§3.9）：只记元数据（ruleId/计数/turnId），不记正文与 rationale。

import type { Logger, MetricsRegistry } from '@shared/observability/types'
import type { ConfigStore } from '@shared/config/types'
import type {
  ComplianceSnapshot,
  ComplianceDecisionRecord,
  ComplianceSeverity,
  ComplianceViolationType
} from '@shared/compliance/types'
import type { Database } from 'better-sqlite3'
import type { SecretStore } from '../security/secret-store'
import type { SessionStore } from '../chat/session-store'
import type { PromptLoader } from '../prompts/loader'
import type { ChatComplianceIntegration } from '../chat/service'
import type { ExtractionProvider } from '../memory/extraction/provider'
import { createOpenAIExtractionProvider } from '../memory/extraction/provider'
import { createSecureFetch } from '../security/network-policy'
import { resolveCompat } from '../llm/compat/detect-compat'
import { registerHook } from '../hooks/registry'
import { COMPLIANCE_RULES } from './rules'
import { compileComplianceRules, type CompiledComplianceRule } from './compile'
import { createComplianceCircuit, type ComplianceCircuit } from './circuit'
import { createComplianceGate, type ComplianceGate, type ComplianceGateOutcome } from './gate'
import {
  createComplianceAuditor,
  type ComplianceAuditInput,
  type ComplianceAuditResult
} from './auditor'
import type { ComplianceAuditTask } from './audit-queue'
import { createComplianceAuditHook, buildRecentTurns } from './hook'
import {
  createCompliancePersistence,
  sampleRowFromRecord,
  type CompliancePersistence,
  type ComplianceSampleRow
} from './persistence'

/** recentViolations 内存环形缓冲容量（F5-001 §3.10：最近 50 条）。 */
const RECENT_VIOLATIONS_MAX = 50
/** 人设摘要截断上限（§3.6：identity + soul 层截取，≤400 字）。hook 侧另有防御截断。 */
const PERSONA_SUMMARY_MAX_CHARS = 400
/** dislike 补审可回看 gateOutcome 的轮数上界（内存 Map，防无界增长）。 */
const LAST_OUTCOMES_MAX = 200

export interface SetupComplianceDeps {
  /** sessionDb（迁移 009 三表所在库；与 SessionStore 同一连接）。 */
  readonly db: Database
  readonly configStore: ConfigStore
  readonly secretStore: SecretStore
  readonly sessionStore: SessionStore
  /** 人设摘要来源：identity.md + soul.md（§3.6「从当前 Prompt 的 identity + soul 层截取」）。 */
  readonly promptLoader: PromptLoader
  readonly logger: Logger
  readonly metrics: MetricsRegistry
  readonly isDev: boolean
  /** L0 已知事实键名（只给键名不给值）；缺省空列表。memory 关闭时无 L0。 */
  readonly getKnownFactKeys?: () => readonly string[]
  /** 规则集（测试注入坏规则验证拒绝路径）；缺省出厂全集 COMPLIANCE_RULES。 */
  readonly rules?: readonly (typeof COMPLIANCE_RULES)[number][]
  /**
   * 测试用独立审计 provider 注入。仍受 API key 门控（无 key 绝不注册 audit hook），
   * 生产不传，始终由本 composition root 新建 OpenAI ExtractionProvider，保持实例隔离。
   */
  readonly auditProviderForTest?: ExtractionProvider
  /** 测试/确定性时钟；默认 Date.now。 */
  readonly now?: () => number
}

export interface ComplianceInfrastructure {
  /** 注入 ChatServiceDeps.compliance（gate 工厂 + TURN_END 落库）。 */
  readonly chatIntegration: ChatComplianceIntegration
  /** companion:compliance:get-snapshot IPC 数据源（内存态现算，聚合量无正文）。 */
  readonly getSnapshot: () => ComplianceSnapshot
  /**
   * dislike 补审接线点（P3C1-07 feedback service 的 onDislike 回调注入此处）。
   * 无审计轨道（无 API key）时为 no-op--反馈落库 + 计数不受影响。
   */
  readonly onDislike: (turnId: string, sessionId: string, messageId: string) => void
  /** 退出清理：停审计消费者（中止 in-flight，结果不再投递）。 */
  readonly cleanup: () => void
}

/** Null Object gate（F5-001 §5 边界条件：enabled=false 时 setup 层返回，ChatService 零分支）。 */
function createNullGate(): ComplianceGate {
  const nullOutcome: ComplianceGateOutcome = {
    blocked: false,
    regenerations: 0,
    degradedPass: false,
    ruleIds: [],
    checkedSegments: 0,
    totalMs: 0,
    degraded: false
  }
  return {
    push: (delta) => ({ releaseText: delta, abort: false, violations: [] }),
    flush: () => ({ releaseText: '', abort: false, violations: [] }),
    resetForRetry: () => {},
    takeRecords: () => [],
    outcome: () => nullOutcome
  }
}

/** recentViolations 环形缓冲条目（ComplianceSnapshot.recentViolations 的可变版）。 */
interface RecentViolationEntry {
  turnId: string
  type: ComplianceViolationType
  severity: ComplianceSeverity
  detectionMethod: 'regex' | 'llm'
  ruleId?: string
}

/** 快照内存态（进程生命周期；重启归零是接受的--纵向数据在 DB，§3.11）。 */
interface SnapshotState {
  /** ruleId -> 命中计数（含被禁用规则，初始 0；writeSamples 时累加）。 */
  readonly ruleHits: Map<string, number>
  readonly rejectedRules: { id: string; reason: string }[]
  /** 最近 50 条违规（regex + llm，仅分类元数据、无自由文本）。可变数组（环形缓冲实现细节）。 */
  readonly recentViolations: RecentViolationEntry[]
  /** C1 observe 恒 0 blocked -> 误报率恒 null（无数据，不是 0%）。 */
  blockedTurns: number
  blockedPassedAudits: number
  /** verdict !== 'pass' 的完成审计数（漏报率分母）。 */
  findingsAudits: number
  /** verdict === 'block' 且 gate 未拦（escaped）的审计数（漏报率分子）。 */
  escapeAudits: number
}

export function setupCompliance(deps: SetupComplianceDeps): ComplianceInfrastructure {
  const cmplLogger = deps.logger.child('compliance')
  const now = deps.now ?? Date.now

  // ── 1. 规则编译（启动一次；rejected 记 CMPL_RULE_INVALID 并继续，F5-001 §5）──
  const ruleSet = deps.rules ?? COMPLIANCE_RULES
  const compiled = compileComplianceRules(ruleSet)
  const ruleById = new Map<string, CompiledComplianceRule>()
  for (const c of compiled.rules) ruleById.set(c.rule.id, c)
  for (const r of compiled.rejected) {
    try {
      cmplLogger.warn('compliance rule rejected at compile; rule disabled', {
        scope: 'compliance.rules',
        code: 'CMPL_RULE_INVALID',
        tags: { ruleId: r.ruleId },
        detail: r.reasons.join('; ')
      })
    } catch {
      /* logger 抛错不影响启动 */
    }
  }

  const getGateConfig = (): Readonly<
    ReturnType<typeof deps.configStore.get>['persona']['compliance']['gate']
  > => deps.configStore.get().persona.compliance.gate
  const getAuditConfig = (): Readonly<
    ReturnType<typeof deps.configStore.get>['persona']['compliance']['audit']
  > => deps.configStore.get().persona.compliance.audit

  /** gate 是否处于采集状态（裁定 1.8：enabled=总开关，scope='off' 运行时等价关闭）。 */
  const gateCollecting = (): boolean => {
    const g = getGateConfig()
    return g.enabled && g.scope !== 'off'
  }

  // ── 2. 熔断器（进程级单例）+ persistence + 快照态 ──
  const circuit: ComplianceCircuit = createComplianceCircuit({}, cmplLogger, deps.metrics)
  const persistence: CompliancePersistence = createCompliancePersistence({
    db: deps.db,
    logger: cmplLogger
  })

  const snapshotState: SnapshotState = {
    ruleHits: new Map(ruleSet.map((r) => [r.id, 0])),
    rejectedRules: compiled.rejected.map((r) => ({ id: r.ruleId, reason: r.reasons.join('; ') })),
    recentViolations: [],
    blockedTurns: 0,
    blockedPassedAudits: 0,
    findingsAudits: 0,
    escapeAudits: 0
  }
  function pushRing(entry: RecentViolationEntry): void {
    snapshotState.recentViolations.push(entry)
    if (snapshotState.recentViolations.length > RECENT_VIOLATIONS_MAX) {
      snapshotState.recentViolations.shift()
    }
  }

  /** dislike 补审用的近期 gateOutcome 回看（有界；跨重启自然丢失，gateOutcome 可选）。 */
  const lastOutcomes = new Map<string, ComplianceGateOutcome>()
  function rememberOutcome(turnId: string, outcome: ComplianceGateOutcome): void {
    lastOutcomes.set(turnId, outcome)
    while (lastOutcomes.size > LAST_OUTCOMES_MAX) {
      const oldest = lastOutcomes.keys().next().value
      if (oldest === undefined) break
      lastOutcomes.delete(oldest)
    }
  }

  // ── 3. ChatService 集成对象（gate 工厂 + TURN_END 落库）──
  const chatIntegration: ChatComplianceIntegration = {
    createGate(turnId, candidateId) {
      // kill switch（裁定 1.8）：Null Object，不采集。live config 每轮读一次。
      if (!gateCollecting()) return createNullGate()
      const gateConfig = getGateConfig()
      return createComplianceGate({
        rules: compiled.rules,
        options: {
          scope: gateConfig.scope,
          firstSegmentMinChars: gateConfig.firstSegmentMinChars,
          segmentMaxChars: gateConfig.segmentMaxChars,
          budgetMs: gateConfig.budgetMs,
          maxHoldMs: gateConfig.maxHoldMs,
          disabledRuleIds: deps.configStore.get().persona.compliance.disabledRuleIds,
          attemptIndex: 0, // C1 无重生成；C3 起 attempt 1 新建 gate 时换 1
          debugCaptureText: deps.configStore.get().persona.compliance.debugCaptureText,
          turnId,
          candidateId
        },
        circuit,
        logger: cmplLogger,
        metrics: deps.metrics
      })
    },
    recordTurnEnd(input) {
      try {
        if (!gateCollecting()) return // kill switch：不建行、不喂熔断器
        // §3.11 纪律 1：turns 行 TURN_END 先 INSERT；审计/反馈是后来的 UPDATE。
        persistence.recordTurn({
          turnId: input.turnId,
          occurredAt: now(),
          gateScope: getGateConfig().scope,
          blocked: input.outcome.blocked,
          regenerations: input.outcome.regenerations,
          degradedPass: input.outcome.degradedPass,
          degraded: input.outcome.degraded,
          checkedSegments: input.outcome.checkedSegments,
          gateMs: input.outcome.totalMs,
          providerFirstDeltaMs: input.providerFirstDeltaMs,
          gateHoldMs: input.gateHoldMs
        })
        circuit.record(input.outcome)
        rememberOutcome(input.turnId, input.outcome)
        if (input.outcome.blocked) snapshotState.blockedTurns++
      } catch (e) {
        // fail-open：合规落库失败绝不影响聊天终局
        try {
          cmplLogger.warn('compliance turn persist failed (fail-open)', {
            scope: 'compliance',
            turnId: input.turnId,
            tags: { reason: e instanceof Error ? e.name : 'unknown' }
          })
        } catch {
          /* logger 抛错不影响主流程 */
        }
      }
    }
  }

  // ── 4. writeSamples sink（350 hook 第一步；裁定 1.4 #4）──
  // samples 是门控遥测：audit.enabled=false 也照写（裁定 1.8）；gate 关闭时
  // records 恒空，天然 no-op。合同永不抛。
  function writeSamples(
    turnId: string,
    records: readonly ComplianceDecisionRecord[],
    occurredAt: number
  ): void {
    const rows: ComplianceSampleRow[] = []
    const snapshotEntries: RecentViolationEntry[] = []
    for (const record of records) {
      const compiledRule = ruleById.get(record.ruleId)
      // 防御：被禁用/被拒规则不会产记录；未知 ID 不造样本、不涨快照计数。
      if (compiledRule === undefined) continue
      rows.push(
        sampleRowFromRecord(record, compiledRule.rule.type, compiledRule.rule.severity, occurredAt)
      )
      snapshotEntries.push({
        turnId,
        type: compiledRule.rule.type,
        severity: compiledRule.rule.severity,
        detectionMethod: 'regex',
        ruleId: record.ruleId
      })
    }
    if (rows.length === 0) return
    try {
      // 纪律：只有 parent turn 存在且整个事务完成后，才更新内存调试快照；
      // turn 写入失败/清理竞态时不留 DB 孤儿、不制造「已记录」假象。
      if (!persistence.recordSamples(rows)) {
        cmplLogger.debug('compliance samples skipped: parent turn missing', {
          scope: 'compliance',
          turnId,
          metrics: { rows: rows.length }
        })
        return
      }
      for (const record of records) {
        if (ruleById.has(record.ruleId)) {
          snapshotState.ruleHits.set(
            record.ruleId,
            (snapshotState.ruleHits.get(record.ruleId) ?? 0) + 1
          )
        }
      }
      for (const entry of snapshotEntries) pushRing(entry)
    } catch (e) {
      try {
        cmplLogger.warn('compliance samples persist failed (fail-open)', {
          scope: 'compliance',
          turnId,
          metrics: { rows: rows.length },
          tags: { reason: e instanceof Error ? e.name : 'unknown' }
        })
      } catch {
        /* logger 抛错不影响主流程 */
      }
    }
  }

  // ── 5. 人设摘要 / L0 键名（hook 与 dislike 补审共用；抛错按空降级）──
  function getPersonaSummary(): string {
    try {
      const identity = deps.promptLoader.load('identity.md') ?? ''
      const soul = deps.promptLoader.load('soul.md') ?? ''
      return `${identity}\n${soul}`.trim().slice(0, PERSONA_SUMMARY_MAX_CHARS)
    } catch {
      return ''
    }
  }
  function getKnownFactKeys(): readonly string[] {
    try {
      return deps.getKnownFactKeys?.() ?? []
    } catch {
      return []
    }
  }

  // ── 6. 独立审计 provider（硬 composition 合同；无 key 不注册 hook）──
  const fauxMode = process.env['COMPANION_TEST_MODE'] === 'faux'
  const apiKey = deps.secretStore.get('modelApiKey')
  let auditProvider: ExtractionProvider | null = null
  if (apiKey) {
    if (deps.auditProviderForTest !== undefined) {
      auditProvider = deps.auditProviderForTest
    } else if (fauxMode) {
      // E2E：常量响应（可脚本化），零网络。缺省 pass 空壳。
      const response =
        process.env['COMPANION_FAUX_COMPLIANCE_AUDIT'] ??
        JSON.stringify({ verdict: 'pass', level: 'none', violations: [] })
      auditProvider = {
        complete: async () => response
      }
    } else {
      const modelConfig = deps.configStore.get().model
      const secureFetch = createSecureFetch(
        {
          isDev: deps.isDev,
          allowHttpLocalhostInDev: deps.configStore.get().security.allowHttpLocalhostInDev
        },
        cmplLogger
      )
      auditProvider = createOpenAIExtractionProvider(
        {
          provider: modelConfig.provider,
          model: modelConfig.model,
          baseUrl: modelConfig.baseUrl,
          apiKey,
          // 与聊天/提取同款 compat 解析：审计必须显式关思考（防 reasoning 烧光 max_tokens）
          thinkingFormat: resolveCompat(
            modelConfig.provider,
            modelConfig.baseUrl,
            modelConfig.compatOverrides
          ).thinkingFormat
        },
        { logger: cmplLogger, fetchFn: secureFetch }
      )
    }
  } else {
    cmplLogger.warn('no API key; compliance audit hook not registered (gate unaffected)', {
      scope: 'compliance',
      code: 'LLM_AUTH'
    })
  }

  // ── 7. 审计结果 sink：UPDATE turns + llm 样本行 + 快照态（§3.11/裁定 1.4 #4）──
  function onAuditResultSink(task: ComplianceAuditTask, result: ComplianceAuditResult): void {
    try {
      // parent 已在关闭/清理竞态中消失：审计结果不反建 samples/分母，也不污染快照。
      if (!persistence.recordAuditResult(task.turnId, result, now())) {
        cmplLogger.debug('compliance audit result skipped: parent turn missing', {
          scope: 'compliance',
          turnId: task.turnId
        })
        return
      }
    } catch (e) {
      try {
        cmplLogger.warn('compliance audit result persist failed (fail-open)', {
          scope: 'compliance',
          turnId: task.turnId,
          tags: { reason: e instanceof Error ? e.name : 'unknown' }
        })
      } catch {
        /* logger 抛错不影响主流程 */
      }
      return
    }
    // 快照态（内存，永不抛）。unavailable 空壳不入任何分母（§3.6 失败表）。
    if (!result.unavailable) {
      const gateBlocked = task.input.gateOutcome?.blocked === true
      if (gateBlocked && result.verdict === 'pass') snapshotState.blockedPassedAudits++
      if (result.verdict !== 'pass') {
        snapshotState.findingsAudits++
        if (result.verdict === 'block' && !gateBlocked) snapshotState.escapeAudits++
      }
      for (const v of result.violations) {
        pushRing({
          turnId: task.turnId,
          type: v.type,
          severity: v.severity,
          detectionMethod: 'llm'
        })
      }
    }
  }

  // ── 8. 审计器 + hook 注册（无 provider 时全跳过）──
  let auditHook: ReturnType<typeof createComplianceAuditHook> | null = null
  if (auditProvider !== null) {
    const auditor = createComplianceAuditor({
      provider: auditProvider,
      logger: cmplLogger,
      metrics: deps.metrics,
      // 构造时读取；改超时需重启（auditor API 构造期合同）
      timeoutMs: getAuditConfig().timeoutMs
    })
    auditHook = createComplianceAuditHook({
      logger: cmplLogger,
      sessionStore: deps.sessionStore,
      auditor,
      getAuditConfig,
      getPersonaSummary,
      getKnownFactKeys,
      // 裁定 1.8：enabled=false / scope='off' = 全管线 kill switch（含 samples 与离线审计）。
      shouldCollect: gateCollecting,
      writeSamples,
      onAuditResult: onAuditResultSink
    })
    registerHook(auditHook.hook)
    auditHook.startConsumer()
    cmplLogger.info('compliance audit hook registered (turn.end priority 350)', {
      scope: 'compliance',
      metrics: { rules: compiled.rules.length, rejected: compiled.rejected.length }
    })
  }

  // 动态撤销：gate.enabled=false / scope='off' 不只是新 turn 的开关，而是对已排队/
  // 在飞审计的即时撤销边界。revoke 不 close queue，重新启用后可继续采集。
  let unsubscribeCollectionRevocation: (() => void) | null = null
  if (auditHook !== null) {
    try {
      unsubscribeCollectionRevocation = deps.configStore.subscribe(() => {
        if (!gateCollecting()) auditHook?.revokeCollection()
      })
    } catch (e) {
      // 订阅失败不阻止启动；消费者每个任务前/后仍有 live shouldCollect 双检查。
      try {
        cmplLogger.warn('compliance collection revocation subscription unavailable', {
          scope: 'compliance',
          tags: { reason: e instanceof Error ? e.name : 'unknown' }
        })
      } catch {
        /* logger 抛错不影响启动 */
      }
    }
  }

  // ── 9. dislike 补审（§3.7「被 dislike 的轮强制补审」）──
  function onDislike(turnId: string, sessionId: string, messageId: string): void {
    // messageId 已由 feedback service 完成关联校验；本层只以 turn/session 装配补审输入。
    void messageId
    try {
      if (auditHook === null) return // 无审计轨道：反馈落库照常（P3C1-07），补审跳过
      // 裁定 1.8：全局 kill switch 下连补审也不得读取 SessionStore/调用 LLM。
      if (!gateCollecting()) return
      const auditConfig = getAuditConfig()
      if (!auditConfig.enabled) return
      const pair = deps.sessionStore.getTurnMessages(sessionId, turnId)
      if (pair === null || pair.assistant.content.length === 0) return
      const gateOutcome = lastOutcomes.get(turnId)
      const input: ComplianceAuditInput = {
        turnId,
        sessionId,
        personaSummary: getPersonaSummary(),
        recentTurns: buildRecentTurns(
          deps.sessionStore.getMessages(sessionId, (auditConfig.recentTurnWindow + 1) * 2),
          turnId,
          auditConfig.recentTurnWindow
        ),
        userText: pair.user.content,
        candidateText: pair.assistant.content,
        ...(gateOutcome !== undefined ? { gateOutcome } : {}),
        knownFactKeys: getKnownFactKeys()
      }
      // 队列内同 turnId 幂等；已完成轮允许再次入队（补审语义，audit-queue #3）
      const enqueued = auditHook.queue.enqueue({
        turnId,
        sessionId,
        input,
        reason: 'dislike'
      })
      if (enqueued) auditHook.startConsumer()
    } catch (e) {
      try {
        cmplLogger.warn(
          'compliance dislike supplementary-audit failed (feedback already persisted)',
          {
            scope: 'compliance',
            turnId,
            tags: { reason: e instanceof Error ? e.name : 'unknown' }
          }
        )
      } catch {
        /* logger 抛错不影响主流程 */
      }
    }
  }

  // ── 10. 90 天滚动清理（§3.11 纪律 3；启动时一次，turn_id 级联）──
  try {
    persistence.purgeStale(now())
  } catch (e) {
    try {
      cmplLogger.warn('compliance history purge failed at startup (non-fatal)', {
        scope: 'compliance',
        tags: { reason: e instanceof Error ? e.name : 'unknown' }
      })
    } catch {
      /* logger 抛错不影响启动 */
    }
  }

  // ── 11. 快照（§3.10：只含聚合量；派生率近似值）──
  function getSnapshot(): ComplianceSnapshot {
    const gateConfig = getGateConfig()
    const ruleHits: Record<string, number> = {}
    for (const [id, count] of snapshotState.ruleHits) ruleHits[id] = count
    return {
      gateEnabled: gateConfig.enabled && gateConfig.scope !== 'off',
      gateScope: gateConfig.scope,
      ruleHits,
      rejectedRules: snapshotState.rejectedRules,
      recentViolations: [...snapshotState.recentViolations],
      // C1 observe 无 blocks -> null（无数据 ≠ 0%，§3.9「只能看趋势」）
      approxFalsePositiveRate:
        snapshotState.blockedTurns > 0
          ? snapshotState.blockedPassedAudits / snapshotState.blockedTurns
          : null,
      approxEscapeRate:
        snapshotState.findingsAudits > 0
          ? snapshotState.escapeAudits / snapshotState.findingsAudits
          : null
    }
  }

  cmplLogger.info('compliance infrastructure ready', {
    scope: 'compliance',
    metrics: {
      rules: compiled.rules.length,
      rejected: compiled.rejected.length,
      auditHook: auditHook !== null ? 1 : 0
    }
  })

  return {
    chatIntegration,
    getSnapshot,
    onDislike,
    cleanup: () => {
      unsubscribeCollectionRevocation?.()
      auditHook?.stopConsumer()
    }
  }
}
