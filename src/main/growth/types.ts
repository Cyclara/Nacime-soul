// src/main/growth/types.ts
// F5-006 "成长"完整数据模型 - 合同类型定义。
// 依据：F5-006 §3（接口/类型定义）。本项目严格照抄 F5-006 冻结合同。
//
// 铁律（F5-006 §5）：
//   - 成长模块是只读投影的订阅者，不 import 任何记忆模块内部实现
//   - payload 只存 ID 和枚举，不存内容文本（隐私纪律同 F5-011）
//   - 指标全部是确定性算术，不用 LLM 计算数值
//   - 用户 UI 只看 U 值/阶段徽章/时间线；A/B/C 原始指标进 F5-011 调试面板

// === 领域事件 ===

/**
 * 领域事件类型。记忆/对话模块通过 EventEmitter 'growth:event' 发出。
 * 共 10 种（F5-006 §3）。
 */
export type GrowthEventType =
  | 'l0.filled' // L0 字段从"未知"->具体值
  | 'l0.updated' // L0 字段值变更
  | 'l1.refreshed' // L1 近期状态更新
  | 'l2.added' // 新 L2 记忆写入（MemoryJudge 终审通过）
  | 'l2.referenced' // 一条 L2 记忆进入了 prompt 且回复完成
  | 'l2.confirmed' // 引用后用户下一轮无纠正（隐式确认）
  | 'l2.corrected' // 引用后用户下一轮触发 correctionIntent
  | 'conflict.resolved' // 冲突解决完成
  | 'session.daily_first' // 当天首次对话（activeDays 计数源）
  | 'milestone.reached' // 由成长模块自身发出（供 UI/叙事订阅）

export interface GrowthEvent {
  id: string // 唯一 ID（项目用 randomUUID；F5-006 称 ULID，功能等价）
  ts: number // epoch ms
  type: GrowthEventType
  /** 载荷只存 ID 和枚举，不存内容文本（隐私纪律与 F5-011 一致） */
  payload: {
    field?: string // l0.* 事件：字段名
    memoryId?: string // l2.* 事件
    conflictId?: string
    milestoneId?: string
  }
}

// === A/B/C 三层指标的落地字段 ===

/**
 * L0 字段权重表：填充率按权重加权（名字比"备注"更能代表"了解"）。
 * 键与 l0-store.ts L0_FIELD_DESCRIPTIONS 对齐。【必须实现】
 */
export const L0_FIELD_WEIGHTS: Record<string, number> = {
  preferredName: 2,
  name: 2,
  occupation: 1.5,
  likes: 1.5,
  dislikes: 1.5,
  age: 1,
  gender: 1,
  relationship_status: 1,
  permanentNote: 0.5
}

/** 每日快照。growth_snapshots 表，date 为主键，5 年 ≈ 1,800 行 */
export interface GrowthSnapshot {
  date: string // 'YYYY-MM-DD'（本地时区）
  // ── A: 存储层 ──
  l0FillRate: number // Σweight(已填) / Σweight(全部)，[0,1]
  l0FilledCount: number
  l1FreshnessScore: number // L1 条目中 lastUpdated ≤7 天的占比，[0,1]
  l2Total: number
  l2ByState: { active: number; dormant: number; archived: number }
  // ── B: 检索层 ──
  /** 近 7 天 1 - corrected/referenced；样本 <5 时为 null（不装有数据） */
  refAccuracy7d: number | null
  /** 累计被纠正次数（l2.corrected 事件总数，只增不减） */
  correctionsTotal: number
  /** 最近一次手动评测得分（10 场景，[0,1]），无则 null */
  manualEvalScore: number | null
  // ── C: 引擎层（从 DMAE 引擎拉取聚合，异常检测本体在 F5-002）──
  dmaeAvgActivation: number
  dmaeOldestActiveDays: number
  // ── 汇总 ──
  understanding: number // U 值，整数百分比 0-100
  activeDays: number // 累计有对话的天数
  uniqueTopics: number // L2 记忆 tags 去重计数
}

/**
 * "了解度" U 值公式（F5-006 §3，写死在代码 + 注释引用本文档）。
 *   U = 100 · (0.5·l0FillRate + 0.3·min(1, uniqueTopics/50) + 0.2·min(1, activeDays/60))
 *
 * 设计意图：前期由 L0 驱动（快速反馈），中期由话题广度驱动，
 * 相处时长兜底 20% 保证"陪伴本身就是成长"。
 * 单调不减（L0 清空字段是唯一例外，接受）。
 */
export function computeUnderstanding(
  s: Pick<GrowthSnapshot, 'l0FillRate' | 'uniqueTopics' | 'activeDays'>
): number {
  return Math.round(
    100 *
      (0.5 * s.l0FillRate +
        0.3 * Math.min(1, s.uniqueTopics / 50) +
        0.2 * Math.min(1, s.activeDays / 60))
  )
}

/** 关系阶段（F5-006 §3 GrowthProfile.stage）。U <10 stranger / <30 acquaintance / <60 familiar / ≥60 close */
export type GrowthStage = 'stranger' | 'acquaintance' | 'familiar' | 'close'

