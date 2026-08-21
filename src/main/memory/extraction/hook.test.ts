// src/main/memory/extraction/hook.test.ts
// P2-39 sync_turn 与 MemoryJudge 融合：批量终审策略（每 6 轮或队列候选 ≥12 触发、
// 跨轮去重合并 confidence 取高、单轮 final drain 保证 I-01 成立）+ 门禁。
// 依据 S-010 §1.1/§1.5、S-Phase2 P2-39、S-004-补充 I-01/J-13。
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MemoryConfig } from '@shared/config/types'
import { DEFAULT_CONFIG_V1 } from '../../config/defaults'
import { testNoopLogger, makeMemoryDb } from '../../../../tests/helpers/test-db'
import type { SessionStore } from '../../chat/session-store'
import { createMemorySessionStore } from '../../chat/session-store'
import type { TurnEndData } from '../../chat/service'
import { createExtractionHook } from './hook'
import type { ExtractionService, ExtractionInput, ExtractionOutput } from './service'
import type { MemoryCandidate } from './candidate'
import type { MemoryTargetLayer } from './candidate'
import type { L0FieldKey } from '../l0-store'
import type { MemoryJudge, JudgeDecision, JudgeContext } from './judge'
import { createMemoryJudge } from './judge'
import type { MemoryDispatcher, DispatchContext, DispatchResult } from './dispatch'
import { createMemoryDispatcher } from './dispatch'
import { createFauxExtractionProvider } from './provider'
import { createSyncTurnExtractor } from './sync-turn'
import type { AttributionGate, AttributionGateItem, AttributionVerdict } from './attribution-gate'
import { createL0Store } from '../l0-store'
import { createL1Store } from '../l1-store'
import { createL2Store } from '../l2-store'
import { createSQLiteVectorStore } from '../vector/sqlite-vector-store'
import { createMemoryRevisionClock } from '../revision-clock'
import { createMemoryWriter } from '../writer'

// === 测试辅助 ===

const memoryConfig: Readonly<MemoryConfig> = { ...DEFAULT_CONFIG_V1.memory, enabled: true }

function turnEnd(turnId: string, sessionId = 's1'): TurnEndData {
  return {
    turnId,
    sessionId,
    requestId: `req_${turnId}`,
    status: 'completed',
    inputLen: 4,
    outputLen: 8,
    memoryEligible: true,
    referencedMemoryIds: []
  }
}

function fakeSessionStore(missingTurns: string[] = []): SessionStore {
  return {
    getTurnMessages: (sessionId: string, turnId: string) => {
      if (missingTurns.includes(turnId)) return null
      return {
        user: {
          id: `m_${turnId}`,
          sessionId,
          role: 'user' as const,
          content: `内容-${turnId}`,
          createdAt: 1,
          status: 'complete' as const,
          turnId
        },
        assistant: {
          id: `a_${turnId}`,
          sessionId,
          role: 'assistant' as const,
          content: '回复',
          createdAt: 2,
          status: 'complete' as const,
          turnId
        }
      }
    }
  } as unknown as SessionStore
}

function mkCandidate(
  candidateId: string,
  content: string,
  opts: { targetLayer?: MemoryTargetLayer; field?: L0FieldKey; confidence?: number } = {}
): MemoryCandidate {
  const layer = opts.targetLayer ?? 'l2'
  return {
    candidateId,
    targetLayer: layer,
    field: layer === 'l0' ? opts.field : undefined,
    content,
    confidence: opts.confidence ?? 0.8,
    certainty: 'explicit',
    attribution: 'user_explicit',
    evidence: [{ messageId: `m_${candidateId.split(':')[0]}`, role: 'user', quote: content }],
    memoryType: layer === 'l2' ? 'stable' : undefined,
    importance: layer === 'l2' ? 'medium' : undefined,
    forbiddenOverclaims: []
  }
}

