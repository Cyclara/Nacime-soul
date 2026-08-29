// src/main/memory/dmae/diagnostics.ts
// P2-32：DmaeDiagnosticsService -- DMAE 面板的唯一数据来源。
// 依据：F5-002 §3.7（DmaeDiagnosticsService 接口 + DmaePanelSnapshot + DmaeSelectionSummary）。
//
// 设计要点：
//   1. 与 DmaeEngineService 分离：引擎负责"算"，诊断负责"看"。
//   2. 引擎不 import 诊断（依赖方向单向）；诊断通过引擎的只读接口 + 历史表读数据。
//   3. P2-32 只做骨架：anomalies=[]（P2-33 实现规则）、lastBenchmark=null（P2-34 实现体检）。
//   4. 隐私红线：contentPreview 是唯一允许携带记忆内容的字段（≤60 字符，仅走 IPC 到本地渲染）。
//      诊断服务的所有日志只记计数，不记 memoryId 列表外的内容（F5-011 白名单）。
//
// 数据源：
//   - DmaeEngineService：getStats / states / lastSelection / turn / getActivation
//   - DmaeHistoryStore：queryTurns / queryDaily / querySamples
//   - DmaeStateStore：getHealth / path
//   - L2Store：count / list / get（取 importance、lifecycleState、content 摘要）
//   - ConfigStore：get().memory.dmae（params/maxActive）

import type { Logger } from '@shared/observability/types'
import type { MemoryConfig } from '@shared/config/types'
import type { DmaeEligibleCursor } from '@shared/memory/types'
import type { DmaeEngineService } from './service'
import type { DmaeHistoryStore } from './history-store'
import type { DmaeStateStore } from './state-file'
import type { L2Store } from '../l2-store'
import type { DmaeParamsSnapshot } from './history-types'
import { snapshotFromDmaeConfig } from './history-types'
import type { DmaeAnomaly, AnomalyContext } from './anomaly-types'
import type { DmaeSamplePoint, DmaeDailyAggregate } from './history-types'
import { deriveState } from './formulas'
import { evaluateAllRules } from './rules'
import { runBenchmark as computeBenchmark } from './benchmark'
import type { DmaeBenchmarkReport, DmaeQualitativeScores } from './benchmark-types'
// M-20：面板 DTO 已下沉 shared/memory/dmae-types（跨 IPC），本文件内部使用走此 import
import type {
  DmaePanelSnapshot,
  DmaeSelectionSummary,
  DmaeActiveSetEntry,
  DmaeStateFileHealth,
  DmaeTurnExplanation
} from '@shared/memory/dmae-types'

// === DmaePanelSnapshot / DmaeTurnExplanation（F5-002 §3.7）===
// M-20：DmaePanelSnapshot / DmaeSelectionSummary / DmaeActiveSetEntry / DmaeStateFileHealth /
// DmaeTurnExplanation 已下沉 shared/memory/dmae-types（跨 IPC 边界），此处 re-export 兼容既有导入。
export type {
  DmaePanelSnapshot,
  DmaeSelectionSummary,
  DmaeActiveSetEntry,
  DmaeStateFileHealth,
  DmaeTurnExplanation
} from '@shared/memory/dmae-types'

// === DmaeDiagnosticsService 接口 ===

/** 面板唯一数据来源。F5-002 §3.7 */
export interface DmaeDiagnosticsService {
  /** 面板首屏：概览 + 异常 + 建议，一次拉完。eligible 集合按稳定 cursor 分页。 */
  getPanelSnapshot(input?: {
    eligibleCursor?: DmaeEligibleCursor
    eligibleLimit?: number
  }): DmaePanelSnapshot
  /** 最近一轮的最终预算真值；旧历史行缺列时返回 unknown，不伪造为 0。 */
  getPromptTruth(): {
    readonly selected: number
    readonly included: number | null
    readonly trimmed: number | null
  }
  /** 趋势图数据 */
  getDailyTrend(days: 7 | 30 | 90): readonly DmaeDailyAggregate[]
  /** 单条记忆的 activation 历史（get-dmae-history 的真实实现） */
  getMemoryHistory(
    memoryId: string,
    days: 7 | 30 | 90
  ): { memoryId: string; points: DmaeSamplePoint[]; truncatedAt?: number }
  /** 单条记忆最近一轮的公式分解 */
  explainLastTurn(memoryId: string): DmaeTurnExplanation | null
  /** P2-34：运行参数基准体检（M1~M6），结果写入面板 lastBenchmark */
  runBenchmark(windowDays: 7 | 30 | 90): DmaeBenchmarkReport
  /** P2-34：记录定性评分（Q1~Q3 人工判断），结果写入面板 lastQualitative */
  recordQualitative(scores: DmaeQualitativeScores): void
}

