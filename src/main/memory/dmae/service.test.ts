// src/main/memory/dmae/service.test.ts
// P2-25：DMAE 引擎服务集成--selectL2 排序、updateTurn 编排、reconcile、持久化、
// "对话提及旧事实->activation 上升->进入 prompt"完整链路。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { createDmaeStateStore } from './state-file'
import {
  createDmaeEngineService,
  MAX_PENDING_HIT_SESSIONS,
  type DmaeEngineService
} from './service'
import type { L2Memory, L2Store, MemoryLifecycleState } from '../l2-store'
import type { MemoryConfig } from '@shared/config/types'
import type { Logger } from '@shared/observability/types'
import type { HydratedHit } from '../../prompts/builder'

function makeLogger(): Logger {
  return {
    child: () => makeLogger(),
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  } as unknown as Logger
}

const DEFAULT_CFG: MemoryConfig = {
  enabled: true,
  embeddingProvider: '',
  embeddingModel: '',
  embeddingDimension: 1024,
  maxActive: 15,
  minRetrievalScore: 0.35,
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
    presets: [],
    anomaly: {
      muted: {
        R01: 0,
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
      },
      windows: {
        R01: { days: 3 },
        R02: { days: 7 },
        R03: { days: 3 },
        R04: { turns: 50 },
        R05: { turns: 100 },
        R06: {},
        R07: { turns: 50 },
        R08: { turns: 200 },
        R09: { days: 3 },
        R10: { days: 3, turns: 100 },
        R11: { days: 7 },
        R12: {},
        R13: {}
      }
    },
    historySampleEveryTurns: 1
  }
} as MemoryConfig

function makeL2(
  id: string,
  importance = 5,
  lifecycleState: MemoryLifecycleState = 'active'
): L2Memory {
  return {
    id,
    evidenceIds: [],
    sourceMessageIds: [],
    triggerText: null,
    content: `content-${id}`,
    confidence: 0.8,
    syncStatus: 'synced',
    lifecycleState,
    isPinned: false,
    accessCount: 0,
    weight: 1,
    type: 'situational',
    importance,
    archivedAt: null,
    extractionKey: null,
    source: 'user_explicit'
  }
}

function makeMockL2Store(
  mems: L2Memory[]
): Pick<L2Store, 'list' | 'get' | 'count'> & { add(m: L2Memory): void } {
  const byId = new Map(mems.map((m) => [m.id, m]))
  return {
    list: (filter) => {
      let result = [...byId.values()]
      if (filter?.lifecycleState) {
        const states = Array.isArray(filter.lifecycleState)
          ? filter.lifecycleState
          : [filter.lifecycleState]
        result = result.filter((m) => states.includes(m.lifecycleState))
      }
      return result
    },
    get: (id) => byId.get(id) ?? null,
    count: () => byId.size,
    add: (m) => {
      byId.set(m.id, m)
    }
  }
}

function makeHit(id: string, score = 0.8, importance = 5): HydratedHit {
  return {
    memory: makeL2(id, importance),
    retrievalScore: score
  }
}

let tmpDir: string
let filePath: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmae-svc-'))
  filePath = path.join(tmpDir, 'dmae-state.json')
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function makeService(
  mems: L2Memory[],
  cfg: MemoryConfig = DEFAULT_CFG
): {
  service: DmaeEngineService
  l2Store: Pick<L2Store, 'list' | 'get' | 'count'> & { add(m: L2Memory): void }
} {
  const l2Store = makeMockL2Store(mems)
  const stateStore = createDmaeStateStore({ filePath, logger: makeLogger() })
  const service = createDmaeEngineService({
    stateStore,
    l2Store,
    getMemoryConfig: () => cfg,
    logger: makeLogger()
  })
  service.initialize()
  return { service, l2Store }
}

// === selectL2 ===

