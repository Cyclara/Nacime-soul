// src/main/memory/dmae/history-store.ts
// P2-31.5F/G：DMAE 历史存储--recordTurn + 分层采样 + 日聚合。
// 依据：F5-002 §3.2/§3.7、S-Phase2 P2-31.5F/G 验收标准。
//
// 设计要点：
//   1. recordTurn：每轮写一行 dmae_turns + 分层采样写 dmae_samples
//   2. 分层采样：只采 Active + 状态迁移 + 用户关注的条目，不是 15k 全采
//   3. historySampleEveryTurns 只影响 samples，不影响 turns（turns 每轮必写）
//   4. aggregateDaily：同日幂等（upsert）、跨零点新行
//   5. 保留策略：samples 30 天、turns 90 天、daily/annotations 永久（P2-31.5G 接入 GC 调度器）
//
// 隐私纪律（F5-011）：只存数值/ID，不含记忆 content。

import type { Database } from 'better-sqlite3'
import type { Logger } from '@shared/observability/types'
import type { DmaeState } from './formulas'
import type { DmaeEntryDiagnostics, DmaeTurnDiagnostics } from './engine'
import type { DmaeSelectionSummary } from './service'
import {
  type DmaeSamplePoint,
  type DmaeTurnRecord,
  type DmaeDailyAggregate,
  type DmaeParamAnnotation,
  type DmaeParamsSnapshot,
  computeParamsHash
} from './history-types'

/** HistoryStore 接口 */
export interface DmaeHistoryStore {
  /**
   * 每轮调用：写 dmae_turns + 分层采样写 dmae_samples。
   * - turns 每轮必写（1 行/轮）
   * - samples 按 historySampleEveryTurns 采样，只采 Active + 迁移 + 关注的条目
   */
  recordTurn(input: RecordTurnInput): void

  /** 查询单条记忆的采样历史（30/90 天） */
  querySamples(memoryId: string, days: 7 | 30 | 90): DmaeSamplePoint[]

  /** 查询最近 N 天内全部采样点（P2-34 benchmark M2/M3 轨迹用，不限定 memoryId） */
  queryAllSamples(days: number): DmaeSamplePoint[]

  /** 查询最近 N 轮的全部采样点（不限定 memoryId，规则引擎 R07 用） */
  queryRecentSamples(turns: number): DmaeSamplePoint[]

  /** 查询逐轮标量（30/90 天） */
  queryTurns(days: 7 | 30 | 90): DmaeTurnRecord[]

  /** 查询每日聚合（30/90 天） */
  queryDaily(days: 7 | 30 | 90): DmaeDailyAggregate[]

  /** 同日幂等聚合：把当天的 turns 聚合成一行 dmae_daily */
  aggregateDaily(date: string): void

  /** 写调参标注 */
  addAnnotation(annotation: DmaeParamAnnotation): void

  /** 查询调参标注（近 N 天） */
  queryAnnotations(days: 7 | 30 | 90): DmaeParamAnnotation[]

  /** 清理过期数据（samples 30 天、turns 90 天；daily/annotations 永久） */
  pruneExpired(now: number): { samplesDeleted: number; turnsDeleted: number }
}

export interface RecordTurnInput {
  /** 全局 DMAE turn 计数器 */
  turn: number
  ts: number
  /** 引擎诊断（逐条 + 聚合） */
  diagnostics: DmaeTurnDiagnostics
  /** selectL2 的选择摘要 */
  selection: DmaeSelectionSummary | null
  /** 各态计数 */
  counts: { active: number; dormant: number; archived: number }
  /** L2 总数 */
  l2Total: number
  /** 当前 DMAE 参数快照 */
  params: DmaeParamsSnapshot
  /** 采样频率（1=每轮采，2=隔轮采...） */
  sampleEveryTurns: number
  /** 用户关注的 memory ID 集合（面板 [关注] 按钮） */
  watchedIds: ReadonlySet<string>
}

export interface DmaeHistoryStoreOptions {
  db: Database
  logger: Logger
}

