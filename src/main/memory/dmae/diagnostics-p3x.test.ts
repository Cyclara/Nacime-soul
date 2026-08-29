// P3X-01/03：预算后真值和 15k eligible 集合的分页合同。

import { describe, expect, it } from 'vitest'
import { createDmaeDiagnosticsService } from './diagnostics'
import type { DmaeEngineService } from './service'
import type { DmaeHistoryStore } from './history-store'
import type { DmaeStateStore } from './state-file'
import type { L2Store } from '../l2-store'
import type { MemoryConfig } from '@shared/config/types'
import type { Logger } from '@shared/observability/types'
import type { DmaeDailyAggregate, DmaeSamplePoint, DmaeTurnRecord } from './history-types'

const logger: Logger = {
  fatal() { /* noop */ }, error() { /* noop */ }, warn() { /* noop */ }, info() { /* noop */ }, debug() { /* noop */ }, child() { return logger }
}

const config = {
  enabled: true,
  embeddingProvider: '',
  embeddingModel: '',
  embeddingDimension: 1024,
  maxActive: 15,
  minRetrievalScore: 0.35,
  attributionGate: { provider: '', model: '', baseUrl: '' },
  dmae: {
    enabled: true,
    maxScore: 100,
    promptThreshold: 30,
    userRewardBase: 20,
    wakeGamma: 0.5,
    modelRewardBase: 8,
    wakeLambda: 0.3,
    decayAlpha: 1.5,
    decayBeta: 0.3,
    historySampleEveryTurns: 1,
    presets: [],
    anomaly: {
      muted: { R01: 0, R02: 0, R03: 0, R04: 0, R05: 0, R06: 0, R07: 0, R08: 0, R09: 0, R10: 0, R11: 0, R12: 0, R13: 0 },
      windows: { R01: { days: 3 }, R02: { days: 7 }, R03: { days: 3 }, R04: { turns: 50 }, R05: { turns: 100 }, R06: {}, R07: { turns: 50 }, R08: { turns: 200 }, R09: { days: 3 }, R10: { days: 3, turns: 100 }, R11: {}, R12: {}, R13: {} }
    }
  }
} as unknown as MemoryConfig

function id(index: number): string {
  return `l2_1700000000000_${String(index).padStart(5, '0')}`
}

function turnTruth(): DmaeTurnRecord {
  return {
    turn: 1, ts: 1, eligibleActive: 15_000, retrievalHits: 15, promptSelected: 15, maxActive: 15,
    promptIncluded: 12, promptTrimmed: 3, promptIncludedIds: [id(0), id(2)], promptTrimmedIds: [id(1)],
    userHits: 0, modelHits: 0, modelHitsGated: 0, modelRewardRawSum: 0, modelRewardEffectiveSum: 0,
    totalDecay: 0, floorRevivals: 0, trueFloorRevivals: 0, paramsHash: 'x', dormant: 0, archived: 0,
    l2Total: 15_000, activationSum: 0, activationCount: 15_000, activationMedian: 0, archivedTransitions: 0
  }
}

function service(total: number, turns: DmaeTurnRecord[] = []): ReturnType<typeof createDmaeDiagnosticsService> {
  const states = new Map<string, { activation: number; userSilence: number; modelSilence: number; everActivated: boolean }>()
  const records = Array.from({ length: total }, (_, index) => ({ id: id(index), importance: 5, content: `entry ${index}`, lifecycleState: 'active', isPinned: false }))
  for (let index = 0; index < total; index++) {
    states.set(id(index), { activation: 100 - (index % 50), userSilence: 0, modelSilence: 0, everActivated: true })
  }
  const history: DmaeHistoryStore = {
    recordTurn() { /* noop */ }, querySamples: () => [] as DmaeSamplePoint[], queryAllSamples: () => [], queryRecentSamples: () => [],
    queryTurns: () => turns, queryDaily: () => [] as DmaeDailyAggregate[], aggregateDaily() { /* noop */ }, addAnnotation() { /* noop */ }, queryAnnotations: () => [], pruneExpired: () => ({ samplesDeleted: 0, turnsDeleted: 0 })
  }
  const dmae: DmaeEngineService = {
    initialize() { /* noop */ }, selectL2: () => [], updateTurn: () => { throw new Error('not used') }, getActivation: () => 0,
    getStats: () => ({ active: total, dormant: 0, archived: 0 }), getL2Total: () => total, seedActivation: () => false,
    get pendingUserHitSessions() { return 0 }, get lastSaveOk() { return true }, get states() { return states },
    get lastSelection() { return { retrievalHits: 15, promptSelected: 15, selectedIds: [id(0), id(1), id(2)], maxActive: 15, atTurn: 1 } }, get turn() { return 1 }
  } as unknown as DmaeEngineService
  const l2: Pick<L2Store, 'count' | 'list' | 'get'> = {
    count: () => total, list: () => records as never, get: (memoryId) => records.find((record) => record.id === memoryId) as never
  }
  const stateStore: DmaeStateStore = {
    load: () => ({ turn: 1, states: new Map() }), save() { /* noop */ }, path: '',
    getHealth: () => ({ lastLoadReset: null, lastLoadResetReason: null, lastSaveOk: true, lastSaveAt: 1, saveFailures7d: 0 })
  }
  return createDmaeDiagnosticsService({ logger, dmaeService: dmae, historyStore: history, stateStore, l2Store: l2, getMemoryConfig: () => config })
}

describe('P3X DMAE panel truth and paging', () => {
  it('separates selectL2 candidates from final PromptBudgeter injection truth', () => {
    const snapshot = service(15_000, [turnTruth()]).getPanelSnapshot({ eligibleLimit: 1 })
    expect(snapshot.selection).toMatchObject({ lastPromptSelectedCount: 15, lastPromptIncludedCount: 12, lastPromptTrimmedCount: 3 })
    expect(snapshot.activeSet[0]).toMatchObject({ selectedLastTurn: true, injectedLastTurn: true })
  })

  it('returns bounded 100-entry pages with a stable keyset cursor at 15k scale', () => {
    const diagnostics = service(15_000)
    const first = diagnostics.getPanelSnapshot({ eligibleLimit: 100 })
    expect(first.activeSet).toHaveLength(100)
    expect(first.nextEligibleCursor).not.toBeNull()
    expect(first.activeSetPaginated).toBe(true)

    const second = diagnostics.getPanelSnapshot({ eligibleLimit: 100, eligibleCursor: first.nextEligibleCursor! })
    expect(second.activeSet).toHaveLength(100)
    expect(new Set([...first.activeSet, ...second.activeSet].map((entry) => entry.memoryId)).size).toBe(200)
  })

  it('marks stale-turn cursors as reset instead of appending an unstable page', () => {
    const snapshot = service(15_000).getPanelSnapshot({ eligibleCursor: { turn: 0, activation: 100, memoryId: id(0) }, eligibleLimit: 10 })
    expect(snapshot.eligibleCursorReset).toBe(true)
    expect(snapshot.activeSet[0]!.memoryId).toBe(id(0))
  })
})