describe('P2-25 selectL2：按 activation 排序选 top maxActive', () => {
  it('按 activation 降序选 top maxActive', () => {
    const { service } = makeService([makeL2('m1', 5), makeL2('m2', 5), makeL2('m3', 5)])
    // 手动设 activation
    service.states.get('m1')!.activation = 50
    service.states.get('m2')!.activation = 80
    service.states.get('m3')!.activation = 30

    const hits = [makeHit('m1'), makeHit('m2'), makeHit('m3')]
    const selected = service.selectL2(hits, DEFAULT_CFG, 's1')
    expect(selected).toHaveLength(3)
    expect(selected[0].id).toBe('l2:m2') // activation 80
    expect(selected[1].id).toBe('l2:m1') // activation 50
    expect(selected[2].id).toBe('l2:m3') // activation 30
    expect(selected[0].rankSource).toBe('dmae-activation')
    expect(selected[0].selectionRank).toBe(80)
  })

  it('过滤 activation < threshold（Archived/Dormant 不进 prompt）', () => {
    const { service } = makeService([makeL2('m1', 5), makeL2('m2', 5)])
    service.states.get('m1')!.activation = 50 // Active
    service.states.get('m2')!.activation = 10 // Dormant

    const hits = [makeHit('m1'), makeHit('m2')]
    const selected = service.selectL2(hits, DEFAULT_CFG, 's1')
    expect(selected).toHaveLength(1)
    expect(selected[0].id).toBe('l2:m1')
  })

  it('同分按 id 升序（稳定 tiebreak，字典序）', () => {
    const { service } = makeService([makeL2('m10', 5), makeL2('m02', 5), makeL2('m01', 5)])
    service.states.get('m01')!.activation = 50
    service.states.get('m02')!.activation = 50
    service.states.get('m10')!.activation = 50

    const hits = [makeHit('m10'), makeHit('m02'), makeHit('m01')]
    const selected = service.selectL2(hits, DEFAULT_CFG, 's1')
    // 字典序：m01 < m02 < m10
    expect(selected.map((s) => s.id)).toEqual(['l2:m01', 'l2:m02', 'l2:m10'])
  })

  it('maxActive 截断', () => {
    const mems = Array.from({ length: 20 }, (_, i) => makeL2(`m${i}`, 5))
    const { service } = makeService(mems)
    for (let i = 0; i < 20; i++) {
      service.states.get(`m${i}`)!.activation = 30 + i
    }
    const hits = mems.map((m) => makeHit(m.id))
    const cfg = { ...DEFAULT_CFG, maxActive: 15 }
    const selected = service.selectL2(hits, cfg, 's1')
    expect(selected).toHaveLength(15)
    expect(selected[0].id).toBe('l2:m19') // 最高 49
  })

  it('selectionRank=activation, rankSource=dmae-activation, retrievalScore 保留', () => {
    const { service } = makeService([makeL2('m1', 5)])
    service.states.get('m1')!.activation = 42
    const hits = [makeHit('m1', 0.77)]
    const selected = service.selectL2(hits, DEFAULT_CFG, 's1')
    expect(selected[0].selectionRank).toBe(42)
    expect(selected[0].rankSource).toBe('dmae-activation')
    expect(selected[0].retrievalScore).toBe(0.77)
    expect(selected[0].content).toBe('content-m1')
  })

  it('新 L2 初始 Dormant（M-46：activation=importance×2 < threshold）-> 不进 prompt', () => {
    const { service } = makeService([makeL2('m1', 5)])
    // m1 刚初始化 activation=10（M-46 Dormant 缓冲带），仍 < threshold=30
    expect(service.states.get('m1')!.activation).toBe(10)
    const hits = [makeHit('m1')]
    const selected = service.selectL2(hits, DEFAULT_CFG, 's1')
    expect(selected).toHaveLength(0) // Dormant 不进 prompt
  })
})

// === updateTurn + selectL2 记录 userHitIds ===