interface HookMocks {
  hook: ReturnType<typeof createExtractionHook>
  extract: ReturnType<typeof vi.fn>
  judgeBatch: ReturnType<typeof vi.fn>
  dispatchBatch: ReturnType<typeof vi.fn>
  order: string[]
}

function makeHook(
  opts: {
    responses?: Record<string, MemoryCandidate[]>
    config?: Readonly<MemoryConfig>
    /** 指定 turn 的 getTurnMessages 返回 null（J-12） */
    missingTurns?: string[]
    /** 覆盖 extraction 行为（如制造 provider 抛错） */
    extractImpl?: (input: ExtractionInput) => Promise<ExtractionOutput>
    /** 覆盖 dispatch 行为（如制造 drain 失败） */
    dispatchImpl?: (
      decisions: readonly JudgeDecision[],
      ctx: DispatchContext
    ) => Promise<DispatchResult>
    /** M-42：注入归因门（缺省 = 无门，drain 直接走正则路径） */
    attributionGate?: AttributionGate | null
  } = {}
): HookMocks {
  const responses = opts.responses ?? {}
  const config = opts.config ?? memoryConfig

  const order: string[] = []
  const extract = vi.fn(
    opts.extractImpl ??
      (async (input: ExtractionInput): Promise<ExtractionOutput> => {
        const candidates = responses[input.turnId] ?? []
        return {
          candidates,
          parseResult: { candidates, outcome: 'complete', droppedCount: 0, outputChars: 0 },
          durationMs: 1
        }
      })
  )
  const judgeBatch = vi.fn(
    (candidates: readonly MemoryCandidate[], ctx: JudgeContext): JudgeDecision[] => {
      order.push(`judge:${ctx.turnId}`)
      return candidates.map((c) => ({
        candidateId: c.candidateId,
        action: 'accept' as const,
        reason: 'ACCEPTED' as const,
        accepted: c
      }))
    }
  )
  const dispatchBatch = vi.fn(
    opts.dispatchImpl ??
      (async (_decisions: readonly JudgeDecision[], ctx: DispatchContext) => {
        order.push(`dispatch:${ctx.turnId}`)
        return { accepted: 0, downgraded: 0, rejected: 0, reasonCounts: {}, writtenMemoryIds: [] }
      })
  )

  const hook = createExtractionHook({
    logger: testNoopLogger,
    sessionStore: fakeSessionStore(opts.missingTurns),
    extractionService: { extract } as unknown as ExtractionService,
    judge: { judgeBatch } as unknown as MemoryJudge,
    dispatcher: { dispatchBatch } as unknown as MemoryDispatcher,
    getMemoryConfig: () => config,
    attributionGate: opts.attributionGate
  })
  return { hook, extract, judgeBatch, dispatchBatch, order }
}

// === P2-39 批量终审策略（mock 驱动）===

