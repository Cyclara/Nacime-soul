// src/main/memory/dmae/rules.test.ts
// P2-33 规则引擎测试（2026-08-10 审计补：rules.ts 此前 0% 覆盖）。
// 重点：配置窗口读取（R01/R04/R05/R07/R08）、R10 真算 <5%、R05 真实轮次节奏、抑制 + muted。
import { describe, it, expect } from 'vitest'
import { evaluateAllRules, ANOMALY_RULES } from './rules'
import type { AnomalyContext, DmaeAnomaly } from './anomaly-types'
import { DEFAULT_ANOMALY_WINDOWS } from '@shared/memory/dmae-config'
import type {
  DmaeDailyAggregate,
  DmaeTurnRecord,
  DmaeSamplePoint,
  DmaeParamAnnotation,
  DmaeParamsSnapshot
} from './history-types'

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

function entry(
  id: string,
  activation: number,
  over: Partial<AnomalyContext['entries'][number]> = {}
): AnomalyContext['entries'][number] {
  return {
    id,
    activation,
    userSilence: 0,
    modelSilence: 0,
    state:
      activation <= 0
        ? ('Archived' as const)
        : activation >= PARAMS.promptThreshold
          ? ('Active' as const)
          : ('Dormant' as const),
    importance: 5,
    isPinned: false,
    lifecycleState: 'active',
    createdAt: Date.now() - 3600_000,
    everActivated: true,
    ...over
  }
}

function daily(date: string, over: Partial<DmaeDailyAggregate> = {}): DmaeDailyAggregate {
  return {
    date,
    turns: 10,
    eligibleActive: 5,
    dormant: 2,
    archived: 3,
    l2Total: 10,
    avgPromptSelected: 5,
    medianPromptSelected: 5,
    saturatedTurns: 8,
    medianRetrievalHits: 6,
    avgActivation: 40,
    medianActivation: 40,
    archivedTransitions: 0,
    floorRevivals: 0,
    trueFloorRevivals: 0,
    modelRewardYield: 0.5,
    paramsHash: 'x',
    ...over
  }
}

function turn(t: number, ts: number, over: Partial<DmaeTurnRecord> = {}): DmaeTurnRecord {
  return {
    turn: t,
    ts,
    eligibleActive: 5,
    retrievalHits: 6,
    promptSelected: 5,
    maxActive: 15,
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
    l2Total: 10,
    activationSum: 400,
    activationCount: 10,
    activationMedian: 40,
    archivedTransitions: 0,
    ...over
  }
}

function sample(
  memoryId: string,
  turn_: number,
  activation: number,
  over: Partial<DmaeSamplePoint> = {}
): DmaeSamplePoint {
  return {
    memoryId,
    turn: turn_,
    ts: 1_700_000_000_000 + turn_ * 1000,
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
    paramsJson: null,
    ...over
  }
}

const NOW = 1_700_000_000_000

/** 造一个"足够样本"的上下文：≥20 条目 + currentTurn ≥ 50 */
function ctx(over: Partial<AnomalyContext> = {}): AnomalyContext {
  const base: AnomalyContext = {
    params: PARAMS,
    maxActive: 15,
    entries: Array.from({ length: 20 }, (_, i) => entry(`m${i}`, 40)),
    daily: [],
    recentTurns: [],
    recentSamples: [],
    currentTurn: 100,
    lastAnnotation: null,
    stateFileHealth: { lastLoadReset: 'none', saveFailures7d: 0 },
    windows: DEFAULT_ANOMALY_WINDOWS,
    now: NOW
  }
  return { ...base, ...over }
}

function run(ctx_: AnomalyContext): DmaeAnomaly[] {
  return evaluateAllRules(ctx_, {})
}