describe('P2-25 updateTurn：用 selectL2 记录的 userHitIds + modelHitIds 更新', () => {
  it('selectL2 记录的 hits 成为 updateTurn 的 userHitIds', () => {
    const { service } = makeService([makeL2('m1', 60)])
    // m1 初始 Archived（activation=0）
    service.states.get('m1')!.activation = 0
    service.states.get('m1')!.userSilence = 5

    // selectL2 记录 m1 为 userHit（即使不进 prompt，因为 activation=0）
    const hits = [makeHit('m1', 0.9, 60)]
    service.selectL2(hits, DEFAULT_CFG, 's1')

    // updateTurn：userHit m1 -> Floor 复活到 importance=60
    const result = service.updateTurn('s1', [])
    expect(result.stats.userHits).toBe(1)
    expect(result.stats.floorRevivals).toBe(1)
    expect(service.states.get('m1')!.activation).toBe(60) // Floor=importance=60
  })

  it('modelHitIds 来自 referencedMemoryIds', () => {
    const { service } = makeService([makeL2('m1', 5)])
    service.states.get('m1')!.activation = 50 // Active
    service.states.get('m1')!.userSilence = 2

    // selectL2 记录 m1 为 userHit
    service.selectL2([makeHit('m1')], DEFAULT_CFG, 's1')
    // updateTurn：m1 既是 userHit 又是 modelHit
    const result = service.updateTurn('s1', ['m1'])
    expect(result.stats.userHits).toBe(1)
    expect(result.stats.modelHits).toBe(1)
  })

  it('updateTurn 后 userHitIds 桶清空（下一轮不残留）', () => {
    const { service } = makeService([makeL2('m1', 5)])
    service.states.get('m1')!.activation = 50
    service.selectL2([makeHit('m1')], DEFAULT_CFG, 's1')
    service.updateTurn('s1', [])
    // 第二轮不 selectL2，直接 updateTurn -> userHits=0
    const result = service.updateTurn('s1', [])
    expect(result.stats.userHits).toBe(0)
  })
})

// === reconcile ===

describe('P2-25 updateTurn reconcile', () => {
  it('新写入的 L2 在 updateTurn 时加入 states（M-46：importance 比例初始激活）', () => {
    const { service, l2Store } = makeService([makeL2('m1', 5)])
    expect(service.states.size).toBe(1)

    // 模拟新 L2 写入
    l2Store.add(makeL2('m2', 5))

    // updateTurn reconcile -> m2 加入（M-46：5×2=10，Dormant 缓冲带）
    // 注意：reconcile 后本轮引擎立即跑一遍——m2 无命中，沉默 1 轮衰减 (1.5+0.3)/√5
    service.updateTurn('s1', [])
    expect(service.states.size).toBe(2)
    expect(service.states.has('m2')).toBe(true)
    expect(service.states.get('m2')!.activation).toBeCloseTo(10 - 1.8 / Math.sqrt(5), 5)
  })

  it('L2 被删（不在 list）-> states 孤儿清理', () => {
    const { service } = makeService([makeL2('m1', 5), makeL2('m2', 5)])
    expect(service.states.size).toBe(2)

    // 模拟 m2 被删（list 只返回 m1）
    // 通过重新 makeService 模拟：这里直接验证 initialize 的 reconcile
    // updateTurn 也会 reconcile
    // 由于 mock l2Store 的 list 是固定的，我们需要改 mock
    // 简化：验证 initialize 的 reconcile 清理孤儿
    const stateStore = createDmaeStateStore({ filePath, logger: makeLogger() })
    // 先写入有孤儿的 state
    stateStore.save(
      new Map([
        ['m1', { activation: 50, userSilence: 0, modelSilence: 0, everActivated: true }],
        ['orphan', { activation: 30, userSilence: 0, modelSilence: 0, everActivated: true }]
      ]),
      0
    )
    const service2 = createDmaeEngineService({
      stateStore,
      l2Store: makeMockL2Store([makeL2('m1', 5)]), // 只有 m1，orphan 是孤儿
      getMemoryConfig: () => DEFAULT_CFG,
      logger: makeLogger()
    })
    service2.initialize()
    expect(service2.states.size).toBe(1)
    expect(service2.states.has('m1')).toBe(true)
    expect(service2.states.has('orphan')).toBe(false)
  })

  it('soft_deleted/purged 的 L2 不参与 DMAE（reconcile 只取 active/dormant/archived）', () => {
    const stateStore = createDmaeStateStore({ filePath, logger: makeLogger() })
    const service = createDmaeEngineService({
      stateStore,
      l2Store: makeMockL2Store([
        makeL2('m1', 5, 'active'),
        makeL2('m2', 5, 'soft_deleted'),
        makeL2('m3', 5, 'purged')
      ]),
      getMemoryConfig: () => DEFAULT_CFG,
      logger: makeLogger()
    })
    service.initialize()
    expect(service.states.size).toBe(1) // 只有 m1
    expect(service.states.has('m1')).toBe(true)
  })
})

