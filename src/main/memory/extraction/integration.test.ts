// src/main/memory/extraction/integration.test.ts
// P2-10/11/12 集成测试：I-01 "我叫小明" 完整链路。
// user message -> extraction -> judge -> dispatch -> L0 写入 -> 事件。
// 依据 S-010 §3.2 I-01, I-01b。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeMemoryDb, testNoopLogger, type TestDb } from '../../../../tests/helpers/test-db'
import { createL0Store } from '../l0-store'
import { createL1Store } from '../l1-store'
import { createL2Store } from '../l2-store'
import { createSQLiteVectorStore } from '../vector/sqlite-vector-store'
import { createMemoryRevisionClock } from '../revision-clock'
import { createMemoryWriter } from '../writer'
import { createExtractionService } from './service'
import { createFauxExtractionProvider } from './provider'
import { createMemoryJudge } from './judge'
import { createMemoryDispatcher } from './dispatch'

describe('P2-10/11/12 integration: I-01 "我叫小明" full chain', () => {
  let t: TestDb
  let l0Dir: string
  let l0Store: ReturnType<typeof createL0Store>
  let l1Store: ReturnType<typeof createL1Store>
  let l2Store: ReturnType<typeof createL2Store>
  let vectorStore: ReturnType<typeof createSQLiteVectorStore>
  let revisionClock: ReturnType<typeof createMemoryRevisionClock>
  let writer: ReturnType<typeof createMemoryWriter>
  let dispatcher: ReturnType<typeof createMemoryDispatcher>

  beforeEach(async () => {
    t = await makeMemoryDb()
    l0Dir = mkdtempSync(join(tmpdir(), 'nacime-int-'))
    l0Store = createL0Store({ filePath: join(l0Dir, 'l0.json'), logger: testNoopLogger })
    l1Store = createL1Store({ filePath: join(l0Dir, 'l1.json'), logger: testNoopLogger })
    l2Store = createL2Store({ db: t.db, now: () => 1710000000000, randomSuffix: () => 's1' })
    vectorStore = createSQLiteVectorStore({ db: t.db, dim: 4, logger: testNoopLogger })
    await vectorStore.init()
    revisionClock = createMemoryRevisionClock(t.db)
    writer = createMemoryWriter({
      db: t.db,
      l2Store,
      vectorStore,
      embedding: null,
      revisionClock,
      logger: testNoopLogger
    })
    dispatcher = createMemoryDispatcher({
      l0Store,
      l1Store,
      l2Store,
      writer,
      logger: testNoopLogger
    })
  })
  afterEach(() => {
    t.cleanup()
    rmSync(l0Dir, { recursive: true, force: true })
  })

  it('I-01: "我叫小明" -> L0.preferredName written, L0 event emitted', async () => {
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
            evidence: [{ messageId: 'msg_1', role: 'user', quote: '我叫小明' }],
            forbiddenOverclaims: []
          }
        ]
      })
    ])
    const svc = createExtractionService({ provider: faux, logger: testNoopLogger })
    const judge = createMemoryJudge()

    // 记录 L0 事件
    const filled: string[] = []
    l0Store.on('l0.filled', (f) => filled.push(f))

    // 1. 提取
    const { candidates } = await svc.extract({
      turnId: 'turn_1',
      userMessageId: 'msg_1',
      userContent: '我叫小明'
    })
    expect(candidates.length).toBe(1)

    // 2. 判决
    const decisions = judge.judgeBatch(candidates, {
      turnId: 'turn_1',
      userMessageId: 'msg_1',
      userContent: '我叫小明'
    })
    expect(decisions[0].action).toBe('accept')

    // 3. 分发
    const result = await dispatcher.dispatchBatch(decisions, {
      sessionId: 's1',
      turnId: 'turn_1'
    })
    expect(result.accepted).toBe(1)
    expect(filled).toEqual(['preferredName'])
    expect(l0Store.getField('preferredName')?.value).toBe('小明')
  })

  it('I-01b: "你叫小明" -> L0 never written, identity/soul unchanged', async () => {
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
            evidence: [{ messageId: 'msg_1', role: 'user', quote: '你叫小明' }],
            forbiddenOverclaims: []
          }
        ]
      })
    ])
    const svc = createExtractionService({ provider: faux, logger: testNoopLogger })
    const judge = createMemoryJudge()

    const { candidates } = await svc.extract({
      turnId: 'turn_1',
      userMessageId: 'msg_1',
      userContent: '你叫小明'
    })
    const decisions = judge.judgeBatch(candidates, {
      turnId: 'turn_1',
      userMessageId: 'msg_1',
      userContent: '你叫小明'
    })
    expect(decisions[0].action).toBe('reject')
    expect(decisions[0].reason).toBe('L0_SUBJECT_IS_ASSISTANT')

    const result = await dispatcher.dispatchBatch(decisions, {
      sessionId: 's1',
      turnId: 'turn_1'
    })
    expect(result.rejected).toBe(1)
    expect(result.accepted).toBe(0)
    // L0 未写入
    expect(l0Store.getField('preferredName')).toBeNull()
  })

  it('I-01 L2 chain: L2 candidate -> judge accept -> writer -> L2 row + revision', async () => {
    const faux = createFauxExtractionProvider()
    faux.setResponses([
      JSON.stringify({
        schemaVersion: 1,
        candidates: [
          {
            targetLayer: 'l2',
            content: '用户喜欢喝咖啡',
            confidence: 0.85,
            certainty: 'explicit',
            attribution: 'user_explicit',
            evidence: [{ messageId: 'msg_1', role: 'user', quote: '我喜欢喝咖啡' }],
            memoryType: 'stable',
            importance: 'high',
            forbiddenOverclaims: []
          }
        ]
      })
    ])
    const svc = createExtractionService({ provider: faux, logger: testNoopLogger })
    const judge = createMemoryJudge()

    const { candidates } = await svc.extract({
      turnId: 'turn_1',
      userMessageId: 'msg_1',
      userContent: '我喜欢喝咖啡'
    })
    const decisions = judge.judgeBatch(candidates, {
      turnId: 'turn_1',
      userMessageId: 'msg_1',
      userContent: '我喜欢喝咖啡'
    })
    expect(decisions[0].action).toBe('accept')

    const result = await dispatcher.dispatchBatch(decisions, {
      sessionId: 's1',
      turnId: 'turn_1'
    })
    expect(result.accepted).toBe(1)
    expect(result.writtenMemoryIds.length).toBe(1)
    expect(l2Store.count()).toBe(1)
    expect(revisionClock.current()).toBeGreaterThan(0)

    // 重放相同 extractionKey -> no-op
    await dispatcher.dispatchBatch(decisions, {
      sessionId: 's1',
      turnId: 'turn_1'
    })
    expect(l2Store.count()).toBe(1) // 没有重复写入
    // P2-37: attribution='user_explicit' -> source='user_explicit'
    const written = l2Store.get(result.writtenMemoryIds[0])
    expect(written?.source).toBe('user_explicit')
  })

  it('P2-37: L2 candidate attribution=assistant_inferred -> source=inferred', async () => {
    const faux = createFauxExtractionProvider()
    faux.setResponses([
      JSON.stringify({
        schemaVersion: 1,
        candidates: [
          {
            targetLayer: 'l2',
            content: '用户似乎偏好安静的环境',
            confidence: 0.6,
            certainty: 'inferred',
            attribution: 'assistant_inferred',
            evidence: [{ messageId: 'msg_1', role: 'user', quote: '我不喜欢太吵' }],
            memoryType: 'situational',
            importance: 'medium',
            forbiddenOverclaims: []
          }
        ]
      })
    ])
    const svc = createExtractionService({ provider: faux, logger: testNoopLogger })
    const judge = createMemoryJudge()

    const { candidates } = await svc.extract({
      turnId: 'turn_1',
      userMessageId: 'msg_1',
      userContent: '我不喜欢太吵'
    })
    const decisions = judge.judgeBatch(candidates, {
      turnId: 'turn_1',
      userMessageId: 'msg_1',
      userContent: '我不喜欢太吵'
    })
    expect(decisions[0].action).toBe('accept')

    const result = await dispatcher.dispatchBatch(decisions, {
      sessionId: 's1',
      turnId: 'turn_1'
    })
    expect(result.writtenMemoryIds.length).toBe(1)
    // P2-37: attribution='assistant_inferred' -> source='inferred'（保守降权）
    const written = l2Store.get(result.writtenMemoryIds[0])
    expect(written?.source).toBe('inferred')
  })
})
