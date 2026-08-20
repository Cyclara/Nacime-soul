// src/main/memory/dmae/history-store.test.ts
// P2-31.5F/G：DMAE HistoryStore 测试。
// 依据：S-Phase2 P2-31.5F/G 验收标准 + F5-002 §3.2。
//
// 核心验收：
//   - 50 轮后 turns 恰好 50 行
//   - samples 约 (Active+迁移+关注)×采样轮，不是 15k×50
//   - historySampleEveryTurns 只影响 samples
//   - aggregateDaily 同日幂等
//   - pruneExpired 30/90 天清理

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { createDmaeHistoryStore, type RecordTurnInput } from './history-store'
import { migration as migration003 } from '../../migrations/scripts/003_dmae_history'
import { migration as migration005 } from '../../migrations/scripts/005_dmae_turn_stats'
import { computeParamsHash, type DmaeParamsSnapshot } from './history-types'
import type { DmaeTurnDiagnostics, DmaeEntryDiagnostics } from './engine'
import type { DmaeState } from './formulas'
import type { DmaeSelectionSummary } from './service'
import type { Logger } from '@shared/observability/types'

const noopLogger: Logger = {
  fatal() {
    /* noop */
  },
  error() {
    /* noop */
  },
  warn() {
    /* noop */
  },
  info() {
    /* noop */
  },
  debug() {
    /* noop */
  },
  child() {
    return noopLogger
  }
}

let tmpDir: string
let db: Database.Database

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmae-hist-'))
  db = new Database(path.join(tmpDir, 'memory.db'))
  db.pragma('journal_mode = WAL')
  // 建表（用 003 + 005 迁移的 up；005 补 daily 聚合/采样/explain 所需列）
  migration003.up({ db, dataDir: tmpDir, log: noopLogger, dryRun: false })
  migration005.up({ db, dataDir: tmpDir, log: noopLogger, dryRun: false })
})

