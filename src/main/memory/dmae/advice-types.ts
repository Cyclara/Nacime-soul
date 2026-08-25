// src/main/memory/dmae/advice-types.ts
// P2-34：DMAE 调参建议引擎类型（F5-002 §3.4）。
// 依据：F5-002 §3.4 的 solveDecayForLifespan / maxAchievableLifespan / normalizeSuggestion / detectInteractions。
//
// 设计要点：
//   1. 建议引擎不写 config（F5-002 §5 红线）：只返回 changes，由用户在设置页确认保存
//   2. 反解公式不猜数字：从目标存活轮数反解 (α,β)，不硬编码建议值
//   3. 六个参数里只有五个是活的（α/β/Bu/γ/threshold），Bm/λ 恒等于零效果（§2.1 事实 A）

import type { DmaeParamsSnapshot } from './history-types'

// re-export TunableParam（唯一真源在 anomaly-types，advice 也需要）
export type { TunableParam } from './anomaly-types'
export type { DmaeParamChange, DmaeAdvice } from './anomaly-types'

// === 参数作用方向表（F5-002 §3.4）===

/** 参数作用方向。用于检测叠加效应 */
export const PARAM_EFFECT_DIRECTION: Record<
  string, // TunableParam
  { increase: 'persist' | 'volatile'; label: string }
> = {
  userRewardBase: { increase: 'persist', label: '记忆力度 Bu' },
  wakeGamma: { increase: 'persist', label: '重复提及增长 γ' },
  modelRewardBase: { increase: 'persist', label: '主动提及权重 Bm' },
  wakeLambda: { increase: 'volatile', label: '主动提及衰减 λ' },
  decayAlpha: { increase: 'volatile', label: '遗忘速度 α' },
  decayBeta: { increase: 'volatile', label: '模型侧遗忘 β' },
  promptThreshold: { increase: 'volatile', label: '进入门槛 threshold' }
}

// === schema 范围常量（与 config/schema/memory.ts 对齐，建议值裁剪用）===

export const PARAM_SCHEMA_RANGE: Record<
  string, // TunableParam
  { min: number; max: number }
> = {
  promptThreshold: { min: 1, max: 99 },
  userRewardBase: { min: 10, max: 30 },
  wakeGamma: { min: 0.3, max: 0.8 },
  modelRewardBase: { min: 5, max: 12 },
  wakeLambda: { min: 0.1, max: 0.5 },
  decayAlpha: { min: 0.3, max: 2 },
  decayBeta: { min: 0.05, max: 0.5 }
}

// === 反解结果（F5-002 §3.4）===

/** solveDecayForLifespan 的三种结果 */
export type SolveDecayResult =
  | { kind: 'ok'; alpha: number; beta: number }
  | { kind: 'needs-combo'; alpha: number; beta: number; suggestedBu: number }
  | { kind: 'unreachable'; maxTurns: number }

// === 建议引擎接口 ===

/** 建议引擎接口（P2-34 实现） */
export interface DmaeAdviceEngine {
  /** 反解衰减参数对 (α, β) */
  solveDecayForLifespan(input: {
    targetTurns: number
    medianImportance: number
    peakActivation: number
    threshold: number
    currentBeta: number
    currentUserRewardBase: number
  }): SolveDecayResult

  /** 在 schema 允许的全参数范围内，模拟一条记忆最多能存活多少轮 */
  maxAchievableLifespan(importance: number, peakActivation: number, threshold: number): number

  /** 建议值后处理：范围裁剪 + 取整 + 最小步长 */
  normalizeSuggestion(
    param: string, // TunableParam
    current: number,
    raw: number
  ): number | null

  /** 生成相互作用警告 */
  detectInteractions(
    changes: ReadonlyArray<{ param: string; direction: 'increase' | 'decrease' }>,
    recentAnnotations: ReadonlyArray<{
      before: DmaeParamsSnapshot
      after: DmaeParamsSnapshot
      source: 'manual' | 'preset' | 'advice'
      ts: number
    }>,
    windowDays: number
  ): string[]
}