export function createDmaeHistoryStore(opts: DmaeHistoryStoreOptions): DmaeHistoryStore {
  const { db, logger } = opts

  // 预编译 SQL（better-sqlite3 statement 是线程安全的可重用对象）
  const insertTurn = db.prepare(`
    INSERT OR REPLACE INTO dmae_turns (
      turn, ts, eligible_active, retrieval_hits, prompt_selected, max_active,
      user_hits, model_hits, model_hits_gated,
      model_reward_raw_sum, model_reward_effective_sum, total_decay,
      floor_revivals, true_floor_revivals, params_hash,
      dormant, archived, l2_total, activation_sum, activation_count,
      activation_median, archived_transitions
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `)

  const insertSample = db.prepare(`
    INSERT OR REPLACE INTO dmae_samples (
      memory_id, turn, ts, activation, user_silence, model_silence, state,
      user_hit, model_hit, model_reward_effective, model_reward_raw,
      model_hit_gated, decay, ever_activated_before, first_activation,
      state_before, state_after, before_activation, before_user_silence,
      before_model_silence, params_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `)

  const selectRecentSamples = db.prepare(`
    SELECT * FROM dmae_samples
    WHERE turn >= ?
    ORDER BY turn DESC
    LIMIT 5000
  `)

  const selectSamples = db.prepare(`
    SELECT * FROM dmae_samples
    WHERE memory_id = ? AND ts >= ?
    ORDER BY turn ASC
  `)

  const selectAllSamples = db.prepare(`
    SELECT * FROM dmae_samples
    WHERE ts >= ?
    ORDER BY turn ASC
  `)

  const selectTurns = db.prepare(`
    SELECT * FROM dmae_turns
    WHERE ts >= ?
    ORDER BY turn ASC
  `)

  const selectDaily = db.prepare(`
    SELECT * FROM dmae_daily
    WHERE date >= ?
    ORDER BY date ASC
  `)

  const upsertDaily = db.prepare(`
    INSERT OR REPLACE INTO dmae_daily (date, json) VALUES (?, ?)
  `)

  const selectDailyByDate = db.prepare(`
    SELECT json FROM dmae_daily WHERE date = ?
  `)

  const selectTurnsByDate = db.prepare(`
    SELECT * FROM dmae_turns
    WHERE ts >= ? AND ts < ?
    ORDER BY turn ASC
  `)

  const insertAnnotation = db.prepare(`
    INSERT OR REPLACE INTO dmae_annotations (id, ts, turn, json) VALUES (?, ?, ?, ?)
  `)

  const selectAnnotations = db.prepare(`
    SELECT json FROM dmae_annotations
    WHERE ts >= ?
    ORDER BY ts ASC
  `)

  const deleteOldSamples = db.prepare(`
    DELETE FROM dmae_samples WHERE ts < ?
  `)

  const deleteOldTurns = db.prepare(`
    DELETE FROM dmae_turns WHERE ts < ?
  `)

  function recordTurn(input: RecordTurnInput): void {
    const { turn, ts, diagnostics, selection, counts, params, sampleEveryTurns, watchedIds } = input
    const l2Total = input.l2Total

    const paramsHash = computeParamsHash(params)

    // P1（2026-08-10 审计）：真实各态计数 + activation 分布 + 迁入 Archived 数（daily 聚合真源）
    const activationStats = diagnostics.activationStats

    // 1. 写 dmae_turns（每轮必写）
    const turnRecord: DmaeTurnRecord = {
      turn,
      ts,
      eligibleActive: counts.active,
      retrievalHits: selection?.retrievalHits ?? 0,
      promptSelected: selection?.promptSelected ?? 0,
      maxActive: selection?.maxActive ?? 0,
      userHits: diagnostics.entries.filter((e) => e.userHit).length,
      modelHits: diagnostics.entries.filter((e) => e.modelHit).length,
      modelHitsGated: diagnostics.modelHitsGated,
      modelRewardRawSum: diagnostics.modelRewardRawSum,
      modelRewardEffectiveSum: diagnostics.modelRewardEffectiveSum,
      totalDecay: diagnostics.entries.reduce((sum, e) => sum + e.decay, 0),
      floorRevivals: diagnostics.entries.filter(
        (e) => e.everActivatedBefore && !e.firstActivation && e.activationAfter > 0
      ).length,
      trueFloorRevivals: diagnostics.trueFloorRevivals,
      paramsHash,
      dormant: counts.dormant,
      archived: counts.archived,
      l2Total,
      activationSum: activationStats.sum,
      activationCount: activationStats.count,
      activationMedian: activationStats.median,
      archivedTransitions: diagnostics.archivedTransitions
    }
    insertTurn.run(
      turnRecord.turn,
      turnRecord.ts,
      turnRecord.eligibleActive,
      turnRecord.retrievalHits,
      turnRecord.promptSelected,
      turnRecord.maxActive,
      turnRecord.userHits,
      turnRecord.modelHits,
      turnRecord.modelHitsGated,
      turnRecord.modelRewardRawSum,
      turnRecord.modelRewardEffectiveSum,
      turnRecord.totalDecay,
      turnRecord.floorRevivals,
      turnRecord.trueFloorRevivals,
      turnRecord.paramsHash,
      turnRecord.dormant,
      turnRecord.archived,
      turnRecord.l2Total,
      turnRecord.activationSum,
      turnRecord.activationCount,
      turnRecord.activationMedian,
      turnRecord.archivedTransitions
    )

    // 2. 分层采样写 dmae_samples（按 sampleEveryTurns 频率）
    // turn % N === 0 时采样（turn 从 0 开始，N=1 时每轮都采）
    if (turn % sampleEveryTurns !== 0) return

    for (const entry of diagnostics.entries) {
      if (shouldSample(entry, watchedIds, params.promptThreshold)) {
        insertSample.run(
          entry.memoryId,
          turn,
          ts,
          entry.activationAfter,
          entry.userSilenceAfter,
          entry.modelSilenceAfter,
          deriveStateFromActivation(entry.activationAfter, params.promptThreshold),
          entry.userHit ? 1 : 0,
          entry.modelHit ? 1 : 0,
          entry.modelRewardEffective,
          entry.modelRewardRaw,
          entry.modelHitGated ? 1 : 0,
          entry.decay,
          entry.everActivatedBefore ? 1 : 0,
          entry.firstActivation ? 1 : 0,
          entry.stateBefore,
          entry.stateAfter,
          entry.activationBefore,
          entry.userSilenceBefore,
          entry.modelSilenceBefore,
          JSON.stringify(params)
        )
      }
    }
  }

  /**
   * 分层采样判定：只采"值得看"的条目（F5-002 §3.2 策略）。
   * - 用户显式关注的（watchedIds）-> 全采
   * - 本轮发生任何状态迁移（stateBefore !== stateAfter，含 Active→Dormant/Archived 衰减迁移）-> 全采
   * - 首次激活 -> 全采
   * - 更新后 Active（activationAfter >= threshold，阈值来自参数而非写死 30）-> 全采
   * 其余不采（Dormant/Archived 的平滑衰减可由公式重建）。
   */
  function shouldSample(
    entry: DmaeEntryDiagnostics,
    watchedIds: ReadonlySet<string>,
    threshold: number
  ): boolean {
    // 用户关注的 -> 全采
    if (watchedIds.has(entry.memoryId)) return true
    // 本轮状态迁移 -> 全采（修复前只认 firstActivation，Active→Dormant 等关键迁移点漏采）
    if (entry.stateBefore !== entry.stateAfter) return true
    // 首次激活 -> 全采
    if (entry.firstActivation) return true
    // 更新后 Active（activationAfter >= threshold）-> 全采
    if (entry.activationAfter >= threshold) return true
    // 其余不采（Dormant/Archived 的平滑衰减可由公式重建）
    return false
  }

  function querySamples(memoryId: string, days: 7 | 30 | 90): DmaeSamplePoint[] {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    const rows = selectSamples.all(memoryId, cutoff) as Array<Record<string, unknown>>
    return rows.map(rowToSamplePoint)
  }

  function queryAllSamples(days: number): DmaeSamplePoint[] {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    const rows = selectAllSamples.all(cutoff) as Array<Record<string, unknown>>
    return rows.map(rowToSamplePoint)
  }

  function queryRecentSamples(turns: number): DmaeSamplePoint[] {
    // 从 dmae_turns 取当前最大 turn，然后查 turn >= maxTurn - turns 的采样点
    const maxTurnRow = db.prepare('SELECT MAX(turn) as maxTurn FROM dmae_turns').get() as
      { maxTurn: number | null } | undefined
    const maxTurn = maxTurnRow?.maxTurn ?? 0
    const minTurn = Math.max(0, maxTurn - turns)
    // 005 修复（2026-08-10 审计）：DESC + LIMIT 取窗口内"最新"5000 行（旧实现 ASC 取最旧，
    // 高采样量下 R07 漏掉最新跨阈值事件），再反转回升序返回
    const rows = selectRecentSamples.all(minTurn) as Array<Record<string, unknown>>
    return rows.map(rowToSamplePoint).reverse()
  }

  function queryTurns(days: 7 | 30 | 90): DmaeTurnRecord[] {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    const rows = selectTurns.all(cutoff) as Array<Record<string, unknown>>
    return rows.map(rowToTurnRecord)
  }

  function queryDaily(days: 7 | 30 | 90): DmaeDailyAggregate[] {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    const cutoffStr = formatDate(cutoff)
    const rows = selectDaily.all(cutoffStr) as Array<{ date: string; json: string }>
    return rows.map((r) => JSON.parse(r.json) as DmaeDailyAggregate)
  }

  function aggregateDaily(date: string): void {
    // 同日幂等：先查是否已有
    const existing = selectDailyByDate.get(date) as { json: string } | undefined

    // 查当天的 turns（UTC 边界用本地时区 00:00 ~ 次日 00:00）
    const dayStart = parseDateStart(date)
    const dayEnd = dayStart + 24 * 60 * 60 * 1000
    const turns = selectTurnsByDate.all(dayStart, dayEnd) as Array<Record<string, unknown>>
    if (turns.length === 0 && !existing) return // 无数据且无既有 -> 不写

    const mapped = turns.map(rowToTurnRecord)
    const aggregate = computeDailyAggregate(
      date,
      mapped,
      existing ? (JSON.parse(existing.json) as DmaeDailyAggregate) : null
    )
    upsertDaily.run(date, JSON.stringify(aggregate))
  }

  function addAnnotation(annotation: DmaeParamAnnotation): void {
    insertAnnotation.run(annotation.id, annotation.ts, annotation.turn, JSON.stringify(annotation))
  }

  function queryAnnotations(days: 7 | 30 | 90): DmaeParamAnnotation[] {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    const rows = selectAnnotations.all(cutoff) as Array<{ json: string }>
    return rows.map((r) => JSON.parse(r.json) as DmaeParamAnnotation)
  }

  function pruneExpired(now: number): { samplesDeleted: number; turnsDeleted: number } {
    const samplesCutoff = now - 30 * 24 * 60 * 60 * 1000
    const turnsCutoff = now - 90 * 24 * 60 * 60 * 1000
    const samplesDeleted = deleteOldSamples.run(samplesCutoff).changes
    const turnsDeleted = deleteOldTurns.run(turnsCutoff).changes
    if (samplesDeleted > 0 || turnsDeleted > 0) {
      logger.info('dmae history pruned', {
        scope: 'memory',
        metrics: { samplesDeleted, turnsDeleted }
      })
    }
    return { samplesDeleted, turnsDeleted }
  }

  return {
    recordTurn,
    querySamples,
    queryAllSamples,
    queryRecentSamples,
    queryTurns,
    queryDaily,
    aggregateDaily,
    addAnnotation,
    queryAnnotations,
    pruneExpired
  }
}