describe('P2-39 extraction hook 批量终审策略', () => {
  it('J-13: 6 eligible turn -> 批量终审（全部 judge 先于全部 dispatch，一次 drain）', async () => {
    const responses: Record<string, MemoryCandidate[]> = {}
    for (let i = 1; i <= 6; i++) {
      responses[`t${i}`] = [mkCandidate(`t${i}:0`, `事实${i}`)]
    }
    const { hook, judgeBatch, dispatchBatch, order } = makeHook({ responses })
    for (let i = 1; i <= 6; i++) {
      hook.hook.fn({ event: 'turn.end' }, turnEnd(`t${i}`))
    }
    await hook.flush()

    expect(judgeBatch).toHaveBeenCalledTimes(6)
    expect(dispatchBatch).toHaveBeenCalledTimes(6)
    // 批量结构：所有 judge 在前，所有 dispatch 在后（而非逐轮 judge/dispatch 交错）
    expect(order.slice(0, 6)).toEqual([
      'judge:t1',
      'judge:t2',
      'judge:t3',
      'judge:t4',
      'judge:t5',
      'judge:t6'
    ])
    expect(order.slice(6)).toEqual([
      'dispatch:t1',
      'dispatch:t2',
      'dispatch:t3',
      'dispatch:t4',
      'dispatch:t5',
      'dispatch:t6'
    ])
  })

  it('J-13: 队列候选数 ≥12（每轮 6 候选，2 轮）-> 提前触发批量终审', async () => {
    const responses: Record<string, MemoryCandidate[]> = {
      t1: Array.from({ length: 6 }, (_, i) => mkCandidate(`t1:${i}`, `A${i}`)),
      t2: Array.from({ length: 6 }, (_, i) => mkCandidate(`t2:${i}`, `B${i}`))
    }
    const { hook, judgeBatch, dispatchBatch, order } = makeHook({ responses })
    hook.hook.fn({ event: 'turn.end' }, turnEnd('t1'))
    hook.hook.fn({ event: 'turn.end' }, turnEnd('t2'))
    await hook.flush()

    expect(judgeBatch).toHaveBeenCalledTimes(2)
    expect(dispatchBatch).toHaveBeenCalledTimes(2)
    expect(order).toEqual(['judge:t1', 'judge:t2', 'dispatch:t1', 'dispatch:t2'])
  })

  it('单轮 -> 队列耗尽 final drain 写入（I-01 前提：候选不被永久积压）', async () => {
    const { hook, judgeBatch, dispatchBatch } = makeHook({
      responses: {
        t1: [mkCandidate('t1:0', '小明', { targetLayer: 'l0', field: 'preferredName' })]
      }
    })
    hook.hook.fn({ event: 'turn.end' }, turnEnd('t1'))
    await hook.flush()

    expect(judgeBatch).toHaveBeenCalledTimes(1)
    expect(dispatchBatch).toHaveBeenCalledTimes(1)
    const decisions = dispatchBatch.mock.calls[0][0] as readonly JudgeDecision[]
    expect(decisions[0].action).toBe('accept')
  })

  it('P2-39 去重：跨轮同事实合并 confidence 取高（低者标 DUPLICATE_CANDIDATE）', async () => {
    const { hook, dispatchBatch } = makeHook({
      responses: {
        t1: [
          mkCandidate('t1:0', '小明', {
            targetLayer: 'l0',
            field: 'preferredName',
            confidence: 0.7
          })
        ],
        t2: [
          mkCandidate('t2:0', '小明', {
            targetLayer: 'l0',
            field: 'preferredName',
            confidence: 0.95
          })
        ]
      }
    })
    hook.hook.fn({ event: 'turn.end' }, turnEnd('t1'))
    hook.hook.fn({ event: 'turn.end' }, turnEnd('t2'))
    await hook.flush()

    // 两轮在同一 drain（2 轮 <6、2 候选 <12 -> final drain）
    const t1Calls = dispatchBatch.mock.calls.filter(
      (c) => (c[1] as DispatchContext).turnId === 't1'
    )
    const t2Calls = dispatchBatch.mock.calls.filter(
      (c) => (c[1] as DispatchContext).turnId === 't2'
    )
    expect(t1Calls).toHaveLength(1)
    expect(t2Calls).toHaveLength(1)
    expect((t1Calls[0][0] as readonly JudgeDecision[])[0].action).toBe('reject')
    expect((t1Calls[0][0] as readonly JudgeDecision[])[0].reason).toBe('DUPLICATE_CANDIDATE')
    expect((t2Calls[0][0] as readonly JudgeDecision[])[0].action).toBe('accept')
    const kept = (t2Calls[0][0] as readonly JudgeDecision[])[0]
    if (kept.action !== 'accept') throw new Error(`expected accept, got ${kept.reason}`)
    expect(kept.accepted.confidence).toBe(0.95)
  })

  it('memoryEligible=false -> 不入队，不调 extract（S-010 §1.1 硬门 2）', async () => {
    const { hook, extract } = makeHook()
    hook.hook.fn({ event: 'turn.end' }, { ...turnEnd('t1'), memoryEligible: false })
    await hook.flush()
    expect(extract).not.toHaveBeenCalled()
    expect(hook.queue.pending()).toBe(0)
  })

  it('memory.enabled=false -> 全旁路，不调 extract（S-010 §1.1 硬门 1）', async () => {
    const disabled = { ...DEFAULT_CONFIG_V1.memory, enabled: false } as Readonly<MemoryConfig>
    const { hook, extract } = makeHook({ config: disabled })
    hook.hook.fn({ event: 'turn.end' }, turnEnd('t1'))
    await hook.flush()
    expect(extract).not.toHaveBeenCalled()
    expect(hook.queue.pending()).toBe(0)
  })

  it('drain 失败 -> fail-open 丢弃该批，消费者继续处理后续轮次（S-010 §1.1 败而不崩）', async () => {
    const responses: Record<string, MemoryCandidate[]> = {}
    for (let i = 1; i <= 7; i++) {
      responses[`t${i}`] = [mkCandidate(`t${i}:0`, `事实${i}`)]
    }
    let dispatchCalls = 0
    const { hook, extract, dispatchBatch } = makeHook({
      responses,
      dispatchImpl: async () => {
        dispatchCalls++
        if (dispatchCalls === 1) throw new Error('dispatch boom')
        return { accepted: 0, downgraded: 0, rejected: 0, reasonCounts: {}, writtenMemoryIds: [] }
      }
    })
    for (let i = 1; i <= 7; i++) {
      hook.hook.fn({ event: 'turn.end' }, turnEnd(`t${i}`))
    }
    await hook.flush()

    // t1-t6 的 t6 阈值 drain：t1 组 dispatch 抛错 -> safeDrain 丢弃整批；
    // 消费者未中止，t7 仍被提取 + final drain 写入
    expect(extract).toHaveBeenCalledTimes(7)
    expect(dispatchBatch).toHaveBeenCalledTimes(2) // t1(throw) + t7(success)
    const t7Dispatch = dispatchBatch.mock.calls.filter(
      (c) => (c[1] as DispatchContext).turnId === 't7'
    )
    expect(t7Dispatch).toHaveLength(1)
  })

  it('getTurnMessages 返回 null -> 不入队、不调 extract（S-010 §1.1 J-12）', async () => {
    const { hook, extract } = makeHook({ missingTurns: ['t1'] })
    hook.hook.fn({ event: 'turn.end' }, turnEnd('t1'))
    await hook.flush()
    expect(extract).not.toHaveBeenCalled()
    expect(hook.queue.pending()).toBe(0)
  })

  it('提取失败（provider 抛错）-> 该轮空候选，消费者继续处理后续轮次', async () => {
    const responses: Record<string, MemoryCandidate[]> = {
      t2: [mkCandidate('t2:0', '事实2')]
    }
    const { hook, extract, dispatchBatch } = makeHook({
      responses,
      extractImpl: async (input: ExtractionInput) => {
        if (input.turnId === 't1') throw new Error('extract boom')
        const candidates = responses[input.turnId] ?? []
        return {
          candidates,
          parseResult: { candidates, outcome: 'complete', droppedCount: 0, outputChars: 0 },
          durationMs: 1
        }
      }
    })
    hook.hook.fn({ event: 'turn.end' }, turnEnd('t1'))
    hook.hook.fn({ event: 'turn.end' }, turnEnd('t2'))
    await hook.flush()

    expect(extract).toHaveBeenCalledTimes(2)
    // t1 提取失败只影响自身；t2 正常提取 + final drain 写入
    expect(dispatchBatch).toHaveBeenCalledTimes(1)
    const t2Dispatch = dispatchBatch.mock.calls.filter(
      (c) => (c[1] as DispatchContext).turnId === 't2'
    )
    expect(t2Dispatch).toHaveLength(1)
  })
})

