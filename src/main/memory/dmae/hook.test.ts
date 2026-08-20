// src/main/memory/dmae/hook.test.ts
// C-γ-2：DMAE hook 广播 + sessionId 透传测试。
// 依据：2026-08-03 审计裁定 R-6 问题 B / 交接文档 C-γ-2。
//   - updateTurn 产生 activation 变化 -> revisionClock.next() + broadcaster.notify('dmae')
//   - 无变化（纯沉默衰减）-> 不广播
//   - sessionId 从 TurnEndData.sessionId 透传给 dmaeService.updateTurn
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createDmaeHook } from './hook'
import type { DmaeEngineService } from './service'
import type { DmaeTurnResult } from './engine'
import type { HookResult } from '../../hooks/types'
import type { MemoryConfig } from '@shared/config/types'
import type { Logger } from '@shared/observability/types'
import { configureMetrics, createMetrics } from '../../observability/metrics'

function makeLogger(): Logger {
  return {
    child: () => makeLogger(),
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  } as unknown as Logger
}

const MEM_CFG: MemoryConfig = {
  enabled: true,
  dmae: { enabled: true }
} as MemoryConfig

/** 构造一个可控的 DmaeEngineService mock，updateTurn 返回指定 result */
function makeDmaeService(result: DmaeTurnResult): {
  service: DmaeEngineService
  updateTurnSpy: ReturnType<typeof vi.fn>
} {
  const updateTurnSpy = vi.fn().mockReturnValue(result)
  const service = {
    initialize: () => {},
    selectL2: () => [],
    updateTurn: updateTurnSpy,
    getActivation: () => 0,
    getStats: () => ({ active: 0, dormant: 0, archived: 0 }),
    get lastSaveOk() {
      return true
    },
    getL2Total: () => 0,
    seedActivation: () => false,
    get pendingUserHitSessions() {
      return 0
    },
    get states() {
      return new Map()
    }
  } as unknown as DmaeEngineService
  return { service, updateTurnSpy }
}

function makeTurnEnd(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    turnId: 'turn-1',
    sessionId: 'session-A',
    requestId: 'req-1',
    status: 'completed',
    inputLen: 10,
    outputLen: 20,
    memoryEligible: true,
    referencedMemoryIds: [],
    ...overrides
  }
}

function emptyResult(overrides: Partial<DmaeTurnResult['stats']> = {}): DmaeTurnResult {
  return {
    transitions: [],
    stats: {
      userHits: 0,
      modelHits: 0,
      floorRevivals: 0,
      totalDecay: 0,
      active: 0,
      dormant: 0,
      archived: 0,
      ...overrides
    },
    diagnostics: {
      entries: [],
      modelRewardRawSum: 0,
      modelRewardEffectiveSum: 0,
      modelHitsGated: 0,
      trueFloorRevivals: 0,
      activationStats: { count: 0, sum: 0, mean: 0, median: 0 },
      archivedTransitions: 0
    }
  }
}

beforeEach(() => {
  // 隔离全局 metrics 单例，避免与其他测试串扰
  configureMetrics(createMetrics())
})

