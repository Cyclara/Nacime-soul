// src/main/memory/dmae/benchmark-types.ts
// P2-34.5：DMAE 参数基准报告类型（F5-002 §3.6）。
// 依据：F5-002 §3.6 的 DmaeBenchmarkReport（6 定量 + 3 定性）。
//
// 设计要点：
//   1. M1/M4/M5/M6 用绝对区间判定（healthy/low/high）
//   2. M2/M3 标 experimental，用 maxAchievableLifespan 现算可达区间，只报位置（at-floor/mid/at-ceiling）
//   3. 基准报告只在本机生成，不进 CI（F5-002 §3.6）
//   4. 健康区间是产品语义锚点，不是科学真理--tooltip 必须说明

import type { DmaeParamsSnapshot } from './history-types'

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

/** 健康区间（F5-002 §3.6）*/
export const HEALTHY_RANGES = {
  M1: { min: 0.4, max: 0.9 },
  M4: { min: 0.3, max: 1.0 },
  M5: { min: 0, max: 0.25 },
  M6: { min: 0.02, max: 0.2 }
} as const

/** 定性评分（Q1/Q2/Q3，人工判断）*/
export interface DmaeQualitativeScores {
  q1: number // 突兀感 0-3
  q2: number // 失忆感 0-3
  q3: number // 关心感 0-3
  note?: string
  ts: number
}
