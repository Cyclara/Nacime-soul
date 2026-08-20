// src/main/memory/dmae/advice.test.ts
// P2-34 建议引擎测试（2026-08-10 审计补：advice.ts 此前 7% 覆盖）。
// 核心回归：needs-combo 的 suggestedBu 必须真正 > currentBu（修复前恒等）。
import { describe, it, expect } from 'vitest'
import {
  solveDecayForLifespan,
  maxAchievableLifespan,
  normalizeSuggestion,
  detectInteractions
} from './advice'
import type { DmaeParamsSnapshot } from './history-types'

const PARAMS: DmaeParamsSnapshot = {
  maxScore: 100,
  promptThreshold: 30,
  userRewardBase: 20,
  wakeGamma: 0.5,
  modelRewardBase: 8,
  wakeLambda: 0.3,
  decayAlpha: 1.5,
  decayBeta: 0.3
}

describe('solveDecayForLifespan', () => {
  it('小目标（targetTurns=2）-> ok：decay 参数可解', () => {
    const r = solveDecayForLifespan({
      targetTurns: 2,
      medianImportance: 5,
      peakActivation: 50,
      threshold: 30,
      currentBeta: 0.3,
      currentUserRewardBase: 20
    })
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') {
      expect(r.alpha).toBeGreaterThan(0)
      expect(r.beta).toBe(0.3)
    }
  })

  it('P2 回归：needs-combo 的 suggestedBu 必须 > currentBu（修复前恒等）', () => {
    // T=8 使衰减参数单独不可达，但 Bu 拉满可达
    const r = solveDecayForLifespan({
      targetTurns: 8,
      medianImportance: 5,
      peakActivation: 50,
      threshold: 30,
      currentBeta: 0.3,
      currentUserRewardBase: 20
    })
    expect(r.kind).toBe('needs-combo')
    if (r.kind === 'needs-combo') {
      // 修复前：suggestedBu = 20 * (50/50) = 20 == currentBu（无效建议）
      expect(r.suggestedBu).toBeGreaterThan(20)
      // α/β 取最小档（Bu 抬到让最小衰减档恰好可达）
      expect(r.alpha).toBe(0.3)
      expect(r.beta).toBe(0.05)
    }
  })

  it('目标过大 -> unreachable：返回 maxTurns', () => {
    const r = solveDecayForLifespan({
      targetTurns: 50,
      medianImportance: 5,
      peakActivation: 50,
      threshold: 30,
      currentBeta: 0.3,
      currentUserRewardBase: 20
    })
    expect(r.kind).toBe('unreachable')
    if (r.kind === 'unreachable') {
      expect(r.maxTurns).toBeGreaterThan(0)
    }
  })

  it('importance>=10 豁免 -> maxAchievableLifespan 无限', () => {
    expect(maxAchievableLifespan(10, 50, 30)).toBe(Number.MAX_SAFE_INTEGER)
  })
})

describe('normalizeSuggestion', () => {
  it('范围裁剪 + 取整', () => {
    // decayAlpha 范围 [0.3, 2]
    expect(normalizeSuggestion('decayAlpha', 1.5, 5)).toBe(2) // 超上限 -> 2
    expect(normalizeSuggestion('decayAlpha', 1.5, 0.1)).toBe(0.3) // 超下限 -> 0.3
  })

  it('最小变更幅度 15%', () => {
    // current=1.5，raw=1.55：|Δ|=0.05 < 15%·1.5=0.225 -> 放大到 1.5+0.225=1.725 -> 1.73
    expect(normalizeSuggestion('decayAlpha', 1.5, 1.55)).toBe(1.73)
    // 已在范围上限的微调（raw>max）被 clamp 回 current -> 不放大（改不动）
    expect(normalizeSuggestion('decayAlpha', 2, 2.05)).toBe(2)
  })

  it('未知参数返回 null', () => {
    expect(normalizeSuggestion('nope', 1, 1)).toBeNull()
  })
})

describe('detectInteractions', () => {
  const now = Date.now()
  const ann = (
    param: keyof DmaeParamsSnapshot,
    from: number,
    to: number,
    daysAgo: number
  ): {
    before: DmaeParamsSnapshot
    after: DmaeParamsSnapshot
    source: 'manual' | 'preset' | 'advice'
    ts: number
  } => ({
    before: { ...PARAMS, [param]: from },
    after: { ...PARAMS, [param]: to },
    source: 'manual' as const,
    ts: now - daysAgo * 24 * 3600_000
  })

  it('同作用方向（同为 persist）-> 警告', () => {
    // decayAlpha 是 volatile：建议增大 decayAlpha 是 volatile；历史也增大 decayAlpha 是 volatile
    const warnings = detectInteractions(
      [{ param: 'decayAlpha', direction: 'increase' }],
      [ann('decayAlpha', 0.5, 0.8, 2)],
      7
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('叠加')
  })

  it('不同作用方向 -> 不警告', () => {
    // 建议增大 decayAlpha（volatile），历史是减小 decayAlpha（persist 反向）-> 不叠加
    const warnings = detectInteractions(
      [{ param: 'decayAlpha', direction: 'increase' }],
      [ann('decayAlpha', 0.8, 0.5, 2)], // 历史是减小
      7
    )
    expect(warnings).toHaveLength(0)
  })

  it('窗口外 -> 不警告', () => {
    const warnings = detectInteractions(
      [{ param: 'decayAlpha', direction: 'increase' }],
      [ann('decayAlpha', 0.5, 0.8, 30)], // 30 天前 > 7 天窗口
      7
    )
    expect(warnings).toHaveLength(0)
  })

  it('历史未动该参数 -> 不警告', () => {
    const warnings = detectInteractions(
      [{ param: 'decayAlpha', direction: 'increase' }],
      [ann('wakeGamma', 0.3, 0.4, 1)], // 动的是别的参数
      7
    )
    expect(warnings).toHaveLength(0)
  })
})
