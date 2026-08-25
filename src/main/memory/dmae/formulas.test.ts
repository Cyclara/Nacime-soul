// src/main/memory/dmae/formulas.test.ts
// P2-22 / D-01 / D-02 / D-04：DMAE 纯公式 100% branch。
// 表驱动断言固定样例数值（S-004 §3.3 红线：公式模块 100% branch）。
//
// 默认参数（与 config/defaults.ts 一致）：Bu=20, γ=0.5, Bm=8, λ=0.3, α=1.5, β=0.3,
//   maxScore=100, promptThreshold=30。
// 公式来源：Cyrene-Agent worldbook.ts v4.0（经审计确认）。

import { describe, it, expect } from 'vitest'
import {
  computeUserReward,
  computeModelReward,
  computeDecay,
  deriveState,
  floorValue,
  clampActivation,
  dmaeParamsFromConfig,
  IMPORTANCE_EXEMPT_THRESHOLD,
  MIN_IMPORTANCE,
  RM_CLAMP_EPSILON,
  type DmaeParams
} from './formulas'
import type { MemoryConfig } from '@shared/config/types'

/** 默认 DMAE 参数（与 DEFAULT_CONFIG_V1.memory.dmae 一致） */
const P: DmaeParams = {
  maxScore: 100,
  promptThreshold: 30,
  userRewardBase: 20,
  wakeGamma: 0.5,
  modelRewardBase: 8,
  wakeLambda: 0.3,
  decayAlpha: 1.5,
  decayBeta: 0.3
}

function makeMemoryConfig(overrides: Partial<MemoryConfig['dmae']> = {}): MemoryConfig {
  return {
    enabled: true,
    embeddingProvider: '',
    embeddingModel: '',
    embeddingDimension: 1024,
    maxActive: 15,
    minRetrievalScore: 0.35,
    attributionGate: { provider: '', model: '', baseUrl: '' },
    dmae: { ...P, ...overrides }
  } as MemoryConfig
}

// === D-01: Ru/Rm/Decay 公式固定样例 ===

describe('D-01 computeUserReward: Ru = Bu×(1+γ·ln(1+U))', () => {
  // U=0,1,10 的精确值
  const cases: Array<{ U: number; expected: number }> = [
    { U: 0, expected: 20 }, // 20×(1+0.5×ln1) = 20×1 = 20
    { U: 1, expected: 20 * (1 + 0.5 * Math.log(2)) }, // ≈26.9315
    { U: 10, expected: 20 * (1 + 0.5 * Math.log(11)) } // ≈43.9790
  ]
  for (const { U, expected } of cases) {
    it(`U=${U} -> ${expected.toFixed(4)}`, () => {
      expect(computeUserReward(U, P)).toBeCloseTo(expected, 10)
    })
  }
  it('连续命中 U=0 给基础奖励 Bu=20', () => {
    expect(computeUserReward(0, P)).toBe(20)
  })
  it('久别重逢：U 越大奖励越大（单调递增）', () => {
    const r0 = computeUserReward(0, P)
    const r1 = computeUserReward(1, P)
    const r10 = computeUserReward(10, P)
    expect(r0).toBeLessThan(r1)
    expect(r1).toBeLessThan(r10)
  })
})

describe('D-01 computeModelReward: Rm = Bm×e^(−λ·U)', () => {
  const cases: Array<{ U: number; expected: number }> = [
    { U: 0, expected: 8 }, // 8×e^0 = 8
    { U: 1, expected: 8 * Math.exp(-0.3) }, // ≈5.9265
    { U: 10, expected: 8 * Math.exp(-3) } // ≈0.3983
  ]
  for (const { U, expected } of cases) {
    it(`U=${U} -> ${expected.toFixed(4)}`, () => {
      expect(computeModelReward(U, P)).toBeCloseTo(expected, 10)
    })
  }
  it('U=0 给最大 Bm=8', () => {
    expect(computeModelReward(0, P)).toBe(8)
  })
  it('指数衰减：U 越大 Rm 越小（单调递减，防模型霸占）', () => {
    const r0 = computeModelReward(0, P)
    const r1 = computeModelReward(1, P)
    const r10 = computeModelReward(10, P)
    expect(r0).toBeGreaterThan(r1)
    expect(r1).toBeGreaterThan(r10)
  })
  it('U->∞ 时 Rm->0', () => {
    expect(computeModelReward(100, P)).toBeLessThan(0.001)
  })
})

