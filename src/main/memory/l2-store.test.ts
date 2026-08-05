// src/main/memory/l2-store.test.ts
// P2-07：14 字段写读回等价、evidenceIds 溯源、emit、list/count/update/remove/touch。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createL2Store, type L2Store } from './l2-store'
import { makeMemoryDb, type TestDb } from '../../../tests/helpers/test-db'

describe('P2-07 L2Store', () => {
  let t: TestDb
  let store: L2Store
  let idc = 0

  beforeEach(async () => {
    t = await makeMemoryDb()
    idc = 0
    store = createL2Store({ db: t.db, now: () => 1710000000000, randomSuffix: () => `s${idc++}` })
  })
  afterEach(() => t.cleanup())

  it('add then get round-trips all 14 fields (evidence traceable)', () => {
    const mem = store.add({
      content: '用户喜欢喝咖啡',
      confidence: 0.8,
      evidenceIds: ['msg_1', 'msg_2'],
      sourceMessageIds: ['msg_1'],
      triggerText: '我爱喝咖啡',
      type: 'stable',
      importance: 8,
      isPinned: true
    })
    expect(mem.id.startsWith('l2_1710000000000_')).toBe(true)
    const got = store.get(mem.id)
    expect(got).toEqual(mem)
    expect(got?.evidenceIds).toEqual(['msg_1', 'msg_2'])
    expect(got?.isPinned).toBe(true)
    expect(got?.syncStatus).toBe('pending') // 默认待嵌入
    expect(got?.lifecycleState).toBe('active')
  })

  it('emits l2.added on add', () => {
    const added: string[] = []
    store.on('l2.added', (m) => added.push(m.id))
    const mem = store.add({ content: 'x', confidence: 0.5 })
    expect(added).toEqual([mem.id])
  })

  it('update patches fields', () => {
    const mem = store.add({ content: 'x', confidence: 0.5 })
    store.update(mem.id, { lifecycleState: 'archived', archivedAt: 999, confidence: 0.9 })
    const got = store.get(mem.id)
    expect(got?.lifecycleState).toBe('archived')
    expect(got?.archivedAt).toBe(999)
    expect(got?.confidence).toBe(0.9)
  })

  it('list filters by lifecycleState and syncStatus; count works', () => {
    store.add({ content: 'a', confidence: 0.5, lifecycleState: 'active', syncStatus: 'synced' })
    store.add({ content: 'b', confidence: 0.5, lifecycleState: 'archived', syncStatus: 'pending' })
    expect(store.list({ lifecycleState: 'active' }).length).toBe(1)
    expect(store.list({ syncStatus: 'pending' }).length).toBe(1)
    expect(store.list({ lifecycleState: ['active', 'archived'] }).length).toBe(2)
    expect(store.count()).toBe(2)
    expect(store.count({ syncStatus: 'synced' })).toBe(1)
  })

  it('touch increments accessCount', () => {
    const mem = store.add({ content: 'x', confidence: 0.5 })
    store.touch(mem.id)
    store.touch(mem.id)
    expect(store.get(mem.id)?.accessCount).toBe(2)
  })

  it('remove deletes the row', () => {
    const mem = store.add({ content: 'x', confidence: 0.5 })
    store.remove(mem.id)
    expect(store.get(mem.id)).toBeNull()
  })

  it('get returns null for unknown id', () => {
    expect(store.get('l2_nope')).toBeNull()
  })

  it('search 在 SQL 截断前执行：120 条中末尾 5 条匹配仍全部可见，count 只统计匹配项', () => {
    let tick = 0
    const pagedStore = createL2Store({
      db: t.db,
      now: () => 1710000000000 + tick++,
      randomSuffix: () => 'q'
    })
    // 先插匹配项，使其在 ORDER BY id DESC 时落到 115 条较新记录之后。
    for (let i = 0; i < 5; i++) {
      pagedStore.add({ content: `needle-${i}`, confidence: 0.8 })
    }
    for (let i = 0; i < 115; i++) {
      pagedStore.add({ content: `ordinary-${i}`, confidence: 0.8 })
    }

    const matches = pagedStore.list({ search: 'needle', limit: 50, offset: 0 })

    expect(matches.map((m) => m.content).sort()).toEqual([
      'needle-0',
      'needle-1',
      'needle-2',
      'needle-3',
      'needle-4'
    ])
    expect(pagedStore.count({ search: 'needle' })).toBe(5)
  })

  it('offset 在 SQL 层分页', () => {
    let tick = 0
    const pagedStore = createL2Store({
      db: t.db,
      now: () => 1710000000000 + tick++,
      randomSuffix: () => 'o'
    })
    for (let i = 0; i < 8; i++) {
      pagedStore.add({ content: `item-${i}`, confidence: 0.8 })
    }

    expect(pagedStore.list({ limit: 3, offset: 2 }).map((m) => m.content)).toEqual([
      'item-5',
      'item-4',
      'item-3'
    ])
  })

  it('LIKE 把百分号、下划线与反斜线按字面匹配', () => {
    store.add({ content: '进度 100%', confidence: 0.8 })
    store.add({ content: '进度 1000', confidence: 0.8 })
    store.add({ content: '标识 a_b', confidence: 0.8 })
    store.add({ content: '标识 acb', confidence: 0.8 })
    store.add({ content: String.raw`路径 C:\temp`, confidence: 0.8 })
    store.add({ content: String.raw`路径 C:temp`, confidence: 0.8 })

    expect(store.list({ search: '100%' }).map((m) => m.content)).toEqual(['进度 100%'])
    expect(store.list({ search: 'a_b' }).map((m) => m.content)).toEqual(['标识 a_b'])
    expect(store.list({ search: String.raw`C:\temp` }).map((m) => m.content)).toEqual([
      String.raw`路径 C:\temp`
    ])
  })
})
