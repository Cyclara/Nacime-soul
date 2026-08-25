// src/main/growth/service.test.ts
// P2-40 GrowthStore + GrowthService 测试。
// 验收（S-Phase2 P2-40）：模拟 20 事件 -> 表 20 行、payload 无内容文本。
// 依据：F5-006 §3/§5（事件溯源投影、payload 只存 ID/枚举、ingest 同步非事务失败只 warn）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeMemoryDb, testNoopLogger, type TestDb } from '../../../tests/helpers/test-db'
import { createGrowthEventBus } from './event-bus'
import { createGrowthService, createGrowthStore } from './service'
import type { GrowthEvent } from './types'

describe('P2-40 GrowthStore', () => {
  let t: TestDb
  let store: ReturnType<typeof createGrowthStore>
  let clock: number
  let idc: number

  beforeEach(async () => {
    t = await makeMemoryDb()
    clock = 1710000000000
    idc = 0
    store = createGrowthStore({ db: t.db, now: () => clock })
  })
  afterEach(() => t.cleanup())

  function makeEvent(overrides: Partial<GrowthEvent> = {}): GrowthEvent {
    return {
      id: `evt_${idc++}`,
      ts: clock,
      type: 'l2.added',
      payload: { memoryId: 'l2_test1' },
      ...overrides
    }
  }

  it('append + list: 20 事件 -> 20 行', () => {
    for (let i = 0; i < 20; i++) {
      store.append(makeEvent({ id: `evt_${i}`, ts: clock + i }))
    }
    expect(store.count()).toBe(20)
    expect(store.list().length).toBe(20)
  })

  it('payload 只含 ID/枚举，不含内容文本（隐私纪律 F5-006 §5）', () => {
    store.append(makeEvent({ payload: { memoryId: 'l2_abc', field: 'preferredName' } }))
    const rows = store.list()
    expect(rows[0].payload.memoryId).toBe('l2_abc')
    expect(rows[0].payload.field).toBe('preferredName')
    const payloadStr = JSON.stringify(rows[0].payload)
    expect(payloadStr).not.toMatch(/content|quote|text/i)
  })

  it('list 按 ts 升序', () => {
    store.append(makeEvent({ id: 'e3', ts: clock + 300 }))
    store.append(makeEvent({ id: 'e1', ts: clock + 100 }))
    store.append(makeEvent({ id: 'e2', ts: clock + 200 }))
    const rows = store.list()
    expect(rows.map((r) => r.id)).toEqual(['e1', 'e2', 'e3'])
  })

  it('count with type filter', () => {
    store.append(makeEvent({ type: 'l2.added' }))
    store.append(makeEvent({ type: 'l0.filled' }))
    store.append(makeEvent({ type: 'l2.added' }))
    expect(store.count()).toBe(3)
    expect(store.count({ type: 'l2.added' })).toBe(2)
    expect(store.count({ type: 'l0.filled' })).toBe(1)
  })

  it('count with sinceTs filter', () => {
    store.append(makeEvent({ id: 'a', ts: 1000 }))
    store.append(makeEvent({ id: 'b', ts: 2000 }))
    store.append(makeEvent({ id: 'c', ts: 3000 }))
    expect(store.count({ sinceTs: 2000 })).toBe(2)
  })

  it('hasTypeOnDate: 当天事件检测', () => {
    // 本地时区 2024-03-09 12:00
    const ts = new Date(2024, 2, 9, 12, 0, 0).getTime()
    store.append(makeEvent({ type: 'session.daily_first', ts }))
    expect(store.hasTypeOnDate('session.daily_first', '2024-03-09')).toBe(true)
    expect(store.hasTypeOnDate('session.daily_first', '2024-03-10')).toBe(false)
    expect(store.hasTypeOnDate('l2.added', '2024-03-09')).toBe(false)
  })

  it('hasTypeOnDate: 跨零点事件归当天', () => {
    // 本地时区 2024-03-09 23:59
    const ts = new Date(2024, 2, 9, 23, 59, 0).getTime()
    store.append(makeEvent({ type: 'session.daily_first', ts }))
    expect(store.hasTypeOnDate('session.daily_first', '2024-03-09')).toBe(true)
    expect(store.hasTypeOnDate('session.daily_first', '2024-03-10')).toBe(false)
  })

  it('hasTypeOnDate: 非法日期返回 false', () => {
    expect(store.hasTypeOnDate('session.daily_first', 'invalid')).toBe(false)
  })
})