describe('D-01 computeDecay: √I 分母对 I=1/4/9 的衰减比', () => {
  // usNew=1, msNew=0 简化：Decay = α·1²/√I = 1.5/√I
  it('I=1 -> 1.5/√1 = 1.5', () => {
    expect(computeDecay(1, 0, 1, P)).toBeCloseTo(1.5, 10)
  })
  it('I=4 -> 1.5/√4 = 0.75', () => {
    expect(computeDecay(1, 0, 4, P)).toBeCloseTo(0.75, 10)
  })
  it('I=9 -> 1.5/√9 = 0.5', () => {
    expect(computeDecay(1, 0, 9, P)).toBeCloseTo(0.5, 10)
  })
  it('衰减比 I=1:4:9 = 6:3:2', () => {
    const d1 = computeDecay(1, 0, 1, P)
    const d4 = computeDecay(1, 0, 4, P)
    const d9 = computeDecay(1, 0, 9, P)
    // 1.5 : 0.75 : 0.5 = 6 : 3 : 2
    expect(d1 / d4).toBeCloseTo(2, 10) // 1.5/0.75 = 2
    expect(d4 / d9).toBeCloseTo(1.5, 10) // 0.75/0.5 = 1.5
    expect(d1 / d9).toBeCloseTo(3, 10) // 1.5/0.5 = 3
  })
  it('高 I 忘得更慢：I=9 衰减 < I=1 衰减', () => {
    expect(computeDecay(2, 3, 9, P)).toBeLessThan(computeDecay(2, 3, 1, P))
  })
  it('平方累积：usNew=2 比 usNew=1 衰减多 4 倍（α 项）', () => {
    const d1 = computeDecay(1, 0, 1, P) // 1.5×1=1.5
    const d2 = computeDecay(2, 0, 1, P) // 1.5×4=6.0
    expect(d2 / d1).toBeCloseTo(4, 10)
  })
  it('msNew 贡献：usNew=0,msNew=2,I=1 -> β×4=1.2', () => {
    expect(computeDecay(0, 2, 1, P)).toBeCloseTo(0.3 * 4, 10) // 1.2
  })
  it('混合：usNew=2,msNew=3,I=5 -> (1.5×4+0.3×9)/√5', () => {
    const expected = (1.5 * 4 + 0.3 * 9) / Math.sqrt(5)
    expect(computeDecay(2, 3, 5, P)).toBeCloseTo(expected, 10)
  })
})

// === D-04: importance=10 硬豁免 ===

describe('D-04 importance≥10 硬豁免 Decay', () => {
  it('importance=10 -> Decay=0（永不衰减）', () => {
    expect(computeDecay(5, 5, 10, P)).toBe(0)
  })
  it('importance>10 -> Decay=0', () => {
    expect(computeDecay(100, 100, 99, P)).toBe(0)
  })
  it('importance=9 仍衰减（边界：9<10 不豁免）', () => {
    expect(computeDecay(1, 0, 9, P)).toBeCloseTo(0.5, 10) // 1.5/√9=0.5
  })
  it('豁免阈值常量 = 10', () => {
    expect(IMPORTANCE_EXEMPT_THRESHOLD).toBe(10)
  })
  it('双保险：I=10 硬豁免=0，I=9 软豁免=0.5（√I 项仍衰减）', () => {
    expect(computeDecay(1, 0, 10, P)).toBe(0)
    expect(computeDecay(1, 0, 9, P)).toBeGreaterThan(0)
  })
})