// === 持久化 ===

describe('P2-25 updateTurn 持久化（重启延续）', () => {
  it('updateTurn 后 save -> 新服务实例 load 延续 activation', () => {
    const { service } = makeService([makeL2('m1', 60)])
    service.states.get('m1')!.activation = 0
    service.states.get('m1')!.userSilence = 5

    // 第 1 轮：userHit -> Floor 复活到 60
    service.selectL2([makeHit('m1', 0.9, 60)], DEFAULT_CFG, 's1')
    service.updateTurn('s1', [])
    expect(service.states.get('m1')!.activation).toBe(60)

    // 模拟重启：新服务实例 load
    const stateStore2 = createDmaeStateStore({ filePath, logger: makeLogger() })
    const service2 = createDmaeEngineService({
      stateStore: stateStore2,
      l2Store: makeMockL2Store([makeL2('m1', 60)]),
      getMemoryConfig: () => DEFAULT_CFG,
      logger: makeLogger()
    })
    service2.initialize()
    expect(service2.states.get('m1')!.activation).toBe(60) // 延续
  })

  it('P0: turn 跨重启单调延续，历史不再被覆盖', () => {
    const { service } = makeService([makeL2('m1', 5)])
    service.states.get('m1')!.activation = 50

    // 进程 1 内跑 2 轮 -> turn=2
    service.selectL2([makeHit('m1')], DEFAULT_CFG, 's1')
    service.updateTurn('s1', [])
    expect(service.turn).toBe(1)
    service.selectL2([makeHit('m1')], DEFAULT_CFG, 's1')
    service.updateTurn('s1', [])
    expect(service.turn).toBe(2)

    // 模拟重启：新服务实例应恢复到 turn=2（修复前是 0）
    const stateStore2 = createDmaeStateStore({ filePath, logger: makeLogger() })
    const service2 = createDmaeEngineService({
      stateStore: stateStore2,
      l2Store: makeMockL2Store([makeL2('m1', 5)]),
      getMemoryConfig: () => DEFAULT_CFG,
      logger: makeLogger()
    })
    service2.initialize()
    expect(service2.turn).toBe(2)

    // 重启后下一轮 -> turn=3（严格递增，绝不写回 1..2）
    service2.selectL2([makeHit('m1')], DEFAULT_CFG, 's1')
    service2.updateTurn('s1', [])
    expect(service2.turn).toBe(3)

    // 再重启一次，确认 3 也持久化
    const stateStore3 = createDmaeStateStore({ filePath, logger: makeLogger() })
    const service3 = createDmaeEngineService({
      stateStore: stateStore3,
      l2Store: makeMockL2Store([makeL2('m1', 5)]),
      getMemoryConfig: () => DEFAULT_CFG,
      logger: makeLogger()
    })
    service3.initialize()
    expect(service3.turn).toBe(3)
  })
})

// === P2-25 验收：对话提及旧事实 -> activation 上升 -> 进入 prompt ===