// === 辅助函数 ===

function deriveStateFromActivation(activation: number, threshold: number): DmaeState {
  if (activation <= 0) return 'Archived'
  if (activation >= threshold) return 'Active'
  return 'Dormant'
}

function formatDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function parseDateStart(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime()
}

function rowToSamplePoint(row: Record<string, unknown>): DmaeSamplePoint {
  return {
    memoryId: row.memory_id as string,
    turn: row.turn as number,
    ts: row.ts as number,
    activation: row.activation as number,
    userSilence: row.user_silence as number,
    modelSilence: row.model_silence as number,
    state: row.state as DmaeState,
    userHit: row.user_hit === 1,
    modelHit: row.model_hit === 1,
    modelRewardEffective: row.model_reward_effective as number,
    modelRewardRaw: row.model_reward_raw as number,
    modelHitGated: row.model_hit_gated === 1,
    decay: row.decay as number,
    everActivatedBefore: row.ever_activated_before === 1,
    firstActivation: row.first_activation === 1,
    // 005 补列（旧行可能为 null）
    stateBefore: (row.state_before as DmaeState | null) ?? null,
    stateAfter: (row.state_after as DmaeState | null) ?? null,
    activationBefore: (row.before_activation as number | null) ?? null,
    userSilenceBefore: (row.before_user_silence as number | null) ?? null,
    modelSilenceBefore: (row.before_model_silence as number | null) ?? null,
    paramsJson: (row.params_json as string | null) ?? null
  }
}

