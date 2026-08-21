// src/main/memory/conflict/resolver.test.ts
// P2-20 ConflictResolver + ConflictService：LLM 裁决 + 检测/解决/日志/写回。
// 依据 S-Phase2 P2-20 验收 + S-004-补充 I-02。
//
// 测试策略：
//   - faux embedding 返回固定向量 [1,0,0,0] -> 所有内容 cosine 相似度 = 1.0
//     （让向量检索总能找到已有记忆，聚焦测试冲突逻辑而非检索质量）
//   - FauxExtractionProvider 返回 resolution JSON
//   - 时钟注入确定性
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeMemoryDb, testNoopLogger, type TestDb } from '../../../../tests/helpers/test-db'
import { createL2Store } from '../l2-store'
import { createSQLiteVectorStore } from '../vector/sqlite-vector-store'
import { createMemoryRevisionClock } from '../revision-clock'
import { createMemoryWriter } from '../writer'
import { createFauxExtractionProvider } from '../extraction/provider'
import { createConflictLogStore } from './log'
import {
  createConflictResolver,
  createConflictService,
  computeConflictSignals,
  type ConflictPair
} from './resolver'
import type { L2Memory } from '../l2-store'
import type { EmbeddingClient } from '../embedding'
import type { MemoryConfig } from '@shared/config/types'

const DIM = 4

/** 确定性 embedding：所有内容返回 [1,0,0,0] -> cosine 相似度恒为 1.0 */
function makeDeterministicEmbedding(): EmbeddingClient {
  return {
    async embed(): Promise<Float32Array> {
      const v = new Float32Array(DIM)
      v[0] = 1.0
      return v
    },
    async embedBatch(texts: string[]): Promise<Float32Array[]> {
      return texts.map(() => {
        const v = new Float32Array(DIM)
        v[0] = 1.0
        return v
      })
    }
  }
}

const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: true,
  embeddingProvider: 'openai-compatible',
  embeddingModel: 'text-embedding-3-small',
  embeddingDimension: DIM,
  maxActive: 15,
  minRetrievalScore: 0.35,
  dmae: {
    enabled: false,
    maxScore: 100,
    promptThreshold: 30,
    userRewardBase: 100,
    wakeGamma: 0.5,
    modelRewardBase: 30,
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
}

