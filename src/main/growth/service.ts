// src/main/growth/service.ts
// GrowthService 实现：订阅 EventBus，ingest() 写 growth_events 表。
// 依据：F5-006 §3/§5（数据流：memory 写路径 -> emit 事件 -> ingest 同步非事务 -> 每日快照 -> Prompt/UI 消费）。
//
// 任务分工：
//   P2-40 范围：事件总线 + ingest + GrowthStore CRUD + 事件发射点接线（本文件）
//   P2-41 范围：snapshotToday/getProfile/getTimeline/getTrend/rebuildFromEvents 真实实现
//
// 铁律（F5-006 §5）：
//   - ingest 同步非事务、失败只 warn（不影响记忆写入）
//   - payload 只存 ID/枚举，不存内容文本
//   - 不 import 任何记忆模块内部实现（依赖方向：growth <- composition root 注入）

import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { Logger } from '@shared/observability/types'
import type {
  GrowthEvent,
  GrowthEventType,
  GrowthProfile,
  GrowthService,
  GrowthSnapshot,
  GrowthTimelineEntry,
  MilestoneDef
} from './types'
import { MILESTONES_V1, deriveStage } from './types'
import type { GrowthEventBus } from './event-bus'
import {
  computeSnapshot,
  createSnapshotStore,
  type GrowthMetricsProvider,
  type SnapshotStore
} from './snapshot'
import {
  collectPromptFragments,
  createMilestoneStore,
  findNewlyReachedMilestones,
  loadMilestones,
  makeMilestoneEvent,
  renderNarrative,
  type MilestoneStore
} from './milestones'

// === GrowthStore: growth_events 表 CRUD ===

/** growth_events 表的行投影 */
export interface GrowthEventRow {
  id: string
  ts: number
  type: GrowthEventType
  payload: GrowthEvent['payload']
}

export interface GrowthStoreListFilter {
  type?: GrowthEventType
  /** 仅返回 ts >= sinceTs 的事件 */
  sinceTs?: number
  limit?: number
}

export interface GrowthStore {
  /** 插入一条事件。抛错由调用方（ingest）捕获。 */
  append(e: GrowthEvent): void
  /** 按时间升序列出事件（供 P2-41 rebuildFromEvents / 快照计算用） */
  list(filter?: GrowthStoreListFilter): GrowthEventRow[]
  /** 计数 */
  count(filter?: Omit<GrowthStoreListFilter, 'limit'>): number
  /** 查询某天（本地时区 'YYYY-MM-DD'）是否有指定类型事件（session.daily_first 幂等用） */
  hasTypeOnDate(type: GrowthEventType, date: string): boolean
  /** 查某类型事件最近一条的 ts（无则 null）。供 reference-tracker 定位"上一轮 referenced"（走 ts 索引，O(1)） */
  lastTs(type: GrowthEventType): number | null
}

interface RawRow {
  id: string
  ts: number
  type: string
  payload: string
}

export interface GrowthStoreOptions {
  db: Database
  now?: () => number
}

