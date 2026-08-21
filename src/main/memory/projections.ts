// src/main/memory/projections.ts
// P2-29: 记忆/成长 IPC 投影函数。L2Memory -> L2MemoryView 等脱敏投影集中在此。
// 依据：S-003-补充 §3.7（投影函数集中在 projections.ts，保证"哪些字段出 IPC"只有一处定义）。
//
// 安全红线（F5-011 + S-003-补充 §4）：
//   - 列表投影不含 embedding / BudgetReport 等内部结构。
//   - 详情不含 evidence 正文，只含 evidenceIds / sourceMessageIds（ID 引用）。
//   - DMAE 快照只含计数 + 激活集合（memoryId + activation 数值），不含 content。

import type { L0Store, L0FieldKey } from './l0-store'
import type { L2Memory } from './l2-store'
import type { DmaeEngineService } from './dmae/service'
import type { MemoryConfig } from '@shared/config/types'
import type {
  DmaeSnapshotView,
  GrowthProfileView,
  GrowthTimelineEntryView,
  L0ProfileView,
  L2MemoryDetail,
  L2MemoryView
} from '@shared/memory/types'
import type { GrowthProfile, GrowthTimelineEntry } from '../growth/types'

/** L0_FIELD_DESCRIPTIONS 的固定 key 顺序（S-011 §1.3：不按对象插入顺序） */
const L0_FIELD_ORDER: readonly L0FieldKey[] = [
  'preferredName',
  'name',
  'occupation',
  'likes',
  'dislikes',
  'age',
  'gender',
  'relationship_status',
  'permanentNote'
]

import { L0_FIELD_DESCRIPTIONS } from './l0-store'

/** L0Profile -> L0ProfileView（白名单顺序 + filledCount/totalCount） */
export function projectL0(l0Store: L0Store): L0ProfileView {
  const profile = l0Store.get()
  const fields = L0_FIELD_ORDER.map((key) => {
    const f = profile.fields[key]
    return {
      key,
      label: L0_FIELD_DESCRIPTIONS[key],
      // M-43：非称呼类字段与 L2 统一做人称转换（"伙伴喜欢…" -> "你喜欢…"）
      value: f ? (L0_HUMANIZE_EXEMPT.has(key) ? f.value : humanizeMemoryContent(f.value)) : null,
      isPinned: f ? f.isPinned : false,
      updatedAt: f ? f.updatedAt : null
    }
  })
  const filledCount = L0_FIELD_ORDER.filter((k) => profile.fields[k]).length
  return {
    fields,
    filledCount,
    totalCount: L0_FIELD_ORDER.length
  }
}

/**
 * 面向伙伴的 UI 文案：行首的"用户…/伙伴…"统一转换成自然的"你…"。
 * M-43（2026-08-21）：去掉后续字白名单——白名单漏字导致"你/伙伴"混排
 * （"伙伴最大的兴趣"的"最"不在名单就原样显示）。改为只排除非指代场景：
 * 伙伴们（复数）、伙伴关系、伙伴这个、伙伴本身。
 */
export function humanizeMemoryContent(content: string): string {
  return content.replace(/^(?:用户|伙伴)(?!们|关系|这个|本身)/, '你')
}

/**
 * L0 中不做人称转换的字段：称呼类字段的值本身可能就是"伙伴"
 * （用户自选希望被叫"伙伴"时，翻成"你"就破坏了语义）。
 * 其余字段（喜好/厌恶/职业等）的值可能是"伙伴喜欢…"整句，与 L2 列表统一转"你"（M-43）。
 */
const L0_HUMANIZE_EXEMPT: ReadonlySet<L0FieldKey> = new Set(['preferredName', 'name'])

/** L2Memory -> L2MemoryView（列表轻量投影，不含 embedding） */
export function projectL2View(mem: L2Memory, activation: number): L2MemoryView {
  return {
    id: mem.id,
    content: humanizeMemoryContent(mem.content),
    type: mem.type,
    // purged 不暴露给 renderer（S-003-补充 不在 list 状态白名单）
    lifecycleState: mem.lifecycleState === 'purged' ? 'archived' : mem.lifecycleState,
    activation,
    importance: mem.importance,
    confidence: mem.confidence,
    isPinned: mem.isPinned,
    accessCount: mem.accessCount,
    // id 格式 l2_{createdAtMs}_{random}：提取时间戳部分
    createdAt: extractCreatedAt(mem.id)
  }
}