describe('P2-20 ConflictResolver (LLM 裁决)', () => {
  function makePair(overrides: Partial<ConflictPair> = {}): ConflictPair {
    const newMemory: L2Memory = {
      id: 'l2_new1',
      evidenceIds: ['msg_2'],
      sourceMessageIds: ['msg_2'],
      triggerText: '其实我不喝咖啡了',
      content: '用户不喝咖啡了',
      confidence: 0.8,
      syncStatus: 'synced',
      lifecycleState: 'active',
      isPinned: false,
      accessCount: 0,
      weight: 1,
      type: 'stable',
      importance: 8,
      archivedAt: null,
      extractionKey: null,
      source: 'user_explicit',
      importanceBeforePin: null,
      editedAt: null
    }
    const existingMemory: L2Memory = {
      id: 'l2_old1',
      evidenceIds: ['msg_1'],
      sourceMessageIds: ['msg_1'],
      triggerText: '我喜欢咖啡',
      content: '用户喜欢咖啡',
      confidence: 0.8,
      syncStatus: 'synced',
      lifecycleState: 'active',
      isPinned: false,
      accessCount: 0,
      weight: 1,
      type: 'stable',
      importance: 8,
      archivedAt: null,
      extractionKey: null,
      source: 'user_explicit',
      importanceBeforePin: null,
      editedAt: null
    }
    return {
      newMemory,
      existingMemory,
      ragScore: 0.9,
      score: { score: 80, band: 'high', breakdown: {}, overridden: false },
      ...overrides
    }
  }

  it('LLM 返回 supersede -> 返回 supersede', async () => {
    const faux = createFauxExtractionProvider()
    faux.setResponses([JSON.stringify({ resolution: 'supersede', rationale: '用户纠正' })])
    const resolver = createConflictResolver({ provider: faux, logger: testNoopLogger })
    const result = await resolver.resolve(makePair(), new AbortController().signal)
    expect(result).toBe('supersede')
    expect(faux.calls()).toHaveLength(1)
  })

  it('LLM 返回 coexist -> 返回 coexist', async () => {
    const faux = createFauxExtractionProvider()
    faux.setResponses([JSON.stringify({ resolution: 'coexist', rationale: '不同情境' })])
    const resolver = createConflictResolver({ provider: faux, logger: testNoopLogger })
    const result = await resolver.resolve(makePair(), new AbortController().signal)
    expect(result).toBe('coexist')
  })

  it('LLM 返回 reject -> 返回 reject', async () => {
    const faux = createFauxExtractionProvider()
    faux.setResponses([JSON.stringify({ resolution: 'reject', rationale: '新记忆错误' })])
    const resolver = createConflictResolver({ provider: faux, logger: testNoopLogger })
    const result = await resolver.resolve(makePair(), new AbortController().signal)
    expect(result).toBe('reject')
  })

  it('LLM 返回非法 JSON -> fail-safe coexist', async () => {
    const faux = createFauxExtractionProvider()
    faux.setResponses(['not json at all'])
    const resolver = createConflictResolver({ provider: faux, logger: testNoopLogger })
    const result = await resolver.resolve(makePair(), new AbortController().signal)
    expect(result).toBe('coexist')
  })

  it('LLM 返回非法 resolution 值 -> fail-safe coexist', async () => {
    const faux = createFauxExtractionProvider()
    faux.setResponses([JSON.stringify({ resolution: 'invalid', rationale: '?' })])
    const resolver = createConflictResolver({ provider: faux, logger: testNoopLogger })
    const result = await resolver.resolve(makePair(), new AbortController().signal)
    expect(result).toBe('coexist')
  })

  it('LLM 调用抛错 -> fail-safe coexist', async () => {
    const faux = createFauxExtractionProvider()
    // 队列空 -> 抛错
    const resolver = createConflictResolver({ provider: faux, logger: testNoopLogger })
    const result = await resolver.resolve(makePair(), new AbortController().signal)
    expect(result).toBe('coexist')
  })

  it('resolver prompt temperature=0 + 结构化输出', async () => {
    const faux = createFauxExtractionProvider()
    faux.setResponses([JSON.stringify({ resolution: 'supersede', rationale: '纠正' })])
    const resolver = createConflictResolver({ provider: faux, logger: testNoopLogger })
    await resolver.resolve(makePair(), new AbortController().signal)
    const call = faux.calls()[0]
    expect(call.temperature).toBe(0)
    expect(call.messages[0].role).toBe('system')
    expect(call.messages[1].role).toBe('user')
    // user message 含记忆内容（作为数据）
    expect(call.messages[1].content).toContain('用户不喝咖啡了')
    expect(call.messages[1].content).toContain('用户喜欢咖啡')
  })
})

describe('P2-20 computeConflictSignals (启发式信号)', () => {
  function makePair(
    newContent: string,
    existingContent: string,
    trigger: string | null
  ): ConflictPair {
    const base: L2Memory = {
      id: 'l2_x',
      evidenceIds: ['msg_1'],
      sourceMessageIds: ['msg_1'],
      triggerText: null,
      content: '',
      confidence: 0.8,
      syncStatus: 'synced',
      lifecycleState: 'active',
      isPinned: false,
      accessCount: 0,
      weight: 1,
      type: 'stable',
      importance: 8,
      archivedAt: null,
      extractionKey: null,
      source: 'user_explicit',
      importanceBeforePin: null,
      editedAt: null
    }
    return {
      newMemory: { ...base, id: 'l2_new', content: newContent, triggerText: trigger },
      existingMemory: { ...base, id: 'l2_old', content: existingContent },
      ragScore: 0.9,
      score: { score: 0, band: 'none', breakdown: {}, overridden: false }
    }
  }

  it('correctionIntent: triggerText 含 "其实" -> true', () => {
    const pair = makePair('用户不喝咖啡', '用户喜欢咖啡', '其实我不喝咖啡了')
    const score = computeConflictSignals(pair, { recentlyResolved: false, now: () => 0 })
    expect(score.breakdown.correctionIntent).toBe(20)
  })

  it('correctionIntent: triggerText 为 null -> false', () => {
    const pair = makePair('用户不喝咖啡', '用户喜欢咖啡', null)
    const score = computeConflictSignals(pair, { recentlyResolved: false, now: () => 0 })
    expect(score.breakdown.correctionIntent).toBe(0)
  })

  it('localContradiction: 一方有否定一方没有 -> true', () => {
    const pair = makePair('用户不喜欢咖啡', '用户喜欢咖啡', null)
    const score = computeConflictSignals(pair, { recentlyResolved: false, now: () => 0 })
    expect(score.breakdown.localContradiction).toBe(10)
  })

  it('localContradiction: 双方都有否定 -> false', () => {
    const pair = makePair('用户不喜欢咖啡', '用户不喝咖啡', null)
    const score = computeConflictSignals(pair, { recentlyResolved: false, now: () => 0 })
    expect(score.breakdown.localContradiction).toBe(0)
  })

  it('impactScope: stable -> high (+10)', () => {
    const pair = makePair('a', 'b', null)
    const score = computeConflictSignals(pair, { recentlyResolved: false, now: () => 0 })
    expect(score.breakdown.impactScope).toBe(10)
  })

  it('recentlyResolved -> -25', () => {
    const pair = makePair('a', 'b', null)
    const score = computeConflictSignals(pair, { recentlyResolved: true, now: () => 0 })
    expect(score.breakdown.recentlyResolved).toBe(-25)
  })

  it('detectionSource=rag（不触发安全兜底）', () => {
    const pair = makePair('a', 'b', null)
    const score = computeConflictSignals(pair, { recentlyResolved: false, now: () => 0 })
    expect(score.overridden).toBe(false)
  })
})