describe('C-γ-2 DMAE hook：sessionId 透传', () => {
  it('updateTurn 接收 TurnEndData.sessionId（非 referencedMemoryIds）', () => {
    const { service, updateTurnSpy } = makeDmaeService(emptyResult())
    const revisionClock = { next: vi.fn(() => 1), current: vi.fn(() => 0) }
    const broadcaster = { notify: vi.fn(), flush: vi.fn(), dispose: vi.fn() }

    const { hook } = createDmaeHook({
      logger: makeLogger(),
      dmaeService: service,
      getMemoryConfig: () => MEM_CFG,
      revisionClock,
      broadcaster
    })

    hook.fn(
      { event: 'turn.end' },
      makeTurnEnd({ sessionId: 'session-X', referencedMemoryIds: ['m1'] })
    )

    expect(updateTurnSpy).toHaveBeenCalledOnce()
    expect(updateTurnSpy).toHaveBeenCalledWith('session-X', ['m1'])
  })

  it('P1: recordTurn 收到真实 l2Total，且每轮都 aggregateDaily（当日幂等 upsert）', () => {
    const updateTurnSpy = vi
      .fn()
      .mockReturnValue(emptyResult({ active: 2, dormant: 1, archived: 0 }))
    const recordTurnSpy = vi.fn()
    const aggregateDailySpy = vi.fn()
    const historyStore = {
      recordTurn: recordTurnSpy,
      aggregateDaily: aggregateDailySpy,
      querySamples: () => [],
      queryRecentSamples: () => [],
      queryTurns: () => [],
      queryDaily: () => [],
      queryAnnotations: () => [],
      addAnnotation: () => {},
      pruneExpired: () => ({ samplesDeleted: 0, turnsDeleted: 0 })
    }
    const service = {
      initialize: () => {},
      selectL2: () => [],
      updateTurn: updateTurnSpy,
      getActivation: () => 0,
      getStats: () => ({ active: 0, dormant: 0, archived: 0 }),
      get lastSaveOk() {
        return true
      },
      getL2Total: () => 42,
      seedActivation: () => false,
      get turn() {
        return 3
      },
      get lastSelection() {
        return null
      },
      get pendingUserHitSessions() {
        return 0
      },
      get states() {
        return new Map()
      }
    } as unknown as DmaeEngineService
    const revisionClock = { next: vi.fn(), current: vi.fn(() => 0) }
    const broadcaster = { notify: vi.fn(), flush: vi.fn(), dispose: vi.fn() }

    const { hook } = createDmaeHook({
      logger: makeLogger(),
      dmaeService: service,
      historyStore: historyStore as never,
      getMemoryConfig: () => MEM_CFG,
      revisionClock,
      broadcaster
    })

    hook.fn({ event: 'turn.end' }, makeTurnEnd())
    hook.fn({ event: 'turn.end' }, makeTurnEnd())

    expect(recordTurnSpy).toHaveBeenCalledTimes(2)
    expect(recordTurnSpy.mock.calls[0][0]).toMatchObject({
      turn: 3,
      counts: { active: 2, dormant: 1, archived: 0 },
      l2Total: 42 // 修复前恒 0
    })
    // 每轮都聚合同日（修复前只在日期变化时聚合）
    expect(aggregateDailySpy).toHaveBeenCalledTimes(2)
  })

  it('P2: save 失败 -> 不记录历史（激活未落盘，历史行不能谎称持久化）', () => {
    const updateTurnSpy = vi.fn().mockReturnValue(emptyResult())
    const recordTurnSpy = vi.fn()
    const historyStore = {
      recordTurn: recordTurnSpy,
      aggregateDaily: vi.fn(),
      querySamples: () => [],
      queryRecentSamples: () => [],
      queryTurns: () => [],
      queryDaily: () => [],
      queryAnnotations: () => [],
      addAnnotation: () => {},
      pruneExpired: () => ({ samplesDeleted: 0, turnsDeleted: 0 })
    }
    const service = {
      initialize: () => {},
      selectL2: () => [],
      updateTurn: updateTurnSpy,
      getActivation: () => 0,
      getStats: () => ({ active: 0, dormant: 0, archived: 0 }),
      get lastSaveOk() {
        return false // save 失败
      },
      getL2Total: () => 0,
      seedActivation: () => false,
      get turn() {
        return 1
      },
      get lastSelection() {
        return null
      },
      get pendingUserHitSessions() {
        return 0
      },
      get states() {
        return new Map()
      }
    } as unknown as DmaeEngineService
    const revisionClock = { next: vi.fn(), current: vi.fn(() => 0) }
    const broadcaster = { notify: vi.fn(), flush: vi.fn(), dispose: vi.fn() }

    const { hook } = createDmaeHook({
      logger: makeLogger(),
      dmaeService: service,
      historyStore: historyStore as never,
      getMemoryConfig: () => MEM_CFG,
      revisionClock,
      broadcaster
    })

    hook.fn({ event: 'turn.end' }, makeTurnEnd())
    expect(recordTurnSpy).not.toHaveBeenCalled()
  })
})