export function createGrowthStore(opts: GrowthStoreOptions): GrowthStore {
  const { db } = opts

  const insertStmt = db.prepare(
    `INSERT INTO growth_events (id, ts, type, payload) VALUES (?, ?, ?, ?)`
  )

  function append(e: GrowthEvent): void {
    insertStmt.run(e.id, e.ts, e.type, JSON.stringify(e.payload))
  }

  function list(filter?: GrowthStoreListFilter): GrowthEventRow[] {
    const conds: string[] = []
    const params: unknown[] = []
    if (filter?.type) {
      conds.push('type = ?')
      params.push(filter.type)
    }
    if (filter?.sinceTs !== undefined) {
      conds.push('ts >= ?')
      params.push(filter.sinceTs)
    }
    const clause = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    let sql = `SELECT * FROM growth_events ${clause} ORDER BY ts ASC`
    if (filter?.limit && filter.limit > 0) {
      sql += ` LIMIT ${Math.floor(filter.limit)}`
    }
    const rows = db.prepare(sql).all(...params) as RawRow[]
    return rows.map(rowToEvent)
  }

  function count(filter?: Omit<GrowthStoreListFilter, 'limit'>): number {
    const conds: string[] = []
    const params: unknown[] = []
    if (filter?.type) {
      conds.push('type = ?')
      params.push(filter.type)
    }
    if (filter?.sinceTs !== undefined) {
      conds.push('ts >= ?')
      params.push(filter.sinceTs)
    }
    const clause = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const row = db.prepare(`SELECT COUNT(*) c FROM growth_events ${clause}`).get(...params) as {
      c: number
    }
    return row.c
  }

  function hasTypeOnDate(type: GrowthEventType, date: string): boolean {
    // date = 'YYYY-MM-DD'（本地时区）
    // 查询当天 00:00 到次日 00:00（本地）的事件
    const [y, m, d] = date.split('-').map(Number)
    if (!y || !m || !d) return false
    const startTs = new Date(y, m - 1, d, 0, 0, 0, 0).getTime()
    const endTs = new Date(y, m - 1, d + 1, 0, 0, 0, 0).getTime()
    const row = db
      .prepare(`SELECT COUNT(*) c FROM growth_events WHERE type = ? AND ts >= ? AND ts < ?`)
      .get(type, startTs, endTs) as { c: number }
    return row.c > 0
  }

  function lastTs(type: GrowthEventType): number | null {
    const row = db
      .prepare(`SELECT ts FROM growth_events WHERE type = ? ORDER BY ts DESC LIMIT 1`)
      .get(type) as { ts: number } | undefined
    return row ? row.ts : null
  }

  function rowToEvent(r: RawRow): GrowthEventRow {
    let payload: GrowthEvent['payload'] = {}
    try {
      const v = JSON.parse(r.payload)
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        payload = v as GrowthEvent['payload']
      }
    } catch {
      /* 损坏 payload 视为空对象，不阻塞查询 */
    }
    return {
      id: r.id,
      ts: r.ts,
      type: r.type as GrowthEventType,
      payload
    }
  }

  return { append, list, count, hasTypeOnDate, lastTs }
}

// === GrowthService ===

export interface GrowthServiceDeps {
  db: Database
  eventBus: GrowthEventBus
  logger: Logger
  now?: () => number
  /** P2-41: 指标数据源（L0/L1/L2/DMAE 聚合）；由 composition root 注入。null = 降级空快照 */
  metricsProvider?: GrowthMetricsProvider | null
  /** P2-41: 里程碑定义文件路径（resources/growth/milestones.json）；缺省回退 MILESTONES_V1 */
  milestonesPath?: string
  /** P2-41: L0 已填字段集合的获取器（供 l0.field:xxx 里程碑条件检查） */
  getL0FilledFields?: () => ReadonlySet<string>
  /** revisionClock + broadcaster：里程碑达成时推进 revision + 广播 growth hint */
  revisionClock?: { next(): number } | null
  broadcaster?: { notify(hint: string): void } | null
}

/**
 * 创建 GrowthService。
 * P2-40：ingest() 订阅 EventBus 写 growth_events 表。
 * P2-41：snapshotToday/getProfile/getTimeline/getTrend/rebuildFromEvents 真实实现
 *        （快照 + U 值 + 里程碑引擎 + promptFragments 接入 relationship 层）。
 */