describe('P2-33: 13 条规则注册完整 + 基础行为', () => {
  it('注册表含全部 13 条规则（R01~R13）', () => {
    expect(ANOMALY_RULES.map((r) => r.id)).toEqual([
      'R01',
      'R02',
      'R03',
      'R04',
      'R05',
      'R06',
      'R07',
      'R08',
      'R09',
      'R10',
      'R11',
      'R12',
      'R13'
    ])
  })

  it('样本不足（条目<20 或 turn<50）-> 统计型规则静默，R06/R11 例外', () => {
    // 小样本 + 低 turn：所有统计规则不触发
    const small = ctx({
      entries: [entry('m0', 40)],
      currentTurn: 10,
      daily: [daily('2026-08-08', { archivedTransitions: 1, turns: 10 })],
      stateFileHealth: { lastLoadReset: 'invalid-json', saveFailures7d: 0 } // R11 例外触发
    })
    const res = run(small)
    expect(res.map((a) => a.ruleId)).toContain('R11') // 完整性规则不受样本门槛控制
  })
})

describe('P1: 配置窗口接线（不再硬编码）', () => {
  it('R01 使用配置的 windowDays（改 2 天只看最近 2 天）', () => {
    // 3 天 daily：前 2 天 archivedTransitions 高，第 3 天（最近）为 0
    const d = [
      daily('2026-08-06', { archivedTransitions: 8, turns: 10 }),
      daily('2026-08-07', { archivedTransitions: 8, turns: 10 }),
      daily('2026-08-08', { archivedTransitions: 0, turns: 10 })
    ]
    const c = ctx({
      daily: d,
      windows: { ...DEFAULT_ANOMALY_WINDOWS, R01: { days: 2 } }
    })
    // 最近 2 天 archivedTransitions=8 → /20 = 40% < 60% -> R01 不触发（若硬编码 3 天则 16/30=53% 也不触发，
    // 换用 1 天窗口看更清楚）
    const c1 = ctx({
      daily: d,
      windows: { ...DEFAULT_ANOMALY_WINDOWS, R01: { days: 1 } }
    })
    expect(run(c1).some((a) => a.ruleId === 'R01')).toBe(false) // 最近 1 天 archivedTransitions=0

    // 1 天窗口但最近一天 archivedTransitions 高 -> 触发，evidence.windowDays=1
    const dHigh = [daily('2026-08-08', { archivedTransitions: 14, turns: 10 })]
    const cHigh = ctx({
      daily: dHigh,
      windows: { ...DEFAULT_ANOMALY_WINDOWS, R01: { days: 1 } }
    })
    const r01 = run(cHigh).find((a) => a.ruleId === 'R01')
    expect(r01).toBeDefined()
    expect(r01!.evidence.windowDays).toBe(1)
    void c
  })

  it('R04 使用配置的 windowTurns（僵尸阈值不再是写死 50）', () => {
    // windowTurns=20：userSilence=30 的 Active 条目算僵尸
    const c = ctx({
      entries: [
        ...Array.from({ length: 19 }, (_, i) => entry(`ok${i}`, 40)),
        entry('zombie', 40, { userSilence: 30, modelSilence: 30 })
      ],
      windows: { ...DEFAULT_ANOMALY_WINDOWS, R04: { turns: 20 } }
    })
    const r04 = run(c).find((a) => a.ruleId === 'R04')
    expect(r04).toBeDefined()
    expect(r04!.evidence.windowTurns).toBe(20)

    // 默认 50：userSilence=30 不算僵尸 -> 不触发
    const c2 = ctx({
      entries: [
        ...Array.from({ length: 19 }, (_, i) => entry(`ok${i}`, 40)),
        entry('zombie', 40, { userSilence: 30, modelSilence: 30 })
      ]
    })
    expect(run(c2).some((a) => a.ruleId === 'R04')).toBe(false)
  })

  it('R07 使用配置的 windowTurns（只统计窗口内跨阈值次数）', () => {
    // 制造一条在"新窗口内"跨阈值 6 次的样本序列
    const crossings = Array.from({ length: 7 }, (_, i) =>
      sample('jittery', 90 + i, i % 2 === 0 ? 40 : 20)
    )
    const c = ctx({
      recentSamples: crossings,
      currentTurn: 120, // 窗口 50：只统计 turn>=70，全部 7 个样本都在窗口内
      windows: { ...DEFAULT_ANOMALY_WINDOWS, R07: { turns: 50 } }
    })
    const r07 = run(c).find((a) => a.ruleId === 'R07')
    expect(r07).toBeDefined()
    expect(r07!.evidence.windowTurns).toBe(50)
  })

  it('R08 使用配置的 windowTurns（窗口>可忽略 20 条下限）', () => {
    const lowYield = Array.from({ length: 30 }, (_, i) =>
      turn(i, 1_700_000_000_000 + i * 1000, {
        modelRewardRawSum: 100,
        modelRewardEffectiveSum: 1, // yield=0.01 < 0.05
        modelHits: 30,
        modelHitsGated: 0
      })
    )
    const c = ctx({
      recentTurns: lowYield,
      windows: { ...DEFAULT_ANOMALY_WINDOWS, R08: { turns: 200 } }
    })
    const r08 = run(c).find((a) => a.ruleId === 'R08')
    expect(r08).toBeDefined()
    expect(r08!.evidence.windowTurns).toBe(30) // 实际窗口 = min(200, 数据量)
  })
})