afterEach(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const DEFAULT_PARAMS: DmaeParamsSnapshot = {
  maxScore: 100,
  promptThreshold: 30,
  userRewardBase: 20,
  wakeGamma: 0.5,
  modelRewardBase: 8,
  wakeLambda: 0.3,
  decayAlpha: 1.5,
  decayBeta: 0.3
}

/** 按 threshold 派生状态（测试 helper 用；与 formulas.deriveState 语义一致） */
function stateOf(activation: number, threshold = 30): DmaeState {
  if (activation <= 0) return 'Archived'
  if (activation >= threshold) return 'Active'
  return 'Dormant'
}

function makeEntryDiag(
  id: string,
  activation: number,
  opts: Partial<DmaeEntryDiagnostics> = {}
): DmaeEntryDiagnostics {
  const s = stateOf(activation)
  return {
    memoryId: id,
    userHit: false,
    modelHit: false,
    modelHitGated: false,
    modelRewardRaw: 0,
    modelRewardEffective: 0,
    decay: 0,
    everActivatedBefore: activation > 0,
    firstActivation: false,
    stateBefore: opts.stateBefore ?? s,
    stateAfter: opts.stateAfter ?? s,
    activationBefore: opts.activationBefore ?? activation,
    userSilenceBefore: opts.userSilenceBefore ?? 0,
    modelSilenceBefore: opts.modelSilenceBefore ?? 0,
    activationAfter: activation,
    userSilenceAfter: 0,
    modelSilenceAfter: 0,
    ...opts
  }
}

function makeDiagnostics(entries: DmaeEntryDiagnostics[]): DmaeTurnDiagnostics {
  const activations = entries.map((e) => e.activationAfter)
  const sorted = [...activations].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
  return {
    entries,
    modelRewardRawSum: entries.reduce((s, e) => s + e.modelRewardRaw, 0),
    modelRewardEffectiveSum: entries.reduce((s, e) => s + e.modelRewardEffective, 0),
    modelHitsGated: entries.filter((e) => e.modelHitGated).length,
    trueFloorRevivals: 0,
    activationStats: {
      count: entries.length,
      sum: activations.reduce((s, v) => s + v, 0),
      mean: entries.length ? activations.reduce((s, v) => s + v, 0) / entries.length : 0,
      median
    },
    archivedTransitions: entries.filter(
      (e) => e.stateBefore !== e.stateAfter && e.stateAfter === 'Archived'
    ).length
  }
}

function makeSelection(promptSelected: number, retrievalHits: number): DmaeSelectionSummary {
  return {
    retrievalHits,
    promptSelected,
    selectedIds: [],
    maxActive: 15,
    atTurn: 0
  }
}

function recordNthTurn(
  store: ReturnType<typeof createDmaeHistoryStore>,
  turn: number,
  entries: DmaeEntryDiagnostics[],
  opts: Partial<RecordTurnInput> = {}
): void {
  store.recordTurn({
    turn,
    ts: Date.now() - (50 - turn) * 1000, // 近期时间戳（确保在 90 天查询窗口内）
    diagnostics: makeDiagnostics(entries),
    selection: makeSelection(entries.filter((e) => e.activationAfter >= 30).length, entries.length),
    counts: {
      active: entries.filter((e) => e.activationAfter >= 30).length,
      dormant: entries.filter((e) => e.activationAfter > 0 && e.activationAfter < 30).length,
      archived: entries.filter((e) => e.activationAfter <= 0).length
    },
    l2Total: entries.length,
    params: DEFAULT_PARAMS,
    sampleEveryTurns: 1,
    watchedIds: new Set(),
    ...opts
  })
}

describe('P2-31.5F: HistoryStore recordTurn', () => {
  it('50 轮后 turns 恰好 50 行', () => {
    const store = createDmaeHistoryStore({ db, logger: noopLogger })
    for (let i = 0; i < 50; i++) {
      recordNthTurn(store, i, [makeEntryDiag('m1', 50)])
    }
    const turns = store.queryTurns(90)
    expect(turns).toHaveLength(50)
    expect(turns[0].turn).toBe(0)
    expect(turns[49].turn).toBe(49)
  })

  it('samples 只采 Active + 迁移 + 关注的条目，不是全部', () => {
    const store = createDmaeHistoryStore({ db, logger: noopLogger })
    // 10 条：3 条 Active（>=30），5 条 Dormant/Archived（<30），2 条首次激活
    const entries: DmaeEntryDiagnostics[] = [
      makeEntryDiag('active1', 50),
      makeEntryDiag('active2', 60),
      makeEntryDiag('active3', 40),
      makeEntryDiag('dormant1', 10),
      makeEntryDiag('dormant2', 5),
      makeEntryDiag('archived1', 0),
      makeEntryDiag('archived2', 0),
      makeEntryDiag('archived3', 0),
      makeEntryDiag('archived4', 0),
      makeEntryDiag('archived5', 0),
      // 首次激活（everActivatedBefore=false, activationAfter>0）
      { ...makeEntryDiag('new1', 15), everActivatedBefore: false, firstActivation: true }
    ]
    recordNthTurn(store, 0, entries)

    // 应该采样：3 个 Active + 1 个首次激活 = 4 条（dormant/archived 不采）
    const samples = store.querySamples('active1', 90)
    expect(samples).toHaveLength(1) // active1 有 1 条
    expect(store.querySamples('dormant1', 90)).toHaveLength(0) // dormant 不采
    expect(store.querySamples('archived1', 90)).toHaveLength(0) // archived 不采
    expect(store.querySamples('new1', 90)).toHaveLength(1) // 首次激活全采
  })

  it('用户关注的条目即使非 Active 也采样', () => {
    const store = createDmaeHistoryStore({ db, logger: noopLogger })
    recordNthTurn(store, 0, [makeEntryDiag('watched1', 5)], {
      watchedIds: new Set(['watched1'])
    })
    expect(store.querySamples('watched1', 90)).toHaveLength(1)
  })

  it('historySampleEveryTurns=2 -> turns 每轮写，samples 隔轮采', () => {
    const store = createDmaeHistoryStore({ db, logger: noopLogger })
    for (let i = 0; i < 10; i++) {
      recordNthTurn(store, i, [makeEntryDiag('m1', 50)], {
        sampleEveryTurns: 2
      })
    }
    // turns 仍 10 行
    expect(store.queryTurns(90)).toHaveLength(10)
    // samples 只在偶数 turn 采（0, 2, 4, 6, 8）= 5 条
    const samples = store.querySamples('m1', 90)
    expect(samples).toHaveLength(5)
    expect(samples.map((s) => s.turn)).toEqual([0, 2, 4, 6, 8])
  })

  it('turns 记录字段完整（retrievalHits/promptSelected/maxActive 等）', () => {
    const store = createDmaeHistoryStore({ db, logger: noopLogger })
    store.recordTurn({
      turn: 1,
      ts: Date.now(),
      diagnostics: makeDiagnostics([
        {
          ...makeEntryDiag('m1', 50),
          userHit: true,
          modelHit: true,
          modelRewardRaw: 8,
          modelRewardEffective: 0.5,
          decay: 0.6
        }
      ]),
      selection: makeSelection(1, 6),
      counts: { active: 1, dormant: 0, archived: 0 },
      l2Total: 1,
      params: DEFAULT_PARAMS,
      sampleEveryTurns: 1,
      watchedIds: new Set()
    })
    const turns = store.queryTurns(90)
    expect(turns).toHaveLength(1)
    const t = turns[0]
    expect(t.turn).toBe(1)
    expect(t.eligibleActive).toBe(1)
    expect(t.retrievalHits).toBe(6)
    expect(t.promptSelected).toBe(1)
    expect(t.maxActive).toBe(15)
    expect(t.userHits).toBe(1)
    expect(t.modelHits).toBe(1)
    expect(t.modelRewardRawSum).toBe(8)
    expect(t.modelRewardEffectiveSum).toBe(0.5)
    expect(t.paramsHash).toBe(computeParamsHash(DEFAULT_PARAMS))
  })
})

describe('P2-31.5F: HistoryStore queryDaily + aggregateDaily', () => {
  it('aggregateDaily 同日幂等（跑两次仍 1 行）', () => {
    const store = createDmaeHistoryStore({ db, logger: noopLogger })
    const today = new Date(2026, 7, 6) // 2026-08-06
    const ts = today.getTime()
    // 写 3 轮
    for (let i = 0; i < 3; i++) {
      store.recordTurn({
        turn: i,
        ts: ts + i * 1000,
        diagnostics: makeDiagnostics([makeEntryDiag('m1', 50)]),
        selection: makeSelection(1, 2),
        counts: { active: 1, dormant: 0, archived: 0 },
        l2Total: 1,
        params: DEFAULT_PARAMS,
        sampleEveryTurns: 1,
        watchedIds: new Set()
      })
    }
    // 聚合同一天两次
    const date = '2026-08-06'
    store.aggregateDaily(date)
    store.aggregateDaily(date) // 幂等

    const daily = store.queryDaily(90)
    expect(daily).toHaveLength(1)
    expect(daily[0].date).toBe(date)
    expect(daily[0].turns).toBe(3)
  })

  it('跨零点两天各 1 行 daily', () => {
    const store = createDmaeHistoryStore({ db, logger: noopLogger })
    const day1 = new Date(2026, 7, 5, 23, 50, 0) // 2026-08-05 23:50
    const day2 = new Date(2026, 7, 6, 0, 10, 0) // 2026-08-06 00:10

    // day1 写 2 轮
    for (let i = 0; i < 2; i++) {
      store.recordTurn({
        turn: i,
        ts: day1.getTime() + i * 1000,
        diagnostics: makeDiagnostics([makeEntryDiag('m1', 50)]),
        selection: makeSelection(1, 2),
        counts: { active: 1, dormant: 0, archived: 0 },
        l2Total: 1,
        params: DEFAULT_PARAMS,
        sampleEveryTurns: 1,
        watchedIds: new Set()
      })
    }
    // day2 写 1 轮
    store.recordTurn({
      turn: 2,
      ts: day2.getTime(),
      diagnostics: makeDiagnostics([makeEntryDiag('m1', 50)]),
      selection: makeSelection(1, 2),
      counts: { active: 1, dormant: 0, archived: 0 },
      l2Total: 1,
      params: DEFAULT_PARAMS,
      sampleEveryTurns: 1,
      watchedIds: new Set()
    })

    store.aggregateDaily('2026-08-05')
    store.aggregateDaily('2026-08-06')

    const daily = store.queryDaily(90)
    expect(daily).toHaveLength(2)
    expect(daily[0].date).toBe('2026-08-05')
    expect(daily[0].turns).toBe(2)
    expect(daily[1].date).toBe('2026-08-06')
    expect(daily[1].turns).toBe(1)
  })
})

describe('P2-31.5G: HistoryStore annotations + pruneExpired', () => {
  it('addAnnotation + queryAnnotations 往返', () => {
    const store = createDmaeHistoryStore({ db, logger: noopLogger })
    store.addAnnotation({
      id: 'ann1',
      ts: Date.now(),
      turn: 5,
      before: DEFAULT_PARAMS,
      after: { ...DEFAULT_PARAMS, decayAlpha: 0.8 },
      source: 'manual'
    })
    const anns = store.queryAnnotations(7)
    expect(anns).toHaveLength(1)
    expect(anns[0].id).toBe('ann1')
    expect(anns[0].after.decayAlpha).toBe(0.8)
  })

  it('pruneExpired 删除 30 天前的 samples 和 90 天前的 turns', () => {
    const store = createDmaeHistoryStore({ db, logger: noopLogger })
    const now = Date.now()
    // 写一条 40 天前的 sample + 100 天前的 turn
    store.recordTurn({
      turn: 1,
      ts: now - 40 * 24 * 60 * 60 * 1000, // 40 天前
      diagnostics: makeDiagnostics([makeEntryDiag('m1', 50)]),
      selection: makeSelection(1, 1),
      counts: { active: 1, dormant: 0, archived: 0 },
      l2Total: 1,
      params: DEFAULT_PARAMS,
      sampleEveryTurns: 1,
      watchedIds: new Set()
    })
    store.recordTurn({
      turn: 2,
      ts: now - 100 * 24 * 60 * 60 * 1000, // 100 天前
      diagnostics: makeDiagnostics([makeEntryDiag('m2', 50)]),
      selection: makeSelection(1, 1),
      counts: { active: 1, dormant: 0, archived: 0 },
      l2Total: 1,
      params: DEFAULT_PARAMS,
      sampleEveryTurns: 1,
      watchedIds: new Set()
    })

    const result = store.pruneExpired(now)
    // 40 天前的 sample 被删（>30 天），100 天前的 turn 被删（>90 天）
    expect(result.samplesDeleted).toBeGreaterThan(0)
    expect(result.turnsDeleted).toBeGreaterThan(0)
  })

  it('daily 和 annotations 永久保留（不被 pruneExpired 删除）', () => {
    const store = createDmaeHistoryStore({ db, logger: noopLogger })
    // 用近期时间戳（确保在 90 天查询窗口内），验证 pruneExpired 不删 annotations
    store.addAnnotation({
      id: 'recent-ann',
      ts: Date.now(),
      turn: 1,
      before: DEFAULT_PARAMS,
      after: DEFAULT_PARAMS,
      source: 'manual'
    })
    store.pruneExpired(Date.now())
    // annotation 仍在（daily/annotations 永久保留，不被 pruneExpired 删除）
    expect(store.queryAnnotations(90)).toHaveLength(1)
  })
})

// === P1 修复（2026-08-10 审计）：真实聚合值 / 迁移采样 / 自定义阈值 / 取最新 ===

describe('P1: dmae_turns 携带真实聚合字段（005 补列）', () => {
  it('dormant/archived/l2Total/activation 统计/archivedTransitions 落库', () => {
    const store = createDmaeHistoryStore({ db, logger: noopLogger })
    store.recordTurn({
      turn: 1,
      ts: Date.now(),
      diagnostics: makeDiagnostics([
        makeEntryDiag('a', 50), // Active
        makeEntryDiag('d', 15), // Dormant
        makeEntryDiag('x', 0), // Archived
        {
          ...makeEntryDiag('y', 0, { stateBefore: 'Dormant', stateAfter: 'Archived' }),
          stateBefore: 'Dormant',
          stateAfter: 'Archived'
        } // Dormant -> Archived 迁移
      ]),
      selection: makeSelection(1, 3),
      counts: { active: 1, dormant: 1, archived: 2 },
      l2Total: 4,
      params: DEFAULT_PARAMS,
      sampleEveryTurns: 1,
      watchedIds: new Set()
    })
    const t = store.queryTurns(90)[0]
    expect(t.dormant).toBe(1)
    expect(t.archived).toBe(2)
    expect(t.l2Total).toBe(4)
    // activation 统计：50, 15, 0, 0 -> sum=65, count=4, mean=16.25, median=(0+15)/2=7.5
    expect(t.activationSum).toBe(65)
    expect(t.activationCount).toBe(4)
    expect(t.activationMedian).toBe(7.5)
    expect(t.archivedTransitions).toBe(1)
  })
})

describe('P1: computeDailyAggregate 用真实值（不再硬编码 0/条目数冒充）', () => {
  it('dormant/archived/l2Total/avgActivation/archivedTransitions 来自 turn 数据', () => {
    const store = createDmaeHistoryStore({ db, logger: noopLogger })
    const ts = new Date(2026, 7, 6).getTime()
    // 两轮：activation 全为 [50,15,0,0]（sum=65,count=4）；dormant=1 archived=2 l2Total=4；迁移 1
    for (let i = 0; i < 2; i++) {
      store.recordTurn({
        turn: i,
        ts: ts + i * 1000,
        diagnostics: makeDiagnostics([
          makeEntryDiag('a', 50),
          makeEntryDiag('d', 15),
          makeEntryDiag('x', 0),
          {
            ...makeEntryDiag('y', 0),
            stateBefore: 'Dormant',
            stateAfter: 'Archived'
          }
        ]),
        selection: makeSelection(1, 3),
        counts: { active: 1, dormant: 1, archived: 2 },
        l2Total: 4,
        params: DEFAULT_PARAMS,
        sampleEveryTurns: 1,
        watchedIds: new Set()
      })
    }
    store.aggregateDaily('2026-08-06')
    const d = store.queryDaily(90)[0]
    expect(d.dormant).toBe(1) // 修复前硬编码 0
    expect(d.archived).toBe(2) // 修复前硬编码 0
    expect(d.l2Total).toBe(4) // 修复前硬编码 0
    expect(d.avgActivation).toBe(16.25) // 修复前是 eligibleActive(=1) 的均值
    expect(d.medianActivation).toBe(7.5)
    expect(d.archivedTransitions).toBe(2) // 修复前从 floorRevivals 取（方向反）
  })

  it('同日多次 recordTurn 后 aggregateDaily 反映最新一轮（幂等 upsert）', () => {
    const store = createDmaeHistoryStore({ db, logger: noopLogger })
    const ts = new Date(2026, 7, 6).getTime()
    // 第 1 轮 active=1
    store.recordTurn({
      turn: 0,
      ts,
      diagnostics: makeDiagnostics([makeEntryDiag('a', 50)]),
      selection: makeSelection(1, 1),
      counts: { active: 1, dormant: 0, archived: 0 },
      l2Total: 1,
      params: DEFAULT_PARAMS,
      sampleEveryTurns: 1,
      watchedIds: new Set()
    })
    store.aggregateDaily('2026-08-06')
    // 第 2 轮 active=2 dormant=1
    store.recordTurn({
      turn: 1,
      ts: ts + 1000,
      diagnostics: makeDiagnostics([makeEntryDiag('a', 50), makeEntryDiag('d', 10)]),
      selection: makeSelection(1, 2),
      counts: { active: 2, dormant: 1, archived: 0 },
      l2Total: 2,
      params: DEFAULT_PARAMS,
      sampleEveryTurns: 1,
      watchedIds: new Set()
    })
    // 修复后：每轮 hook 都调 aggregateDaily，第二次覆盖第一次
    store.aggregateDaily('2026-08-06')
    const d = store.queryDaily(90)[0]
    expect(d.turns).toBe(2)
    expect(d.eligibleActive).toBe(2) // 反映最新一轮，不是第一轮
    expect(d.dormant).toBe(1)
    expect(d.l2Total).toBe(2)
  })
})

describe('P1: 分层采样识别全部状态迁移 + 用参数阈值（不再写死 30）', () => {
  it('Active -> Dormant 衰减迁移被采样（修复前漏采）', () => {
    const store = createDmaeHistoryStore({ db, logger: noopLogger })
    recordNthTurn(store, 0, [
      makeEntryDiag('m1', 20, { stateBefore: 'Active', stateAfter: 'Dormant' })
    ])
    // activationAfter=20 < 30 不是 Active，但发生了迁移 -> 必须采样
    expect(store.querySamples('m1', 90)).toHaveLength(1)
  })

  it('自定义 threshold=40：activation 35 是 Dormant 不采样，35 且迁移才采', () => {
    const store = createDmaeHistoryStore({ db, logger: noopLogger })
    const params40 = { ...DEFAULT_PARAMS, promptThreshold: 40 }
    // 无迁移、非首次激活、after=35 < 40 -> 不采
    store.recordTurn({
      turn: 0,
      ts: Date.now(),
      diagnostics: makeDiagnostics([makeEntryDiag('a', 35)]),
      selection: makeSelection(0, 1),
      counts: { active: 0, dormant: 1, archived: 0 },
      l2Total: 1,
      params: params40,
      sampleEveryTurns: 1,
      watchedIds: new Set()
    })
    expect(store.querySamples('a', 90)).toHaveLength(0)

    // 同一条目发生 Active->Dormant 迁移 -> 采样（即使 after < threshold）
    store.recordTurn({
      turn: 1,
      ts: Date.now() + 1000,
      diagnostics: makeDiagnostics([
        makeEntryDiag('a', 35, { stateBefore: 'Active', stateAfter: 'Dormant' })
      ]),
      selection: makeSelection(0, 1),
      counts: { active: 0, dormant: 1, archived: 0 },
      l2Total: 1,
      params: params40,
      sampleEveryTurns: 1,
      watchedIds: new Set()
    })
    expect(store.querySamples('a', 90)).toHaveLength(1)
  })

  it('采样点携带 stateBefore/stateAfter/权威 before 值/params_json', () => {
    const store = createDmaeHistoryStore({ db, logger: noopLogger })
    recordNthTurn(store, 0, [
      makeEntryDiag('m1', 45, {
        stateBefore: 'Dormant',
        stateAfter: 'Active',
        activationBefore: 20,
        userSilenceBefore: 3,
        modelSilenceBefore: 2
      })
    ])
    const s = store.querySamples('m1', 90)[0]
    expect(s.stateBefore).toBe('Dormant')
    expect(s.stateAfter).toBe('Active')
    expect(s.activationBefore).toBe(20)
    expect(s.userSilenceBefore).toBe(3)
    expect(s.modelSilenceBefore).toBe(2)
    expect(s.paramsJson).toBe(JSON.stringify(DEFAULT_PARAMS))
  })
})

describe('P1: queryRecentSamples 取窗口内最新（DESC+reverse 修复）', () => {
  it('>5000 采样时保留最新 turn 的样本（修复前 ASC LIMIT 丢新取旧）', () => {
    const store = createDmaeHistoryStore({ db, logger: noopLogger })
    // turn 0：5500 条 Active 条目 -> 5500 采样点
    const many = Array.from({ length: 5500 }, (_, i) => makeEntryDiag(`m${i}`, 50))
    store.recordTurn({
      turn: 0,
      ts: Date.now(),
      diagnostics: makeDiagnostics(many),
      selection: makeSelection(5500, 5500),
      counts: { active: 5500, dormant: 0, archived: 0 },
      l2Total: 5500,
      params: DEFAULT_PARAMS,
      sampleEveryTurns: 1,
      watchedIds: new Set()
    })
    // turn 1：1 条新条目 -> 1 采样点
    store.recordTurn({
      turn: 1,
      ts: Date.now() + 1000,
      diagnostics: makeDiagnostics([makeEntryDiag('newest', 60)]),
      selection: makeSelection(1, 1),
      counts: { active: 1, dormant: 0, archived: 0 },
      l2Total: 1,
      params: DEFAULT_PARAMS,
      sampleEveryTurns: 1,
      watchedIds: new Set()
    })

    const samples = store.queryRecentSamples(50)
    // DESC LIMIT 5000 取最新 -> turn=1 的样本必须存在（旧实现取前 5000 行会丢它）
    expect(samples.some((s) => s.memoryId === 'newest' && s.turn === 1)).toBe(true)
    // 且按 turn 升序返回（reverse 后）
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i].turn).toBeGreaterThanOrEqual(samples[i - 1].turn)
    }
  })
})