export function createGrowthService(deps: GrowthServiceDeps): GrowthService {
  const { eventBus, logger } = deps
  const now = deps.now ?? ((): number => Date.now())
  const store = createGrowthStore({ db: deps.db, now })
  const snapshotStore: SnapshotStore = createSnapshotStore({ db: deps.db })
  const milestoneStore: MilestoneStore = createMilestoneStore({ db: deps.db })
  const metricsProvider = deps.metricsProvider ?? null
  const getL0FilledFields = deps.getL0FilledFields ?? (() => new Set<string>())
  const milestones: readonly MilestoneDef[] = deps.milestonesPath
    ? loadMilestones(deps.milestonesPath, logger)
    : MILESTONES_V1

  let startedAtCached: number | null = null

  function ingest(e: GrowthEvent): void {
    try {
      store.append(e)
    } catch (err) {
      // F5-006 §5：失败只 warn，不影响记忆写入
      logger.warn('growth event ingest failed', {
        scope: 'growth',
        tags: {
          type: e.type,
          reason: err instanceof Error ? err.name : 'unknown'
        }
      })
    }
  }

  // 订阅 EventBus：所有 'growth:event' 事件进 ingest（同步、非事务）
  eventBus.on(ingest)

  // ── P2-41 实现 ──

  /** 当天日期（本地时区 'YYYY-MM-DD'） */
  function todayStr(): string {
    const d = new Date(now())
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate()
    ).padStart(2, '0')}`
  }

  /**
   * 计算并落盘当天快照。同日幂等（date 为主键 upsert）。
   * 调用时机：当天首轮 turn.end 后触发；也可由 getProfile 按需调用。
   */
  function snapshotToday(): GrowthSnapshot {
    const date = todayStr()
    // 若无 metricsProvider（P2-40 降级或测试），返回空快照
    if (!metricsProvider) {
      return emptySnapshot(date)
    }
    const snap = computeSnapshot(date, metricsProvider, store, now())
    try {
      snapshotStore.upsert(snap)
      // 落盘后检查里程碑（只对新达成的）
      checkMilestones(snap)
    } catch (e) {
      // 快照落盘失败不阻塞：getProfile 会用实时 computeSnapshot 兜底
      logger.warn('growth snapshot upsert failed', {
        scope: 'growth',
        detail: e instanceof Error ? e.message : String(e)
      })
    }
    return snap
  }

  /**
   * 检查里程碑条件，对新达成的写 growth_milestones + emit milestone.reached。
   * F5-006 §5：只触发一次不回退（已达成的不重复触发）。
   */
  function checkMilestones(snap: GrowthSnapshot): void {
    const filledFields = getL0FilledFields()
    const newly = findNewlyReachedMilestones(milestones, snap, filledFields, milestoneStore)
    if (newly.length === 0) return
    const ts = now()
    for (const def of newly) {
      try {
        milestoneStore.add(def.id, ts)
      } catch (e) {
        logger.warn('growth milestone add failed', {
          scope: 'growth',
          tags: { milestoneId: def.id },
          detail: e instanceof Error ? e.message : String(e)
        })
        continue
      }
      // emit milestone.reached 事件（进 ingest -> 写 growth_events）
      eventBus.emit(makeMilestoneEvent(def, ts, randomUUID))
    }
    // 里程碑达成是用户可见的 growth 变更 -> 推进 revision + 广播
    try {
      deps.revisionClock?.next()
      deps.broadcaster?.notify('growth')
    } catch (e) {
      logger.warn('growth milestone broadcast failed', {
        scope: 'growth',
        detail: e instanceof Error ? e.message : String(e)
      })
    }
  }

  /** 首次对话时间（session.daily_first 事件的最早 ts；无则 0） */
  function getStartedAt(): number {
    if (startedAtCached !== null) return startedAtCached
    const dailyEvents = store.list({ type: 'session.daily_first' })
    if (dailyEvents.length > 0) {
      startedAtCached = dailyEvents[0].ts // list 升序，第一条最早
      return startedAtCached
    }
    return 0
  }

  /**
   * 当前态（喂 Prompt relationship 层 + UI）。
   * current = 今日实时快照（未落盘版本：若 metricsProvider 可用则实时计算，否则用今日已落盘快照兜底）。
   */
  function getProfile(): GrowthProfile {
    const date = todayStr()
    // 实时计算（不落盘，避免每次 getProfile 都写表）；无 metricsProvider 则降级到今日已落盘快照/空快照
    const current: GrowthSnapshot = metricsProvider
      ? computeSnapshot(date, metricsProvider, store, now())
      : (snapshotStore.get(date) ?? emptySnapshot(date))

    const reached = milestoneStore.list()
    const promptFragments = collectPromptFragments(milestones, reached)
    const stage = deriveStage(current.understanding)

    return {
      startedAt: getStartedAt(),
      current,
      milestonesReached: reached,
      promptFragments,
      stage
    }
  }

  /**
   * 成长时间线（UI 渲染"你们的记忆时间线"，倒序）。
   * 里程碑条目（kind='milestone'）+ 每月 periodic 小结（kind='periodic'，Phase 5 任务，本阶段空）。
   * 叙事 {{var}} 占位用一次当前快照渲染（避免 N 个里程碑 N 次实时快照计算）。
   */
  function getTimeline(limit?: number): GrowthTimelineEntry[] {
    const reached = milestoneStore.list()
    if (reached.length === 0) return []
    const defMap = new Map(milestones.map((d) => [d.id, d]))
    // 取一次当前快照（renderNarrative 的 {{l2Total}} 等占位用）
    const date = todayStr()
    const current: GrowthSnapshot = metricsProvider
      ? computeSnapshot(date, metricsProvider, store, now())
      : (snapshotStore.get(date) ?? emptySnapshot(date))
    const entries: GrowthTimelineEntry[] = []
    for (const r of reached) {
      const def = defMap.get(r.id)
      if (!def) continue
      entries.push({
        ts: r.ts,
        kind: 'milestone',
        title: def.title,
        text: renderNarrative(def.narrativeTemplate, current),
        milestoneId: def.id
      })
    }
    // 倒序（最新在前）
    entries.sort((a, b) => b.ts - a.ts)
    const n = limit ?? entries.length
    return entries.slice(0, Math.max(0, n))
  }

  /** 趋势（从 growth_snapshots 表查 N 天某指标） */
  function getTrend(
    metric: keyof GrowthSnapshot,
    days: number
  ): Array<{ date: string; value: number }> {
    return snapshotStore.getTrend(metric, days)
  }

  /**
   * 灾难恢复/指标算法升级：从事件流全量重放重建快照与里程碑。
   * F5-006 §3：缺失区间的快照保留原值（尽力而为）。
   *
   * 实现：清空 growth_snapshots + growth_milestones，按事件 ts 升序重放，
   *   遇到 session.daily_first 事件时为该天重建快照 + 检查里程碑。
   *   注意：A/B/C 指标依赖 metricsProvider，重放时只能用当前 metricsProvider（无法还原历史 L0/L2 状态）。
   *   因此 rebuildFromEvents 主要重建的是 activeDays + correctionsTotal + refAccuracy7d 等事件可推导指标，
   *   以及里程碑达成的时序。其余指标取当前值（F5-006 §5 边界条件：缺失区间保留原值的语义在此放宽）。
   */
  async function rebuildFromEvents(): Promise<void> {
    // 清空快照表 + 里程碑表（事件表保留，它是真源）
    deps.db.exec(`DELETE FROM growth_snapshots`)
    deps.db.exec(`DELETE FROM growth_milestones`)
    startedAtCached = null

    if (!metricsProvider) {
      logger.warn('growth rebuildFromEvents: no metricsProvider, skipping snapshot rebuild', {
        scope: 'growth'
      })
      return
    }

    // 按天重建：找出所有 session.daily_first 事件的天，为每天建一个快照
    const dailyEvents = store.list({ type: 'session.daily_first' })
    const seenDates = new Set<string>()
    for (const e of dailyEvents) {
      const d = new Date(e.ts)
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
        d.getDate()
      ).padStart(2, '0')}`
      if (seenDates.has(date)) continue
      seenDates.add(date)
      // 用当前 metricsProvider 重建该天快照（注意：非历史精确值，F5-006 §5 取舍）
      const snap = computeSnapshot(date, metricsProvider, store, e.ts)
      try {
        snapshotStore.upsert(snap)
      } catch {
        /* best-effort */
      }
    }

    // 重建里程碑：按快照 understanding/activeDays/l2Total 时序重新检查
    // 注意：里程碑按"最早满足的天"达成。简化：用最新快照检查一次（保守：不回退已达成的）
    const latest = dailyEvents.length > 0 ? snapshotStore.get(todayStr()) : null
    if (latest) {
      // 只对当前快照检查（里程碑 once：达成即不再回退，F5-006 §5）
      checkMilestones(latest)
    }
  }

  return {
    ingest,
    snapshotToday,
    getProfile,
    getTimeline,
    getTrend,
    rebuildFromEvents
  }
}

/** 空快照（P2-40 降级 + P2-41 无 metricsProvider 时用）。 */
function emptySnapshot(date: string): GrowthSnapshot {
  return {
    date,
    l0FillRate: 0,
    l0FilledCount: 0,
    l1FreshnessScore: 0,
    l2Total: 0,
    l2ByState: { active: 0, dormant: 0, archived: 0 },
    refAccuracy7d: null,
    correctionsTotal: 0,
    manualEvalScore: null,
    dmaeAvgActivation: 0,
    dmaeOldestActiveDays: 0,
    understanding: 0,
    activeDays: 0,
    uniqueTopics: 0
  }
}
