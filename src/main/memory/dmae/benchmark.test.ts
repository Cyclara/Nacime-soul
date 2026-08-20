// src/main/memory/dmae/benchmark.test.ts
// P2-34（2026-08-10 审计补）：M1~M6 基准体检计算。
import { describe, it, expect } from 'vitest'
import { runBenchmark, type BenchmarkInput } from './benchmark'
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

const NOW = Date.now()

function entry(
  id: string,
  over: Partial<BenchmarkInput['entries'][number]> = {}
): BenchmarkInput['entries'][number] {
  return {
    id,
    activation: 40,
    importance: 5,
    everActivated: true,
    createdAt: NOW - 3 * 86400_000, // 3 天前（> 1 天"新条目"阈值，确保计入 settled）
    ...over
  }
}

function turn(t: number, promptSelected: number, maxActive = 15): BenchmarkInput['turns'][number] {
  return {
    turn: t,
    ts: NOW,
    eligibleActive: 5,
    retrievalHits: 6,
    promptSelected,
    maxActive,
    userHits: 0,
    modelHits: 0,
    modelHitsGated: 0,
    modelRewardRawSum: 10,
    modelRewardEffectiveSum: 5,
    totalDecay: 3,
    floorRevivals: 0,
    trueFloorRevivals: 0,
    paramsHash: 'x',
    dormant: 2,
    archived: 3,
    l2Total: 20,
    activationSum: 800,
    activationCount: 20,
    activationMedian: 40,
    archivedTransitions: 0
  }
}

function sample(id: string, turn_: number, activation: number): BenchmarkInput['samples'][number] {
  return {
    memoryId: id,
    turn: turn_,
    ts: NOW,
    activation,
    userSilence: 0,
    modelSilence: 0,
    state: activation >= PARAMS.promptThreshold ? 'Active' : 'Dormant',
    userHit: false,
    modelHit: false,
    modelRewardEffective: 0,
    modelRewardRaw: 0,
    modelHitGated: false,
    decay: 0,
    everActivatedBefore: true,
    firstActivation: false,
    stateBefore: null,
    stateAfter: null,
    activationBefore: null,
    userSilenceBefore: null,
    modelSilenceBefore: null,
    paramsJson: null
  }
}

function base(over: Partial<BenchmarkInput> = {}): BenchmarkInput {
  return {
    windowDays: 30,
    params: PARAMS,
    now: NOW,
    entries: Array.from({ length: 20 }, (_, i) => entry(`m${i}`)),
    turns: [turn(0, 8), turn(1, 10), turn(2, 6)],
    samples: [
      sample('m0', 0, 40),
      sample('m0', 1, 50),
      sample('m0', 2, 20), // m0 存活：首 Active(t0) -> 非 Active(t2)
      sample('m1', 0, 40),
      sample('m1', 1, 45),
      sample('m1', 2, 22),
      sample('m2', 0, 40),
      sample('m2', 1, 35),
      sample('m2', 2, 15)
    ],
    previous: null,
    ...over
  }
}

describe('P2-34: runBenchmark M1~M6', () => {
  it('M1 占位率 = 平均 promptSelected/maxActive', () => {
    // promptSelected 8,10,6 / maxActive 15 -> (0.533 + 0.667 + 0.4)/3 = 0.533
    const r = runBenchmark(base())
    expect(r.metrics.activeUtilization).toBeCloseTo((8 + 10 + 6) / (3 * 15), 3)
    expect(r.verdicts.M1).toBe('healthy') // [0.4, 0.9]
  })

  it('M1 过低 -> low（占位率 <0.4）', () => {
    const r = runBenchmark(base({ turns: [turn(0, 2), turn(1, 1), turn(2, 1)] }))
    expect(r.metrics.activeUtilization).toBeLessThan(0.4)
    expect(r.verdicts.M1).toBe('low')
  })

  it('M4 复用率 = 激活≥2轮/激活≥1轮', () => {
    // 3 条记忆都有 ≥2 个 Active 采样 -> activatedTwice=3, activatedOnce=3 -> 1.0
    const r = runBenchmark(base())
    expect(r.metrics.reuseRate).toBe(1)
    expect(r.verdicts.M4).toBe('healthy')
  })

  it('M5 冷冻率排除近 1 天新条目', () => {
    // 20 条：5 条从未激活（settled，非新），5 条全新（createdAt=now）不算
    const entries = [
      ...Array.from({ length: 10 }, (_, i) => entry(`a${i}`)),
      ...Array.from({ length: 5 }, (_, i) => entry(`f${i}`, { everActivated: false })),
      ...Array.from({ length: 5 }, (_, i) =>
        entry(`new${i}`, { everActivated: false, createdAt: NOW })
      )
    ]
    const r = runBenchmark(base({ entries }))
    expect(r.metrics.frozenRate).toBeCloseTo(5 / 15, 3) // 排除 5 条新条目
    expect(r.verdicts.M5).toBe('high') // 0.33 > 0.25
  })

  it('M6 豁免占比 = importance≥10/总数', () => {
    const entries = [
      ...Array.from({ length: 16 }, (_, i) => entry(`a${i}`)),
      ...Array.from({ length: 4 }, (_, i) => entry(`x${i}`, { importance: 10 }))
    ]
    const r = runBenchmark(base({ entries }))
    expect(r.metrics.exemptRatio).toBeCloseTo(4 / 20, 3)
    expect(r.verdicts.M6).toBe('healthy') // [0.02, 0.20]
  })

  it('M2/M3 experimental：样本不足 -> experimental-insufficient；有数据 -> 报位置', () => {
    // 无采样 -> insufficient
    const none = runBenchmark(base({ samples: [] }))
    expect(none.verdicts.M2).toBe('experimental-insufficient')
    expect(none.verdicts.M3).toBe('experimental-insufficient')

    // 有采样：存活轮数 = 2（t0 Active -> t2 非 Active）-> 与可达区间比较
    const some = runBenchmark(base())
    expect(
      some.verdicts.M3 === 'at-floor' ||
        some.verdicts.M3 === 'mid' ||
        some.verdicts.M3 === 'at-ceiling'
    ).toBe(true)
    expect(some.achievableRange.lifespan.min).toBeGreaterThanOrEqual(1)
  })

  it('sufficientSample=false（条目<20）仍计算但标注不可信', () => {
    const r = runBenchmark(base({ entries: Array.from({ length: 5 }, (_, i) => entry(`m${i}`)) }))
    expect(r.sufficientSample).toBe(false)
    expect(typeof r.metrics.activeUtilization).toBe('number')
  })

  it('comparedTo：同参数指纹给 deltas，不同指纹为 null', () => {
    const first = runBenchmark(base())
    const same = runBenchmark(base({ previous: first }))
    expect(same.comparedTo).not.toBeNull()
    expect(same.comparedTo!.deltas.activeUtilization).toBeCloseTo(0, 5)

    const diffParams = runBenchmark(
      base({ previous: first, params: { ...PARAMS, decayAlpha: 0.8 } })
    )
    expect(diffParams.comparedTo).toBeNull()
  })
})