export interface DmaeDiagnosticsServiceDeps {
  logger: Logger
  dmaeService: DmaeEngineService
  historyStore: DmaeHistoryStore
  stateStore: DmaeStateStore
  l2Store: Pick<L2Store, 'count' | 'list' | 'get'>
  getMemoryConfig: () => Readonly<MemoryConfig>
}

/** 从 l2_{createdAtMs}_{random} id 提取 createdAt（ms）。解析失败返回 0。 */
function extractCreatedAt(id: string): number {
  const parts = id.split('_')
  if (parts.length < 3) return 0
  const ts = parseInt(parts[1], 10)
  return Number.isFinite(ts) ? ts : 0
}

/** 创建 DmaeDiagnosticsService */
export function createDmaeDiagnosticsService(
  deps: DmaeDiagnosticsServiceDeps
): DmaeDiagnosticsService {
  const { logger, dmaeService, historyStore, stateStore, l2Store, getMemoryConfig } = deps

  // P2-34：基准体检 + 定性评分（进程内；面板按需拉取）
  let lastBenchmark: DmaeBenchmarkReport | null = null
  let lastQualitative: DmaeQualitativeScores | null = null

  function getPanelSnapshot(
    input: { eligibleCursor?: DmaeEligibleCursor; eligibleLimit?: number } = {}
  ): DmaePanelSnapshot {
    const cfg = getMemoryConfig()
    const params = snapshotFromDmaeConfig(cfg.dmae)
    const stats = dmaeService.getStats()
    const threshold = cfg.dmae.promptThreshold
    const maxActive = Math.max(0, cfg.maxActive)
    const l2Total = l2Store.count({})
    const currentTurn = dmaeService.turn
    const lastSelection = dmaeService.lastSelection
    const latestTurn = historyStore.queryTurns(90).at(-1)

    // P3X-03：15k 条时仅返回一个稳定 keyset page；不把全库列表塞进 IPC。
    const eligibleCursorReset =
      input.eligibleCursor !== undefined && input.eligibleCursor.turn !== currentTurn
    const activePage = buildActiveSet({
      threshold,
      currentTurn,
      selectedIds: lastSelection?.selectedIds ?? [],
      includedIds: latestTurn?.promptIncludedIds ?? [],
      cursor: eligibleCursorReset ? undefined : input.eligibleCursor,
      limit: input.eligibleLimit
    })

    // 上一轮真实占位（S-F03：区分 eligibleActive、selected 与 budget 后 injected）
    const promptTruth = {
      selected: latestTurn?.promptSelected ?? 0,
      included: latestTurn?.promptIncluded ?? null,
      trimmed: latestTurn?.promptTrimmed ?? null
    }
    const selection: DmaeSelectionSummary = {
      eligibleActiveCount: stats.active,
      lastRetrievalHits: lastSelection?.retrievalHits ?? 0,
      lastPromptSelectedCount: lastSelection?.promptSelected ?? 0,
      lastPromptIncludedCount: promptTruth.included,
      lastPromptTrimmedCount: promptTruth.trimmed,
      lastPromptSelectedIds: [...(lastSelection?.selectedIds ?? [])],
      maxActive
    }

    // 状态文件健康度（R11 数据源）
    const health = stateStore.getHealth()
    const stateFile: DmaeStateFileHealth = {
      path: stateStore.path,
      entries: dmaeService.states.size,
      lastSaveOk: health.lastSaveOk,
      lastSaveAt: health.lastSaveAt,
      lastLoadReset: health.lastLoadResetReason ?? 'none', // P2：忠实反映 invalid-json / schema-mismatch
      saveFailures7d: health.saveFailures7d
    }

    // P2-33：异常检测规则求值
    const anomalies = evaluateAnomalies(
      ctx_buildAnomalyContext(cfg, params, maxActive, currentTurn, health)
    )

    return {
      enabled: cfg.dmae.enabled,
      params,
      maxActive,
      currentTurn,
      counts: {
        eligibleActive: stats.active,
        dormant: stats.dormant,
        archived: stats.archived,
        l2Total
      },
      selection,
      activeSet: activePage.entries,
      nextEligibleCursor: activePage.nextCursor,
      activeSetPaginated: activePage.paginated,
      eligibleCursorReset,
      anomalies,
      lastBenchmark, // P2-34 基准体检结果（runBenchmark 写入）
      lastQualitative, // P2-34 定性评分（recordQualitative 写入）
      stateFile
    }
  }

  /** 构建 AnomalyContext（规则引擎纯函数的输入） */
  function ctx_buildAnomalyContext(
    cfg: Readonly<MemoryConfig>,
    params: DmaeParamsSnapshot,
    maxActive: number,
    currentTurn: number,
    health: {
      lastLoadReset: number | null
      lastLoadResetReason: 'invalid-json' | 'schema-mismatch' | null
      lastSaveOk: boolean
      lastSaveAt: number | null
      saveFailures7d: number
    }
  ): AnomalyContext {
    // entries: L2 list join DMAE states
    const l2List = l2Store.list({ lifecycleState: ['active', 'dormant', 'archived'] })
    const threshold = cfg.dmae.promptThreshold
    const entries = l2List.map((mem) => {
      const st = dmaeService.states.get(mem.id)
      const activation = st?.activation ?? 0
      return {
        id: mem.id,
        activation,
        userSilence: st?.userSilence ?? 0,
        modelSilence: st?.modelSilence ?? 0,
        state: deriveState(activation, threshold),
        importance: mem.importance,
        isPinned: mem.isPinned,
        lifecycleState: mem.lifecycleState,
        createdAt: extractCreatedAt(mem.id),
        everActivated: st?.everActivated ?? false
      }
    })

    const daily = historyStore.queryDaily(30)
    const recentTurns = historyStore.queryTurns(30)
    const recentSamples = historyStore.queryRecentSamples(50)
    // P1（2026-08-10 审计）：lastAnnotation 从历史表取最近一次调参标注（修复前恒 null -> R10 不可达）
    const annotations = historyStore.queryAnnotations(30)
    const lastAnnotation = annotations.length > 0 ? annotations[annotations.length - 1] : null

    return {
      params,
      maxActive,
      entries,
      daily,
      recentTurns,
      recentSamples,
      currentTurn,
      lastAnnotation,
      stateFileHealth: {
        lastLoadReset: health.lastLoadResetReason ?? 'none',
        saveFailures7d: health.saveFailures7d
      },
      // P1（2026-08-10 审计）：把配置的规则窗口注入规则引擎（修复前硬编码 3/7/50/100/200）
      windows: cfg.dmae.anomaly.windows,
      now: Date.now()
    }
  }

  /** 求值异常规则（含抑制 + muted 过滤） */
  function evaluateAnomalies(ctx: AnomalyContext): DmaeAnomaly[] {
    const cfg = getMemoryConfig()
    const muted = cfg.dmae.anomaly.muted as Readonly<Record<string, number>>
    return evaluateAllRules(ctx, muted)
  }

  /** P3X-03：有资格集合按 activation desc / memoryId asc 做稳定 keyset pagination。 */
  function buildActiveSet(input: {
    threshold: number
    currentTurn: number
    selectedIds: readonly string[]
    includedIds: readonly string[]
    cursor?: DmaeEligibleCursor
    limit?: number
  }): {
    entries: DmaeActiveSetEntry[]
    nextCursor: DmaeEligibleCursor | null
    paginated: boolean
  } {
    const limit = Math.max(1, Math.min(input.limit ?? 100, 200))
    const candidates: Array<{ id: string; activation: number; userSilence: number }> = []
    for (const [id, st] of dmaeService.states) {
      if (st.activation >= input.threshold)
        candidates.push({ id, activation: st.activation, userSilence: st.userSilence })
    }
    candidates.sort((a, b) => b.activation - a.activation || a.id.localeCompare(b.id))
    const afterCursor =
      input.cursor === undefined
        ? candidates
        : candidates.filter(
            (entry) =>
              entry.activation < input.cursor!.activation ||
              (entry.activation === input.cursor!.activation && entry.id > input.cursor!.memoryId)
          )
    const page = afterCursor.slice(0, limit)
    const selectedSet = new Set(input.selectedIds)
    const includedSet = new Set(input.includedIds)
    const entries = page.map((entry) => {
      const mem = l2Store.get(entry.id)
      const contentPreview = mem ? truncateContent(mem.content, 60) : ''
      const importance = mem?.importance ?? 5
      const samples = historyStore.querySamples(entry.id, 30)
      const spark = samples.slice(-7).map((sample) => sample.activation)
      return {
        memoryId: entry.id,
        contentPreview,
        activation: entry.activation,
        importance,
        userSilence: entry.userSilence,
        spark,
        trend: computeTrend(spark),
        decayExempt: importance >= 10,
        selectedLastTurn: selectedSet.has(entry.id),
        injectedLastTurn: includedSet.has(entry.id)
      }
    })
    const last = page.at(-1)
    return {
      entries,
      nextCursor:
        last !== undefined && afterCursor.length > page.length
          ? { turn: input.currentTurn, activation: last.activation, memoryId: last.id }
          : null,
      paginated: candidates.length > limit
    }
  }

  function getPromptTruth(): {
    readonly selected: number
    readonly included: number | null
    readonly trimmed: number | null
  } {
    const latest = historyStore.queryTurns(90).at(-1)
    return {
      selected: latest?.promptSelected ?? 0,
      included: latest?.promptIncluded ?? null,
      trimmed: latest?.promptTrimmed ?? null
    }
  }

  function getDailyTrend(days: 7 | 30 | 90): readonly DmaeDailyAggregate[] {
    return historyStore.queryDaily(days)
  }

  function getMemoryHistory(
    memoryId: string,
    days: 7 | 30 | 90
  ): { memoryId: string; points: DmaeSamplePoint[]; truncatedAt?: number } {
    const samples = historyStore.querySamples(memoryId, days)
    // 30 天逐点 + 更早的每日聚合（降采样），F5-002 §5 边界条件
    const truncatedAt = days > 30 ? Date.now() - 30 * 24 * 60 * 60 * 1000 : undefined
    return { memoryId, points: samples, truncatedAt }
  }

  function explainLastTurn(memoryId: string): DmaeTurnExplanation | null {
    // 从 dmae_samples 取该记忆最近一轮的采样点
    const samples = historyStore.querySamples(memoryId, 7)
    if (samples.length === 0) return null
    const latest = samples[samples.length - 1]
    const mem = l2Store.get(memoryId)
    const importance = mem?.importance ?? 5

    // P1（2026-08-10 审计）：采样点携带该轮"权威" before 值 + 参数快照（005 补列）。
    // 修复前从稀疏样本反推 before/用当前参数解释旧轮，参数改动后解释会算错。
    // 旧数据行（列仍为 null）回退到旧逻辑（近似），新数据行完全按持久化值。
    const params = latest.paramsJson
      ? (JSON.parse(latest.paramsJson) as DmaeParamsSnapshot)
      : snapshotFromDmaeConfig(getMemoryConfig().dmae)
    const threshold = params.promptThreshold

    const aOld = latest.activationBefore ?? latest.activation
    const usOld = latest.userSilenceBefore ?? latest.userSilence
    const msOld = latest.modelSilenceBefore ?? latest.modelSilence
    const beforeState = latest.stateBefore ?? deriveState(aOld, threshold)

    // 构建公式分解项
    const terms: DmaeTurnExplanation['terms'] = []

    // Ru（用户命中奖励）
    if (latest.userHit) {
      const ru = params.userRewardBase * (1 + params.wakeGamma * Math.log(1 + usOld))
      terms.push({
        name: 'Ru',
        formula: `${params.userRewardBase} × (1 + ${params.wakeGamma}·ln(1+${usOld}))`,
        value: ru,
        applied: true
      })
    } else {
      terms.push({
        name: 'Ru',
        formula: '无用户命中',
        value: 0,
        applied: false
      })
    }

    // Rm_raw（clamp 前模型奖励）
    if (latest.modelHit && !latest.modelHitGated) {
      terms.push({
        name: 'Rm_raw',
        formula: `${params.modelRewardBase} × e^(−${params.wakeLambda}·${usOld})`,
        value: latest.modelRewardRaw,
        applied: true
      })
      terms.push({
        name: 'Rm_clamped',
        formula: `min(${latest.modelRewardRaw.toFixed(2)}, ${latest.decay.toFixed(2)} − 0.01)`,
        value: latest.modelRewardEffective,
        applied: true
      })
    } else {
      terms.push({
        name: 'Rm_raw',
        formula: latest.modelHitGated ? '模型命中但被 Active gating 拦下' : '无模型命中',
        value: 0,
        applied: false
      })
      terms.push({
        name: 'Rm_clamped',
        formula: latest.modelHitGated ? '未进入 clamp' : '无模型命中',
        value: 0,
        applied: false
      })
    }

    // Decay（用权威 before us/ms + 该轮参数）
    const usNew = latest.userHit ? 0 : usOld + 1
    const msNew = latest.modelHit || latest.userHit ? 0 : msOld + 1
    terms.push({
      name: 'Decay',
      formula: `(${params.decayAlpha}·${usNew}² + ${params.decayBeta}·${msNew}²) / √${importance}`,
      value: latest.decay,
      applied: latest.decay > 0
    })

    // Floor
    const floorApplied = latest.userHit && beforeState === 'Archived'
    terms.push({
      name: 'Floor',
      formula: floorApplied ? `max(aNew, ${importance})` : '无 Floor 复活',
      value: floorApplied ? importance : 0,
      applied: floorApplied
    })

    // Clamp
    const aRaw =
      aOld +
      (terms.find((t) => t.name === 'Ru')?.value ?? 0) +
      latest.modelRewardEffective -
      latest.decay
    const clamped = Math.max(
      0,
      Math.min(params.maxScore, floorApplied ? Math.max(aRaw, importance) : aRaw)
    )
    terms.push({
      name: 'Clamp',
      formula: `clamp(${aRaw.toFixed(2)}, 0, ${params.maxScore})`,
      value: clamped,
      applied: aRaw !== clamped
    })

    return {
      memoryId,
      turn: latest.turn,
      importance,
      before: {
        activation: aOld,
        userSilence: usOld,
        modelSilence: msOld,
        state: beforeState
      },
      userHit: latest.userHit,
      modelHit: latest.modelHit,
      terms,
      after: {
        activation: latest.activation,
        state: latest.stateAfter ?? deriveState(latest.activation, threshold)
      }
    }
  }

  /** P2-34：运行基准体检（M1~M6 纯计算，无副作用；结果进程内缓存供面板读取） */
  function runBenchmark(windowDays: 7 | 30 | 90): DmaeBenchmarkReport {
    const cfg = getMemoryConfig()
    const params = snapshotFromDmaeConfig(cfg.dmae)
    const now = Date.now()
    const entries = l2Store
      .list({ lifecycleState: ['active', 'dormant', 'archived'] })
      .map((mem) => ({
        id: mem.id,
        activation: dmaeService.states.get(mem.id)?.activation ?? 0,
        importance: mem.importance,
        everActivated: dmaeService.states.get(mem.id)?.everActivated ?? false,
        createdAt: extractCreatedAt(mem.id)
      }))
    const turns = historyStore.queryTurns(windowDays)
    const samples = historyStore.queryAllSamples(windowDays)

    lastBenchmark = computeBenchmark({
      windowDays,
      params,
      now,
      entries,
      turns,
      samples,
      previous: lastBenchmark
    })
    return lastBenchmark
  }

  /** P2-34：记录定性评分（Q1~Q3 人工判断） */
  function recordQualitative(scores: DmaeQualitativeScores): void {
    lastQualitative = { ...scores }
  }

  logger.debug('dmae diagnostics service created', { scope: 'memory' })

  return {
    getPanelSnapshot,
    getPromptTruth,
    getDailyTrend,
    getMemoryHistory,
    explainLastTurn,
    runBenchmark,
    recordQualitative
  }
}

// === 辅助函数 ===

/** 截断内容到 maxLen 字符（隐私：面板唯一允许带内容的字段） */
function truncateContent(content: string, maxLen: number): string {
  if (content.length <= maxLen) return content
  return content.slice(0, maxLen) + '…'
}

/** 计算迷你趋势：最近 2 点比较（>5% rising, <-5% falling, 否则 stable） */
function computeTrend(spark: number[]): 'rising' | 'falling' | 'stable' {
  if (spark.length < 2) return 'stable'
  const prev = spark[spark.length - 2]
  const curr = spark[spark.length - 1]
  if (prev === 0) return curr > 0 ? 'rising' : 'stable'
  const change = (curr - prev) / prev
  if (change > 0.05) return 'rising'
  if (change < -0.05) return 'falling'
  return 'stable'
}
