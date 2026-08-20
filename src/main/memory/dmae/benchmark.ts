// src/main/memory/dmae/benchmark.ts
// P2-34（2026-08-10 审计补）：DMAE 参数基准体检——M1~M6 定量指标计算。
// 依据：F5-002 §3.6 + benchmark-types.ts（DmaeBenchmarkReport / HEALTHY_RANGES）。
//
// 判定原则：
//   - M1/M4/M5/M6 用绝对健康区间（benchmark-types.HEALTHY_RANGES）
//   - M2/M3 标 experimental：用 maxAchievableLifespan 类模拟器现算可达区间，
//     只报位置（at-floor/mid/at-ceiling），不给绝对健康/不健康
//   - sufficientSample=false 时 metrics 仍算但面板标注不可信
//
// 本模块纯函数、无 IO，可单测（P2-34 验收）。

import type { DmaeParamsSnapshot } from './history-types'
import type { DmaeTurnRecord, DmaeSamplePoint } from './history-types'
import { type DmaeBenchmarkReport, HEALTHY_RANGES } from './benchmark-types'

export interface BenchmarkEntry {
  id: string
  activation: number
  importance: number
  everActivated: boolean
  createdAt: number
}

export interface BenchmarkInput {
  windowDays: 7 | 30 | 90
  params: DmaeParamsSnapshot
  now: number
  entries: ReadonlyArray<BenchmarkEntry>
  turns: ReadonlyArray<DmaeTurnRecord>
  samples: ReadonlyArray<DmaeSamplePoint>
  previous: DmaeBenchmarkReport | null
}

