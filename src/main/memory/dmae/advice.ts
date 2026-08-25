// src/main/memory/dmae/advice.ts
// P2-34：DMAE 调参建议引擎实现（F5-002 §3.4）。
// 依据：F5-002 §3.4 的 solveDecayForLifespan / maxAchievableLifespan / normalizeSuggestion / detectInteractions。
//
// 核心公式（F5-002 §3.4）：
//   累计衰减 Σ(t=1..T) [(α·t² + β·t²)/√I] = (α+β)/√I · T(T+1)(2T+1)/6
//   要求：A₀ − (α+β)/√I · T(T+1)(2T+1)/6 ≥ threshold
//   ⇒ S_required = 6·√I·(A₀ − threshold) / [T(T+1)(2T+1)]
//   可达 ⟺ S_required ≥ 0.35（S 的下界 = ALPHA_MIN + BETA_MIN = 0.3 + 0.05）
//
// 红线（F5-002 §5）：建议引擎不写 config，只返回 changes。

import type { DmaeAdviceEngine, SolveDecayResult } from './advice-types'
import { PARAM_SCHEMA_RANGE, PARAM_EFFECT_DIRECTION } from './advice-types'
import type { DmaeParamsSnapshot } from './history-types'

const ALPHA_MIN = 0.3
const ALPHA_MAX = 2.0
const BETA_MIN = 0.05
const BETA_MAX = 0.5
const S_MIN = ALPHA_MIN + BETA_MIN // 0.35

/**
 * 反解衰减参数对 (α, β)。
 * 分配策略（按此顺序，保证建议最小惊讶）：
 *   1. 记 S = S_required。若 S ≥ currentBeta + ALPHA_MIN，令 β 不变、α = S − β
 *   2. 否则 α = ALPHA_MIN(0.3)，β = clamp(S − 0.3, BETA_MIN, BETA_MAX)
 *   3. 若 S < 0.35（= ALPHA_MIN + BETA_MIN），衰减参数已无余量 -> 转入 needs-combo/unreachable
 *
 * ⚠️ S_required 是"累计衰减系数 S=α+β"的**上界**（S ≤ S_required 即满足"活 targetTurns 轮"），
 * 不是需要达到的目标值。因此策略 1 中 α 被钳到 ALPHA_MAX 时返回 ok 是正确的——
 * S = ALPHA_MAX + currentBeta ≤ S_required 仍满足不等式，不是"静默撒谎"。
 * 只有 S_required < S_MIN（衰减太慢撑不满目标轮数）才需要 needs-combo/unreachable。
 */
export function solveDecayForLifespan(input: {
  targetTurns: number
  medianImportance: number
  peakActivation: number
  threshold: number
  currentBeta: number
  currentUserRewardBase: number
}): SolveDecayResult {
  const { targetTurns, medianImportance, peakActivation, threshold, currentBeta } = input
  const I = Math.max(1, medianImportance)
  const A0 = peakActivation

  // S_required = 6·√I·(A₀ − threshold) / [T(T+1)(2T+1)]
  const denom = targetTurns * (targetTurns + 1) * (2 * targetTurns + 1)
  const sRequired = (6 * Math.sqrt(I) * (A0 - threshold)) / denom

  // 不可达：S_required < S 的下界
  if (sRequired < S_MIN) {
    // 检查 needs-combo：抬高 A₀（提 Bu）后能否可达
    // A₀' ≈ A₀ × Bu_new/Bu_cur，Bu 上界 30
    const buMax = 30
    const a0Scaled = A0 * (buMax / Math.max(1, input.currentUserRewardBase))
    const sRequiredScaled = (6 * Math.sqrt(I) * (a0Scaled - threshold)) / denom
    if (sRequiredScaled >= S_MIN) {
      // needs-combo：α/β 压到最小档 + 抬 Bu。
      // P2（2026-08-10 审计）：修复前 suggestedBu = currentBu * (A0/A0) = currentBu 恒等，
      // "建议同时抬 Bu"却根本不改 Bu。
      // 正确反解：在 α=ALPHA_MIN、β=BETA_MIN（S=0.35 最小档）下，撑到 targetTurns 所需的最小 Bu。
      //   S_required(Bu_new) = 6√I(A₀·Bu_new/Bu_cur − threshold)/denom = S_MIN
      //   ⇒ Bu_new = Bu_cur · (threshold + denom·S_MIN/(6√I)) / A₀
      const alpha = ALPHA_MIN
      const beta = BETA_MIN
      const buNeeded =
        (input.currentUserRewardBase * (threshold + (denom * S_MIN) / (6 * Math.sqrt(I)))) / A0
      const suggestedBu = Math.min(buMax, Math.ceil(buNeeded))
      return { kind: 'needs-combo', alpha, beta, suggestedBu }
    }
    // unreachable：Bu 也拉满仍不可达
    return { kind: 'unreachable', maxTurns: maxAchievableLifespan(I, A0, threshold) }
  }

  // 可达：分配 (α, β)
  // 策略 1：β 不变，α = S − β
  if (sRequired >= currentBeta + ALPHA_MIN) {
    const alpha = Math.min(ALPHA_MAX, sRequired - currentBeta)
    return { kind: 'ok', alpha: round2(alpha), beta: round2(currentBeta) }
  }

  // 策略 2：α = ALPHA_MIN，β = clamp(S − 0.3, BETA_MIN, BETA_MAX)
  const alpha = ALPHA_MIN
  const beta = Math.max(BETA_MIN, Math.min(BETA_MAX, sRequired - ALPHA_MIN))
  return { kind: 'ok', alpha: round2(alpha), beta: round2(beta) }
}