/** L2Memory -> L2MemoryDetail（详情，含 evidence ID 引用） */
export function projectL2Detail(mem: L2Memory, activation: number): L2MemoryDetail {
  return {
    ...projectL2View(mem, activation),
    triggerText: mem.triggerText ?? '',
    evidenceIds: mem.evidenceIds,
    sourceMessageIds: mem.sourceMessageIds
  }
}

/** 从 l2_{createdAtMs}_{random} id 提取 createdAt（ms）。解析失败返回 0。 */
function extractCreatedAt(id: string): number {
  const parts = id.split('_')
  if (parts.length < 3) return 0
  const ts = parseInt(parts[1], 10)
  return Number.isFinite(ts) ? ts : 0
}

/**
 * DmaeEngineService -> DmaeSnapshotView。
 * dmaeService=null（dmae 关闭）时返回 enabled=false 的空快照。
 */
export function projectDmaeSnapshot(
  dmaeService: DmaeEngineService | null,
  memoryConfig: Readonly<MemoryConfig>
): DmaeSnapshotView {
  if (!dmaeService || !memoryConfig.dmae.enabled) {
    return {
      enabled: false,
      counts: { active: 0, dormant: 0, archived: 0 },
      maxActive: memoryConfig.maxActive,
      promptThreshold: memoryConfig.dmae.promptThreshold,
      activeSet: []
    }
  }
  const stats = dmaeService.getStats()
  // 激活集合：从 states 取 activation≥threshold 的 top maxActive
  const threshold = memoryConfig.dmae.promptThreshold
  const maxActive = Math.max(0, memoryConfig.maxActive)
  const entries: Array<{ memoryId: string; activation: number }> = []
  for (const [id, st] of dmaeService.states) {
    if (st.activation >= threshold) {
      entries.push({ memoryId: id, activation: st.activation })
    }
  }
  entries.sort(
    (a, b) =>
      b.activation - a.activation ||
      (a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0)
  )
  return {
    enabled: true,
    counts: { active: stats.active, dormant: stats.dormant, archived: stats.archived },
    maxActive,
    promptThreshold: threshold,
    activeSet: entries.slice(0, maxActive)
  }
}

// === Growth 投影（S-003-补充 §3.7：投影集中在此，保证"哪些字段出 IPC"只有一处定义）===

/**
 * GrowthProfile -> GrowthProfileView（F5-006 决策 2 白名单投影）。
 * 只暴露 U 值/阶段/相处天数/记忆数/起始时间/里程碑（id+title），A/B/C 原始指标不外泄。
 *
 * @param milestoneTitles 里程碑 id -> title 映射（F5-006 MILESTONES_V1 或自定义 json 的 title 表）。
 *   查不到时回退 milestoneId（避免 title 缺口导致 UI 空白）。
 */
export function projectGrowthProfile(
  p: GrowthProfile,
  milestoneTitles: ReadonlyMap<string, string>
): GrowthProfileView {
  return {
    understanding: p.current.understanding,
    stage: p.stage,
    activeDays: p.current.activeDays,
    l2Total: p.current.l2Total,
    startedAt: p.startedAt,
    milestonesReached: p.milestonesReached.map((m) => ({
      id: m.id,
      title: milestoneTitles.get(m.id) ?? m.id,
      ts: m.ts
    }))
  }
}

/** GrowthTimelineEntry -> GrowthTimelineEntryView（kind/title/text 脱敏投影） */
export function projectGrowthTimeline(
  entries: readonly GrowthTimelineEntry[]
): GrowthTimelineEntryView[] {
  return entries.map((e) => ({
    ts: e.ts,
    kind: e.kind,
    title: e.title,
    text: e.text
  }))
}
