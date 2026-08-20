// src/main/growth/snapshot.test.ts
// P2-41 快照 + U 值计算测试。
// 验收（S-Phase2 P2-41）：computeUnderstanding 公式三段权重、snapshotToday 同日幂等、
//   refAccuracy7d 公式（referenced7d<5 时 null）、activeDays = session.daily_first 计数。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeMemoryDb, testNoopLogger, type TestDb } from '../../../tests/helpers/test-db'
import { computeSnapshot, createSnapshotStore, type GrowthMetricsProvider } from './snapshot'
import { createGrowthStore } from './service'
import { computeUnderstanding } from './types'
import type { GrowthSnapshot } from './types'

describe('P2-41 computeUnderstanding 公式', () => {
  it('U = 100·(0.5·l0FillRate + 0.3·min(1,topics/50) + 0.2·min(1,days/60)) — 三段权重', () => {
    // 全 0
    expect(computeUnderstanding({ l0FillRate: 0, uniqueTopics: 0, activeDays: 0 })).toBe(0)
    // L0 满分（0.5·1=0.5），其余 0 -> U=50
    expect(computeUnderstanding({ l0FillRate: 1, uniqueTopics: 0, activeDays: 0 })).toBe(50)
    // topics 满（50+，0.3·1=0.3），L0 0，days 0 -> U=30
    expect(computeUnderstanding({ l0FillRate: 0, uniqueTopics: 50, activeDays: 0 })).toBe(30)
    // days 满（60+，0.2·1=0.2），L0 0，topics 0 -> U=20
    expect(computeUnderstanding({ l0FillRate: 0, uniqueTopics: 0, activeDays: 60 })).toBe(20)
    // 全满 -> U=100
    expect(computeUnderstanding({ l0FillRate: 1, uniqueTopics: 50, activeDays: 60 })).toBe(100)
  })

  it('uniqueTopics / 50 截断（topics=100 仍按 1 算）', () => {
    expect(computeUnderstanding({ l0FillRate: 0, uniqueTopics: 100, activeDays: 0 })).toBe(30)
  })

  it('activeDays / 60 截断', () => {
    expect(computeUnderstanding({ l0FillRate: 0, uniqueTopics: 0, activeDays: 600 })).toBe(20)
  })

  it('四舍五入到整数百分比', () => {
    // 0.5·0.333 + 0.3·0 + 0.2·0 = 0.1665 -> 16.65 -> 17
    const u = computeUnderstanding({ l0FillRate: 1 / 3, uniqueTopics: 0, activeDays: 0 })
    expect(u).toBe(17)
  })
})

