// src/main/memory/dmae/formulas.ts
// P2-22: DMAE 纯公式模块（无 IO 纯函数）。
// 依据：S-Phase2 P2-22、S-004-补充 D-01/D-02、F5-006（成长系统合同）、
//       技术分析 §1.1.3 DMAE Worldbook 引擎。
//
// 公式来源：Cyrene-Agent worldbook.ts v4.0（经审计确认语义，见项目参考/Cyrene-Agent）。
//   Ru = Bu × (1 + γ·ln(1+usOld))        [用户命中奖励；usOld=距上次用户命中的轮数]
//   Rm = Bm × e^(−λ·usOld)                [模型命中奖励 raw；调用方做 Active gating + Rm<D clamp]
//   Decay = (α·usNew² + β·msNew²) / √I    [遗忘曲线；I=importance]
//   deriveState: ≤0->Archived, ≥threshold->Active, 其余 Dormant
//
// nacime-soul 相对 Cyrene-Agent 的增量（S-Phase2 P2-22 明确要求）：
//   1. importance≥10 硬豁免 Decay（=0）；Cyrene-Agent 只有 √I 软豁免（忘得更慢但仍衰减）。
//      双保险：√I 项（高 I 忘得慢）+ 硬豁免（I≥10 完全不衰减）。
//   2. 参数从 config.memory.dmae 读取（非硬编码 DEFAULT_DMAE_PARAMS）。
//   3. MAX_ACTIVE 从 config.memory.maxActive 读取（Cyrene-Agent 硬编码 8，nacime-soul 默认 15）。
//
// 本模块 100% branch 覆盖（S-004 §3.3 红线）。公式对错 = 记忆行为对错，错一个分支是数据级事故。

import type { MemoryConfig } from '@shared/config/types'

/** DMAE 可调参数（从 config.memory.dmae 读取）。字段名与 Cyrene-Agent DmaeParams 对齐 */
export interface DmaeParams {
  /** 物理上界（默认 100） */
  maxScore: number
  /** Active 阈值：activation≥此值进 Prompt（默认 30） */
  promptThreshold: number
  /** 用户基础奖励 Bu（默认 20） */
  userRewardBase: number
  /** 久别重逢增益 γ（默认 0.5） */
  wakeGamma: number
  /** 模型基础奖励 Bm（默认 8） */
  modelRewardBase: number
  /** 模型奖励衰减率 λ（默认 0.3） */
  wakeLambda: number
  /** 用户沉默权重 α（默认 1.5） */
  decayAlpha: number
  /** 模型沉默权重 β（默认 0.3） */
  decayBeta: number
}

/** DMAE 三态（与 L2Memory.lifecycleState 的 active/dormant/archived 对应） */
export type DmaeState = 'Active' | 'Dormant' | 'Archived'

/** importance≥10 硬豁免阈值（S-Phase2 P2-22）。seed 关联条目永不衰减 */
export const IMPORTANCE_EXEMPT_THRESHOLD = 10

/** √I 除零保护：importance 下限（Cyrene-Agent MIN_INTRINSIC_VALUE=1，sqrt(0) 会爆） */
export const MIN_IMPORTANCE = 1

/** Rm < D 不变量保护（Cyrene-Agent EPSILON=0.01）：Rm = clamp(Rm, 0, D - ε) */
export const RM_CLAMP_EPSILON = 0.01

/**
 * 从 MemoryConfig 提取 DMAE 参数。配置 schema 已校验范围（S-005），
 * 此处只做字段映射，不重复校验。
 */
export function dmaeParamsFromConfig(cfg: Readonly<MemoryConfig>): DmaeParams {
  const d = cfg.dmae
  return {
    maxScore: d.maxScore,
    promptThreshold: d.promptThreshold,
    userRewardBase: d.userRewardBase,
    wakeGamma: d.wakeGamma,
    modelRewardBase: d.modelRewardBase,
    wakeLambda: d.wakeLambda,
    decayAlpha: d.decayAlpha,
    decayBeta: d.decayBeta
  }
}