// === I-01 真实链路（hook + sync_turn + judge + dispatch + L0 写入 + 事件）===

describe('I-01 sync_turn 真实链路', () => {
  it('"我叫小明" -> sync_turn 候选 -> MemoryJudge -> L0.preferredName 写入 -> l0.filled 事件', async () => {
    const t = await makeMemoryDb()
    const l0Dir = mkdtempSync(join(tmpdir(), 'nacime-hook-'))
    const l0Store = createL0Store({ filePath: join(l0Dir, 'l0.json'), logger: testNoopLogger })
    const l1Store = createL1Store({ filePath: join(l0Dir, 'l1.json'), logger: testNoopLogger })
    const l2Store = createL2Store({
      db: t.db,
      now: () => 1710000000000,
      randomSuffix: () => 's1'
    })
    const vectorStore = createSQLiteVectorStore({ db: t.db, dim: 4, logger: testNoopLogger })
    await vectorStore.init()
    const revisionClock = createMemoryRevisionClock(t.db)
    const writer = createMemoryWriter({
      db: t.db,
      l2Store,
      vectorStore,
      embedding: null,
      revisionClock,
      logger: testNoopLogger
    })
    const dispatcher = createMemoryDispatcher({
      l0Store,
      l1Store,
      l2Store,
      writer,
      logger: testNoopLogger
    })
    const judge = createMemoryJudge()

    // 真实会话存储：种入 t1 轮（user + assistant）
    const sessionStore = createMemorySessionStore()
    const sessionId = sessionStore.createSession()
    sessionStore.appendMessage(sessionId, {
      id: 'm_1',
      sessionId,
      role: 'user',
      content: '我叫小明',
      createdAt: 1,
      status: 'complete',
      turnId: 't1'
    })
    sessionStore.appendMessage(sessionId, {
      id: 'a_1',
      sessionId,
      role: 'assistant',
      content: '你好小明',
      createdAt: 2,
      status: 'complete',
      turnId: 't1'
    })

    // sync_turn 便宜提取（Faux）
    const faux = createFauxExtractionProvider()
    faux.setResponses([
      JSON.stringify({
        schemaVersion: 1,
        candidates: [
          {
            targetLayer: 'l0',
            field: 'preferredName',
            content: '小明',
            confidence: 0.95,
            certainty: 'explicit',
            attribution: 'user_explicit',
            evidence: [{ messageId: 'm_1', role: 'user', quote: '我叫小明' }],
            forbiddenOverclaims: []
          }
        ]
      })
    ])
    const syncTurn = createSyncTurnExtractor({ provider: faux, logger: testNoopLogger })

    // 记录 l0.filled 事件
    const filled: string[] = []
    l0Store.on('l0.filled', (f) => filled.push(f))

    const hook = createExtractionHook({
      logger: testNoopLogger,
      sessionStore,
      extractionService: syncTurn,
      judge,
      dispatcher,
      getMemoryConfig: () => memoryConfig
    })
    hook.hook.fn({ event: 'turn.end' }, turnEnd('t1', sessionId))
    await hook.flush()

    // L0.preferredName 写入 + 事件 + 可被下轮 prompt 层 4 读取
    expect(filled).toEqual(['preferredName'])
    expect(l0Store.getField('preferredName')?.value).toBe('小明')

    t.cleanup()
    rmSync(l0Dir, { recursive: true, force: true })
    hook.stopConsumer()
  })
})

