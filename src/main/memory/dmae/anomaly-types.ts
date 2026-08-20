// src/main/memory/dmae/anomaly-types.ts
// P2-32：DMAE 异常检测类型（F5-002 §3.3）。
// 依据：F5-002 §3.3 的 13 条规则 + S-012 §3.3（P2-32 只定类型，规则实现是 P2-33）。
//
// 设计要点：
//   1. 本文件只放类型与公共形状；规则实现（AnomalyRule 函数）在 P2-33 的 rules.ts
//   2. AnomalyRuleId 从 shared/memory/dmae-config re-export（单一真源，不重复定义）
//   3. DmaeAnomaly 是面板渲染与"忽略"状态的统一结构

import type { AnomalyRuleId } from '@shared/memory/dmae-config'
import type { DmaeState } from './formulas'
import type { DmaeParamsSnapshot } from './history-types'

// re-export（F5-002 §3.5：AnomalyRuleId 唯一真源在 shared/memory/dmae-config）
export type { AnomalyRuleId }

// === 严重级别 ===

/** 严重级别。critical 在面板顶部红色常驻；warning 黄色可折叠；info 仅工程档可见 */
export type AnomalySeverity = 'critical' | 'warning' | 'info'

// === 异常告警 ===

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

// === 调参建议 ===

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

// === 规则运行上下文（P2-33 实现规则时用）===

/** 规则运行所需的输入快照。由 DmaeDiagnosticsService 组装，规则函数是纯函数 */
export interface AnomalyContext {
  params: DmaeParamsSnapshot
  maxActive: number
  /** 当前全部条目状态（含 importance，从 L2Store join） */
  entries: ReadonlyArray<{
    id: string
    activation: number
    userSilence: number
    modelSilence: number
    state: DmaeState
    importance: number
    isPinned: boolean
    lifecycleState: string
    createdAt: number
    /** 是否曾经激活过（来自引擎 states 的 everActivated） */
    everActivated: boolean
  }>
  /** 最近 N 天的每日聚合（按 date 升序） */
  daily: readonly import('./history-types').DmaeDailyAggregate[]
  /** 最近 W 轮的逐轮记录（R08/R09 用，来自 dmae_turns） */
  recentTurns: readonly import('./history-types').DmaeTurnRecord[]
  /** 最近 W 轮的采样点（用于逐条轨迹分析，R07 用） */
  recentSamples: readonly import('./history-types').DmaeSamplePoint[]
  /** 当前全局 turn */
  currentTurn: number
  /** 最近一次参数变更标注 */
  lastAnnotation: import('./history-types').DmaeParamAnnotation | null
  /** 状态文件健康度（R11 用） */
  stateFileHealth: {
    lastLoadReset: 'none' | 'invalid-json' | 'schema-mismatch'
    saveFailures7d: number
  }
  /**
   * 配置的规则窗口（P1 修复：R01~R11 必须读它，不再硬编码）。
   * 每个规则只用它声明支持的维度（WINDOW_KEYS），缺失键回退到默认值。
   */
  windows: Record<AnomalyRuleId, { days?: number; turns?: number }>
  now: number
}

/** 规则函数签名。纯函数，无 IO，可单测 */
export type AnomalyRule = (ctx: AnomalyContext) => DmaeAnomaly | null
