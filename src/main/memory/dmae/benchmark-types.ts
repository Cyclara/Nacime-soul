// src/main/memory/dmae/benchmark-types.ts
// P2-34.5：DMAE 参数基准报告类型（F5-002 §3.6）。
// 依据：F5-002 §3.6 的 DmaeBenchmarkReport（6 定量 + 3 定性）。
//
// 设计要点：
//   1. M1/M4/M5/M6 用绝对区间判定（healthy/low/high）
//   2. M2/M3 标 experimental，用 maxAchievableLifespan 现算可达区间，只报位置（at-floor/mid/at-ceiling）
//   3. 基准报告只在本机生成，不进 CI（F5-002 §3.6）
//   4. 健康区间是产品语义锚点，不是科学真理--tooltip 必须说明
//
// M-20：DmaeBenchmarkReport / DmaeQualitativeScores 已下沉 shared/memory/dmae-types（跨 IPC），
// 此处 re-export 兼容既有导入。HEALTHY_RANGES 是运行时常量且仅 main 使用，留在本文件。

// M-20 re-export（兼容既有导入）
export type { DmaeBenchmarkReport, DmaeQualitativeScores } from '@shared/memory/dmae-types'

/** 健康区间（F5-002 §3.6）*/
export const HEALTHY_RANGES = {
  M1: { min: 0.4, max: 0.9 },
  M4: { min: 0.3, max: 1.0 },
  M5: { min: 0, max: 0.25 },
  M6: { min: 0.02, max: 0.2 }
} as const
