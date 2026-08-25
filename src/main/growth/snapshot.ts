// src/main/growth/snapshot.ts
// 每日快照 + U 值计算。依据 F5-006 §3（GrowthSnapshot + computeUnderstanding）。
//
// P2-41 范围：
//   - GrowthMetricsProvider 接口（由 setup.ts 注入，growth 不 import memory 内部实现）
//   - computeSnapshot：从 metrics provider + event store 计算 GrowthSnapshot
//   - SnapshotStore：growth_snapshots 表 CRUD（date 为主键，同日幂等 upsert）
//
// 依赖方向（F5-006 §5）：growth 不 import memory 模块。
//   GrowthMetricsProvider 是结构接口，由 composition root（setup.ts）实现并注入。

import type { Database } from 'better-sqlite3'
import type { GrowthSnapshot } from './types'
import { computeUnderstanding } from './types'
import type { GrowthStore } from './service'

// === GrowthMetricsProvider：由 composition root 注入的数据源 ===

/**
 * 成长指标数据源。由 setup.ts 实现，从 L0/L1/L2/DMAE 读取数据。
 * growth 模块不 import memory 模块，只依赖此接口。
 */
export interface GrowthMetricsProvider {
  /** L0 加权填充率 + 已填字段数（F5-006 §3 L0_FIELD_WEIGHTS） */
  getL0Fill(): { rate: number; filledCount: number }
  /** L1 新鲜度（lastUpdated ≤7 天的占比）[0,1] */
  getL1Freshness(): number
  /** L2 总数 + 各态计数 + uniqueTopics（F5-006 说 tags 去重；L2 无 tags 字段，暂用 l2Total 近似） */
  getL2Stats(): {
    total: number
    byState: { active: number; dormant: number; archived: number }
    uniqueTopics: number
  }
  /** DMAE 聚合（dmae.enabled=false 时 null） */
  getDmaeAggregate(): { avgActivation: number; oldestActiveDays: number } | null
}

// === SnapshotStore：growth_snapshots 表 CRUD ===

export interface SnapshotStore {
  /** upsert 当天快照（date 为主键，同日幂等覆盖） */
  upsert(s: GrowthSnapshot): void
  /** 取某天快照 */
  get(date: string): GrowthSnapshot | null
  /** 取最近 N 天快照（升序，最旧在前） */
  listRecent(days: number): GrowthSnapshot[]
  /** 取某指标 N 天趋势（升序） */
  getTrend(metric: keyof GrowthSnapshot, days: number): Array<{ date: string; value: number }>
}

export function createSnapshotStore(opts: { db: Database }): SnapshotStore {
  const { db } = opts
  const upsertStmt = db.prepare(
    `INSERT INTO growth_snapshots (date, json) VALUES (?, ?)
     ON CONFLICT(date) DO UPDATE SET json = excluded.json`
  )
  const getStmt = db.prepare(`SELECT json FROM growth_snapshots WHERE date = ?`)

  function upsert(s: GrowthSnapshot): void {
    upsertStmt.run(s.date, JSON.stringify(s))
  }

  function get(date: string): GrowthSnapshot | null {
    const row = getStmt.get(date) as { json: string } | undefined
    if (!row) return null
    try {
      return JSON.parse(row.json) as GrowthSnapshot
    } catch {
      return null
    }
  }

  function listRecent(days: number): GrowthSnapshot[] {
    const limit = Math.max(0, Math.floor(days))
    const rows = db
      .prepare(`SELECT json FROM growth_snapshots ORDER BY date DESC LIMIT ?`)
      .all(limit) as Array<{ json: string }>
    return rows
      .map((r) => {
        try {
          return JSON.parse(r.json) as GrowthSnapshot
        } catch {
          return null
        }
      })
      .filter((s): s is GrowthSnapshot => s !== null)
      .reverse() // 升序（最旧在前）
  }

  function getTrend(
    metric: keyof GrowthSnapshot,
    days: number
  ): Array<{ date: string; value: number }> {
    const snapshots = listRecent(days)
    return snapshots.map((s) => ({ date: s.date, value: s[metric] as number }))
  }

  return { upsert, get, listRecent, getTrend }
}

// === 快照计算 ===

/**
 * 从 metrics provider + event store 计算当天 GrowthSnapshot。
 * 依据 F5-006 §3：A/B/C 三层指标 + U 值。
 *
 * 纯函数，不落盘。供 snapshotToday（落盘）和 getProfile.current（实时）共用。
 */
export function computeSnapshot(
  date: string,
  metrics: GrowthMetricsProvider,
  eventStore: GrowthStore,
  now: number
): GrowthSnapshot {
  const l0 = metrics.getL0Fill()
  const l1Freshness = metrics.getL1Freshness()
  const l2 = metrics.getL2Stats()
  const dmae = metrics.getDmaeAggregate()

  // B 层：refAccuracy7d + correctionsTotal
  // F5-006 §3：refAccuracy7d = 1 − corrected₇d / referenced₇d；样本 <5 时 null
  const sevenDaysAgo = now - 7 * 24 * 3600 * 1000
  const referenced7d = eventStore.count({ type: 'l2.referenced', sinceTs: sevenDaysAgo })
  const corrected7d = eventStore.count({ type: 'l2.corrected', sinceTs: sevenDaysAgo })
  const correctionsTotal = eventStore.count({ type: 'l2.corrected' })
  const refAccuracy7d = referenced7d >= 5 ? 1 - corrected7d / referenced7d : null

  // 汇总：activeDays（session.daily_first 事件数 = 累计对话天数，每天幂等最多 1 条）
  const activeDays = eventStore.count({ type: 'session.daily_first' })

  const understanding = computeUnderstanding({
    l0FillRate: l0.rate,
    uniqueTopics: l2.uniqueTopics,
    activeDays
  })

  return {
    date,
    l0FillRate: l0.rate,
    l0FilledCount: l0.filledCount,
    l1FreshnessScore: l1Freshness,
    l2Total: l2.total,
    l2ByState: l2.byState,
    refAccuracy7d,
    correctionsTotal,
    manualEvalScore: null, // P2-41 不实现手动评测会话（F5-006 §3 B 层双轨，手动评测延后）
    dmaeAvgActivation: dmae?.avgActivation ?? 0,
    dmaeOldestActiveDays: dmae?.oldestActiveDays ?? 0,
    understanding,
    activeDays,
    uniqueTopics: l2.uniqueTopics
  }
}