describe('P2-25 验收：对话提及旧事实 -> activation 上升 -> 进入 prompt', () => {
  it('第 1 轮提及 -> Floor 复活；第 2 轮进 prompt', () => {
    const { service } = makeService([makeL2('m1', 60)]) // importance=60 -> Floor=60 Active
    // m1 初始 Archived（activation=0），久未提及
    service.states.get('m1')!.activation = 0
    service.states.get('m1')!.userSilence = 10
    service.states.get('m1')!.modelSilence = 10

    // 第 1 轮：用户提及旧事实 -> 检索命中 m1 -> selectL2（m1 不进 prompt，activation=0）
    const hits = [makeHit('m1', 0.9, 60)]
    const selected1 = service.selectL2(hits, DEFAULT_CFG, 's1')
    expect(selected1).toHaveLength(0) // activation=0 < threshold，不进 prompt

    // turn.end -> updateTurn（userHit m1 -> Floor 复活到 60）
    service.updateTurn('s1', [])
    expect(service.states.get('m1')!.activation).toBe(60) // Floor=importance=60

    // 第 2 轮：m1 activation=60 -> selectL2 选中 -> 进 prompt
    const selected2 = service.selectL2(hits, DEFAULT_CFG, 's1')
    expect(selected2).toHaveLength(1)
    expect(selected2[0].id).toBe('l2:m1')
    expect(selected2[0].selectionRank).toBe(60)
    expect(selected2[0].rankSource).toBe('dmae-activation')
  })

  it('importance=5 的记忆需多次提及（Floor=5，Ru(0)=20 需 2 轮到 Active）', () => {
    const { service } = makeService([makeL2('m1', 5)]) // importance=5
    service.states.get('m1')!.activation = 0
    service.states.get('m1')!.userSilence = 0
    service.states.get('m1')!.modelSilence = 0

    // 第 1 轮：提及 -> Ru(0)=20, Floor=max(20,5)=20 -> activation=20（Dormant, <30）
    service.selectL2([makeHit('m1', 0.9, 5)], DEFAULT_CFG, 's1')
    service.updateTurn('s1', [])
    expect(service.states.get('m1')!.activation).toBe(20) // Dormant

    // 第 2 轮：activation=20 < threshold -> 不进 prompt
    const selected2 = service.selectL2([makeHit('m1', 0.9, 5)], DEFAULT_CFG, 's1')
    expect(selected2).toHaveLength(0)

    // 第 2 轮再次提及 -> Ru(0)=20, aNew=20+20=40（Active）
    service.updateTurn('s1', [])
    expect(service.states.get('m1')!.activation).toBe(40)

    // 第 3 轮：activation=40 >= threshold -> 进 prompt
    const selected3 = service.selectL2([makeHit('m1', 0.9, 5)], DEFAULT_CFG, 's1')
    expect(selected3).toHaveLength(1)
    expect(selected3[0].selectionRank).toBe(40)
  })
})

// === getStats ===

describe('getStats 各态计数', () => {
  it('统计 active/dormant/archived', () => {
    const { service } = makeService([makeL2('m1', 5), makeL2('m2', 5), makeL2('m3', 5)])
    service.states.get('m1')!.activation = 50 // Active
    service.states.get('m2')!.activation = 15 // Dormant
    service.states.get('m3')!.activation = 0 // Archived
    expect(service.getStats()).toEqual({ active: 1, dormant: 1, archived: 1 })
  })
})

// === getActivation ===

describe('getActivation', () => {
  it('有 state 返回 activation', () => {
    const { service } = makeService([makeL2('m1', 5)])
    service.states.get('m1')!.activation = 42
    expect(service.getActivation('m1')).toBe(42)
  })
  it('无 state 返回 0', () => {
    const { service } = makeService([makeL2('m1', 5)])
    expect(service.getActivation('unknown')).toBe(0)
  })
})

// === C-γ-2：跨会话命中隔离 + 孤儿桶兜底 ===
// 依据：2026-08-03 审计裁定 R-6 / 交接文档 C-γ-2。隔离键=sessionId（架构裁定）。