/**
 * 在 schema 允许的全参数范围内，模拟一条记忆最多能存活多少轮。
 * 实现方式：以最慢档 α=0.3, β=0.05 逐轮迭代累减，直到跌破 threshold。
 */
export function maxAchievableLifespan(
  importance: number,
  peakActivation: number,
  threshold: number
): number {
  if (importance >= 10) return Number.MAX_SAFE_INTEGER // 豁免永不衰减
  const I = Math.max(1, importance)
  const resistance = 1 / Math.sqrt(I)
  const alpha = ALPHA_MIN
  const beta = BETA_MIN

  let activation = peakActivation
  let turns = 0
  const maxIter = 200 // 安全上限
  while (activation >= threshold && turns < maxIter) {
    turns++
    const us = turns
    const ms = turns
    const decay = (alpha * us * us + beta * ms * ms) * resistance
    activation -= decay
  }
  return turns
}

/**
 * 建议值后处理：范围裁剪 + 取整 + 最小步长。
 * - 裁剪到 schema 范围
 * - 取 2 位小数
 * - 最小变更幅度：若 |suggested − current| < current×0.15，则放大到 15%
 */
export function normalizeSuggestion(param: string, current: number, raw: number): number | null {
  const range = PARAM_SCHEMA_RANGE[param]
  if (!range) return null

  // 裁剪到范围
  let suggested = Math.max(range.min, Math.min(range.max, raw))

  // 取 2 位小数
  suggested = round2(suggested)

  // 最小变更幅度 15%
  const minChange = Math.abs(current) * 0.15
  if (Math.abs(suggested - current) < minChange && suggested !== current) {
    // 放大到 15%
    const direction = suggested > current ? 1 : -1
    suggested = round2(current + direction * minChange)
    // 再次裁剪
    suggested = Math.max(range.min, Math.min(range.max, suggested))
  }

  return suggested
}

/**
 * 生成相互作用警告。
 * 规则（F5-002 §3.4）：若建议的变更与近 windowDays 天内某次已发生的变更**作用方向一致**
 * （同为 persist 或同为 volatile），产出一条警告。
 * P2（2026-08-10 审计）：修复前算 changeEffect 却忽略它，任何近期同参数变更都警告。
 */
export function detectInteractions(
  changes: ReadonlyArray<{ param: string; direction: 'increase' | 'decrease' }>,
  recentAnnotations: ReadonlyArray<{
    before: DmaeParamsSnapshot
    after: DmaeParamsSnapshot
    source: 'manual' | 'preset' | 'advice'
    ts: number
  }>,
  windowDays: number
): string[] {
  const warnings: string[] = []
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000

  for (const change of changes) {
    const dir = PARAM_EFFECT_DIRECTION[change.param]
    if (!dir) continue
    const changeEffect = effectFor(dir.increase, change.direction)

    for (const ann of recentAnnotations) {
      if (ann.ts < cutoff) continue
      const before = ann.before[change.param as keyof DmaeParamsSnapshot]
      const after = ann.after[change.param as keyof DmaeParamsSnapshot]
      if (typeof before !== 'number' || typeof after !== 'number' || before === after) continue
      const annDirection: 'increase' | 'decrease' = after > before ? 'increase' : 'decrease'
      const annEffect = effectFor(dir.increase, annDirection)
      if (annEffect !== changeEffect) continue // 作用方向不同 -> 不叠加，不警告
      const daysAgo = Math.max(0, Math.round((Date.now() - ann.ts) / (24 * 60 * 60 * 1000)))
      warnings.push(
        `你 ${daysAgo} 天前刚往「${dir.label}」的同一作用方向调过参数，现在再调可能效果叠加——建议这次改小一点，或者先观察几天。`
      )
      break
    }
  }

  return warnings
}

/** 把一次参数变更映射为作用方向（persist/volatile）。decrease 取 increase 的反向。 */
function effectFor(
  increaseEffect: 'persist' | 'volatile',
  direction: 'increase' | 'decrease'
): 'persist' | 'volatile' {
  if (direction === 'increase') return increaseEffect
  return increaseEffect === 'persist' ? 'volatile' : 'persist'
}

/** 创建建议引擎实例 */
export function createDmaeAdviceEngine(): DmaeAdviceEngine {
  return {
    solveDecayForLifespan,
    maxAchievableLifespan,
    normalizeSuggestion,
    detectInteractions
  }
}

/** 取 2 位小数 */
function round2(v: number): number {
  return Math.round(v * 100) / 100
}
