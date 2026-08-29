// src/shared/memory/dmae-types.ts
// M-20：DMAE 面板 DTO 下沉 shared（此前 preload / renderer / shared 反向 import
// main/memory/dmae/* 的类型，违反"shared 不能反向 import main"契约）。
// main 侧 diagnostics / history-types / benchmark-types / anomaly-types / formulas
// 从此处 re-export，兼容既有导入。
//
// 内容 = 跨 IPC 边界的 DMAE DTO 全图：
//   - 三态：DmaeState
//   - 参数快照：DmaeParamsSnapshot
//   - 面板首屏：DmaePanelSnapshot（+ DmaeSelectionSummary / DmaeActiveSetEntry / DmaeStateFileHealth）
//   - 工程档分解：DmaeTurnExplanation
//   - 趋势：DmaeDailyAggregate
//   - 体检：DmaeBenchmarkReport（+ DmaeQualitativeScores）
//   - 异常与建议：DmaeAnomaly / AnomalySeverity / DmaeAdvice / DmaeParamChange / TunableParam
//
// 留在 main 的（不跨 IPC，无需下沉）：
//   DmaeSamplePoint / DmaeTurnRecord / DmaeParamAnnotation（历史存储内部 DTO）、
//   AnomalyContext / AnomalyRule（规则引擎内部）、
//   HEALTHY_RANGES / computeParamsHash / snapshotFromDmaeConfig（运行时，仅 main 使用）。
//
// 隐私红线（F5-011）：contentPreview 是唯一允许携带记忆内容的字段（≤60 字符，
// 仅走 IPC 到本地渲染）；不得进日志、基准报告、预设导出。

import type { AnomalyRuleId } from './dmae-config'

// === 三态 ===

/** DMAE 三态（与 L2Memory.lifecycleState 的 active/dormant/archived 对应） */
export type DmaeState = 'Active' | 'Dormant' | 'Archived'

// === 参数快照 ===

/** DMAE 参数快照（annotation 用，全 8 字段） */
export interface DmaeParamsSnapshot {
  maxScore: number
  promptThreshold: number
  userRewardBase: number
  wakeGamma: number
  modelRewardBase: number
  wakeLambda: number
  decayAlpha: number
  decayBeta: number
}

// === DmaePanelSnapshot（F5-002 §3.7）===

/** 面板首屏载荷 */
export interface DmaePanelSnapshot {
  enabled: boolean
  params: DmaeParamsSnapshot
  maxActive: number
  currentTurn: number
  /**
   * 全库三态计数。`eligibleActive` = `activation ≥ threshold` 的条目总数。
   * ⚠ 它不是 Prompt 占位数（F5-002 §2.1 事实 D）。占位看 `selection`。
   */
  counts: { eligibleActive: number; dormant: number; archived: number; l2Total: number }
  /** 上一轮的真实占位（S-F03 裁定）。面板"用了几个位置"只能读这里。 */
  selection: DmaeSelectionSummary
  /**
   * 当前**有资格进入**的集合页（全局 `activation ≥ threshold`，P3X-03 以 cursor 分页）。
   * ⚠ 这是"够格的"，**不是**"上一轮真的进了 Prompt 的"。
   */
  activeSet: DmaeActiveSetEntry[]
  /** 下一页游标；null = 当前页已到末尾。 */
  nextEligibleCursor: import('./types').DmaeEligibleCursor | null
  /** 当前页是否因 15k 防护而分页。 */
  activeSetPaginated: boolean
  /** 上一次 cursor 对应旧 DMAE turn，当前页已从头重置。 */
  eligibleCursorReset: boolean
  /** P2-33 实现规则引擎后填充。P2-32 恒为空数组。 */
  anomalies: DmaeAnomaly[]
  /** P2-34 实现基准体检后填充。null = 尚未运行体检。 */
  lastBenchmark: DmaeBenchmarkReport | null
  /** P2-34 定性评分（Q1~Q3，人工判断）。null = 尚未记录。 */
  lastQualitative: DmaeQualitativeScores | null
  /** 状态文件健康度（R11 数据源） */
  stateFile: DmaeStateFileHealth
}