describe('C-γ-2 DMAE hook：activation 变化时广播（问题 B）', () => {
  it('有 transition -> revisionClock.next() + broadcaster.notify("dmae")', () => {
    const result: DmaeTurnResult = {
      transitions: [{ id: 'm1', from: 'Archived', to: 'Active', archivedAt: null }],
      stats: {
        userHits: 1,
        modelHits: 0,
        floorRevivals: 1,
        totalDecay: 0,
        active: 1,
        dormant: 0,
        archived: 0
      },
      diagnostics: {
        entries: [],
        modelRewardRawSum: 0,
        modelRewardEffectiveSum: 0,
        modelHitsGated: 0,
        trueFloorRevivals: 0,
        activationStats: { count: 0, sum: 0, mean: 0, median: 0 },
        archivedTransitions: 0
      }
    }
    const { service } = makeDmaeService(result)
    const revisionClock = { next: vi.fn(() => 42), current: vi.fn(() => 41) }
    const broadcaster = { notify: vi.fn(), flush: vi.fn(), dispose: vi.fn() }

    const { hook } = createDmaeHook({
      logger: makeLogger(),
      dmaeService: service,
      getMemoryConfig: () => MEM_CFG,
      revisionClock,
      broadcaster
    })

    hook.fn({ event: 'turn.end' }, makeTurnEnd())

    expect(revisionClock.next).toHaveBeenCalledOnce()
    expect(broadcaster.notify).toHaveBeenCalledWith('dmae')
  })

  it('有 userHit 但无 transition -> 仍广播（activation 值变了）', () => {
    const result = emptyResult({ userHits: 1 })
    const { service } = makeDmaeService(result)
    const revisionClock = { next: vi.fn(() => 1), current: vi.fn(() => 0) }
    const broadcaster = { notify: vi.fn(), flush: vi.fn(), dispose: vi.fn() }

    const { hook } = createDmaeHook({
      logger: makeLogger(),
      dmaeService: service,
      getMemoryConfig: () => MEM_CFG,
      revisionClock,
      broadcaster
    })

    hook.fn({ event: 'turn.end' }, makeTurnEnd())

    expect(revisionClock.next).toHaveBeenCalledOnce()
    expect(broadcaster.notify).toHaveBeenCalledWith('dmae')
  })

  it('有 modelHit 但无 transition -> 仍广播', () => {
    const result = emptyResult({ modelHits: 1 })
    const { service } = makeDmaeService(result)
    const revisionClock = { next: vi.fn(() => 1), current: vi.fn(() => 0) }
    const broadcaster = { notify: vi.fn(), flush: vi.fn(), dispose: vi.fn() }

    const { hook } = createDmaeHook({
      logger: makeLogger(),
      dmaeService: service,
      getMemoryConfig: () => MEM_CFG,
      revisionClock,
      broadcaster
    })

    hook.fn({ event: 'turn.end' }, makeTurnEnd())

    expect(broadcaster.notify).toHaveBeenCalledWith('dmae')
  })

  it('纯沉默衰减（无 hit/revival/transition）-> 不广播', () => {
    const result = emptyResult({ totalDecay: 5.0 })
    const { service } = makeDmaeService(result)
    const revisionClock = { next: vi.fn(), current: vi.fn(() => 0) }
    const broadcaster = { notify: vi.fn(), flush: vi.fn(), dispose: vi.fn() }

    const { hook } = createDmaeHook({
      logger: makeLogger(),
      dmaeService: service,
      getMemoryConfig: () => MEM_CFG,
      revisionClock,
      broadcaster
    })

    hook.fn({ event: 'turn.end' }, makeTurnEnd())

    expect(revisionClock.next).not.toHaveBeenCalled()
    expect(broadcaster.notify).not.toHaveBeenCalled()
  })

  it('有 floorRevival -> 广播', () => {
    const result = emptyResult({ floorRevivals: 1 })
    const { service } = makeDmaeService(result)
    const revisionClock = { next: vi.fn(() => 1), current: vi.fn(() => 0) }
    const broadcaster = { notify: vi.fn(), flush: vi.fn(), dispose: vi.fn() }

    const { hook } = createDmaeHook({
      logger: makeLogger(),
      dmaeService: service,
      getMemoryConfig: () => MEM_CFG,
      revisionClock,
      broadcaster
    })

    hook.fn({ event: 'turn.end' }, makeTurnEnd())

    expect(broadcaster.notify).toHaveBeenCalledWith('dmae')
  })
})