describe('P2-41 computeSnapshot', () => {
  let t: TestDb
  let eventStore: ReturnType<typeof createGrowthStore>
  let timestamp: number

  beforeEach(async () => {
    t = await makeMemoryDb()
    timestamp = new Date(2024, 2, 9, 12, 0, 0).getTime()
    eventStore = createGrowthStore({ db: t.db, now: () => timestamp })
  })
  afterEach(() => t.cleanup())

  /** 模拟一批 l2.referenced 事件（同一 ts = 同一轮 turn.end fan-out） */
  function emitReferencedBatch(count: number, ts: number): void {
    for (let i = 0; i < count; i++) {
      eventStore.append({
        id: `ref_${i}_${ts}`,
        ts,
        type: 'l2.referenced',
        payload: { memoryId: `l2_${i}` }
      })
    }
  }

  function makeProvider(overrides: Partial<GrowthMetricsProvider> = {}): GrowthMetricsProvider {
    return {
      getL0Fill: () => ({ rate: 0.5, filledCount: 4 }),
      getL1Freshness: () => 0.7,
      getL2Stats: () => ({
        total: 120,
        byState: { active: 10, dormant: 5, archived: 2 },
        uniqueTopics: 30
      }),
      getDmaeAggregate: () => ({ avgActivation: 42, oldestActiveDays: 5 }),
      ...overrides
    }
  }

  it('A 层：l0FillRate/l1Freshness/l2Total/byState 从 metrics provider 读；uniqueTopics 用 l2Total 近似', () => {
    const snap = computeSnapshot('2024-03-09', makeProvider(), eventStore, timestamp)
    expect(snap.l0FillRate).toBe(0.5)
    expect(snap.l0FilledCount).toBe(4)
    expect(snap.l1FreshnessScore).toBe(0.7)
    expect(snap.l2Total).toBe(120)
    expect(snap.l2ByState).toEqual({ active: 10, dormant: 5, archived: 2 })
    expect(snap.uniqueTopics).toBe(30)
  })

  it('C 层：DMAE 聚合（dmae 关闭时全 0）', () => {
    const snapWithDmae = computeSnapshot(
      '2024-03-09',
      makeProvider({ getDmaeAggregate: () => ({ avgActivation: 42, oldestActiveDays: 5 }) }),
      eventStore,
      timestamp
    )
    expect(snapWithDmae.dmaeAvgActivation).toBe(42)
    expect(snapWithDmae.dmaeOldestActiveDays).toBe(5)

    const snapNoDmae = computeSnapshot(
      '2024-03-09',
      makeProvider({ getDmaeAggregate: () => null }),
      eventStore,
      timestamp
    )
    expect(snapNoDmae.dmaeAvgActivation).toBe(0)
    expect(snapNoDmae.dmaeOldestActiveDays).toBe(0)
  })

  it('B 层 refAccuracy7d = 1 - corrected/referenced；referenced7d < 5 时 null', () => {
    // 仅 3 条 referenced（< 5），无 corrected -> null
    emitReferencedBatch(3, timestamp)
    const snap = computeSnapshot('2024-03-09', makeProvider(), eventStore, timestamp)
    expect(snap.refAccuracy7d).toBeNull()
  })

  it('B 层 refAccuracy7d = 1 - 0 = 1（5 条 referenced，0 corrected）', () => {
    emitReferencedBatch(5, timestamp)
    const snap = computeSnapshot('2024-03-09', makeProvider(), eventStore, timestamp)
    expect(snap.refAccuracy7d).toBe(1)
  })

  it('B 层 refAccuracy7d = 1 - 2/10 = 0.8', () => {
    emitReferencedBatch(10, timestamp)
    // 2 条 corrected
    eventStore.append({
      id: 'c1',
      ts: timestamp,
      type: 'l2.corrected',
      payload: { memoryId: 'l2_0' }
    })
    eventStore.append({
      id: 'c2',
      ts: timestamp,
      type: 'l2.corrected',
      payload: { memoryId: 'l2_1' }
    })
    const snap = computeSnapshot('2024-03-09', makeProvider(), eventStore, timestamp)
    expect(snap.refAccuracy7d).toBe(0.8)
    expect(snap.correctionsTotal).toBe(2)
  })

  it('B 层 refAccuracy7d 只算近 7 天（7 天前的 corrected 不计）', () => {
    // 5 条 referenced（最近）+ 1 条 corrected（8 天前，超出 7 天窗口）
    emitReferencedBatch(5, timestamp)
    const oldTs = timestamp - 8 * 24 * 3600 * 1000
    eventStore.append({
      id: 'old_c',
      ts: oldTs,
      type: 'l2.corrected',
      payload: { memoryId: 'l2_0' }
    })
    const snap = computeSnapshot('2024-03-09', makeProvider(), eventStore, timestamp)
    expect(snap.refAccuracy7d).toBe(1) // 7 天内的 corrected 0 条
    expect(snap.correctionsTotal).toBe(1) // 但 correctionsTotal 累计所有
  })

  it('汇总 activeDays = session.daily_first 事件计数', () => {
    eventStore.append({ id: 'd1', ts: timestamp, type: 'session.daily_first', payload: {} })
    eventStore.append({
      id: 'd2',
      ts: timestamp + 86400000,
      type: 'session.daily_first',
      payload: {}
    })
    const snap = computeSnapshot('2024-03-09', makeProvider(), eventStore, timestamp)
    expect(snap.activeDays).toBe(2)
  })

  it('S-004 G-02: 跨午夜两天各一个 daily_first -> activeDays=2（23:59 对话 + 次日 00:01 对话）', () => {
    const day1Late = new Date(2024, 2, 9, 23, 59, 0).getTime() // 3/9 23:59（本地）
    const day2Early = new Date(2024, 2, 10, 0, 1, 0).getTime() // 3/10 00:01（本地，跨零点）
    eventStore.append({ id: 'd1', ts: day1Late, type: 'session.daily_first', payload: {} })
    eventStore.append({ id: 'd2', ts: day2Early, type: 'session.daily_first', payload: {} })
    // 3/10 快照：activeDays 应累计到 2（两个不同本地日）
    const snap = computeSnapshot('2024-03-10', makeProvider(), eventStore, day2Early)
    expect(snap.activeDays).toBe(2)
  })

  it('U 值由 computeUnderstanding 从 snapshot 字段派生', () => {
    const snap = computeSnapshot(
      '2024-03-09',
      makeProvider({
        getL0Fill: () => ({ rate: 1, filledCount: 9 }),
        getL2Stats: () => ({
          total: 50,
          byState: { active: 15, dormant: 0, archived: 0 },
          uniqueTopics: 50
        }),
        getDmaeAggregate: () => null
      }),
      eventStore,
      timestamp
    )
    // L0 满(0.5) + topics 满(0.3) + activeDays 0 -> U=80
    expect(snap.understanding).toBe(80)
  })
})