/** 上一轮的选择链路（S-F03 裁定）。四个数字层层递减，面板不能只显示其中一个。 */
export interface DmaeSelectionSummary {
  /** 全库 activation ≥ threshold 的条目数（"有资格"） */
  eligibleActiveCount: number
  /** 上一轮向量检索召回并通过 hydrate 的条数 */
  lastRetrievalHits: number
  /** 上一轮 selectL2 实际返回的条数（预算裁剪前的候选，不等同最终注入）。 */
  lastPromptSelectedCount: number
  /** PromptBudgeter 最终保留的数量；旧历史缺此真值时为 null。 */
  lastPromptIncludedCount: number | null
  /** PromptBudgeter 最终裁掉的数量；旧历史缺此真值时为 null。 */
  lastPromptTrimmedCount: number | null
  /** 上一轮被选中的 memoryId（≤ maxActive，面板高亮用） */
  lastPromptSelectedIds: string[]
  /** 当时的 maxActive。注意它同时是检索 k（C-F08） */
  maxActive: number
}

/** 有资格进入集合的单条（含内容摘要与迷你趋势） */
export interface DmaeActiveSetEntry {
  memoryId: string
  /** 截断到 60 字符的内容（唯一允许带内容的字段） */
  contentPreview: string
  activation: number
  importance: number
  userSilence: number
  /** 最近 7 个采样点的 activation，画迷你 sparkline */
  spark: number[]
  trend: 'rising' | 'falling' | 'stable'
  /** importance≥10 硬豁免标记 */
  decayExempt: boolean
  /** 上一轮是否被 selectL2 选中（预算裁剪前）。 */
  selectedLastTurn: boolean
  /** 上一轮是否在 PromptBudgeter 裁剪后实际保留；旧历史未知时为 false。 */
  injectedLastTurn: boolean
}

/** 状态文件健康度（F5-002 §3.7） */
export interface DmaeStateFileHealth {
  path: string
  entries: number
  lastSaveOk: boolean
  lastSaveAt: number | null
  lastLoadReset: 'none' | 'invalid-json' | 'schema-mismatch'
  saveFailures7d: number
}

// === DmaeTurnExplanation（F5-002 §3.7 工程档公式分解）===

/** 单条记忆最近一轮的公式分解（工程档 entry inspector） */
export interface DmaeTurnExplanation {
  memoryId: string
  turn: number
  importance: number
  before: { activation: number; userSilence: number; modelSilence: number; state: DmaeState }
  userHit: boolean
  modelHit: boolean
  /** 每一项的公式字符串与数值，面板逐行渲染 */
  terms: Array<{
    name: 'Ru' | 'Rm_raw' | 'Rm_clamped' | 'Decay' | 'Floor' | 'Clamp'
    formula: string
    value: number
    applied: boolean
  }>
  after: { activation: number; state: DmaeState }
}

// === DmaeDailyAggregate（F5-002 §3.2，趋势图数据源）===

/** 每日聚合。趋势图数据源；永久保留。 */
export interface DmaeDailyAggregate {
  date: string // 'YYYY-MM-DD' 本地时区
  turns: number
  eligibleActive: number
  dormant: number
  archived: number
  l2Total: number
  avgPromptSelected: number
  medianPromptSelected: number
  /** 当天 promptSelected === maxActive 的轮数 */
  saturatedTurns: number
  medianRetrievalHits: number
  avgActivation: number
  medianActivation: number
  /** 当天新增 Archived 的条目数 */
  archivedTransitions: number
  floorRevivals: number
  trueFloorRevivals: number
  /** 当天 Σ(effective)/Σ(raw)，分母为 0 时 null */
  modelRewardYield: number | null
  paramsHash: string
}

// === DmaeBenchmarkReport（F5-002 §3.6）===