describe('C-γ-2 DMAE hook：硬门与 failOpen', () => {
  it('memory.enabled=false -> 旁路（不 updateTurn / 不广播）', () => {
    const { service, updateTurnSpy } = makeDmaeService(emptyResult())
    const revisionClock = { next: vi.fn(), current: vi.fn(() => 0) }
    const broadcaster = { notify: vi.fn(), flush: vi.fn(), dispose: vi.fn() }

    const { hook } = createDmaeHook({
      logger: makeLogger(),
      dmaeService: service,
      getMemoryConfig: () => ({ ...MEM_CFG, enabled: false }),
      revisionClock,
      broadcaster
    })

    const res = hook.fn({ event: 'turn.end' }, makeTurnEnd()) as HookResult

    expect(updateTurnSpy).not.toHaveBeenCalled()
    expect(broadcaster.notify).not.toHaveBeenCalled()
    expect(res.data).toBeDefined() // 旁路仍返回 data
  })

  it('dmae.enabled=false -> 旁路', () => {
    const { service, updateTurnSpy } = makeDmaeService(emptyResult())
    const revisionClock = { next: vi.fn(), current: vi.fn(() => 0) }
    const broadcaster = { notify: vi.fn(), flush: vi.fn(), dispose: vi.fn() }

    const { hook } = createDmaeHook({
      logger: makeLogger(),
      dmaeService: service,
      getMemoryConfig: () => ({ ...MEM_CFG, dmae: { ...MEM_CFG.dmae, enabled: false } }),
      revisionClock,
      broadcaster
    })

    hook.fn({ event: 'turn.end' }, makeTurnEnd())

    expect(updateTurnSpy).not.toHaveBeenCalled()
    expect(broadcaster.notify).not.toHaveBeenCalled()
  })

  it('updateTurn 抛错 -> failOpen（不广播、不抛、返回 data）', () => {
    const updateTurnSpy = vi.fn(() => {
      throw new Error('engine boom')
    })
    const service = {
      initialize: () => {},
      selectL2: () => [],
      updateTurn: updateTurnSpy,
      getActivation: () => 0,
      getStats: () => ({ active: 0, dormant: 0, archived: 0 }),
      get lastSaveOk() {
        return true
      },
      getL2Total: () => 0,
      seedActivation: () => false,
      get pendingUserHitSessions() {
        return 0
      },
      get states() {
        return new Map()
      }
    } as unknown as DmaeEngineService
    const revisionClock = { next: vi.fn(), current: vi.fn(() => 0) }
    const broadcaster = { notify: vi.fn(), flush: vi.fn(), dispose: vi.fn() }

    const { hook } = createDmaeHook({
      logger: makeLogger(),
      dmaeService: service,
      getMemoryConfig: () => MEM_CFG,
      revisionClock,
      broadcaster
    })

    const res = hook.fn({ event: 'turn.end' }, makeTurnEnd()) as HookResult

    expect(updateTurnSpy).toHaveBeenCalledOnce()
    expect(broadcaster.notify).not.toHaveBeenCalled() // 抛错前未到广播
    expect(res.data).toBeDefined() // failOpen：仍返回 data
  })
})
