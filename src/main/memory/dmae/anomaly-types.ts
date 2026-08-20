// src/main/memory/dmae/anomaly-types.ts
// P2-32：DMAE 异常检测类型（F5-002 §3.3）。
// 依据：F5-002 §3.3 的 13 条规则 + S-012 §3.3（P2-32 只定类型，规则实现是 P2-33）。
//
// 设计要点：
//   1. 本文件只放类型与公共形状；规则实现（AnomalyRule 函数）在 P2-33 的 rules.ts
//   2. AnomalyRuleId 从 shared/memory/dmae-config re-export（单一真源，不重复定义）
//   3. DmaeAnomaly 是面板渲染与"忽略"状态的统一结构
//
// M-20：AnomalySeverity / DmaeAnomaly / TunableParam / DmaeParamChange / DmaeAdvice
// 已下沉 shared/memory/dmae-types（跨 IPC），此处 re-export 兼容既有导入。
// AnomalyContext / AnomalyRule 是规则引擎内部类型（不跨 IPC），留在本文件。

import type { AnomalyRuleId } from '@shared/memory/dmae-config'
import type { DmaeState } from './formulas'
import type { DmaeParamsSnapshot } from './history-types'
import type { DmaeAnomaly } from '@shared/memory/dmae-types'

// re-export（F5-002 §3.5：AnomalyRuleId 唯一真源在 shared/memory/dmae-config）
export type { AnomalyRuleId }
// M-20 re-export（兼容既有导入）
export type {
  AnomalySeverity,
  DmaeAnomaly,
  TunableParam,
  DmaeParamChange,
  DmaeAdvice
} from '@shared/memory/dmae-types'

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