describe('C-γ-2 跨会话命中隔离（sessionId 分桶）', () => {
  it('A/B 交错 selectL2 -> updateTurn(A) 只消费 A 的 userHitIds（不串线）', () => {
    const { service } = makeService([makeL2('a1', 60), makeL2('b1', 60)])
    // 两个记忆都从 Archived 开始（activation=0），userSilence 高 -> Floor 复活可见
    service.states.get('a1')!.activation = 0
    service.states.get('a1')!.userSilence = 5
    service.states.get('b1')!.activation = 0
    service.states.get('b1')!.userSilence = 5

    // A 会话 selectL2 命中 a1（记录到 sessionA 桶）
    service.selectL2([makeHit('a1', 0.9, 60)], DEFAULT_CFG, 'sessionA')
    // B 会话 selectL2 命中 b1（旧实现会覆盖全局 Set，新实现写到 sessionB 桶）
    service.selectL2([makeHit('b1', 0.9, 60)], DEFAULT_CFG, 'sessionB')

    // A 会话 turn.end -> updateTurn 只应消费 A 的命中（a1），不应激活 b1
    const result = service.updateTurn('sessionA', [])
    expect(result.stats.userHits).toBe(1) // 只有 a1
    // a1 被 Floor 复活到 importance=60
    expect(service.states.get('a1')!.activation).toBe(60)
    // b1 不应被 A 的轮次激活--这是串线检查的核心
    expect(service.states.get('b1')!.activation).toBe(0)
  })

  it('updateTurn(A) 后 updateTurn(B) 各自独立消费自己的命中集', () => {
    const { service } = makeService([makeL2('a1', 60), makeL2('b1', 60)])
    service.states.get('a1')!.activation = 0
    service.states.get('a1')!.userSilence = 5
    service.states.get('b1')!.activation = 0
    service.states.get('b1')!.userSilence = 5

    service.selectL2([makeHit('a1', 0.9, 60)], DEFAULT_CFG, 'sessionA')
    service.selectL2([makeHit('b1', 0.9, 60)], DEFAULT_CFG, 'sessionB')

    // A 先消费
    service.updateTurn('sessionA', [])
    expect(service.states.get('a1')!.activation).toBe(60)
    expect(service.states.get('b1')!.activation).toBe(0)

    // B 后消费 -- B 的桶还在，没有被 A 吃掉
    const resultB = service.updateTurn('sessionB', [])
    expect(resultB.stats.userHits).toBe(1)
    expect(service.states.get('b1')!.activation).toBe(60)
  })

  it('同一 session 连续多轮 selectL2 只占 1 桶（刷新而非新增）', () => {
    const { service } = makeService([makeL2('m1', 60)])
    service.selectL2([makeHit('m1', 0.9, 60)], DEFAULT_CFG, 'sameSession')
    service.selectL2([makeHit('m1', 0.9, 60)], DEFAULT_CFG, 'sameSession')
    service.selectL2([makeHit('m1', 0.9, 60)], DEFAULT_CFG, 'sameSession')
    expect(service.pendingUserHitSessions).toBe(1)
  })

  it('未调 selectL2 的 session -> updateTurn 得空 userHits（不报错，只沉默衰减）', () => {
    const { service } = makeService([makeL2('m1', 5)])
    service.states.get('m1')!.activation = 50
    // 直接 updateTurn，不调 selectL2
    const result = service.updateTurn('neverSelected', [])
    expect(result.stats.userHits).toBe(0)
    expect(result.stats.modelHits).toBe(0)
  })
})

describe('C-γ-2 孤儿桶兜底（turn.end 永不触发时有界）', () => {
  it('selectL2 × (MAX+5) 不同 session 无 updateTurn -> 桶数 <= MAX', () => {
    const { service } = makeService([])
    // 用超过 MAX_PENDING_HIT_SESSIONS 个不同 session 调 selectL2，永不 updateTurn
    for (let i = 0; i < MAX_PENDING_HIT_SESSIONS + 5; i++) {
      service.selectL2([], DEFAULT_CFG, `orphan-${i}`)
    }
    // LRU 淘汰保证有界
    expect(service.pendingUserHitSessions).toBeLessThanOrEqual(MAX_PENDING_HIT_SESSIONS)
  })

  it('LRU 淘汰最老的桶：溢出后最早 session 的 updateTurn 得空 userHits', () => {
    const { service } = makeService([makeL2('m1', 60)])
    service.states.get('m1')!.activation = 0
    service.states.get('m1')!.userSilence = 5

    // 第 1 个 session 命中 m1（将成为最老桶）
    service.selectL2([makeHit('m1', 0.9, 60)], DEFAULT_CFG, 'oldest')
    // 用 MAX 个不同 session 挤掉 oldest 桶
    for (let i = 0; i < MAX_PENDING_HIT_SESSIONS; i++) {
      service.selectL2([], DEFAULT_CFG, `other-${i}`)
    }
    // oldest 桶已被淘汰 -> updateTurn('oldest') 得空 userHits，m1 不被激活
    const result = service.updateTurn('oldest', [])
    expect(result.stats.userHits).toBe(0)
    expect(service.states.get('m1')!.activation).toBe(0)
  })

  it('正常 updateTurn 清理桶 -> 不触发淘汰', () => {
    const { service } = makeService([makeL2('m1', 5)])
    service.selectL2([makeHit('m1')], DEFAULT_CFG, 's1')
    expect(service.pendingUserHitSessions).toBe(1)
    service.updateTurn('s1', [])
    expect(service.pendingUserHitSessions).toBe(0)
  })
})