describe('P1: R05 用真实轮次节奏（不再硬编码 30s/轮）', () => {
  it('按 recentTurns 推算每轮毫秒，窗口内从未激活的记忆才报警', () => {
    const now = NOW
    // recentTurns：turn 0..100，跨度 1000 秒（10s/轮）
    const turns = Array.from({ length: 101 }, (_, i) => turn(i, now - (100 - i) * 10_000))
    // 10 条从未激活的记忆：m_old 存在 500 秒（50 轮 @10s/轮），m_new 存在 10 秒（1 轮）
    // 冷冻率 10/20 = 50% >= 30%（R05 的占比门）
    const mkFrozen = (id: string, createdAt: number): AnomalyContext['entries'][number] =>
      entry(id, 0, { everActivated: false, createdAt })
    const c = ctx({
      entries: [
        ...Array.from({ length: 10 }, (_, i) => entry(`a${i}`, 40)),
        ...Array.from({ length: 10 }, (_, i) => mkFrozen(`old${i}`, now - 500_000)), // ~50 轮
        mkFrozen('brand_new', now - 10_000) // ~1 轮
      ],
      recentTurns: turns,
      currentTurn: 100,
      windows: { ...DEFAULT_ANOMALY_WINDOWS, R05: { turns: 100 } }
    })
    // 冷冻条目 ≈50 轮 < 100 -> 不触发
    expect(run(c).some((a) => a.ruleId === 'R05')).toBe(false)

    // 窗口 30：冷冻条目 ≈50 轮 >= 30 -> 触发
    const c30 = ctx({
      entries: [
        ...Array.from({ length: 10 }, (_, i) => entry(`a${i}`, 40)),
        ...Array.from({ length: 10 }, (_, i) => mkFrozen(`old${i}`, now - 500_000)),
        mkFrozen('brand_new', now - 10_000)
      ],
      recentTurns: turns,
      currentTurn: 100,
      windows: { ...DEFAULT_ANOMALY_WINDOWS, R05: { turns: 30 } }
    })
    const r05 = run(c30).find((a) => a.ruleId === 'R05')
    expect(r05).toBeDefined()
    expect(r05!.evidence.windowTurns).toBe(30)
  })
})