describe('P2-41 SnapshotStore', () => {
  let t: TestDb
  let store: ReturnType<typeof createSnapshotStore>

  beforeEach(async () => {
    t = await makeMemoryDb()
    store = createSnapshotStore({ db: t.db })
  })
  afterEach(() => t.cleanup())

  function makeSnap(date: string, understanding: number): GrowthSnapshot {
    const base: GrowthSnapshot = {
      date,
      l0FillRate: 0,
      l0FilledCount: 0,
      l1FreshnessScore: 0,
      l2Total: 0,
      l2ByState: { active: 0, dormant: 0, archived: 0 },
      refAccuracy7d: null,
      correctionsTotal: 0,
      manualEvalScore: null,
      dmaeAvgActivation: 0,
      dmaeOldestActiveDays: 0,
      understanding,
      activeDays: 0,
      uniqueTopics: 0
    }
    return base
  }

  it('upsert + get: 存取', () => {
    store.upsert(makeSnap('2024-03-09', 50))
    const got = store.get('2024-03-09')
    expect(got?.understanding).toBe(50)
  })

  void testNoopLogger // 占位避免未使用警告
  it('同日 upsert 幂等覆盖（date 为主键）', () => {
    store.upsert(makeSnap('2024-03-09', 50))
    store.upsert(makeSnap('2024-03-09', 80)) // 同日覆盖
    const got = store.get('2024-03-09')
    expect(got?.understanding).toBe(80)
  })

  it('get 不存在返回 null', () => {
    expect(store.get('1999-01-01')).toBeNull()
  })

  it('listRecent 取最近 N 天（降序查升序返）', () => {
    store.upsert(makeSnap('2024-03-07', 1))
    store.upsert(makeSnap('2024-03-08', 2))
    store.upsert(makeSnap('2024-03-09', 3))
    const recent = store.listRecent(2)
    expect(recent.map((s) => s.date)).toEqual(['2024-03-08', '2024-03-09']) // 升序
  })

  it('getTrend 返回 N 天指标序列', () => {
    store.upsert(makeSnap('2024-03-07', 10))
    store.upsert(makeSnap('2024-03-08', 20))
    store.upsert(makeSnap('2024-03-09', 30))
    const trend = store.getTrend('understanding', 3)
    expect(trend.map((p) => p.value)).toEqual([10, 20, 30])
    expect(trend.map((p) => p.date)).toEqual(['2024-03-07', '2024-03-08', '2024-03-09'])
  })
})