// === P2-31.5E：selectL2 lastSelection 诊断摘要（F5-002 §3.7）===

describe('P2-31.5E: selectL2 lastSelection 诊断摘要', () => {
  it('初始 lastSelection = null（尚无已提交的 turn）', () => {
    const { service } = makeService([makeL2('m1', 5)])
    expect(service.lastSelection).toBeNull()
    expect(service.turn).toBe(0)
  })

  it('召回 6、Active 4 -> 提交后 lastSelection.retrievalHits=6, promptSelected=4', () => {
    // 6 条记忆，4 条 activation >= threshold(30)，2 条 < threshold
    const l2s = [
      makeL2('m1', 5), // importance=5 -> 填 activation 后用
      makeL2('m2', 5),
      makeL2('m3', 5),
      makeL2('m4', 5),
      makeL2('m5', 5),
      makeL2('m6', 5)
    ]
    const { service } = makeService(l2s)
    // 手动设 activation：4 条 >= 30，2 条 < 30
    service.states.get('m1')!.activation = 80
    service.states.get('m2')!.activation = 60
    service.states.get('m3')!.activation = 50
    service.states.get('m4')!.activation = 40
    service.states.get('m5')!.activation = 10 // < 30
    service.states.get('m6')!.activation = 5 // < 30

    // 6 条全部检索命中
    const hits = [
      makeHit('m1', 0.9),
      makeHit('m2', 0.8),
      makeHit('m3', 0.7),
      makeHit('m4', 0.6),
      makeHit('m5', 0.5),
      makeHit('m6', 0.4)
    ]
    const selected = service.selectL2(hits, DEFAULT_CFG, 's1')
    expect(selected).toHaveLength(4)

    // P2：selectL2 只暂存（pending），updateTurn 才提交为 lastSelection
    expect(service.lastSelection).toBeNull()
    service.updateTurn('s1', [])

    // 验收：retrievalHits=6, promptSelected=4（只有 4 条 >= threshold）
    expect(service.lastSelection).not.toBeNull()
    expect(service.lastSelection!.retrievalHits).toBe(6)
    expect(service.lastSelection!.promptSelected).toBe(4)
    // selectedIds 是被选中的 memory ID（不含 l2: 前缀）
    expect(service.lastSelection!.selectedIds).toEqual(['m1', 'm2', 'm3', 'm4'])
    // maxActive 来自 config（默认 15）
    expect(service.lastSelection!.maxActive).toBe(15)
    // atTurn = 提交时递增后的 turn（第 1 轮 -> 1）
    expect(service.lastSelection!.atTurn).toBe(1)
  })

  it('全局 eligibleActive 与 promptSelected 不混用', () => {
    // eligibleActive = 全库 activation >= threshold 的条数
    // promptSelected = 本轮检索命中且 >= threshold 且 <= maxActive 的条数
    const l2s = [makeL2('m1', 5), makeL2('m2', 5), makeL2('m3', 5)]
    const { service } = makeService(l2s)
    // 全部 3 条都 >= threshold（eligibleActive=3）
    service.states.get('m1')!.activation = 50
    service.states.get('m2')!.activation = 60
    service.states.get('m3')!.activation = 70

    // 但只检索命中 1 条
    const selected = service.selectL2([makeHit('m1', 0.9)], DEFAULT_CFG, 's1')
    expect(selected).toHaveLength(1)
    service.updateTurn('s1', [])
    expect(service.lastSelection!.retrievalHits).toBe(1)
    expect(service.lastSelection!.promptSelected).toBe(1)
    // eligibleActive（getStats 的 active）= 3，与 promptSelected=1 不同
    expect(service.getStats().active).toBe(3)
  })

  it('updateTurn 递增 turn 计数器，提交的 atTurn 随轮次递增', () => {
    const { service } = makeService([makeL2('m1', 5)])
    service.states.get('m1')!.activation = 50

    service.selectL2([makeHit('m1')], DEFAULT_CFG, 's1')
    service.updateTurn('s1', [])
    expect(service.turn).toBe(1)
    expect(service.lastSelection!.atTurn).toBe(1)

    // 下轮 selectL2 + updateTurn -> atTurn=2
    service.selectL2([makeHit('m1')], DEFAULT_CFG, 's1')
    service.updateTurn('s1', [])
    expect(service.lastSelection!.atTurn).toBe(2)
  })

  it('本轮无 selectL2（无检索）-> 提交 null，不残留上一轮值', () => {
    const { service } = makeService([makeL2('m1', 5)])
    service.states.get('m1')!.activation = 50
    service.selectL2([makeHit('m1')], DEFAULT_CFG, 's1')
    service.updateTurn('s1', [])
    expect(service.lastSelection).not.toBeNull()

    // 第二轮无 selectL2 直接 updateTurn -> 提交 null
    service.updateTurn('s1', [])
    expect(service.lastSelection).toBeNull()
  })

  it('maxActive 截断：召回 20 条但 maxActive=15 -> promptSelected=15', () => {
    const l2s = Array.from({ length: 20 }, (_, i) => makeL2(`m${i}`, 5))
    const { service } = makeService(l2s)
    // 全部 >= threshold
    for (const st of service.states.values()) {
      st.activation = 50
    }
    // 全部检索命中
    const hits = l2s.map((l2) => makeHit(l2.id, 0.5))
    const selected = service.selectL2(hits, DEFAULT_CFG, 's1')
    expect(selected).toHaveLength(15)
    service.updateTurn('s1', [])
    expect(service.lastSelection!.retrievalHits).toBe(20)
    expect(service.lastSelection!.promptSelected).toBe(15)
    expect(service.lastSelection!.selectedIds).toHaveLength(15)
  })
})

