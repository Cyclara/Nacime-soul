// src/main/memory/writer.test.ts
// P2-12 MemoryWriter：L2+vector 同事务、extractionKey 幂等、pending 路径、revision++。
// 依据 S-010 §3.2 I-03a/b, J-14。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeMemoryDb, testNoopLogger, type TestDb } from '../../../tests/helpers/test-db'
import { createL2Store } from './l2-store'
import { createSQLiteVectorStore } from './vector/sqlite-vector-store'
import { createMemoryRevisionClock } from './revision-clock'
import { createMemoryWriter, computeExtractionKey } from './writer'
import type { EmbeddingClient } from './embedding'

let idc = 0
function makeFauxEmbedding(dim: number, fail = false): EmbeddingClient {
  return {
    async embed(): Promise<Float32Array> {
      if (fail) throw new Error('embed failed')
      const v = new Float32Array(dim)
      v[0] = Math.random()
      return v
    },
    async embedBatch(texts: string[]): Promise<Float32Array[]> {
      return texts.map(() => {
        const v = new Float32Array(dim)
        v[0] = Math.random()
        return v
      })
    }
  }
}

describe('P2-12 MemoryWriter', () => {
  let t: TestDb
  let l2Store: ReturnType<typeof createL2Store>
  let vectorStore: ReturnType<typeof createSQLiteVectorStore>
  let revisionClock: ReturnType<typeof createMemoryRevisionClock>

  beforeEach(async () => {
    t = await makeMemoryDb()
    idc = 0
    l2Store = createL2Store({
      db: t.db,
      now: () => 1710000000000,
      randomSuffix: () => `s${idc++}`
    })
    vectorStore = createSQLiteVectorStore({ db: t.db, dim: 4, logger: testNoopLogger })
    await vectorStore.init()
    revisionClock = createMemoryRevisionClock(t.db)
  })
  afterEach(() => t.cleanup())

  it('I-03a: embedding available -> L2 metadata + vector in same transaction', async () => {
    const writer = createMemoryWriter({
      db: t.db,
      l2Store,
      vectorStore,
      embedding: makeFauxEmbedding(4),
      revisionClock,
      logger: testNoopLogger
    })
    const result = await writer.writeL2(
      {
        content: '用户喜欢咖啡',
        confidence: 0.8,
        evidenceIds: ['msg_1'],
        sourceMessageIds: ['msg_1'],
        triggerText: '我喜欢咖啡',
        type: 'stable' as const,
        importance: 8,
        sourceMessageId: 'msg_1',
        fieldOrType: 'stable'
      },
      { sessionId: 's1', turnId: 't1' }
    )
    expect(result.memoryId).not.toBeNull()
    expect(result.pending).toBe(false)
    expect(result.revision).toBe(1)

    // L2 行存在
    const mem = l2Store.get(result.memoryId!)
    expect(mem).not.toBeNull()
    expect(mem?.syncStatus).toBe('synced')
    expect(mem?.extractionKey).not.toBeNull()

    // 向量行存在
    expect(vectorStore.count()).toBe(1)
  })

  it('I-03a 补强：成功写入恰好发射一次 l2.added（commit 后），无事务内幽灵事件', async () => {
    const writer = createMemoryWriter({
      db: t.db,
      l2Store,
      vectorStore,
      embedding: makeFauxEmbedding(4),
      revisionClock,
      logger: testNoopLogger
    })
    const added: string[] = []
    l2Store.on('l2.added', (m) => added.push(m.id))

    const result = await writer.writeL2(
      {
        content: '用户喜欢咖啡',
        confidence: 0.8,
        evidenceIds: ['msg_1'],
        sourceMessageIds: ['msg_1'],
        triggerText: '我喜欢咖啡',
        type: 'stable' as const,
        importance: 8,
        sourceMessageId: 'msg_1',
        fieldOrType: 'stable'
      },
      { sessionId: 's1', turnId: 't1' }
    )

    expect(result.memoryId).not.toBeNull()
    // 恰好一次（修复前 add() 事务内 emit + emitAdded commit 后 = 两次）
    expect(added).toEqual([result.memoryId])
  })

  it('I-03a 补强：事务回滚（vector upsert 抛错）不产生 l2.added 幽灵事件', async () => {
    const writer = createMemoryWriter({
      db: t.db,
      l2Store,
      vectorStore, // dim=4
      embedding: makeFauxEmbedding(8), // dim=8 mismatch -> upsert 抛 MEM_EMBED_FAIL
      revisionClock,
      logger: testNoopLogger
    })
    const added: string[] = []
    l2Store.on('l2.added', (m) => added.push(m.id))

    await expect(
      writer.writeL2(
        {
          content: '用户喜欢咖啡',
          confidence: 0.8,
          evidenceIds: ['msg_1'],
          sourceMessageIds: ['msg_1'],
          triggerText: '我喜欢咖啡',
          type: 'stable' as const,
          importance: 8,
          sourceMessageId: 'msg_1',
          fieldOrType: 'stable'
        },
        { sessionId: 's1', turnId: 't1' }
      )
    ).rejects.toThrow()

    // 事务回滚：订阅者不应收到任何事件（修复前 add() 在事务内 emit 会先发一条幽灵事件）
    expect(added).toEqual([])
    // 且无 L2 行残留
    expect(l2Store.count()).toBe(0)
  })

  it('I-03b: embedding not configured -> metadata 1 row pending, vector 0 rows, revision+1', async () => {
    const writer = createMemoryWriter({
      db: t.db,
      l2Store,
      vectorStore,
      embedding: null, // 未配置
      revisionClock,
      logger: testNoopLogger
    })
    const result = await writer.writeL2(
      {
        content: '用户喜欢茶',
        confidence: 0.7,
        evidenceIds: ['msg_2'],
        sourceMessageIds: ['msg_2'],
        triggerText: '我喜欢茶',
        type: 'situational' as const,
        importance: 5,
        sourceMessageId: 'msg_2',
        fieldOrType: 'situational'
      },
      { sessionId: 's1', turnId: 't2' }
    )
    expect(result.memoryId).not.toBeNull()
    expect(result.pending).toBe(true)
    expect(result.revision).toBe(1)

    const mem = l2Store.get(result.memoryId!)
    expect(mem?.syncStatus).toBe('pending')
    expect(vectorStore.count()).toBe(0)
  })

  it('J-14: same extractionKey replayed -> no-op (no revision, no emit)', async () => {
    const writer = createMemoryWriter({
      db: t.db,
      l2Store,
      vectorStore,
      embedding: null,
      revisionClock,
      logger: testNoopLogger
    })
    const input = {
      content: '用户喜欢咖啡',
      confidence: 0.8,
      evidenceIds: ['msg_1'],
      sourceMessageIds: ['msg_1'],
      triggerText: '我喜欢咖啡',
      type: 'stable' as const,
      importance: 8,
      sourceMessageId: 'msg_1',
      fieldOrType: 'stable'
    }
    const r1 = await writer.writeL2(input, { sessionId: 's1', turnId: 't1' })
    expect(r1.revision).toBe(1)

    // 重放相同 extractionKey
    const r2 = await writer.writeL2(input, { sessionId: 's1', turnId: 't1' })
    expect(r2.memoryId).toBeNull()
    expect(r2.revision).toBe(0) // no-op
    expect(revisionClock.current()).toBe(1) // 未递增

    // 只有一行 L2
    expect(l2Store.count()).toBe(1)
  })

  it('different content -> different extractionKey -> both written', async () => {
    const writer = createMemoryWriter({
      db: t.db,
      l2Store,
      vectorStore,
      embedding: null,
      revisionClock,
      logger: testNoopLogger
    })
    await writer.writeL2(
      {
        content: '用户喜欢咖啡',
        confidence: 0.8,
        evidenceIds: ['msg_1'],
        sourceMessageIds: ['msg_1'],
        triggerText: '我喜欢咖啡',
        type: 'stable' as const,
        importance: 8,
        sourceMessageId: 'msg_1',
        fieldOrType: 'stable'
      },
      { sessionId: 's1', turnId: 't1' }
    )
    await writer.writeL2(
      {
        content: '用户喜欢茶',
        confidence: 0.7,
        evidenceIds: ['msg_2'],
        sourceMessageIds: ['msg_2'],
        triggerText: '我喜欢茶',
        type: 'stable' as const,
        importance: 8,
        sourceMessageId: 'msg_2',
        fieldOrType: 'stable'
      },
      { sessionId: 's1', turnId: 't2' }
    )
    expect(l2Store.count()).toBe(2)
    expect(revisionClock.current()).toBe(2)
  })

  it('transaction failure: vector upsert throws -> no L2 row left', async () => {
    // 维度不匹配的 embedding -> vectorStore.upsert 抛 MEM_EMBED_FAIL
    const writer = createMemoryWriter({
      db: t.db,
      l2Store,
      vectorStore, // dim=4
      embedding: makeFauxEmbedding(8), // dim=8, mismatch
      revisionClock,
      logger: testNoopLogger
    })
    await expect(
      writer.writeL2(
        {
          content: '用户喜欢咖啡',
          confidence: 0.8,
          evidenceIds: ['msg_1'],
          sourceMessageIds: ['msg_1'],
          triggerText: '我喜欢咖啡',
          type: 'stable' as const,
          importance: 8,
          sourceMessageId: 'msg_1',
          fieldOrType: 'stable'
        },
        { sessionId: 's1', turnId: 't1' }
      )
    ).rejects.toMatchObject({ code: 'MEM_EMBED_FAIL' })

    // 事务回滚：L2 行不存在、revision 未递增
    expect(l2Store.count()).toBe(0)
    expect(revisionClock.current()).toBe(0)
    expect(vectorStore.count()).toBe(0)
  })

  it('computeExtractionKey is deterministic for same inputs', () => {
    const k1 = computeExtractionKey(1, 'l2', 'msg_1', 'stable', '用户喜欢咖啡')
    const k2 = computeExtractionKey(1, 'l2', 'msg_1', 'stable', '用户喜欢咖啡')
    expect(k1).toBe(k2)
    // 不同 content -> 不同 key
    const k3 = computeExtractionKey(1, 'l2', 'msg_1', 'stable', '用户喜欢茶')
    expect(k1).not.toBe(k3)
    // NFC normalize: 全角和半角空白不影响
    const k4 = computeExtractionKey(1, 'l2', 'msg_1', 'stable', ' 用户喜欢咖啡 ')
    expect(k1).toBe(k4)
  })

  it('embedding temporarily unavailable (timeout) -> pending path', async () => {
    const { AppError } = await import('@shared/errors')
    const fauxTimeout: EmbeddingClient = {
      async embed(): Promise<Float32Array> {
        throw new AppError({
          code: 'NET_TIMEOUT',
          userMessage: 'timeout',
          severity: 'error',
          retryable: true
        })
      },
      async embedBatch(): Promise<Float32Array[]> {
        throw new AppError({
          code: 'NET_TIMEOUT',
          userMessage: 'timeout',
          severity: 'error',
          retryable: true
        })
      }
    }
    const writer = createMemoryWriter({
      db: t.db,
      l2Store,
      vectorStore,
      embedding: fauxTimeout,
      revisionClock,
      logger: testNoopLogger
    })
    const result = await writer.writeL2(
      {
        content: '用户喜欢咖啡',
        confidence: 0.8,
        evidenceIds: ['msg_1'],
        sourceMessageIds: ['msg_1'],
        triggerText: '我喜欢咖啡',
        type: 'stable' as const,
        importance: 8,
        sourceMessageId: 'msg_1',
        fieldOrType: 'stable'
      },
      { sessionId: 's1', turnId: 't1' }
    )
    expect(result.pending).toBe(true)
    expect(result.memoryId).not.toBeNull()
    const mem = l2Store.get(result.memoryId!)
    expect(mem?.syncStatus).toBe('pending')
  })

  it('embedding non-retryable error (401) -> rejected, not pending', async () => {
    const { AppError } = await import('@shared/errors')
    const faux401: EmbeddingClient = {
      async embed(): Promise<Float32Array> {
        throw new AppError({
          code: 'LLM_AUTH',
          userMessage: '401',
          severity: 'error',
          retryable: false
        })
      },
      async embedBatch(): Promise<Float32Array[]> {
        throw new AppError({
          code: 'LLM_AUTH',
          userMessage: '401',
          severity: 'error',
          retryable: false
        })
      }
    }
    const writer = createMemoryWriter({
      db: t.db,
      l2Store,
      vectorStore,
      embedding: faux401,
      revisionClock,
      logger: testNoopLogger
    })
    await expect(
      writer.writeL2(
        {
          content: '用户喜欢咖啡',
          confidence: 0.8,
          evidenceIds: ['msg_1'],
          sourceMessageIds: ['msg_1'],
          triggerText: '我喜欢咖啡',
          type: 'stable' as const,
          importance: 8,
          sourceMessageId: 'msg_1',
          fieldOrType: 'stable'
        },
        { sessionId: 's1', turnId: 't1' }
      )
    ).rejects.toMatchObject({ code: 'LLM_AUTH' })
    expect(l2Store.count()).toBe(0)
  })
})