/** 从 U 值派生关系阶段 */
export function deriveStage(understanding: number): GrowthStage {
  if (understanding >= 60) return 'close'
  if (understanding >= 30) return 'familiar'
  if (understanding >= 10) return 'acquaintance'
  return 'stranger'
}

// === 里程碑（数据驱动，JSON 可扩展，不写死在代码里）===

export interface MetricCondition {
  metric:
    | 'understanding'
    | 'l0FillRate'
    | 'l2Total'
    | 'activeDays'
    | 'correctionsTotal'
    | `l0.field:${string}`
  op: '>='
  value: number
}

export interface MilestoneDef {
  id: string
  title: string // "她记住了你的名字"
  condition: MetricCondition
  /**
   * 注入 9 层 Prompt relationship 层的行为指令片段。
   * 空字符串 = 纯记录型里程碑，不改变行为
   */
  promptFragment: string
  /** 成长日志的叙事模板，{{var}} 占位 */
  narrativeTemplate: string
  once: true // 本版本全部一次性；重复型预留给未来
}

/**
 * 初版里程碑表（F5-006 §3）。作为 resources/growth/milestones.json 初始内容。
 * 运行时从 JSON 加载（数据驱动）；JSON 不存在时回退此常量。
 */
export const MILESTONES_V1: readonly MilestoneDef[] = [
  {
    id: 'ms.name',
    title: '她记住了你的名字',
    condition: { metric: 'l0.field:preferredName', op: '>=', value: 1 },
    promptFragment: '你已经知道用户的名字，可以自然地用名字称呼（不要每句都用）。',
    narrativeTemplate: '今天她记住了你的名字。',
    once: true
  },
  {
    id: 'ms.u10',
    title: '初识',
    condition: { metric: 'understanding', op: '>=', value: 10 },
    promptFragment: '你们刚认识不久，保持礼貌的好奇，多问开放式问题。',
    narrativeTemplate: '你们不再是陌生人了。',
    once: true
  },
  {
    id: 'ms.u30',
    title: '熟悉',
    condition: { metric: 'understanding', op: '>=', value: 30 },
    promptFragment: '你们已经比较熟了。可以主动引用你记得的偏好，语气更放松。',
    narrativeTemplate: '她开始能接上你的话了--她记得的事情越来越多。',
    once: true
  },
  {
    id: 'ms.u60',
    title: '亲近',
    condition: { metric: 'understanding', op: '>=', value: 60 },
    promptFragment: '你们已经非常熟悉。可以有默契式省略、内部梗、更直接的关心。',
    narrativeTemplate: '不知不觉，她已经很懂你了。',
    once: true
  },
  {
    id: 'ms.l2_100',
    title: '一百段记忆',
    condition: { metric: 'l2Total', op: '>=', value: 100 },
    promptFragment: '',
    narrativeTemplate: '你们之间已经有 {{l2Total}} 段共同记忆。',
    once: true
  },
  {
    id: 'ms.week',
    title: '相识一周',
    condition: { metric: 'activeDays', op: '>=', value: 7 },
    promptFragment: '',
    narrativeTemplate: '你们认识一周了。',
    once: true
  },
  {
    id: 'ms.month',
    title: '相识一月',
    condition: { metric: 'activeDays', op: '>=', value: 30 },
    promptFragment: '你们已相处一个月。可以偶尔回顾"我们刚认识的时候"。',
    narrativeTemplate: '一个月了。她还记得你们的第一次对话。',
    once: true
  },
  {
    id: 'ms.firstFix',
    title: '第一次被纠正',
    condition: { metric: 'correctionsTotal', op: '>=', value: 1 },
    promptFragment: '你曾经记错过用户的事。引用记忆时保留一点不确定的余地（"如果我没记错的话"）。',
    narrativeTemplate: '她记错了一件事，你纠正了她。她会记得这次教训。',
    once: true
  }
]

// === 当前态（喂 Prompt 与 UI）===

export interface GrowthProfile {
  startedAt: number // 首次对话 epoch ms
  current: GrowthSnapshot // 今日实时快照（未落盘版本）
  milestonesReached: Array<{ id: string; ts: number }>
  /** relationship 层拼接源：已达成里程碑的非空 promptFragment，按达成顺序 */
  promptFragments: string[]
  /** 派生关系阶段（供 UI 徽章 & style 层参考） */
  stage: GrowthStage
}

// === 成长日志（UI 渲染"你们的记忆时间线"）===

export interface GrowthTimelineEntry {
  ts: number
  kind: 'milestone' | 'periodic' // periodic = 每月自动小结
  title: string
  text: string // 模板渲染结果（Phase 5 可 LLM 润色，失败回模板）
  milestoneId?: string
}

// === GrowthService 接口（F5-006 §3）===

export interface GrowthService {
  /** 订阅入口：EventBus 上的 'growth:event' 全部进这里 */
  ingest(e: GrowthEvent): void
  /** 每日快照任务（当天首轮 turn.end 后触发；同日幂等） */
  snapshotToday(): GrowthSnapshot
  getProfile(): GrowthProfile
  getTimeline(limit?: number): GrowthTimelineEntry[]
  getTrend(metric: keyof GrowthSnapshot, days: number): Array<{ date: string; value: number }>
  /** 灾难恢复/指标算法升级：从事件流全量重放重建快照与里程碑 */
  rebuildFromEvents(): Promise<void>
}