describe('P2-20/21 ConflictService (检测 + 解决 + 日志)', () => {
  let t: TestDb
  let l2Store: ReturnType<typeof createL2Store>
  let vectorStore: ReturnType<typeof createSQLiteVectorStore>
  let revisionClock: ReturnType<typeof createMemoryRevisionClock>
  let writer: ReturnType<typeof createMemoryWriter>
  let logStore: ReturnType<typeof createConflictLogStore>
  let faux: ReturnType<typeof createFauxExtractionProvider>
  let resolver: ReturnType<typeof createConflictResolver>
  let service: ReturnType<typeof createConflictService>
  let clock: number
  let l2c: number

  beforeEach(async () => {
    t = await makeMemoryDb()
    clock = 1710000000000
    l2c = 0
    l2Store = createL2Store({
      db: t.db,
      now: () => clock,
      randomSuffix: () => `s${l2c++}`
    })
    vectorStore = createSQLiteVectorStore({ db: t.db, dim: DIM, logger: testNoopLogger })
    await vectorStore.init()
    revisionClock = createMemoryRevisionClock(t.db)
    const embedding = makeDeterministicEmbedding()
    writer = createMemoryWriter({
      db: t.db,
      l2Store,
      vectorStore,
      embedding,
      revisionClock,
      logger: testNoopLogger
    })
    logStore = createConflictLogStore({
      db: t.db,
      now: () => clock,
      randomSuffix: () => `cf${clock}_${l2c++}`
    })
    faux = createFauxExtractionProvider()
    resolver = createConflictResolver({ provider: faux, logger: testNoopLogger })
    service = createConflictService({
      l2Store,
      vectorStore,
      embedding,
      resolver,
      logStore,
      revisionClock,
      logger: testNoopLogger,
      getMemoryConfig: () => DEFAULT_MEMORY_CONFIG,
      now: () => clock
    })
  })
  afterEach(() => t.cleanup())

  async function writeL2(
    content: string,
    triggerText: string,
    type: L2Memory['type'] = 'stable'
  ): Promise<L2Memory> {
    const result = await writer.writeL2(
      {
        content,
        confidence: 0.8,
        evidenceIds: ['msg_1'],
        sourceMessageIds: ['msg_1'],
        triggerText,
        type,
        importance: 8,
        sourceMessageId: 'msg_1',
        fieldOrType: type
      },
      { sessionId: 's1', turnId: 't1' }
    )
    return l2Store.get(result.memoryId!)!
  }

  it('I-02: "喜欢咖啡" -> "不喝咖啡了" -> high band -> supersede -> 旧记忆归档', async () => {
    // 1. 预置旧记忆
    const oldMem = await writeL2('用户喜欢咖啡', '我喜欢咖啡')
    // 2. 写新记忆
    const newMem = await writeL2('用户不喝咖啡了', '其实我不喝咖啡了')
    // 3. resolver 返回 supersede
    faux.setResponses([JSON.stringify({ resolution: 'supersede', rationale: '用户纠正了偏好' })])

    // 4. 冲突检测
    const results = await service.checkAndResolve(newMem, { sessionId: 's1', turnId: 't2' })

    // 5. 断言
    expect(results).toHaveLength(1)
    expect(results[0].pair.score.band).toBe('high')
    expect(results[0].pair.score.score).toBeGreaterThanOrEqual(55) // I-02 断言
    expect(results[0].resolution).toBe('supersede')

    // 旧记忆被归档
    const updatedOld = l2Store.get(oldMem.id)
    expect(updatedOld?.lifecycleState).toBe('archived')
    expect(updatedOld?.archivedAt).toBe(clock)

    // 新记忆仍活跃
    const updatedNew = l2Store.get(newMem.id)
    expect(updatedNew?.lifecycleState).toBe('active')

    // conflict_log 1 行
    expect(logStore.count()).toBe(1)
    const logEntry = logStore.list()[0]
    expect(logEntry.resolution).toBe('supersede')
    expect(logEntry.band).toBe('high')
    expect(logEntry.newMemoryId).toBe(newMem.id)
    expect(logEntry.existingMemoryId).toBe(oldMem.id)
  })

  it('high band -> resolver 调用 1 次', async () => {
    await writeL2('用户喜欢咖啡', '我喜欢咖啡')
    const newMem = await writeL2('用户不喝咖啡了', '其实我不喝咖啡了')
    faux.setResponses([JSON.stringify({ resolution: 'coexist', rationale: '' })])

    await service.checkAndResolve(newMem, { sessionId: 's1', turnId: 't2' })

    expect(faux.calls()).toHaveLength(1)
  })

  it('coexist: 不改任何 L2 状态', async () => {
    const oldMem = await writeL2('用户喜欢咖啡', '我喜欢咖啡')
    const newMem = await writeL2('用户不喝咖啡了', '其实我不喝咖啡了')
    faux.setResponses([JSON.stringify({ resolution: 'coexist', rationale: '' })])

    await service.checkAndResolve(newMem, { sessionId: 's1', turnId: 't2' })

    expect(l2Store.get(oldMem.id)?.lifecycleState).toBe('active')
    expect(l2Store.get(newMem.id)?.lifecycleState).toBe('active')
  })

  it('reject: 新记忆 soft_deleted', async () => {
    await writeL2('用户喜欢咖啡', '我喜欢咖啡')
    const newMem = await writeL2('用户不喝咖啡了', '其实我不喝咖啡了')
    faux.setResponses([JSON.stringify({ resolution: 'reject', rationale: '新记忆错误' })])

    await service.checkAndResolve(newMem, { sessionId: 's1', turnId: 't2' })

    expect(l2Store.get(newMem.id)?.lifecycleState).toBe('soft_deleted')
  })

  it('reject 短路：resolver 判新记忆错误后，剩余冲突对不再处理（用已删记忆 supersede 其他旧记忆）', async () => {
    // 预置两条与"新记忆"冲突的旧记忆（都满足 high band，需与 newMem 语义相似）
    const oldMemA = await writeL2('用户喜欢咖啡', '我喜欢咖啡')
    const oldMemB = await writeL2('用户喝咖啡加糖', '我喜欢喝咖啡加糖')
    const newMem = await writeL2('用户不喝咖啡了', '其实我不喝咖啡了')

    // 队列只有 1 条响应：reject。修复前循环会继续消费空队列抛错（Faux 空队列报错），
    // 或若队列给第二条则会错误地继续处理；修复后 reject 即 break，只消费 1 条。
    faux.setResponses([JSON.stringify({ resolution: 'reject', rationale: '新记忆错误' })])

    const results = await service.checkAndResolve(newMem, { sessionId: 's1', turnId: 't2' })

    // 只产生 1 条结果（reject 短路）
    expect(results).toHaveLength(1)
    expect(results[0].resolution).toBe('reject')
    // 新记忆被软删
    expect(l2Store.get(newMem.id)?.lifecycleState).toBe('soft_deleted')
    // 但旧记忆都未被 supersede（reject 后不再用已删新记忆去归档其他旧记忆）
    expect(l2Store.get(oldMemA.id)?.lifecycleState).not.toBe('archived')
    expect(l2Store.get(oldMemB.id)?.lifecycleState).not.toBe('archived')
    // Faux 只消费了 1 条响应（短路成立）
    expect(faux.pending()).toBe(0)
  })

  it('resolver 失败 -> fail-safe coexist，不删任何记忆', async () => {
    const oldMem = await writeL2('用户喜欢咖啡', '我喜欢咖啡')
    const newMem = await writeL2('用户不喝咖啡了', '其实我不喝咖啡了')
    // faux 队列为空 -> 抛错
    faux.setResponses([])

    const results = await service.checkAndResolve(newMem, { sessionId: 's1', turnId: 't2' })

    expect(results[0].resolution).toBe('coexist')
    expect(l2Store.get(oldMem.id)?.lifecycleState).toBe('active')
    expect(l2Store.get(newMem.id)?.lifecycleState).toBe('active')
  })

  it('embedding=null -> 跳过冲突检测', async () => {
    await writeL2('用户喜欢咖啡', '我喜欢咖啡')
    const newMem = await writeL2('用户不喝咖啡了', '其实我不喝咖啡了')

    const serviceNoEmbed = createConflictService({
      l2Store,
      vectorStore,
      embedding: null,
      resolver,
      logStore,
      revisionClock,
      logger: testNoopLogger,
      getMemoryConfig: () => DEFAULT_MEMORY_CONFIG,
      now: () => clock
    })

    const results = await serviceNoEmbed.checkAndResolve(newMem, {
      sessionId: 's1',
      turnId: 't2'
    })

    expect(results).toHaveLength(0)
    expect(logStore.count()).toBe(0)
  })

  it('无相似记忆 -> 空结果', async () => {
    // 只写一条新记忆，不写旧记忆
    const newMem = await writeL2('用户喜欢咖啡', '我喜欢咖啡')

    const results = await service.checkAndResolve(newMem, {
      sessionId: 's1',
      turnId: 't2'
    })

    expect(results).toHaveLength(0)
    expect(logStore.count()).toBe(0)
  })

  it('conflict.resolved 事件发射', async () => {
    await writeL2('用户喜欢咖啡', '我喜欢咖啡')
    const newMem = await writeL2('用户不喝咖啡了', '其实我不喝咖啡了')
    faux.setResponses([JSON.stringify({ resolution: 'supersede', rationale: '' })])

    const emitted: string[] = []
    service.on('conflict.resolved', (r) => emitted.push(r.resolution))

    await service.checkAndResolve(newMem, { sessionId: 's1', turnId: 't2' })

    expect(emitted).toEqual(['supersede'])
  })

  it('supersede -> revision++', async () => {
    await writeL2('用户喜欢咖啡', '我喜欢咖啡')
    const newMem = await writeL2('用户不喝咖啡了', '其实我不喝咖啡了')
    faux.setResponses([JSON.stringify({ resolution: 'supersede', rationale: '' })])

    const revBefore = revisionClock.current()
    await service.checkAndResolve(newMem, { sessionId: 's1', turnId: 't2' })
    const revAfter = revisionClock.current()

    expect(revAfter).toBeGreaterThan(revBefore)
  })

  it('coexist -> revision 不变', async () => {
    await writeL2('用户喜欢咖啡', '我喜欢咖啡')
    const newMem = await writeL2('用户不喝咖啡了', '其实我不喝咖啡了')
    faux.setResponses([JSON.stringify({ resolution: 'coexist', rationale: '' })])

    const revBefore = revisionClock.current()
    await service.checkAndResolve(newMem, { sessionId: 's1', turnId: 't2' })

    expect(revisionClock.current()).toBe(revBefore)
  })

  it('已归档的旧记忆不参与冲突检测', async () => {
    const oldMem = await writeL2('用户喜欢咖啡', '我喜欢咖啡')
    // 手动归档旧记忆
    l2Store.update(oldMem.id, { lifecycleState: 'archived', archivedAt: clock })
    const newMem = await writeL2('用户不喝咖啡了', '其实我不喝咖啡了')

    const results = await service.checkAndResolve(newMem, {
      sessionId: 's1',
      turnId: 't2'
    })

    expect(results).toHaveLength(0)
  })

  it('按优先级排队：高分冲突先解决', async () => {
    // 写两条旧记忆，一条高分信号（有纠正意图），一条低分信号
    const oldHigh = await writeL2('用户喜欢咖啡', '我喜欢咖啡')
    // 第二条旧记忆类型为 one_off（impactScope=low，分数较低）
    const oldLow = await writer.writeL2(
      {
        content: '用户去过咖啡馆',
        confidence: 0.7,
        evidenceIds: ['msg_3'],
        sourceMessageIds: ['msg_3'],
        triggerText: '我去了咖啡馆',
        type: 'one_off',
        importance: 3,
        sourceMessageId: 'msg_3',
        fieldOrType: 'one_off'
      },
      { sessionId: 's1', turnId: 't1' }
    )
    const oldLowMem = l2Store.get(oldLow.memoryId!)!
    const newMem = await writeL2('用户不喝咖啡了', '其实我不喝咖啡了')

    // 两个 resolver 响应（按调用顺序）
    faux.setResponses([
      JSON.stringify({ resolution: 'supersede', rationale: '纠正' }),
      JSON.stringify({ resolution: 'coexist', rationale: '不矛盾' })
    ])

    const results = await service.checkAndResolve(newMem, { sessionId: 's1', turnId: 't2' })

    // 至少检测到 high band 冲突（oldHigh），且第一个被解决
    const highResult = results.find((r) => r.pair.score.band === 'high')
    expect(highResult).toBeDefined()
    expect(highResult!.pair.existingMemory.id).toBe(oldHigh.id)

    // oldHigh 被 supersede（归档）
    expect(l2Store.get(oldHigh.id)?.lifecycleState).toBe('archived')
    // oldLow 未被 supersede（仍是 active 或未被操作）
    expect(l2Store.get(oldLowMem.id)?.lifecycleState).toBe('active')
  })

  it('recentlyResolved: 同对冲突 1 小时内再检测 -> 信号 -25', async () => {
    const oldMem = await writeL2('用户喜欢咖啡', '我喜欢咖啡')
    const newMem = await writeL2('用户不喝咖啡了', '其实我不喝咖啡了')
    faux.setResponses([JSON.stringify({ resolution: 'supersede', rationale: '' })])

    // 第一次检测
    await service.checkAndResolve(newMem, { sessionId: 's1', turnId: 't2' })
    expect(logStore.count()).toBe(1)

    // 恢复旧记忆状态（模拟重新检测）
    l2Store.update(oldMem.id, { lifecycleState: 'active', archivedAt: null })

    // 第二次检测同一对（clock 未推进，在 1 小时窗口内）
    faux.setResponses([JSON.stringify({ resolution: 'coexist', rationale: '' })])
    const results2 = await service.checkAndResolve(newMem, { sessionId: 's1', turnId: 't3' })

    // 第二次检测到 recentlyResolved=true，分数应含 -25 惩罚
    if (results2.length > 0) {
      expect(results2[0].pair.score.breakdown.recentlyResolved).toBe(-25)
    }
  })

  it('M-04 回归：同一事实跨轮（不同 newMemory id）再次纠正 -> 命中 recentlyResolved，不再重复解决', async () => {
    const oldMem = await writeL2('用户喜欢咖啡', '我喜欢咖啡')
    const newMem1 = await writeL2('用户不喝咖啡了', '其实我不喝咖啡了')
    faux.setResponses([JSON.stringify({ resolution: 'supersede', rationale: '' })])

    // 第一次检测 -> 解决并记录"最近已解决"（进程内稳定键缓存）
    const results1 = await service.checkAndResolve(newMem1, { sessionId: 's1', turnId: 't2' })
    expect(results1).toHaveLength(1)
    expect(results1[0].pair.score.breakdown.recentlyResolved).toBe(0) // 首次无 -25
    expect(logStore.count()).toBe(1)

    // 恢复旧记忆状态；移除 newMem1 的向量，让第二次检测只面对 oldMem
    l2Store.update(oldMem.id, { lifecycleState: 'active', archivedAt: null })
    vectorStore.remove(newMem1.id)

    // 下一轮再次纠正同一事实：新 L2（id 必然不同，content 相同）
    const newMem2 = l2Store.add({
      content: '用户不喝咖啡了',
      confidence: 0.8,
      syncStatus: 'synced',
      type: 'stable',
      importance: 8
    })
    faux.setResponses([JSON.stringify({ resolution: 'coexist', rationale: '' })])

    const results2 = await service.checkAndResolve(newMem2, { sessionId: 's1', turnId: 't3' })

    // 旧实现按 new_memory_id 精确匹配 conflict_log：newMem2.id != newMem1.id -> recentlyResolved
    // 恒 false（死代码），该 pair 会以 idle 档重新记录一条 coexist（logStore.count 变 2）。
    // 修复后按稳定键（existing.id + 归一化 content）命中 -> -25 -> 降到 none 档被跳过：
    expect(results2).toHaveLength(0) // oldMem 对被降级跳过，不进入解决流程
    expect(logStore.count()).toBe(1) // 未新增解决记录（不再重复解决同一对）
    expect(l2Store.get(oldMem.id)!.lifecycleState).toBe('active') // 未被再次归档
  })

  it('日志不含记忆正文（F5-011 白名单）', async () => {
    await writeL2('用户喜欢咖啡', '我喜欢咖啡')
    const newMem = await writeL2('用户不喝咖啡了', '其实我不喝咖啡了')
    faux.setResponses([JSON.stringify({ resolution: 'supersede', rationale: '' })])

    await service.checkAndResolve(newMem, { sessionId: 's1', turnId: 't2' })

    // conflict_log 的 signals 字段只含数字，不含 content/quote
    const entry = logStore.list()[0]
    for (const v of Object.values(entry.signals)) {
      expect(typeof v).toBe('number')
    }
    // entry 不含 content 字段
    expect(entry).not.toHaveProperty('content')
    expect(entry).not.toHaveProperty('quote')
  })

  it('band=none（无证据安全兜底）-> 不记日志、不调 resolver', async () => {
    // 直接创建无证据的记忆（绕过 writer，writer 总是加 evidenceIds）
    // evidence='none' -> 安全兜底 overridden=true -> band=none
    const emb = makeDeterministicEmbedding()
    const baseMem: L2Memory = {
      id: '',
      evidenceIds: [],
      sourceMessageIds: [],
      triggerText: null,
      content: '',
      confidence: 0.7,
      syncStatus: 'synced',
      lifecycleState: 'active',
      isPinned: false,
      accessCount: 0,
      weight: 1,
      type: 'one_off',
      importance: 3,
      archivedAt: null,
      extractionKey: null,
      source: 'user_explicit',
      importanceBeforePin: null,
      editedAt: null
    }
    const oldMem = { ...baseMem, id: 'l2_old_manual', content: '用户去过北京' }
    const newMem = { ...baseMem, id: 'l2_new_manual', content: '用户去过上海' }
    l2Store.insert(oldMem)
    l2Store.insert(newMem)
    vectorStore.upsert(oldMem.id, await emb.embed(''))
    vectorStore.upsert(newMem.id, await emb.embed(''))

    faux.setResponses([]) // resolver 不应被调用

    const results = await service.checkAndResolve(newMem, {
      sessionId: 's1',
      turnId: 't2'
    })

    // band=none -> 不返回结果、不记日志、不调 resolver
    expect(results).toHaveLength(0)
    expect(logStore.count()).toBe(0)
    expect(faux.calls()).toHaveLength(0)
  })

  it('normal band -> 默认 coexist，不调 resolver，记日志', async () => {
    // 构造 normal band（55≤score<75）：去掉纠正意图即可降分
    // oldMem type=stable(+10) + ragScore=1.0(+25) + evidence both(+15) + localContradiction(+10) = 60
    await writeL2('用户喜欢咖啡', '我喜欢咖啡', 'stable')
    // triggerText 不含纠正模式 -> correctionIntent=false
    const newMem = await writeL2('用户不喝咖啡', '我不喝咖啡', 'stable')
    faux.setResponses([]) // 不应被调用

    const results = await service.checkAndResolve(newMem, {
      sessionId: 's1',
      turnId: 't2'
    })

    expect(results).toHaveLength(1)
    expect(results[0].pair.score.band).toBe('normal')
    expect(results[0].resolution).toBe('coexist')
    expect(faux.calls()).toHaveLength(0) // normal 不调 resolver
    expect(logStore.count()).toBe(1)
    expect(logStore.list()[0].resolution).toBe('coexist')
  })
})
