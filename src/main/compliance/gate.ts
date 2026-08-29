// src/main/compliance/gate.ts
// 流式合规门控（F5-001 §3.4 + 开工裁定 1.1 双缓冲 + 裁定 1.2 四门切段 + 裁定 1.11 S-C14）。
//
// 【裁定 1.1 双缓冲结构】输出路径与分析路径独立：
// - 输出路径（releaseText 语义按 scope 分双路）：
//   observe                    → releaseText === delta 逐字直通、零持留，abort 恒 false
//   first-segment/all-segments → 仅「首段放行前」持有输出，首段放行后逐字直通
//   off                        → push 直通，不做任何匹配（运行时等价 enabled=false，裁定 1.8）
// - 分析路径：独立累积、四门切段、匹配，产出 violations 与 DecisionRecord（裁定 1.4：
//   逐命中记录 takeRecords() 单次移交、取后清空、幂等；反事实字段组按裁定 1.5 在
//   移交时定格——影子首段用 SHADOW_FIRST_SEGMENT_PARAMS 冻结参数假想 first-segment
//   世界，与真实门共用 delta 流与时钟但不受 live config 调参影响）。
//   永不持有输出权；observe 下 violations 允许滞后于文本放行。
// 调用方只 sink releaseText（单一权威约定保留），不得自行拼接原 delta。
//
// 【裁定 1.2 首段四门，先到先决】边界门（≥firstSegmentMinChars）/ 时限门（maxHoldMs，
// 有最早边界在最早边界切、无边界整缓冲作一段）/ EOF 门（flush）/ 长度门（segmentMaxChars，
// 兼 ReDoS 防线，且不拆 surrogate pair——裁定 1.11 S-C14）。任一门触发时对已积累文本照常
// 匹配判定。后续段恢复边界 ≥16 / 长度门 / EOF 门（无时限门）。
// maxHoldMs 是墙钟时限，但在 push/flush 的同步求值点检查（now() 注入保可测）：C1 observe
// 输出直通，时限只影响分析路径首段判定点；C2 enforce 若需在 delta 停顿期间触发真墙钟
// 释放，由 ChatService 层补调度，本接口不变。
//
// 【fail-open】全部方法同步、无 IO、不抛异常——内部异常（含 now/metrics/logger 抛错）
// 一律吞掉：置 degraded=true、持有内容立即放行、后续直通（CMP-S15）。单轮匹配累计耗时
// 超 budgetMs 同样降级直通并记 compliance.gate.degraded（F5-001 §3.4 ReDoS 兜底）。
//
// 每轮一个实例，不复用（内部有累积缓冲，复用会串轮）；attempt 1 由调用方新建
// observe gate（裁定 1.11 S-C12，不依赖 resetForRetry 可变副作用——该方法仅为
// F5-001 接口完整性保留）。

import type {
  BlockIneligibleReason,
  ComplianceDecisionRecord,
  ComplianceGateScope,
  ComplianceRuleAction,
  ComplianceSpan,
  ComplianceViolation
} from '@shared/compliance/types'
import type { Logger, LogFields, MetricsRegistry } from '@shared/observability/types'
import type { CompiledComplianceRule } from './compile'
import type { ComplianceRule } from './rules'
import { SHADOW_FIRST_SEGMENT_PARAMS, SHADOW_POLICY_VERSION, shadowTargetAction } from './rules'
import type { ComplianceCircuit } from './circuit'
import { scrub } from '../observability/scrub'

export interface ComplianceGateOptions {
  readonly scope: ComplianceGateScope
  /** 首段边界门的保留阈值下限（裁定 1.2：不再宣称"两倍最长模式"）。默认 32（待校准基线）。 */
  readonly firstSegmentMinChars?: number
  /** 长度门：无可用边界时的强制切段长度。同时是单次正则输入上限（ReDoS 防线）。默认 512。 */
  readonly segmentMaxChars?: number
  /** 句末边界字符集。默认 `。！？；!?;\n…`。 */
  readonly boundaryChars?: string
  /** 单轮门控匹配总 CPU 预算（毫秒）。默认 30。超预算 → 本轮降级直通并记 compliance.gate.degraded。 */
  readonly budgetMs?: number
  /** 首段时限门（裁定 1.2 新增）：自首个非空 delta 起的墙钟上限。默认 400（待校准基线）。 */
  readonly maxHoldMs?: number
  /** 本次运行禁用的规则 ID（来自人设配置 disabledRuleIds）。 */
  readonly disabledRuleIds?: readonly string[]
  /** 当前 attempt。默认 0。attempt 1 恒 observe 不拦截（降级表 retry-attempt 行）。 */
  readonly attemptIndex?: 0 | 1
  /** 调试用：命中片段前后各 ≤20 字符窗口写 debug 日志。**仅开发构建生效**（CFG-PER-14），写入前过 scrub()。 */
  readonly debugCaptureText?: boolean
  /** 本轮标识（写入每条 DecisionRecord）。P3C1-08 ChatService 集成时必传；缺省为空串占位。 */
  readonly turnId?: string
  /** 候选生成标识（一轮一次生成尝试一个；attempt 1 新建 gate 时换新的）。同 turnId 的缺省约定。 */
  readonly candidateId?: string
}

