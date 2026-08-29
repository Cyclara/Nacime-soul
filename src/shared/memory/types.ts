// src/shared/memory/types.ts
// Phase 2 memory + growth IPC DTO。main 与 renderer 共用的唯一类型真源。
// 依据：S-003-补充 §3.3/§3.4、S-002-补充 §3.1/§3.2、S-022 §1.4（MemoryUpdatedEvent）。
//
// 设计要点：
//   - 列表投影（L2MemoryView）不含 embedding / evidence 正文，只含轻量元数据。
//   - 详情（L2MemoryDetail）含 evidenceIds / sourceMessageIds（ID 引用，非正文）。
//   - 成长投影（GrowthProfileView）是白名单脱敏投影，不含 A/B/C 原始指标（F5-006 决策 2）。
//   - MemoryUpdatedEvent 只带 revision + hint + ts，不带数据（隐私 + IPC 带宽）。

import type { AnomalyRuleId } from './dmae-config'

// M-20：L2 生命周期/类型枚举下沉到 shared（此前 shared 反向 import main/l2-store，
// 违反"shared 不能反向 import main"契约）。main 侧 l2-store 从此处 re-export，兼容既有导入。
export type MemoryLifecycleState = 'active' | 'dormant' | 'archived' | 'soft_deleted' | 'purged'
export type MemoryType = 'one_off' | 'situational' | 'stable'

// === MemoryId ===

/**
 * L2 记忆 ID。格式：l2_{createdAtMs}_{randomHex}。
 * validator 用正则 ^l2_[0-9]+_[A-Za-z0-9]+$ 校验（1..64 字符）。
 */
export type MemoryId = string

// === L0 画像投影 ===

/** L0 画像字段投影（main 已脱敏：只有白名单字段 + 中文 label） */
export interface L0ProfileView {
  fields: Array<{
    key: string // L0FieldKey（preferredName | name | occupation | ...）
    label: string // 中文标签（main 侧 L0_FIELD_DESCRIPTIONS 提供）
    value: string | null // null = "未知/待发现"（M-43：显示值，行首"用户/伙伴"已转"你"）
    /** M-44：未做人称转换的原始值（编辑草稿用；显示永远用 value） */
    rawValue: string | null
    isPinned: boolean
    updatedAt: number | null
  }>
  filledCount: number
  totalCount: number
}

// === L2 记忆投影 ===

/** L2 记忆列表项（列表页用轻量投影，不含 embedding） */
export interface L2MemoryView {
  id: string
  content: string
  type: MemoryType
  lifecycleState: Exclude<MemoryLifecycleState, 'purged'>
  /** DMAE 当前激活值（引擎快照；dmae 关闭时为 0） */
  activation: number
  importance: number
  confidence: number
  isPinned: boolean
  accessCount: number
  createdAt: number
  /** M-44: 用户最后一次手动编辑时间（ms epoch）；从未编辑为 null（面板显示"已编辑"标记） */
  editedAt: number | null
}

/** 记忆详情（详情抽屉用；evidence 只有 ID，正文按需单独拉） */
export interface L2MemoryDetail extends L2MemoryView {
  /** M-44：未做人称转换的原始 content（编辑草稿用；显示永远用 content） */
  rawContent: string
  triggerText: string
  evidenceIds: string[]
  sourceMessageIds: string[]
}

// === DMAE 快照/历史 ===

/** DMAE 引擎快照（面板基础版 + 完整版共用） */
export interface DmaeSnapshotView {
  enabled: boolean
  counts: { active: number; dormant: number; archived: number }
  maxActive: number
  promptThreshold: number
  /** 当前激活集合（≤ maxActive 条，按 activation 降序） */
  activeSet: Array<{ memoryId: string; activation: number }>
}

export interface DmaeHistoryRequest {
  memoryId: MemoryId
  days: 7 | 30 | 90 // picklist，不收任意数字
}

export interface DmaeHistoryResponse {
  memoryId: string
  points: Array<{ ts: number; activation: number; state: string }>
}

// === Memory 查询/操作请求 ===

export interface MemoryListRequest {
  state?: 'active' | 'dormant' | 'archived' | 'soft_deleted'
  search?: string // trim 后 0..200 字符；main 做 LIKE 转义（% _ 字面化）
  limit: number // 1..200
  offset: number // 0..100_000
}

export interface MemoryListResponse {
  items: L2MemoryView[]
  total: number
  revision: number
}

export interface MemoryDetailRequest {
  memoryId: MemoryId
}

export interface MemoryPinRequest {
  memoryId: MemoryId
  pinned: boolean
}