// === D-02: deriveState 三态边界 ===

describe('D-02 deriveState 三态边界', () => {
  // threshold=30
  it('activation≤0 -> Archived', () => {
    expect(deriveState(0, 30)).toBe('Archived')
    expect(deriveState(-0.001, 30)).toBe('Archived')
    expect(deriveState(-100, 30)).toBe('Archived')
  })
  it('activation≥threshold -> Active', () => {
    expect(deriveState(30, 30)).toBe('Active') // 边界=Active
    expect(deriveState(100, 30)).toBe('Active')
    expect(deriveState(30.001, 30)).toBe('Active')
  })
  it('(0,threshold) -> Dormant', () => {
    expect(deriveState(0.001, 30)).toBe('Dormant')
    expect(deriveState(15, 30)).toBe('Dormant')
    expect(deriveState(29.999, 30)).toBe('Dormant')
  })
  it('activation=0 是 Archived（≤0 包含 0）', () => {
    expect(deriveState(0, 30)).toBe('Archived')
  })
  it('activation=threshold 是 Active（≥threshold 包含 threshold）', () => {
    expect(deriveState(30, 30)).toBe('Active')
  })
})

// === 辅助函数 ===

describe('floorValue', () => {
  it('返回 importance（Cyrene-Agent intrinsicValue 语义）', () => {
    expect(floorValue(5)).toBe(5)
    expect(floorValue(10)).toBe(10)
    expect(floorValue(1)).toBe(1)
  })
})

describe('clampActivation', () => {
  it('低于 0 钳到 0', () => {
    expect(clampActivation(-5, 100)).toBe(0)
    expect(clampActivation(-0.001, 100)).toBe(0)
  })
  it('高于 maxScore 钳到 maxScore', () => {
    expect(clampActivation(150, 100)).toBe(100)
    expect(clampActivation(100.001, 100)).toBe(100)
  })
  it('正常范围原样返回', () => {
    expect(clampActivation(50, 100)).toBe(50)
    expect(clampActivation(0, 100)).toBe(0)
    expect(clampActivation(100, 100)).toBe(100)
  })
})

// === 参数映射 ===

describe('dmaeParamsFromConfig', () => {
  it('从 MemoryConfig 提取 DMAE 参数', () => {
    const cfg = makeMemoryConfig()
    const params = dmaeParamsFromConfig(cfg)
    expect(params).toEqual(P)
  })
  it('自定义参数正确映射', () => {
    const cfg = makeMemoryConfig({ userRewardBase: 30, wakeGamma: 0.8 })
    const params = dmaeParamsFromConfig(cfg)
    expect(params.userRewardBase).toBe(30)
    expect(params.wakeGamma).toBe(0.8)
    expect(params.maxScore).toBe(100) // 未覆盖的保持默认
  })
})

// === 常量导出 ===

describe('常量', () => {
  it('MIN_IMPORTANCE=1（√I 除零保护）', () => {
    expect(MIN_IMPORTANCE).toBe(1)
  })
  it('RM_CLAMP_EPSILON=0.01（Rm<D 不变量）', () => {
    expect(RM_CLAMP_EPSILON).toBe(0.01)
  })
  it('importance<MIN_IMPORTANCE 时用 MIN_IMPORTANCE 兜底（除零保护分支）', () => {
    // importance=0.5 -> max(1, 0.5)=1 -> 等价于 I=1
    expect(computeDecay(1, 0, 0.5, P)).toBeCloseTo(computeDecay(1, 0, 1, P), 10)
  })
  it('importance=0 不爆（除零保护）', () => {
    expect(() => computeDecay(1, 0, 0, P)).not.toThrow()
    expect(computeDecay(1, 0, 0, P)).toBeCloseTo(1.5, 10) // 等价 I=1
  })
  it('负 importance 也兜底到 MIN_IMPORTANCE', () => {
    expect(computeDecay(1, 0, -5, P)).toBeCloseTo(1.5, 10)
  })
})