/** push/flush 的返回。**releaseText 就是应该 sink 出去的内容，调用方不得自行拼接原 delta。** */
export interface ComplianceGateEmission {
  /** 可以立刻 sink 给渲染进程的文本。可能为空串（首段持留中 / abort）。 */
  readonly releaseText: string
  /**
   * true = 必须中止本次 provider 流并走重生成。
   * 只可能在 scope==='first-segment'|'all-segments'、首段、attempt===0、熔断未开、
   * 且尚未 release 过任何非空文本时为 true。
   */
  readonly abort: boolean
  /** 本次新增的违规发现（含被降级为 flag 的）。 */
  readonly violations: readonly ComplianceViolation[]
}

/** 本轮门控的汇总结论。写入 TurnEndData，供离线审计对齐、供指标统计。**不含任何回复正文。** */
export interface ComplianceGateOutcome {
  /** 是否发生过真实阻断。 */
  readonly blocked: boolean
  /** 重生成次数。gate 单实例只见自己的 attempt，恒 0——跨 attempt 计数由 ChatService 汇总。 */
  readonly regenerations: 0 | 1
  /** 重生成后仍检出 critical 却放行了。C1 无重生成，恒 false——由 C3 调用方据双 attempt 结果合成。 */
  readonly degradedPass: boolean
  /** 本轮命中的全部规则 ID（去重，含 flag）。 */
  readonly ruleIds: readonly string[]
  /** 判定过的段数。 */
  readonly checkedSegments: number
  /** 门控匹配累计耗时（now() 注入值）。 */
  readonly totalMs: number
  /** 是否因熔断强制 observe / 超预算 / 内部异常而降级。 */
  readonly degraded: boolean
}

/** 流式合规门控。**每轮一个实例，不复用。** */
export interface ComplianceGate {
  /** 喂入一个 provider delta。调用方必须用返回的 releaseText 去 sink，**不能同时 sink 原始 delta**。 */
  push(delta: string): ComplianceGateEmission
  /** 流正常结束时调用，吐出缓冲区剩余内容（永不 abort——EOF 段动作一律降级 flag）。 */
  flush(): ComplianceGateEmission
  /** 重生成前调用，清空缓冲并把内部模式切到 observe（仅为 F5-001 接口完整性保留；C3 应新建实例）。 */
  resetForRetry(): void
  /**
   * 取走本轮逐命中决策记录（开工裁定 1.4）：**单次移交、取后清空、幂等**——
   * 重复调用返回空数组（防双写）。调用前应先 flush()（ChatService 合同）；
   * 未 flush 被取走时按 EOF 定格影子首段，保证反事实字段有确定值。
   * 记录只含 id/偏移/枚举/时序计数，**无正文**（§3.11 红线）。
   */
  takeRecords(): readonly ComplianceDecisionRecord[]
  /** 取本轮汇总。可在任何时刻调用。 */
  outcome(): ComplianceGateOutcome
}

/** TurnEndData.complianceRecords 的单轮上限（开工裁定 1.4 #3：超出截断并计数，防无界膨胀）。 */
export const COMPLIANCE_RECORDS_MAX_PER_TURN = 64

/**
 * 把 records 截到单轮上限。返回截断条数供 TurnEndData.complianceRecordsTruncated 计数。
 * 纯函数，不修改入参。
 */