// === M-42 drain 归因门接线（mock 驱动 + 真实链路）===

describe('M-42 drain 归因门接线', () => {
  function makeGate(impl: {
    map?: ReadonlyMap<string, AttributionVerdict> | null
    calls?: AttributionGateItem[][]
    throwError?: boolean
  }): { gate: AttributionGate; judgeL0Batch: ReturnType<typeof vi.fn> } {
    const judgeL0Batch = vi.fn(async (items: readonly AttributionGateItem[]) => {
      impl.calls?.push([...items])
      if (impl.throwError) throw new Error('gate boom')
      return impl.map ?? null
    })
    return { gate: { judgeL0Batch }, judgeL0Batch }
  }

  it('drain 前对本批全部 L0 候选批量判定一次（跨组只调一次），map 随 ctx 传给每组 judge', async () => {
    const gateCalls: AttributionGateItem[][] = []
    const map: ReadonlyMap<string, AttributionVerdict> = new Map([
      ['t1:0', { userSelfStatement: true, assistantDirected: false }],
      ['t2:0', { userSelfStatement: true, assistantDirected: false }]
    ])
    const { gate, judgeL0Batch } = makeGate({ map, calls: gateCalls })
    const { hook, judgeBatch } = makeHook({
      attributionGate: gate,
      responses: {
        // t1：1 个 L0 + 1 个 L2；t2：1 个 L0（L2 不进语义门）
        t1: [
          mkCandidate('t1:0', '伙伴', { targetLayer: 'l0', field: 'preferredName' }),
          mkCandidate('t1:1', '周末爬山')
        ],
        t2: [mkCandidate('t2:0', '小明', { targetLayer: 'l0', field: 'preferredName' })]
      }
    })
    hook.hook.fn({ event: 'turn.end' }, turnEnd('t1'))
    hook.hook.fn({ event: 'turn.end' }, turnEnd('t2'))
    await hook.flush()

    // 一次批量调用，只含 L0 候选（t1:0、t2:0），携带 field/content/quotes
    expect(judgeL0Batch).toHaveBeenCalledTimes(1)
    expect(gateCalls).toHaveLength(1)
    expect(gateCalls[0].map((i) => i.candidateId).sort()).toEqual(['t1:0', 't2:0'])
    expect(gateCalls[0][0].field).toBe('preferredName')
    expect(gateCalls[0][0].quotes.length).toBeGreaterThan(0)

    // 两组 judgeBatch 都收到同一份 attribution map（引用相等）
    expect(judgeBatch).toHaveBeenCalledTimes(2)
    for (const call of judgeBatch.mock.calls) {
      expect((call[1] as JudgeContext).attribution).toBe(map)
    }
  })

  it('gate 返回 null -> ctx.attribution 为 null（Judge 回退正则表）', async () => {
    const { gate } = makeGate({ map: null })
    const { hook, judgeBatch } = makeHook({
      attributionGate: gate,
      responses: {
        t1: [mkCandidate('t1:0', '伙伴', { targetLayer: 'l0', field: 'preferredName' })]
      }
    })
    hook.hook.fn({ event: 'turn.end' }, turnEnd('t1'))
    await hook.flush()

    expect(judgeBatch).toHaveBeenCalledTimes(1)
    expect((judgeBatch.mock.calls[0][1] as JudgeContext).attribution).toBeNull()
  })

  it('gate 违反契约抛错 -> 防御兜底：标注 null 且批次不丢（dispatch 仍执行）', async () => {
    const { gate } = makeGate({ throwError: true })
    const { hook, judgeBatch, dispatchBatch } = makeHook({
      attributionGate: gate,
      responses: {
        t1: [mkCandidate('t1:0', '伙伴', { targetLayer: 'l0', field: 'preferredName' })]
      }
    })
    hook.hook.fn({ event: 'turn.end' }, turnEnd('t1'))
    await hook.flush()

    expect(judgeBatch).toHaveBeenCalledTimes(1)
    expect((judgeBatch.mock.calls[0][1] as JudgeContext).attribution).toBeNull()
    expect(dispatchBatch).toHaveBeenCalledTimes(1)
  })

  it('本批无 L0 候选 -> 不调用 gate（零额外 API 成本）', async () => {
    const { gate, judgeL0Batch } = makeGate({ map: new Map() })
    const { hook } = makeHook({
      attributionGate: gate,
      responses: { t1: [mkCandidate('t1:0', '周末爬山')] }
    })
    hook.hook.fn({ event: 'turn.end' }, turnEnd('t1'))
    await hook.flush()
    expect(judgeL0Batch).not.toHaveBeenCalled()
  })

  it('缺省无门 -> drain 不调 gate，ctx.attribution 为 null（现行行为不变）', async () => {
    const { hook, judgeBatch } = makeHook({
      responses: {
        t1: [mkCandidate('t1:0', '伙伴', { targetLayer: 'l0', field: 'preferredName' })]
      }
    })
    hook.hook.fn({ event: 'turn.end' }, turnEnd('t1'))
    await hook.flush()
    expect((judgeBatch.mock.calls[0][1] as JudgeContext).attribution).toBeNull()
  })
})