/** M-44：编辑 L2 记忆内容（trim 后 1..500 字符，与提取管线 judge 上限一致） */
export interface MemoryUpdateContentRequest {
  memoryId: MemoryId
  content: string
}

/**
 * M-44：设定/清空 L0 画像字段。
 * field 必须是 L0 白名单 key（preferredName/name/occupation/...，main 侧 L0_FIELD_DESCRIPTIONS 真源）；
 * value trim 后 0..120 字符（与提取管线 L0 上限一致）；空串 = 清空该字段。
 */
export interface MemorySetL0FieldRequest {
  field: string
  value: string
}

export interface MemoryDeleteRequest {
  memoryId: MemoryId
  confirm: true // 字面量 true，同 config:reset-domain 模式
}

export interface MemoryRestoreRequest {
  memoryId: MemoryId
}

/** P3G-04：回收站稳定 offset 分页。 */
export interface RecycleBinListRequest {
  limit: number
  offset: number
}

export interface RecycleBinItem {
  id: MemoryId
  content: string
  type: MemoryType
  importance: number
  softDeletedAt: number
}

export interface RecycleBinListResponse {
  items: RecycleBinItem[]
  total: number
  revision: number
}

export interface RecycleBinRestoreRequest {
  memoryId: MemoryId
}

export interface RecycleBinEmptyRequest {
  confirm: true
}

// === MemoryOverview（首屏一次拉取）===

export interface MemoryOverview {
  revision: number
  enabled: boolean
  l0: L0ProfileView | null
  dmae: DmaeSnapshotView | null
}

// === MemoryUpdatedEvent（跨进程同步唯一通知源）===

/**
 * 任何记忆/成长数据落库后广播。节流 250ms 合并连发。
 * 依据 S-022 §1.4：revision 为持久化全局 MemoryRevisionClock（不复用 VectorStore 进程内版本）。
 */
export interface MemoryUpdatedEvent {
  revision: number
  hint: 'l0' | 'l1' | 'l2' | 'dmae' | 'growth' | 'bulk'
  ts: number
}

// === Growth 投影（F5-006 只读白名单）===

/** 与 F5-006 GrowthProfile 对齐的脱敏投影（renderer 永远拿不到 A/B/C 原始细目） */
export interface GrowthProfileView {
  understanding: number // U 值 0-100
  stage: 'stranger' | 'acquaintance' | 'familiar' | 'close'
  activeDays: number
  l2Total: number
  startedAt: number
  milestonesReached: Array<{ id: string; title: string; ts: number }>
}

export interface GrowthTimelineEntryView {
  ts: number
  kind: 'milestone' | 'periodic'
  title: string
  text: string
}

export interface GrowthTimelineRequest {
  limit: number // 1..100
}

export interface GrowthTrendRequest {
  metric: 'understanding' | 'l0FillRate' | 'l2Total' // 白名单，禁止任意 snapshot 键
  days: 7 | 30 | 90
}

export type GrowthTrendPoint = { date: string; value: number }

// === MemoryQuery（renderer store 内部查询条件，非 IPC DTO）===

export interface MemoryQuery {
  state?: L2MemoryView['lifecycleState']
  search?: string
  limit: number // 1..200
  offset: number
}

// === P2-32：DMAE 面板 IPC 请求类型（F5-002 §3.7）===

/** P3X-03：有资格集合的 stable keyset cursor，避免 15k 条全量走 IPC。 */
export interface DmaeEligibleCursor {
  turn: number
  activation: number
  memoryId: MemoryId
}

export interface DmaePanelRequest {
  eligibleCursor?: DmaeEligibleCursor
  eligibleLimit?: number
}

export interface DmaeTrendRequest {
  days: 7 | 30 | 90
}

export interface DmaeExplainRequest {
  memoryId: MemoryId
}

// === P2-34：DMAE 基准体检（F5-002 §3.6） ===

export interface DmaeBenchmarkRequest {
  windowDays: 7 | 30 | 90
}

export interface DmaeQualitativeRequest {
  /** 突兀感 0-3 */
  q1: number
  /** 失忆感 0-3 */
  q2: number
  /** 关心感 0-3 */
  q3: number
  note?: string
}

// === M-26：DMAE 异常静音（F5-002 §3.7 第 6 通道，S-005-补充 §1.7） ===

/** 静音某条异常规则 N 天：写入 anomaly.muted[ruleId] = now + days（绝对解除时间戳） */
export interface DmaeMuteRequest {
  ruleId: AnomalyRuleId
  days: number
}