describe('P2-40 GrowthService.ingest', () => {
  let t: TestDb
  let eventBus: ReturnType<typeof createGrowthEventBus>
  let service: ReturnType<typeof createGrowthService>
  let store: ReturnType<typeof createGrowthStore>
  let clock: number

  beforeEach(async () => {
    t = await makeMemoryDb()
    clock = 1710000000000
    eventBus = createGrowthEventBus()
    service = createGrowthService({
      db: t.db,
      eventBus,
      logger: testNoopLogger,
      now: () => clock
    })
    store = createGrowthStore({ db: t.db })
  })
  afterEach(() => t.cleanup())

  it('EventBus emit -> ingest 自动写表（20 事件 -> 20 行）', () => {
    for (let i = 0; i < 20; i++) {
      eventBus.emit({
        id: `evt_${i}`,
        ts: clock + i,
        type: 'l2.added',
        payload: { memoryId: `l2_${i}` }
      })
    }
    expect(store.count()).toBe(20)
  })

  it('ingest 失败只 warn，不抛错（主键冲突场景）', () => {
    const event: GrowthEvent = {
      id: 'evt_dup',
      ts: clock,
      type: 'l2.added',
      payload: { memoryId: 'l2_dup' }
    }
    // 第一次成功
    service.ingest(event)
    expect(store.count()).toBe(1)
    // 第二次主键冲突 -> ingest 内部 catch -> warn，不抛错
    expect(() => service.ingest(event)).not.toThrow()
    // 表里仍只有 1 行（第二次失败未写入）
    expect(store.count()).toBe(1)
  })

  it('payload 不含内容文本（F5-006 §5 隐私纪律）', () => {
    eventBus.emit({
      id: 'evt_1',
      ts: clock,
      type: 'l2.added',
      payload: { memoryId: 'l2_secret' }
    })
    const rows = store.list()
    expect(rows[0].payload.memoryId).toBe('l2_secret')
    const payloadStr = JSON.stringify(rows[0].payload)
    expect(payloadStr).not.toMatch(/content|quote|text/i)
  })

  it('多种事件类型都能 ingest', () => {
    const types = [
      'l0.filled',
      'l0.updated',
      'l1.refreshed',
      'l2.added',
      'l2.referenced',
      'conflict.resolved',
      'session.daily_first'
    ] as const
    for (const type of types) {
      eventBus.emit({ id: `evt_${type}`, ts: clock, type, payload: {} })
    }
    expect(store.count()).toBe(types.length)
    expect(store.count({ type: 'l0.filled' })).toBe(1)
  })

  it('S-004 G-01: 全部 10 种事件类型 payload 只含 ID/枚举，无内容文本', () => {
    const types = [
      'l0.filled',
      'l0.updated',
      'l1.refreshed',
      'l2.added',
      'l2.referenced',
      'l2.confirmed',
      'l2.corrected',
      'conflict.resolved',
      'session.daily_first',
      'milestone.reached'
    ] as const
    for (const type of types) {
      eventBus.emit({
        id: `evt_${type}`,
        ts: clock,
        type,
        payload: { memoryId: 'l2_x', field: 'preferredName', milestoneId: 'ms.name' }
      })
    }
    const rows = store.list()
    expect(rows).toHaveLength(types.length)
    for (const r of rows) {
      const s = JSON.stringify(r.payload)
      // 无 content/quote/text 字段
      expect(s).not.toMatch(/content|quote|text/i)
      // 无中文长文本（≥10 连续中文 = 记忆内容/叙事文本不该出现在 payload）
      expect(/[一-龥]{10,}/.test(s)).toBe(false)
    }
  })

  it('getProfile 返回初始态（P2-41 替换为真实实现）', () => {
    const profile = service.getProfile()
    expect(profile.stage).toBe('stranger')
    expect(profile.current.understanding).toBe(0)
    expect(profile.milestonesReached).toEqual([])
    expect(profile.promptFragments).toEqual([])
  })
})