function rowToTurnRecord(row: Record<string, unknown>): DmaeTurnRecord {
  return {
    turn: row.turn as number,
    ts: row.ts as number,
    eligibleActive: row.eligible_active as number,
    retrievalHits: row.retrieval_hits as number,
    promptSelected: row.prompt_selected as number,
    maxActive: row.max_active as number,
    userHits: row.user_hits as number,
    modelHits: row.model_hits as number,
    modelHitsGated: row.model_hits_gated as number,
    modelRewardRawSum: row.model_reward_raw_sum as number,
    modelRewardEffectiveSum: row.model_reward_effective_sum as number,
    totalDecay: row.total_decay as number,
    floorRevivals: row.floor_revivals as number,
    trueFloorRevivals: row.true_floor_revivals as number,
    paramsHash: row.params_hash as string,
    dormant: row.dormant as number,
    archived: row.archived as number,
    l2Total: row.l2_total as number,
    activationSum: row.activation_sum as number,
    activationCount: row.activation_count as number,
    activationMedian: row.activation_median as number,
    archivedTransitions: row.archived_transitions as number
  }
}

function computeDailyAggregate(
  date: string,
  turns: DmaeTurnRecord[],
  existing: DmaeDailyAggregate | null
): DmaeDailyAggregate {
  if (turns.length === 0 && existing) return existing // 无新数据，保留既有

  const promptSelectedArr = turns.map((t) => t.promptSelected)
  const retrievalHitsArr = turns.map((t) => t.retrievalHits)
  const lastTurn = turns[turns.length - 1]
  const rawSum = turns.reduce((s, t) => s + t.modelRewardRawSum, 0)
  const effSum = turns.reduce((s, t) => s + t.modelRewardEffectiveSum, 0)

  // P1（2026-08-10 审计）：真实聚合，不再用 eligibleActive 冒充激活、不硬编码 0。
  //   avgActivation = 加权平均（Σ sum / Σ count）；medianActivation = 各轮中位数的中位数（近似）
  const totalActivationSum = turns.reduce((s, t) => s + t.activationSum, 0)
  const totalActivationCount = turns.reduce((s, t) => s + t.activationCount, 0)
  const activationMedians = turns
    .filter((t) => t.activationCount > 0)
    .map((t) => t.activationMedian)
  const archivedTransitions = turns.reduce((s, t) => s + t.archivedTransitions, 0)

  return {
    date,
    turns: turns.length,
    eligibleActive: lastTurn.eligibleActive,
    dormant: lastTurn.dormant,
    archived: lastTurn.archived,
    l2Total: lastTurn.l2Total,
    avgPromptSelected: avg(promptSelectedArr),
    medianPromptSelected: median(promptSelectedArr),
    saturatedTurns: turns.filter((t) => t.promptSelected === t.maxActive && t.maxActive > 0).length,
    medianRetrievalHits: median(retrievalHitsArr),
    avgActivation: totalActivationCount > 0 ? totalActivationSum / totalActivationCount : 0,
    medianActivation: activationMedians.length > 0 ? median(activationMedians) : 0,
    archivedTransitions,
    floorRevivals: turns.reduce((s, t) => s + t.floorRevivals, 0),
    trueFloorRevivals: turns.reduce((s, t) => s + t.trueFloorRevivals, 0),
    modelRewardYield: rawSum > 0 ? effSum / rawSum : null,
    paramsHash: lastTurn.paramsHash
  }
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0
  return arr.reduce((s, v) => s + v, 0) / arr.length
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}