// === P2（2026-08-10 审计）：selection 跨会话绑定（A/B 串扰修复）===

describe('P2: selection 按 session 绑定，A/B 交错各自提交', () => {
  it('A selectL2、B selectL2、A updateTurn -> A 提交 A 的 selection（不是 B 的）', () => {
    const { service } = makeService([makeL2('a1', 60), makeL2('b1', 60)])
    service.states.get('a1')!.activation = 50
    service.states.get('b1')!.activation = 50

    service.selectL2([makeHit('a1')], DEFAULT_CFG, 'sessionA')
    service.selectL2([makeHit('b1')], DEFAULT_CFG, 'sessionB')
    // A 先 turn.end
    service.updateTurn('sessionA', [])
    // A 提交的必须是 A 的 selection（retrievalHits=1, selectedIds=[a1]）
    expect(service.lastSelection!.selectedIds).toEqual(['a1'])

    // B 后 turn.end -> 提交 B 的 selection
    service.updateTurn('sessionB', [])
    expect(service.lastSelection!.selectedIds).toEqual(['b1'])
  })

  it('selection 桶被 LRU 淘汰后 updateTurn -> 提交 null（不误用其他会话）', () => {
    const { service } = makeService([makeL2('m1', 60)])
    service.states.get('m1')!.activation = 50
    service.selectL2([makeHit('m1')], DEFAULT_CFG, 'oldest')
    // 用 MAX 个会话挤掉 oldest 的 selection 桶
    for (let i = 0; i < MAX_PENDING_HIT_SESSIONS; i++) {
      service.selectL2([], DEFAULT_CFG, `other-${i}`)
    }
    service.updateTurn('oldest', [])
    expect(service.lastSelection).toBeNull()
  })
})