describe('M-42 真实链路（语义门救回自然说法）', () => {
  it('"以后你可以称我为伙伴"：正则路径拒绝 -> 归因门标注后 L0.preferredName 写入', async () => {
    const t = await makeMemoryDb()
    const l0Dir = mkdtempSync(join(tmpdir(), 'nacime-hook-m42-'))
    const l0Store = createL0Store({ filePath: join(l0Dir, 'l0.json'), logger: testNoopLogger })
    const l1Store = createL1Store({ filePath: join(l0Dir, 'l1.json'), logger: testNoopLogger })
    const l2Store = createL2Store({
      db: t.db,
      now: () => 1710000000000,
      randomSuffix: () => 's1'
    })
    const vectorStore = createSQLiteVectorStore({ db: t.db, dim: 4, logger: testNoopLogger })
    await vectorStore.init()
    const revisionClock = createMemoryRevisionClock(t.db)
    const writer = createMemoryWriter({
      db: t.db,
      l2Store,
      vectorStore,
      embedding: null,
      revisionClock,
      logger: testNoopLogger
    })
    const dispatcher = createMemoryDispatcher({
      l0Store,
      l1Store,
      l2Store,
      writer,
      logger: testNoopLogger
    })
    const judge = createMemoryJudge()

    const sessionStore = createMemorySessionStore()
    const sessionId = sessionStore.createSession()
    sessionStore.appendMessage(sessionId, {
      id: 'm_1',
      sessionId,
      role: 'user',
      content: '以后你可以称我为伙伴，就这么定了。',
      createdAt: 1,
      status: 'complete',
      turnId: 't1'
    })
    sessionStore.appendMessage(sessionId, {
      id: 'a_1',
      sessionId,
      role: 'assistant',
      content: '好的伙伴',
      createdAt: 2,
      status: 'complete',
      turnId: 't1'
    })

    const faux = createFauxExtractionProvider()
    faux.setResponses([
      JSON.stringify({
        schemaVersion: 1,
        candidates: [
          {
            targetLayer: 'l0',
            field: 'preferredName',
            content: '伙伴',
            confidence: 0.9,
            certainty: 'explicit',
            attribution: 'user_explicit',
            evidence: [{ messageId: 'm_1', role: 'user', quote: '以后你可以称我为伙伴' }],
            forbiddenOverclaims: []
          }
        ]
      })
    ])
    const syncTurn = createSyncTurnExtractor({ provider: faux, logger: testNoopLogger })

    // 归因门：candidateId 由 parser 按 `${turnId}:${index}` 赋为 't1:0'
    const gate: AttributionGate = {
      judgeL0Batch: async () =>
        new Map([['t1:0', { userSelfStatement: true, assistantDirected: false }]])
    }

    const hook = createExtractionHook({
      logger: testNoopLogger,
      sessionStore,
      extractionService: syncTurn,
      judge,
      dispatcher,
      getMemoryConfig: () => memoryConfig,
      attributionGate: gate
    })
    hook.hook.fn({ event: 'turn.end' }, turnEnd('t1', sessionId))
    await hook.flush()

    // 语义门救回：直入 L0（正则路径下该候选会被 L0_SUBJECT_IS_ASSISTANT 拒绝）
    expect(l0Store.getField('preferredName')?.value).toBe('伙伴')

    t.cleanup()
    rmSync(l0Dir, { recursive: true, force: true })
    hook.stopConsumer()
  })
})