/** 参数基准报告。面板"参数体检"按钮生成 */
export interface DmaeBenchmarkReport {
  generatedAt: number
  windowDays: number
  paramsHash: string
  params: DmaeParamsSnapshot
  /** 样本是否足够（不足时 metrics 仍算但标注不可信） */
  sufficientSample: boolean
  metrics: {
    /** M1 Prompt 占位率 = 平均 promptSelected/maxActive。健康 [0.4, 0.9] */
    activeUtilization: number
    /** M2 记忆半衰期（轮）。experimental，动态区间 */
    halfLifeTurns: number
    /** M3 存活轮数中位数。experimental，动态区间 */
    medianLifespanTurns: number
    /** M4 复用率 = 激活≥2次/激活≥1次。健康 [0.3, 1.0] */
    reuseRate: number
    /** M5 冷冻率 = 从未激活/总数（排除新条目）。健康 [0, 0.25] */
    frozenRate: number
    /** M6 豁免占比 = importance≥10/总数。健康 [0.02, 0.20] */
    exemptRatio: number
  }
  verdicts: {
    M1: 'healthy' | 'low' | 'high'
    M2: 'at-floor' | 'mid' | 'at-ceiling' | 'experimental-insufficient'
    M3: 'at-floor' | 'mid' | 'at-ceiling' | 'experimental-insufficient'
    M4: 'healthy' | 'low' | 'high'
    M5: 'healthy' | 'low' | 'high'
    M6: 'healthy' | 'low' | 'high'
  }
  /** M2/M3 判定所依据的可达范围 */
  achievableRange: {
    medianImportance: number
    medianPeakActivation: number
    halfLife: { min: number; max: number }
    lifespan: { min: number; max: number }
  }
  /** 与上一次报告（不同 paramsHash）的对比 */
  comparedTo: { paramsHash: string; deltas: Record<string, number> } | null
}

/** 定性评分（Q1/Q2/Q3，人工判断）*/
export interface DmaeQualitativeScores {
  q1: number // 突兀感 0-3
  q2: number // 失忆感 0-3
  q3: number // 关心感 0-3
  note?: string
  ts: number
}

// === 异常与调参建议（F5-002 §3.3/§3.4）===

/** 严重级别。critical 在面板顶部红色常驻；warning 黄色可折叠；info 仅工程档可见 */
export type AnomalySeverity = 'critical' | 'warning' | 'info'

/**
 * 一条检出的异常。面板渲染与"忽略"状态都基于此结构。
 * 依据 F5-002 §3.3。
 */
export interface DmaeAnomaly {
  ruleId: AnomalyRuleId
  severity: AnomalySeverity
  /** 叙事档标题（她的语言） */
  title: string
  /** 叙事档正文，已填入实际数值 */
  narrative: string
  /** 工程档单行摘要 */
  technical: string
  /** 支撑证据。面板 [看看为什么] 展开 */
  evidence: {
    /** 最多 20 条（面板只展示前 20，避免 15k 条列表） */
    memoryIds: string[]
    /** 规则相关的关键数值，键名由规则自定义 */
    metrics: Record<string, number>
    /** 采样窗口 */
    windowTurns: number
    windowDays: number
  }
  /** 关联的调参建议（F5-002 §3.4）。null = 此异常无参数解法 */
  advice: DmaeAdvice | null
  /** 检出时间 */
  detectedAt: number
}

/** 可被建议修改的参数键（maxScore 是 literal 100，不可调） */
export type TunableParam =
  | 'promptThreshold'
  | 'userRewardBase'
  | 'wakeGamma'
  | 'modelRewardBase'
  | 'wakeLambda'
  | 'decayAlpha'
  | 'decayBeta'

/** 一项参数变更。一条建议可以包含多项（如 R01 通常同时调 α 和 β） */
export interface DmaeParamChange {
  param: TunableParam
  currentValue: number
  /** 建议值，已按 F5-002 §3.4 的取整与范围裁剪规则处理 */
  suggestedValue: number
  direction: 'increase' | 'decrease'
}

/**
 * 一条调参建议。面板 [填入设置页] 按钮遍历 changes 逐项填入草稿态。
 * 依据 F5-002 §3.4。
 */
export interface DmaeAdvice {
  /** 产生此建议的规则 */
  ruleId: AnomalyRuleId
  /**
   * 建议类型。
   * - 'tune'    改参数，changes 非空
   * - 'inspect' 不改参数，让用户去看别的东西（如 R04 查 importance、R08 "调了也没用"）
   */
  kind: 'tune' | 'inspect'
  /** 建议的参数变更列表。必须支持多项（R01 同时调 α 和 β） */
  changes: DmaeParamChange[]
  /** 叙事档文案。必须包含"为什么"和"会有什么变化" */
  narrative: string
  /** 相互作用警告。非空时面板必须展示 */
  interactionWarnings: string[]
  /** 预计生效所需的观察时长 */
  observeAfter: { turns: number; days: number }
  /** 置信度。低置信度建议在叙事档标注"不太确定" */
  confidence: 'high' | 'medium' | 'low'
}