/**
 * 用户命中奖励：Ru = Bu × (1 + γ·ln(1+usOld))
 *
 * - usOld = 距上次用户命中的轮数（userSilence）。命中时 usOld 为更新前的累计沉默轮数。
 * - 对数增长防溢出：ln 单调递增但增速放缓，永远不会暴涨。
 * - 久别重逢：沉默越久（usOld 越大），下次命中奖励越大。
 * - 连续命中（usOld=0）时 Ru=Bu（基础奖励）。
 *
 * 仅当 userHit 时调用（engine 层负责判断）。
 */
export function computeUserReward(usOld: number, params: DmaeParams): number {
  return params.userRewardBase * (1 + params.wakeGamma * Math.log(1 + usOld))
}

/**
 * 模型命中奖励（raw，不含 Active gating 与 Rm<D clamp）：Rm = Bm × e^(−λ·usOld)
 *
 * - usOld = 距上次用户命中的轮数（userSilence，与 Ru 同源）。
 * - 指数衰减：usOld 越大 Rm 越小，防止模型"自说自话"积累的记忆霸占 Prompt。
 * - usOld=0 时 Rm=Bm（最大）；usOld→∞ 时 Rm→0。
 *
 * 调用方（engine）职责：
 *   1. Active gating：仅当 aOld≥promptThreshold（旧态 Active）时才给 Rm（v4.0 §5）。
 *   2. Rm<D 不变量：Rm = max(0, min(rawRm, decay - EPSILON))（v4.0 §8，避免 Rm≥D 时仍涨分）。
 */
export function computeModelReward(usOld: number, params: DmaeParams): number {
  return params.modelRewardBase * Math.exp(-params.wakeLambda * usOld)
}

/**
 * 遗忘曲线：Decay = (α·usNew² + β·msNew²) / √I
 *
 * - usNew/msNew = 更新后的用户/模型沉默轮数（engine 层已算好）。
 * - I = importance（≥ MIN_IMPORTANCE 除零保护）。
 * - 平方累积：沉默越久忘得越快（加速遗忘）。
 * - 除以 √I：高内在价值条目忘得更慢（价值决定忘得多慢，而不是爱得多深）。
 *
 * nacime-soul 增量（S-Phase2 P2-22）：importance≥10 硬豁免，返回 0。
 * Cyrene-Agent 只有 √I 软豁免（I=10 时衰减比 I=1 慢 √10≈3.16 倍，但仍衰减）。
 * nacime-soul 双保险：√I 项（软）+ importance≥10 硬豁免（完全不衰减）。
 */
export function computeDecay(
  usNew: number,
  msNew: number,
  importance: number,
  params: DmaeParams
): number {
  // 硬豁免：importance≥10 的条目永不衰减（S-Phase2 P2-22 + D-04）
  if (importance >= IMPORTANCE_EXEMPT_THRESHOLD) return 0
  const I = Math.max(MIN_IMPORTANCE, importance)
  const resistance = 1 / Math.sqrt(I)
  const raw = params.decayAlpha * usNew * usNew + params.decayBeta * msNew * msNew
  return raw * resistance
}

/**
 * 状态派生：≤0->Archived, ≥threshold->Active, 其余 Dormant
 *
 * 纯函数，engine 与 selector 共用。threshold = promptThreshold。
 * 与 L2Memory.lifecycleState 的映射：Active->active, Dormant->dormant, Archived->archived。
 */
export function deriveState(activation: number, threshold: number): DmaeState {
  if (activation <= 0) return 'Archived'
  if (activation >= threshold) return 'Active'
  return 'Dormant'
}

/**
 * Floor 值 = importance（Cyrene-Agent 语义：intrinsicValue 参与 Floor 基线）。
 *
 * 仅 Archived 复活（userHit 且旧态 Archived）时触发（engine 层判断）。
 * 复活后 activation = max(计算值, importance)，保证高价值条目复活后不低于其内在价值。
 * 注意：importance< threshold 时 Floor 可能复活到 Dormant 而非 Active，这是合理的--
 * 高价值但久未提及的条目复活后需要再次被提及才能回到 Active。
 */
export function floorValue(importance: number): number {
  return importance
}

/**
 * 将 activation 钳制到 [0, maxScore]（engine 层更新时调用）。
 * 物理上界 maxScore 防止无限增长；下界 0 保证非负。
 */
export function clampActivation(activation: number, maxScore: number): number {
  return Math.max(0, Math.min(maxScore, activation))
}