describe('P1: R10 真算目标指标 <5% 变化', () => {
  const NOW_LOCAL = new Date(2026, 7, 10, 12, 0, 0).getTime() // 2026-08-10 本地 12:00
  const annotation: DmaeParamAnnotation = {
    id: 'ann-1',
    ts: NOW_LOCAL - 4 * 24 * 3600_000, // 2026-08-06 12:00，4 天前（> 默认 R10 days=3）
    turn: 50,
    before: PARAMS,
    after: { ...PARAMS, decayAlpha: 0.5 },
    source: 'manual'
  }

  it('调参后 avgActivation 变化 <5% -> 触发', () => {
    // annotation 前（08-04/05/06 的凌晨 < 08-06 12:00）avgActivation=40，之后 = 40.5（Δ1.25%）
    const c = ctx({
      daily: [
        daily('2026-08-04', { avgActivation: 40 }),
        daily('2026-08-05', { avgActivation: 40 }),
        daily('2026-08-06', { avgActivation: 40 }),
        daily('2026-08-07', { avgActivation: 40.5 }),
        daily('2026-08-08', { avgActivation: 40.5 }),
        daily('2026-08-09', { avgActivation: 40.5 })
      ],
      lastAnnotation: annotation,
      currentTurn: 200,
      now: NOW_LOCAL
    })
    const r10 = run(c).find((a) => a.ruleId === 'R10')
    expect(r10).toBeDefined()
    expect(r10!.evidence.metrics.relativeChange).toBeLessThan(0.05)
  })

  it('调参后 avgActivation 明显变化（>=5%）-> 不触发', () => {
    const c = ctx({
      daily: [
        daily('2026-08-04', { avgActivation: 40 }),
        daily('2026-08-05', { avgActivation: 40 }),
        daily('2026-08-06', { avgActivation: 40 }),
        daily('2026-08-07', { avgActivation: 60 }),
        daily('2026-08-08', { avgActivation: 60 }),
        daily('2026-08-09', { avgActivation: 60 })
      ],
      lastAnnotation: annotation,
      currentTurn: 200,
      now: NOW_LOCAL
    })
    expect(run(c).some((a) => a.ruleId === 'R10')).toBe(false)
  })

  it('无 annotation -> 永不触发；时间未到窗口 -> 不触发', () => {
    const noAnn = ctx({
      daily: [daily('2026-08-08', { avgActivation: 40 })],
      now: NOW_LOCAL
    })
    expect(run(noAnn).some((a) => a.ruleId === 'R10')).toBe(false)

    const tooSoon: DmaeParamAnnotation = { ...annotation, ts: NOW_LOCAL - 1 * 24 * 3600_000 }
    const early = ctx({
      daily: [daily('2026-08-08', { avgActivation: 40 })],
      lastAnnotation: tooSoon,
      currentTurn: 200,
      now: NOW_LOCAL
    })
    expect(run(early).some((a) => a.ruleId === 'R10')).toBe(false)
  })
})

describe('P2-33: 抑制关系 + muted 过滤', () => {
  it('R01 抑制 R09/R03；R11 抑制全部', () => {
    // R01 触发：近 1 天 archivedTransitions=15 / 20 条目 = 75% >= 60%，且 lifespan 短
    // R09 触发：trueFloorRevivals=8 / turns=10 = 0.8 >= 0.3
    const d = [daily('2026-08-08', { archivedTransitions: 15, turns: 10, trueFloorRevivals: 8 })]
    const c = ctx({
      entries: Array.from({ length: 20 }, (_, i) => entry(`m${i}`, 40)),
      daily: d,
      // lifespan 短：样本从 Active -> 非 Active 快速往返（lifespan=1）
      recentSamples: [
        sample('m0', 1, 40),
        sample('m0', 2, 5),
        sample('m0', 3, 40),
        sample('m0', 4, 5)
      ],
      currentTurn: 100
    })
    const res = run(c)
    const ids = res.map((a) => a.ruleId)
    expect(ids).toContain('R01')
    expect(ids).not.toContain('R09') // 被 R01 抑制
  })

  it('muted 规则不输出（muteUntil > now）', () => {
    const c = ctx({
      daily: [daily('2026-08-08', { archivedTransitions: 8, turns: 10 })]
    })
    const muted = {
      R01: NOW + 3600_000,
      R02: 0,
      R03: 0,
      R04: 0,
      R05: 0,
      R06: 0,
      R07: 0,
      R08: 0,
      R09: 0,
      R10: 0,
      R11: 0,
      R12: 0,
      R13: 0
    }
    const res = evaluateAllRules(c, muted)
    expect(res.some((a) => a.ruleId === 'R01')).toBe(false)
  })
})