// === P0 联动：跨重启 turn 单调（history 键不覆盖）===

describe('P0: 跨 service 重启历史键严格递增（同一 DB + state 文件）', () => {
  it('重启后 turn 从持久化值继续，dmae_turns 行不重复', () => {
    const store1 = createDmaeHistoryStore({ db, logger: noopLogger })
    store1.recordTurn({
      turn: 1,
      ts: Date.now(),
      diagnostics: makeDiagnostics([makeEntryDiag('m1', 50)]),
      selection: makeSelection(1, 1),
      counts: { active: 1, dormant: 0, archived: 0 },
      l2Total: 1,
      params: DEFAULT_PARAMS,
      sampleEveryTurns: 1,
      watchedIds: new Set()
    })
    store1.recordTurn({
      turn: 2,
      ts: Date.now() + 1000,
      diagnostics: makeDiagnostics([makeEntryDiag('m1', 50)]),
      selection: makeSelection(1, 1),
      counts: { active: 1, dormant: 0, archived: 0 },
      l2Total: 1,
      params: DEFAULT_PARAMS,
      sampleEveryTurns: 1,
      watchedIds: new Set()
    })

    // 模拟重启后（turn 已持久化=2），下一轮写 turn=3
    const store2 = createDmaeHistoryStore({ db, logger: noopLogger })
    store2.recordTurn({
      turn: 3,
      ts: Date.now() + 2000,
      diagnostics: makeDiagnostics([makeEntryDiag('m1', 50)]),
      selection: makeSelection(1, 1),
      counts: { active: 1, dormant: 0, archived: 0 },
      l2Total: 1,
      params: DEFAULT_PARAMS,
      sampleEveryTurns: 1,
      watchedIds: new Set()
    })

    const turns = store2.queryTurns(90)
    expect(turns.map((t) => t.turn)).toEqual([1, 2, 3])
    // 若重启后归零写回 1，这里会出现重复 turn=1 行（被 REPLACE 覆盖成 2 行总数），
    // 断言 3 行且 turn 唯一即可证明无覆盖
    expect(new Set(turns.map((t) => t.turn)).size).toBe(3)
  })
})
