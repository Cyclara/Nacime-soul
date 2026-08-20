// src/main/growth/milestones.ts
// 里程碑引擎：加载定义、检查条件、只触发一次、emit milestone.reached。
// 依据 F5-006 §3（MilestoneDef + MILESTONES_V1 + MetricCondition）。
//
// P2-41 范围：
//   - loadMilestones：从 resources/growth/milestones.json 加载（不存在回退 MILESTONES_V1）
//   - MilestoneStore：growth_milestones 表 CRUD（只增不删，F5-006 §5 边界条件）
//   - checkMilestones：检查全部里程碑条件，返回新达成的（已达成的不重复触发）
//   - 里程碑达成 -> emit milestone.reached 事件 + 写 growth_milestones
//   - promptFragments：已达成里程碑的非空 promptFragment，按达成顺序

import { readFileSync } from 'node:fs'
import type { Database } from 'better-sqlite3'
import type { Logger } from '@shared/observability/types'
import type { MilestoneDef, GrowthSnapshot, GrowthEvent } from './types'
import { MILESTONES_V1 } from './types'

// === MilestoneStore：growth_milestones 表 CRUD ===

export interface MilestoneReached {
  id: string
  ts: number
}

export interface MilestoneStore {
  /** 记录里程碑达成（只增不删，F5-006 §5） */
  add(id: string, ts: number): void
  /** 是否已达成 */
  has(id: string): boolean
  /** 全部已达成里程碑（按 ts 升序） */
  list(): MilestoneReached[]
}

export function createMilestoneStore(opts: { db: Database }): MilestoneStore {
  const { db } = opts
  const insertStmt = db.prepare(`INSERT OR IGNORE INTO growth_milestones (id, ts) VALUES (?, ?)`)
  const hasStmt = db.prepare(`SELECT 1 FROM growth_milestones WHERE id = ?`)
  const listStmt = db.prepare(`SELECT id, ts FROM growth_milestones ORDER BY ts ASC`)

  function add(id: string, ts: number): void {
    insertStmt.run(id, ts)
  }

  function has(id: string): boolean {
    return hasStmt.get(id) !== undefined
  }

  function list(): MilestoneReached[] {
    const rows = listStmt.all() as Array<{ id: string; ts: number }>
    return rows.map((r) => ({ id: r.id, ts: r.ts }))
  }

  return { add, has, list }
}

// === 里程碑定义加载 ===

/**
 * 从 JSON 文件加载里程碑定义。文件不存在或解析失败时回退 MILESTONES_V1（F5-006 §3 数据驱动）。
 * 校验：每条必须有 id/title/condition/promptFragment/narrativeTemplate/once。
 */
export function loadMilestones(filePath: string, logger: Logger): readonly MilestoneDef[] {
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      logger.warn('milestones.json is not an array; falling back to MILESTONES_V1', {
        scope: 'growth'
      })
      return MILESTONES_V1
    }
    const valid = parsed.filter((d): d is MilestoneDef => isValidMilestone(d))
    if (valid.length === 0) {
      logger.warn('milestones.json has no valid entries; falling back to MILESTONES_V1', {
        scope: 'growth'
      })
      return MILESTONES_V1
    }
    return valid
  } catch (e) {
    logger.warn('milestones.json load failed; falling back to MILESTONES_V1', {
      scope: 'growth',
      detail: e instanceof Error ? e.message : String(e)
    })
    return MILESTONES_V1
  }
}

function isValidMilestone(d: unknown): d is MilestoneDef {
  if (!d || typeof d !== 'object') return false
  const m = d as Record<string, unknown>
  return (
    typeof m.id === 'string' &&
    typeof m.title === 'string' &&
    typeof m.promptFragment === 'string' &&
    typeof m.narrativeTemplate === 'string' &&
    m.once === true &&
    typeof m.condition === 'object' &&
    m.condition !== null
  )
}

// === 条件检查 ===

/**
 * 检查单个里程碑条件是否满足。
 * 依据 F5-006 §3 MetricCondition：metric + op '>=' + value。
 *
 * 特殊 metric：
 *   'l0.field:{field}'：检查 L0 该字段已填（值为 1 表示已填，0 未填）。
 *     F5-006 §3 ms.name 条件 { metric: 'l0.field:preferredName', op: '>=', value: 1 }。
 *     l0FilledFields 包含该 field 即满足（value=1）。
 */
export function isMilestoneReached(
  def: MilestoneDef,
  snapshot: GrowthSnapshot,
  l0FilledFields: ReadonlySet<string>
): boolean {
  const { metric, value } = def.condition
  if (metric.startsWith('l0.field:')) {
    const field = metric.slice('l0.field:'.length)
    return l0FilledFields.has(field) ? 1 >= value : false
  }
  const snapValue = snapshot[metric as keyof GrowthSnapshot]
  if (typeof snapValue !== 'number') return false
  return snapValue >= value
}

/**
 * 检查全部里程碑，返回新达成的（未在 milestoneStore 中记录的）。
 * 不写表、不 emit（调用方负责）。
 */
export function findNewlyReachedMilestones(
  defs: readonly MilestoneDef[],
  snapshot: GrowthSnapshot,
  l0FilledFields: ReadonlySet<string>,
  milestoneStore: MilestoneStore
): MilestoneDef[] {
  const newly: MilestoneDef[] = []
  for (const def of defs) {
    if (milestoneStore.has(def.id)) continue // 已达成，不重复触发（F5-006 §5 只触发一次）
    if (isMilestoneReached(def, snapshot, l0FilledFields)) {
      newly.push(def)
    }
  }
  return newly
}

// === promptFragments ===

/**
 * 从已达成里程碑 + 定义列表提取 promptFragments（非空，按达成顺序）。
 * 依据 F5-006 §3 GrowthProfile.promptFragments。
 */
export function collectPromptFragments(
  defs: readonly MilestoneDef[],
  reached: MilestoneReached[]
): string[] {
  const defMap = new Map(defs.map((d) => [d.id, d]))
  return reached
    .map((r) => defMap.get(r.id))
    .filter((d): d is MilestoneDef => !!d && d.promptFragment !== '')
    .map((d) => d.promptFragment)
}

// === 叙事模板渲染 ===

/**
 * 渲染里程碑叙事模板（{{var}} 占位替换）。
 * F5-006 §3 narrativeTemplate，如 "你们之间已经有 {{l2Total}} 段共同记忆。"
 */
export function renderNarrative(template: string, snapshot: GrowthSnapshot): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const v = snapshot[key as keyof GrowthSnapshot]
    return v !== undefined ? String(v) : ''
  })
}

// === 里程碑达成事件构造 ===

/**
 * 构造 milestone.reached GrowthEvent（供 emit）。
 */
export function makeMilestoneEvent(
  def: MilestoneDef,
  ts: number,
  idGen: () => string
): GrowthEvent {
  return {
    id: idGen(),
    ts,
    type: 'milestone.reached',
    payload: { milestoneId: def.id }
  }
}
