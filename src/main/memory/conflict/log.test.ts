// src/main/memory/conflict/log.test.ts
// P2-21 ConflictLogStore：append/list/get/count/listByMemory/listByPair。
// 表结构由 001_init 建立；本测试验证 CRUD + 过滤 + 审计查询。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeMemoryDb, type TestDb } from '../../../../tests/helpers/test-db'
import { createConflictLogStore } from './log'
import type { ConflictLogEntry } from './log'

describe('P2-21 ConflictLogStore', () => {
  let t: TestDb
  let store: ReturnType<typeof createConflictLogStore>
  let clock: number
  let suffixc: number

  beforeEach(async () => {
    t = await makeMemoryDb()
    clock = 1710000000000
    suffixc = 0
    store = createConflictLogStore({
      db: t.db,
      now: () => clock,
      randomSuffix: () => `s${suffixc++}`
    })
  })
  afterEach(() => t.cleanup())

  function makeEntry(overrides: Partial<ConflictLogEntry> = {}): ConflictLogEntry {
    return {
      id: '',
      ts: 0,
      newMemoryId: 'l2_new1',
      existingMemoryId: 'l2_old1',
      score: 80,
      band: 'high',
      signals: { correctionIntent: 20, ragCandidate: 25 },
      resolution: 'supersede',
      resolvedAt: 1710000000000,
      ...overrides
    } as ConflictLogEntry
  }

  it('append: 生成 id/ts 并落库', () => {
    const entry = store.append(makeEntry())
    expect(entry.id).toBe('cf_1710000000000_s0')
    expect(entry.ts).toBe(1710000000000)
    expect(entry.newMemoryId).toBe('l2_new1')
    expect(entry.existingMemoryId).toBe('l2_old1')
    expect(entry.score).toBe(80)
    expect(entry.band).toBe('high')
    expect(entry.signals).toEqual({ correctionIntent: 20, ragCandidate: 25 })
    expect(entry.resolution).toBe('supersede')
    expect(entry.resolvedAt).toBe(1710000000000)
  })

  it('get: 按 id 查单条', () => {
    const entry = store.append(makeEntry())
    const got = store.get(entry.id)
    expect(got).not.toBeNull()
    expect(got?.id).toBe(entry.id)
    expect(got?.score).toBe(80)
  })

  it('get: 不存在返回 null', () => {
    expect(store.get('nonexistent')).toBeNull()
  })

  it('list: 按 ts 倒序', () => {
    store.append(makeEntry({ score: 80 }))
    clock += 1000
    store.append(makeEntry({ score: 55 }))
    clock += 1000
    store.append(makeEntry({ score: 35 }))
    const list = store.list()
    expect(list).toHaveLength(3)
    expect(list[0].score).toBe(35) // 最新在前
    expect(list[2].score).toBe(80)
  })

  it('list: 按 band 过滤', () => {
    store.append(makeEntry({ band: 'high', score: 80 }))
    store.append(makeEntry({ band: 'normal', score: 55 }))
    store.append(makeEntry({ band: 'idle', score: 35 }))
    const highOnly = store.list({ band: 'high' })
    expect(highOnly).toHaveLength(1)
    expect(highOnly[0].band).toBe('high')
    const multi = store.list({ band: ['high', 'normal'] })
    expect(multi).toHaveLength(2)
  })

  it('list: 按 resolution 过滤', () => {
    store.append(makeEntry({ resolution: 'supersede' }))
    store.append(makeEntry({ resolution: 'coexist' }))
    store.append(makeEntry({ resolution: 'none' }))
    const supersede = store.list({ resolution: 'supersede' })
    expect(supersede).toHaveLength(1)
    expect(supersede[0].resolution).toBe('supersede')
  })

  it('list: 按 memoryId 过滤（new 或 existing）', () => {
    store.append(makeEntry({ newMemoryId: 'l2_a', existingMemoryId: 'l2_x' }))
    store.append(makeEntry({ newMemoryId: 'l2_b', existingMemoryId: 'l2_x' }))
    store.append(makeEntry({ newMemoryId: 'l2_c', existingMemoryId: 'l2_y' }))
    const xConflicts = store.list({ memoryId: 'l2_x' })
    expect(xConflicts).toHaveLength(2)
  })

  it('list: limit + offset 分页', () => {
    for (let i = 0; i < 5; i++) {
      clock += 1000
      store.append(makeEntry({ score: i }))
    }
    const page1 = store.list({ limit: 2, offset: 0 })
    const page2 = store.list({ limit: 2, offset: 2 })
    expect(page1).toHaveLength(2)
    expect(page2).toHaveLength(2)
    expect(page1[0].score).not.toBe(page2[0].score)
  })

  it('count: 总数', () => {
    store.append(makeEntry())
    store.append(makeEntry())
    expect(store.count()).toBe(2)
  })

  it('count: 按 band 过滤', () => {
    store.append(makeEntry({ band: 'high' }))
    store.append(makeEntry({ band: 'high' }))
    store.append(makeEntry({ band: 'normal' }))
    expect(store.count({ band: 'high' })).toBe(2)
  })

  it('listByMemory: 涉及某记忆的冲突（new 或 existing）', () => {
    store.append(makeEntry({ newMemoryId: 'l2_a', existingMemoryId: 'l2_b' }))
    store.append(makeEntry({ newMemoryId: 'l2_c', existingMemoryId: 'l2_b' }))
    store.append(makeEntry({ newMemoryId: 'l2_b', existingMemoryId: 'l2_d' }))
    const bConflicts = store.listByMemory('l2_b')
    expect(bConflicts).toHaveLength(3)
  })

  it('listByMemory: limit', () => {
    for (let i = 0; i < 5; i++) {
      clock += 1000
      store.append(makeEntry({ newMemoryId: 'l2_a', existingMemoryId: `l2_old${i}` }))
    }
    const limited = store.listByMemory('l2_a', 2)
    expect(limited).toHaveLength(2)
  })

  it('listByPair: 查询同一对冲突', () => {
    store.append(makeEntry({ newMemoryId: 'l2_new', existingMemoryId: 'l2_old' }))
    store.append(makeEntry({ newMemoryId: 'l2_new', existingMemoryId: 'l2_other' }))
    const pair = store.listByPair('l2_new', 'l2_old')
    expect(pair).toHaveLength(1)
    expect(pair[0].existingMemoryId).toBe('l2_old')
  })

  it('listByPair: sinceTs 时间过滤', () => {
    clock = 1000
    store.append(makeEntry({ newMemoryId: 'l2_new', existingMemoryId: 'l2_old' }))
    clock = 5000
    store.append(makeEntry({ newMemoryId: 'l2_new', existingMemoryId: 'l2_old' }))
    const recent = store.listByPair('l2_new', 'l2_old', 4000)
    expect(recent).toHaveLength(1)
    expect(recent[0].ts).toBe(5000)
  })

  it('signals 损坏 JSON 不阻塞查询', () => {
    // 直接插一条 signals 为损坏 JSON 的行
    t.db
      .prepare(
        `INSERT INTO conflict_log (id, ts, new_memory_id, existing_memory_id, score, band, signals, resolution, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('cf_bad', 1710000000000, 'l2_a', 'l2_b', 50, 'normal', '{broken', 'none', null)
    const entry = store.get('cf_bad')
    expect(entry).not.toBeNull()
    expect(entry?.signals).toEqual({})
  })

  it('resolution=none 记录未解决冲突', () => {
    store.append(makeEntry({ resolution: 'none', resolvedAt: null }))
    const list = store.list({ resolution: 'none' })
    expect(list).toHaveLength(1)
    expect(list[0].resolvedAt).toBeNull()
  })
})