export function capComplianceRecords(
  records: readonly ComplianceDecisionRecord[],
  max: number = COMPLIANCE_RECORDS_MAX_PER_TURN
): { records: readonly ComplianceDecisionRecord[]; truncated: number } {
  if (records.length <= max) return { records, truncated: 0 }
  return { records: records.slice(0, max), truncated: records.length - max }
}

export interface ComplianceGateDeps {
  readonly rules: readonly CompiledComplianceRule[]
  readonly options: ComplianceGateOptions
  /** 跨轮熔断器。为 undefined 时不启用熔断。gate 每轮新建，只在构造时读一次 isOpen()。 */
  readonly circuit?: ComplianceCircuit
  readonly logger: Logger
  readonly metrics: MetricsRegistry
  /** 注入以便测试；默认 () => performance.now()。 */
  readonly now?: () => number
}

const DEFAULT_BOUNDARY_CHARS = '。！？；!?;\n…'
/** 后续段边界门阈值（裁定 1.2：不变）。 */
const SUBSEQUENT_SEGMENT_MIN_CHARS = 16
/** debugCaptureText 命中窗口的上下文半径（字符）。 */
const DEBUG_WINDOW_RADIUS = 20

type SegmentTrigger = 'boundary' | 'deadline' | 'length' | 'eof'

interface Segment {
  readonly text: string
  /** 本段在 assistant 全文中的绝对起始 UTF-16 偏移（裁定 1.11 S-C14：span 一律全文绝对坐标）。 */
  readonly absoluteStart: number
  readonly index: number
  readonly trigger: SegmentTrigger
}

interface HitRecord {
  readonly violation: ComplianceViolation
  readonly rule: ComplianceRule
  readonly declaredAction: ComplianceRuleAction
  readonly effectiveAction: ComplianceRuleAction
  readonly segment: Segment
}

/** 是否恰好在 surrogate pair 中间（裁定 1.11 S-C14：强制切段不得拆对）。 */
function splitsSurrogatePair(text: string, cutAt: number): boolean {
  const hi = text.charCodeAt(cutAt - 1)
  const lo = text.charCodeAt(cutAt)
  return hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff
}

/**
 * 若 `deps.circuit?.isOpen() === true`，返回的 gate 的实际 scope 恒为 'observe'，
 * 且 `outcome().degraded === true`（F5-001 §3.4 合同；调用方不需要自己判断）。
 */