/** 计算参数指纹（与 history-types 一致，供 comparedTo 判定） */
function paramsHash(p: DmaeParamsSnapshot): string {
  const json = JSON.stringify([
    p.maxScore,
    p.promptThreshold,
    p.userRewardBase,
    p.wakeGamma,
    p.modelRewardBase,
    p.wakeLambda,
    p.decayAlpha,
    p.decayBeta
  ])
  let hash = 0
  for (let i = 0; i < json.length; i++) {
    const ch = json.charCodeAt(i)
    hash = ((hash << 5) - hash + ch) | 0
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function runBenchmark(input: BenchmarkInput): DmaeBenchmarkReport {
  const { windowDays, params, now, entries, turns, samples, previous } = input
  const sufficientSample = entries.length >= 20 && turns.length >= 3

  // ─ M1：Prompt 占位率 = 平均 promptSelected/maxActive ─
  const utilizations = turns
    .filter((t) => t.maxActive > 0)
    .map((t) => t.promptSelected / t.maxActive)
  const activeUtilization = utilizations.length > 0 ? avg(utilizations) : 0

  // ─ M4：复用率 = 激活≥2 轮 / 激活≥1 轮（按采样点里 activation>0 的轮数） ─
  const activeTurnCounts = new Map<string, number>()
  for (const s of samples) {
    if (s.activation <= 0) continue
    activeTurnCounts.set(s.memoryId, (activeTurnCounts.get(s.memoryId) ?? 0) + 1)
  }
  const counts = [...activeTurnCounts.values()]
  const activatedOnce = counts.length
  const activatedTwice = counts.filter((c) => c >= 2).length
  const reuseRate = activatedOnce > 0 ? activatedTwice / activatedOnce : 0

  // ─ M5：冷冻率 = 从未激活 / 总数（排除近 1 天新条目） ─
  const settled = entries.filter((e) => now - e.createdAt > 24 * 3600_000)
  const frozen = settled.filter((e) => !e.everActivated).length
  const frozenRate = settled.length > 0 ? frozen / settled.length : 0

  // ─ M6：豁免占比 = importance≥10 / 总数 ─
  const exempt = entries.filter((e) => e.importance >= 10).length
  const exemptRatio = entries.length > 0 ? exempt / entries.length : 0

  // ─ M2/M3（experimental）：从采样点算半衰/存活 ─
  const byMemory = groupSamplesByMemory(samples)
  const halfLives = computeHalfLives(byMemory)
  const lifespans = computeLifespans(byMemory)
  const halfLifeTurns = halfLives.length > 0 ? median(halfLives) : 0
  const medianLifespanTurns = lifespans.length > 0 ? median(lifespans) : 0
  const experimentalInsufficient = halfLives.length < 2 && lifespans.length < 2

  // ─ 可达区间（模拟器） ─
  const importances = entries.map((e) => e.importance)
  const peaks = [...byMemory.entries()].map(([, arr]) =>
    Math.max(...arr.map((s) => s.activation), 0)
  )
  const medianImportance = median(importances)
  const medianPeakActivation = peaks.length > 0 ? median(peaks) : 0
  const achievableRange = {
    medianImportance,
    medianPeakActivation,
    halfLife: {
      min: simulateHalfLife(DECAY_SUM_MAX, medianImportance, medianPeakActivation),
      max: simulateHalfLife(DECAY_SUM_MIN, medianImportance, medianPeakActivation)
    },
    lifespan: {
      min: simulateLifespan(
        DECAY_SUM_MAX,
        medianImportance,
        medianPeakActivation,
        params.promptThreshold
      ),
      max: simulateLifespan(
        DECAY_SUM_MIN,
        medianImportance,
        medianPeakActivation,
        params.promptThreshold
      )
    }
  }

  return {
    generatedAt: now,
    windowDays,
    paramsHash: paramsHash(params),
    params,
    sufficientSample,
    metrics: {
      activeUtilization,
      halfLifeTurns,
      medianLifespanTurns,
      reuseRate,
      frozenRate,
      exemptRatio
    },
    verdicts: {
      M1: verdictInRange(activeUtilization, HEALTHY_RANGES.M1),
      M2: experimentalVerdict(halfLifeTurns, achievableRange.halfLife, experimentalInsufficient),
      M3: experimentalVerdict(
        medianLifespanTurns,
        achievableRange.lifespan,
        experimentalInsufficient
      ),
      M4: verdictInRange(reuseRate, HEALTHY_RANGES.M4),
      M5: verdictInRange(frozenRate, HEALTHY_RANGES.M5),
      M6: verdictInRange(exemptRatio, HEALTHY_RANGES.M6)
    },
    achievableRange,
    comparedTo:
      previous && previous.paramsHash === paramsHash(params)
        ? {
            paramsHash: previous.paramsHash,
            deltas: {
              activeUtilization: activeUtilization - previous.metrics.activeUtilization,
              halfLifeTurns: halfLifeTurns - previous.metrics.halfLifeTurns,
              medianLifespanTurns: medianLifespanTurns - previous.metrics.medianLifespanTurns,
              reuseRate: reuseRate - previous.metrics.reuseRate,
              frozenRate: frozenRate - previous.metrics.frozenRate,
              exemptRatio: exemptRatio - previous.metrics.exemptRatio
            }
          }
        : null
  }
}

// === M2/M3 采样轨迹计算 ===

function groupSamplesByMemory(
  samples: ReadonlyArray<DmaeSamplePoint>
): Map<string, DmaeSamplePoint[]> {
  const m = new Map<string, DmaeSamplePoint[]>()
  for (const s of samples) {
    const arr = m.get(s.memoryId) ?? []
    arr.push(s)
    m.set(s.memoryId, arr)
  }
  for (const arr of m.values()) arr.sort((a, b) => a.turn - b.turn)
  return m
}

/** 每条记忆的半衰（达到峰值后衰减到峰值一半所需的轮数） */
function computeHalfLives(byMemory: Map<string, DmaeSamplePoint[]>): number[] {
  const out: number[] = []
  for (const arr of byMemory.values()) {
    if (arr.length < 2) continue
    let peakTurn = arr[0].turn
    let peak = arr[0].activation
    for (const s of arr) {
      if (s.activation > peak) {
        peak = s.activation
        peakTurn = s.turn
      }
    }
    if (peak <= 1) continue
    const halfTarget = Math.max(peak / 2, 1)
    const after = arr.filter((s) => s.turn > peakTurn)
    const crossing = after.find((s) => s.activation <= halfTarget)
    if (crossing) out.push(Math.max(1, crossing.turn - peakTurn))
  }
  return out
}

/** 每条记忆的存活轮数（首次 Active -> 跌出 Active） */
function computeLifespans(byMemory: Map<string, DmaeSamplePoint[]>): number[] {
  const out: number[] = []
  for (const arr of byMemory.values()) {
    let firstActive: number | null = null
    for (const s of arr) {
      if (s.state === 'Active' && firstActive === null) firstActive = s.turn
      else if (s.state !== 'Active' && firstActive !== null) {
        out.push(s.turn - firstActive)
        firstActive = null
      }
    }
  }
  return out
}

// === 模拟器（与引擎衰减公式一致：us=ms=turns，decay=(α+β)t²/√I） ===

function simulateLifespan(
  sumParams: number,
  importance: number,
  peak: number,
  threshold: number
): number {
  if (importance >= 10) return Number.MAX_SAFE_INTEGER
  let a = peak
  let turns = 0
  const cap = 1000
  while (a >= threshold && turns < cap) {
    turns++
    a -= (sumParams * turns * turns) / Math.sqrt(Math.max(1, importance))
  }
  return turns
}

function simulateHalfLife(sumParams: number, importance: number, peak: number): number {
  if (peak <= 1) return 0
  let a = peak
  let turns = 0
  const halfTarget = Math.max(peak / 2, 1)
  const cap = 1000
  while (a > halfTarget && turns < cap) {
    turns++
    a -= (sumParams * turns * turns) / Math.sqrt(Math.max(1, importance))
  }
  return turns
}

// === 判定 ===

function verdictInRange(
  v: number,
  range: { min: number; max: number }
): 'healthy' | 'low' | 'high' {
  if (v < range.min) return 'low'
  if (v > range.max) return 'high'
  return 'healthy'
}

function experimentalVerdict(
  v: number,
  range: { min: number; max: number },
  insufficient: boolean
): 'at-floor' | 'mid' | 'at-ceiling' | 'experimental-insufficient' {
  if (insufficient || range.max === 0) return 'experimental-insufficient'
  const eps = 0.01
  if (v <= range.min + eps) return 'at-floor'
  if (v >= range.max - eps) return 'at-ceiling'
  return 'mid'
}

// === 小工具 ===

function avg(arr: number[]): number {
  if (arr.length === 0) return 0
  return arr.reduce((s, v) => s + v, 0) / arr.length
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

// === 衰减和极值常量（α/β schema 范围，与 advice-types.PARAM_SCHEMA_RANGE 对齐） ===
const DECAY_SUM_MIN = 0.3 + 0.05 // α 下限 0.3 + β 下限 0.05
const DECAY_SUM_MAX = 2.0 + 0.5 // α 上限 2.0 + β 上限 0.5