export function createComplianceGate(deps: ComplianceGateDeps): ComplianceGate {
  const { rules, options, circuit, logger, metrics } = deps
  const now = deps.now ?? (() => performance.now())

  const scope = options.scope
  const minCharsFirst = options.firstSegmentMinChars ?? 32
  const segmentMaxChars = options.segmentMaxChars ?? 512
  const boundaryChars = options.boundaryChars ?? DEFAULT_BOUNDARY_CHARS
  const budgetMs = options.budgetMs ?? 30
  const maxHoldMs = options.maxHoldMs ?? 400
  const attemptIndex = options.attemptIndex ?? 0
  const debugCaptureText = options.debugCaptureText ?? false
  const disabled = new Set(options.disabledRuleIds ?? [])

  // 熔断：构造时读一次。强制 observe 只发生在 gate 本来要做匹配的时候；off 保持 off。
  const circuitOpen = circuit?.isOpen() === true
  let effectiveScope: ComplianceGateScope = circuitOpen && scope !== 'off' ? 'observe' : scope

  // ── 分析路径状态 ──
  let analysisBuffer = ''
  let analysisAbsoluteStart = 0
  let firstSegmentDecided = false
  let firstDeltaAt: number | null = null
  let segmentCount = 0

  // ── 输出路径状态 ──
  let outputHeld = ''
  let firstSegmentReleased = effectiveScope === 'observe' || effectiveScope === 'off'
  let releasedChars = 0
  let aborted = false

  // ── outcome 状态 ──
  let blocked = false
  let degraded = circuitOpen && scope !== 'off'
  /** 匹配停摆（budget/异常降级）。与 degraded 分开：熔断强制 observe 仍要继续匹配。 */
  let halted = false
  const ruleIds = new Set<string>()
  let checkedSegments = 0
  let totalMs = 0
  let latencyEmitted = false

  // ── 影子首段追踪（裁定 1.5：冻结参数假想 first-segment 世界，反事实字段的数据源）──
  // 与真实门共用 delta 流与时钟，但切段参数恒为 SHADOW_FIRST_SEGMENT_PARAMS（不碰 config）。
  // 只追踪「影子首段在哪里、被哪扇门切出」（cutPoint C 与 trigger T）——决定后冻结。
  // 真实门参数被调偏离冻结值时影子时间线不变：这正是防 C1 中途调参污染反事实的机制。
  let shadowBuffer = ''
  let shadowFirstDeltaAt: number | null = null
  let shadowDecided = false
  let shadowCutPoint = 0
  let shadowTrigger: SegmentTrigger | null = null

  /** 待移交记录（反事实字段在 takeRecords 时才定格——影子首段可能尚未决定）。 */
  interface PendingRecord {
    readonly rule: ComplianceRule
    readonly segmentIndex: number
    readonly span: ComplianceSpan
    readonly declaredAction: ComplianceRuleAction
    readonly effectiveAction: ComplianceRuleAction
    readonly releasedCharsBefore: number
  }
  const pendingRecords: PendingRecord[] = []
  let recordsTaken = false

  /** 影子四门（仅首段；参数恒为 SHADOW_FIRST_SEGMENT_PARAMS）。决定后写 cutPoint/trigger 并冻结。 */
  function decideShadowFirstSegment(nowMs: number, isFlush: boolean): void {
    if (shadowDecided || shadowBuffer.length === 0) return
    const maxChars = SHADOW_FIRST_SEGMENT_PARAMS.segmentMaxChars
    const minChars = SHADOW_FIRST_SEGMENT_PARAMS.firstSegmentMinChars
    const windowLen = Math.min(shadowBuffer.length, maxChars)
    let sufficient = -1
    let earliest = -1
    for (let i = 0; i < windowLen; i++) {
      if (boundaryChars.includes(shadowBuffer[i])) {
        if (earliest === -1) earliest = i
        if (i + 1 >= minChars) {
          sufficient = i
          break
        }
      }
    }

    let cutAt = -1
    let trigger: SegmentTrigger | null = null
    if (sufficient !== -1) {
      cutAt = sufficient + 1
      trigger = 'boundary'
    } else if (
      shadowFirstDeltaAt !== null &&
      nowMs - shadowFirstDeltaAt >= SHADOW_FIRST_SEGMENT_PARAMS.maxHoldMs
    ) {
      if (earliest !== -1) {
        cutAt = earliest + 1
        trigger = 'deadline'
      } else {
        cutAt = Math.min(shadowBuffer.length, maxChars)
        trigger = shadowBuffer.length > maxChars ? 'length' : 'deadline'
      }
    }
    if (cutAt === -1 && shadowBuffer.length >= maxChars) {
      cutAt = maxChars
      trigger = 'length'
    }
    if (cutAt === -1 && isFlush) {
      cutAt = shadowBuffer.length
      trigger = 'eof'
    }
    if (cutAt <= 0 || trigger === null) return
    // surrogate 不拆对（S-C14）：首段从绝对 0 起，cutAt 即绝对坐标
    if (cutAt < shadowBuffer.length && splitsSurrogatePair(shadowBuffer, cutAt)) {
      cutAt -= 1
      if (cutAt <= 0) return
    }
    shadowCutPoint = cutAt
    shadowTrigger = trigger
    shadowDecided = true
    shadowBuffer = '' // 决定后缓冲不再有需要
  }

  // ── 切段（分析路径）──

  function takeSegments(nowMs: number, isFlush: boolean): Segment[] {
    const out: Segment[] = []
    for (;;) {
      const isFirst = !firstSegmentDecided
      const minChars = isFirst ? minCharsFirst : SUBSEQUENT_SEGMENT_MIN_CHARS
      // 边界扫描与切段都限制在 segmentMaxChars 窗口内（单次正则输入上限不破）
      const windowLen = Math.min(analysisBuffer.length, segmentMaxChars)
      let sufficient = -1
      let earliest = -1
      for (let i = 0; i < windowLen; i++) {
        if (boundaryChars.includes(analysisBuffer[i])) {
          if (earliest === -1) earliest = i
          if (i + 1 >= minChars) {
            sufficient = i
            break
          }
        }
      }

      let cutAt = -1
      let trigger: SegmentTrigger | null = null
      if (sufficient !== -1) {
        cutAt = sufficient + 1
        trigger = 'boundary'
      } else if (isFirst && firstDeltaAt !== null && nowMs - firstDeltaAt >= maxHoldMs) {
        // 时限门：有最早边界在最早边界切，无边界整缓冲作一段（超窗口按长度截，记 length）
        if (earliest !== -1) {
          cutAt = earliest + 1
          trigger = 'deadline'
        } else if (analysisBuffer.length > 0) {
          cutAt = Math.min(analysisBuffer.length, segmentMaxChars)
          trigger = analysisBuffer.length > segmentMaxChars ? 'length' : 'deadline'
        }
      }
      if (cutAt === -1 && analysisBuffer.length >= segmentMaxChars) {
        cutAt = segmentMaxChars
        trigger = 'length'
      }
      if (cutAt === -1 && isFlush && analysisBuffer.length > 0) {
        cutAt = analysisBuffer.length
        trigger = 'eof'
      }
      if (cutAt <= 0 || trigger === null) break
      // surrogate pair 不拆（S-C14）：切点落在高低位之间则后退一个 code unit
      if (cutAt < analysisBuffer.length && splitsSurrogatePair(analysisBuffer, cutAt)) {
        cutAt -= 1
        if (cutAt <= 0) break
      }

      out.push({
        text: analysisBuffer.slice(0, cutAt),
        absoluteStart: analysisAbsoluteStart,
        index: segmentCount,
        trigger
      })
      segmentCount++
      firstSegmentDecided = true
      analysisBuffer = analysisBuffer.slice(cutAt)
      analysisAbsoluteStart += cutAt
    }
    return out
  }

  // ── 匹配与决策 ──

  /** 首段真 block 资格（降级表第一行：scope 执法系 + attempt 0 + 熔断未开 + 首段 + 未放行过）。 */
  function isBlockEligible(segment: Segment): boolean {
    return (
      (effectiveScope === 'first-segment' || effectiveScope === 'all-segments') &&
      attemptIndex === 0 &&
      !circuitOpen &&
      segment.index === 0 &&
      releasedChars === 0 &&
      !aborted
    )
  }

  /** 真剥离资格（裁定 1.1 #3：observe / attempt 1 / 熔断强制 observe 下 strip 一律降级 flag）。 */
  function isStripEligible(span: ComplianceSpan): boolean {
    if (effectiveScope !== 'first-segment' && effectiveScope !== 'all-segments') return false
    if (attemptIndex !== 0 || circuitOpen) return false
    if (span.start !== 0) return false // S-C14：全文 start===0，不是段局部
    // 剥离后剩余必须非空（对当前持有的输出判定）
    return outputHeld.slice(span.length).trim().length > 0
  }

  function decideEffectiveAction(declared: ComplianceRuleAction, span: ComplianceSpan, segment: Segment): ComplianceRuleAction {
    // EOF 段动作一律降级为 flag（F5-001 §3.4 step 4：流已结束，abort 没有意义）
    if (segment.trigger === 'eof') return 'flag'
    if (declared === 'block') return isBlockEligible(segment) ? 'block' : 'flag'
    if (declared === 'strip') return isStripEligible(span) ? 'strip' : 'flag'
    return 'flag'
  }

  function matchSegment(segment: Segment): HitRecord[] {
    const hits: HitRecord[] = []
    for (const { rule, regex } of rules) {
      if (disabled.has(rule.id)) continue
      // prefix 语义 = 全文开头；非首段（绝对起点非 0）不评估（S-C14：防止后段 local 0 误触）
      if (rule.scope === 'prefix' && segment.absoluteStart !== 0) continue
      const m = regex.exec(segment.text)
      if (m === null) continue
      const span: ComplianceSpan = {
        start: segment.absoluteStart + m.index,
        length: m[0].length
      }
      const violation: ComplianceViolation = {
        type: rule.type,
        severity: rule.severity,
        confidence: rule.confidence,
        detectionMethod: 'regex',
        ruleId: rule.id,
        span
      }
      const declaredAction = rule.action
      hits.push({
        violation,
        rule,
        declaredAction,
        effectiveAction: decideEffectiveAction(declaredAction, span, segment),
        segment
      })
    }
    return hits
  }

  /** CFG-PER-14：debugCaptureText 命中窗口。仅开发构建；≤20 字符上下文；过 scrub()；失败静默。 */
  function debugCaptureHit(hit: HitRecord): void {
    if (!debugCaptureText) return
    if (!import.meta.env.DEV) return // 运行时装甲：生产构建手改 true 也不采集
    const span = hit.violation.span
    if (span === undefined) return
    const localStart = span.start - hit.segment.absoluteStart
    const from = Math.max(0, localStart - DEBUG_WINDOW_RADIUS)
    const to = Math.min(hit.segment.text.length, localStart + span.length + DEBUG_WINDOW_RADIUS)
    try {
      logger.debug('compliance hit window (debugCaptureText)', {
        scope: 'compliance',
        tags: { ruleId: hit.violation.ruleId ?? 'unknown', action: hit.effectiveAction },
        detail: scrub(hit.segment.text.slice(from, to))
      })
    } catch {
      /* debug 通道失败不影响主流程 */
    }
  }

  interface SegmentProcessingResult {
    readonly abort: boolean
    readonly stripLength: number
    readonly hits: readonly HitRecord[]
  }

  /** 匹配一段 + 指标/日志。内部 now/metrics/logger 抛错会向上抛，由 push/flush 的外层统一降级。 */
  function processSegment(segment: Segment): SegmentProcessingResult {
    const matchStart = now()
    const hits = matchSegment(segment)
    totalMs += now() - matchStart
    checkedSegments++
    metrics.counter('compliance.gate.checks').inc()

    let abort = false
    let stripLength = 0
    let blocks = 0
    let strips = 0
    let flags = 0
    let primary: HitRecord | null = null
    for (const hit of hits) {
      if (hit.violation.ruleId !== undefined) ruleIds.add(hit.violation.ruleId)
      // 逐命中记录（裁定 1.4）：gate 产生的命中 span 恒存在；反事实字段 takeRecords 时定格
      if (hit.violation.span !== undefined) {
        pendingRecords.push({
          rule: hit.rule,
          segmentIndex: segment.index,
          span: hit.violation.span,
          declaredAction: hit.declaredAction,
          effectiveAction: hit.effectiveAction,
          releasedCharsBefore: releasedChars
        })
      }
      if (hit.effectiveAction === 'block') {
        blocks++
        abort = true
        if (primary === null || hit.violation.confidence > primary.violation.confidence) primary = hit
      } else if (hit.effectiveAction === 'strip') {
        strips++
        // 多条 strip 命中只应用一条（最高优先级 = 最先记录）；其余按 flag 记录
        if (stripLength === 0) stripLength = hit.violation.span?.length ?? 0
      } else {
        flags++
      }
      debugCaptureHit(hit)
    }
    if (flags > 0) metrics.counter('compliance.gate.flags').inc(flags)
    if (strips > 0) metrics.counter('compliance.gate.strips').inc(strips)
    if (blocks > 0) {
      metrics.counter('compliance.gate.blocks').inc(blocks)
      // 主因 = confidence 最高的 block（F5-001 §3.4 决策优先级）；日志无正文（§3.9 红线）
      logger.warn('compliance gate: block decision', {
        scope: 'compliance',
        tags: { ruleId: primary?.violation.ruleId ?? 'unknown' },
        metrics: {
          confidence: primary?.violation.confidence ?? 0,
          segmentIndex: segment.index,
          hits: hits.length
        }
      })
    }
    return { abort, stripLength, hits }
  }

  // ── 降级 ──

  function haltFromBudget(): void {
    halted = true
    degraded = true
    // 以下调用在 push/flush 的 try 内执行；若再抛会转 degradeAfterError（幂等）
    metrics.counter('compliance.gate.degraded').inc()
    logger.warn('compliance gate degraded: budget exhausted', {
      scope: 'compliance',
      code: 'CMPL_GATE_DEGRADED',
      metrics: { totalMs: Math.round(totalMs * 100) / 100, budgetMs }
    } satisfies LogFields)
  }

  /** 异常降级（CMP-S15）：吞错、置 degraded、放行一切持有、后续直通。本函数自身不再抛。 */
  function degradeAfterError(err: unknown, releaseParts: readonly string[]): ComplianceGateEmission {
    halted = true
    degraded = true
    try {
      metrics.counter('compliance.gate.degraded').inc()
    } catch {
      /* 不再外抛 */
    }
    try {
      logger.warn('compliance gate degraded: internal error', {
        scope: 'compliance',
        code: 'CMPL_GATE_DEGRADED',
        detail: scrub(err instanceof Error ? err.message : String(err))
      })
    } catch {
      /* 不再外抛 */
    }
    firstSegmentReleased = true
    // releaseParts 是本次 push 中已决定放行但尚未返回的内容；outputHeld 是仍持有的全部
    // （当前 delta 恰好在两者之一中，不会重复也不会丢）。
    const releaseText = releaseParts.join('') + outputHeld
    outputHeld = ''
    releasedChars += releaseText.length
    emitLatencyOnce()
    return { releaseText, abort: false, violations: [] }
  }

  function emitLatencyOnce(): void {
    if (latencyEmitted) return
    latencyEmitted = true
    try {
      metrics.histogram('compliance.gate.latencyMs').observe(totalMs)
    } catch {
      /* 收尾指标失败不影响主流程 */
    }
  }

  // ── push / flush ──

  function push(delta: string): ComplianceGateEmission {
    if (effectiveScope === 'off') {
      return { releaseText: delta, abort: false, violations: [] }
    }
    if (aborted) {
      // CMP-S06：abort 后的后续 delta 一律不放行（调用方应已中止 provider 流；双保险）
      return { releaseText: '', abort: true, violations: [] }
    }
    if (halted) {
      releasedChars += delta.length
      return { releaseText: delta, abort: false, violations: [] }
    }

    const releaseParts: string[] = []
    try {
      // 先把 delta 放入唯一归属（releaseParts 或 outputHeld），再调用任何可能抛错的外部函数
      // （now/metrics/logger）——异常降级返回 releaseParts.join('') + outputHeld，
      // 当前 delta 恰好在两者之一中，不丢字节、不重字节。
      analysisBuffer += delta

      // 输出路径（裁定 1.1）：observe / 首段已放行 → 直通；否则持有
      if (effectiveScope === 'observe' || firstSegmentReleased) {
        releaseParts.push(delta)
      } else {
        outputHeld += delta
      }

      const nowMs = now()
      if (firstDeltaAt === null && delta.length > 0) firstDeltaAt = nowMs

      // 影子路径（裁定 1.5）：冻结参数追踪假想首段；只在未决定前累积
      if (!shadowDecided) {
        shadowBuffer += delta
        if (shadowFirstDeltaAt === null && delta.length > 0) shadowFirstDeltaAt = nowMs
        decideShadowFirstSegment(nowMs, false)
      }

      // 分析路径（独立缓冲，永不持有输出权）
      const segments = takeSegments(nowMs, false)
      const violations: ComplianceViolation[] = []
      for (const segment of segments) {
        const result = processSegment(segment)
        for (const hit of result.hits) violations.push(hit.violation)

        if (result.abort && segment.index === 0 && !firstSegmentReleased) {
          // 真阻断：持有文本丢弃，本轮终止（F5-001 §3.5 重生成由调用方驱动）
          blocked = true
          aborted = true
          firstSegmentReleased = true
          outputHeld = ''
          emitLatencyOnce()
          return { releaseText: '', abort: true, violations }
        }

        if (segment.index === 0 && !firstSegmentReleased) {
          // 首段放行：应用 strip（剥后为空则整体降级 flag——isStripEligible 已把过关，双保险）
          firstSegmentReleased = true
          if (result.stripLength > 0 && outputHeld.slice(result.stripLength).trim().length > 0) {
            outputHeld = outputHeld.slice(result.stripLength)
          }
          releaseParts.push(outputHeld)
          outputHeld = ''
        }

        if (totalMs > budgetMs) {
          haltFromBudget()
          break
        }
      }

      if (halted && !firstSegmentReleased) {
        // 降级即放行：fail-open，绝不因门控故障持留用户文本
        firstSegmentReleased = true
        releaseParts.push(outputHeld)
        outputHeld = ''
      }

      const releaseText = releaseParts.join('')
      releasedChars += releaseText.length
      return { releaseText, abort: false, violations }
    } catch (err) {
      return degradeAfterError(err, releaseParts)
    }
  }

  function flush(): ComplianceGateEmission {
    if (effectiveScope === 'off' || halted) {
      emitLatencyOnce()
      return { releaseText: '', abort: false, violations: [] }
    }
    if (aborted) {
      emitLatencyOnce()
      return { releaseText: '', abort: true, violations: [] }
    }

    const releaseParts: string[] = []
    try {
      const nowMs = now()
      if (!shadowDecided) decideShadowFirstSegment(nowMs, true)
      const segments = takeSegments(nowMs, true)
      const violations: ComplianceViolation[] = []
      for (const segment of segments) {
        const result = processSegment(segment)
        for (const hit of result.hits) violations.push(hit.violation)
        // EOF 段动作已全降级 flag（decideEffectiveAction），不会产生 abort/strip
        if (segment.index === 0 && !firstSegmentReleased) {
          firstSegmentReleased = true
          releaseParts.push(outputHeld)
          outputHeld = ''
        }
        if (totalMs > budgetMs) {
          haltFromBudget()
          break
        }
      }
      if (halted && !firstSegmentReleased) {
        firstSegmentReleased = true
        releaseParts.push(outputHeld)
        outputHeld = ''
      }
      const releaseText = releaseParts.join('')
      releasedChars += releaseText.length
      emitLatencyOnce()
      return { releaseText, abort: false, violations }
    } catch (err) {
      return degradeAfterError(err, releaseParts)
    }
  }

  function resetForRetry(): void {
    // F5-001 接口完整性保留；裁定 1.11 S-C12：C3 应为 attempt 1 新建 observe gate 实例
    effectiveScope = 'observe'
    analysisBuffer = ''
    outputHeld = ''
    aborted = false
    // 影子与待移交记录同属 attempt 0 现场：一并清空（recordsTaken 单次移交语义保持粘性）
    shadowBuffer = ''
    shadowFirstDeltaAt = null
    shadowDecided = false
    shadowCutPoint = 0
    shadowTrigger = null
    pendingRecords.length = 0
  }

  function takeRecords(): readonly ComplianceDecisionRecord[] {
    // 裁定 1.4 #2：单次移交、取后清空、幂等（重复调用返回空数组，防双写）
    if (recordsTaken) return []
    recordsTaken = true
    // 未 flush 就被取走（异常路径）：按 EOF 定格影子首段，保证反事实字段有确定值。
    // now() 抛错时传 NaN——deadline 门不触发，落长度/EOF 门（takeRecords 自身不抛）。
    if (!shadowDecided) {
      let nowMs = Number.NaN
      try {
        nowMs = now()
      } catch {
        /* NaN 比较恒 false，deadline 门自然跳过 */
      }
      decideShadowFirstSegment(nowMs, true)
    }
    const out = pendingRecords.map((p): ComplianceDecisionRecord => {
      const counterfactualAction = shadowTargetAction(p.rule)
      // 反事实（裁定 1.5）：影子世界 = 该规则升到影子目标动作 + first-segment 冻结参数 +
      // 本轮真实 attempt/熔断状态。评估顺序 = 枚举语义层级：非候选 → 结构（attempt/熔断）→ 时序。
      let reason: BlockIneligibleReason | undefined
      if (counterfactualAction !== 'block') reason = 'action-not-candidate'
      else if (attemptIndex === 1) reason = 'retry-attempt'
      else if (circuitOpen) reason = 'circuit-open'
      else {
        const end = p.span.start + p.span.length
        if (end <= shadowCutPoint) {
          // 影子门触发时已完整命中——照常可拦（裁定 1.5 #2：不取 flush 类值）
          reason = undefined
        } else if (p.span.start >= shadowCutPoint) reason = 'after-first-segment'
        else if (shadowTrigger === 'deadline') reason = 'deadline-flush'
        else if (shadowTrigger === 'length') reason = 'length-flush'
        else reason = 'already-released'
      }
      return {
        candidateId: options.candidateId ?? '',
        turnId: options.turnId ?? '',
        attemptIndex,
        segmentIndex: p.segmentIndex,
        ruleId: p.rule.id,
        span: p.span,
        confidence: p.rule.confidence,
        declaredAction: p.declaredAction,
        effectiveAction: p.effectiveAction,
        counterfactualAction,
        wouldBlockUnderFirstSegmentPolicy: reason === undefined,
        blockIneligibleReason: reason,
        releasedCharsBefore: p.releasedCharsBefore,
        shadowPolicyVersion: SHADOW_POLICY_VERSION
      }
    })
    pendingRecords.length = 0
    return out
  }

  function outcome(): ComplianceGateOutcome {
    return {
      blocked,
      regenerations: 0,
      degradedPass: false,
      ruleIds: [...ruleIds],
      checkedSegments,
      totalMs,
      degraded
    }
  }

  return { push, flush, resetForRetry, takeRecords, outcome }
}
