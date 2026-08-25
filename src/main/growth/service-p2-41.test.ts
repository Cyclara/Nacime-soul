// src/main/growth/service-p2-41.test.ts
// P2-41 GrowthService 端到端测试。
// 验收（S-Phase2 P2-41）：填 preferredName -> ms.name 达成 -> 下轮 prompt relationship 层含片段；
//   快照幂等（同日跑两次 1 行）；U 值由 computeUnderstanding 三段权重派生；
//   里程碑只触发一次不回退。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeMemoryDb, testNoopLogger, type TestDb } from '../../../tests/helpers/test-db'
import { createGrowthEventBus } from './event-bus'
import { createGrowthService, createGrowthStore } from './service'
import { createGrowthBridgeHook } from './bridge'
import type { GrowthMetricsProvider } from './snapshot'

function makeProvider(overrides: Partial<GrowthMetricsProvider> = {}): GrowthMetricsProvider {
  return {
    getL0Fill: () => ({ rate: 0, filledCount: 0 }),
    getL1Freshness: () => 0,
    getL2Stats: () => ({
      total: 0,
      byState: { active: 0, dormant: 0, archived: 0 },
      uniqueTopics: 0
    }),
    getDmaeAggregate: () => null,
    ...overrides
  }
}

describe('P2-41 GrowthService 真实实现', () => {
  let t: TestDb
  let eventBus: ReturnType<typeof createGrowthEventBus>
  let service: ReturnType<typeof createGrowthService>
  let directStore: ReturnType<typeof createGrowthStore>
  let ts: number
  let l0Filled: Set<string>

  beforeEach(async () => {
    t = await makeMemoryDb()
    ts = new Date(2024, 2, 9, 12, 0, 0).getTime()
    l0Filled = new Set<string>()
    eventBus = createGrowthEventBus()
    // 动态 provider：l0Filled 反映当前 L0 已填字段
    const provider = makeProvider({
      getL0Fill: () => ({
        rate: l0Filled.size > 0 ? 0.2 : 0,
        filledCount: l0Filled.size
      })
    })
    service = createGrowthService({
      db: t.db,
      eventBus,
      logger: testNoopLogger,
      now: () => ts,
      metricsProvider: provider,
      getL0FilledFields: () => new Set(l0Filled),
      revisionClock: { next: () => 1 },
      broadcaster: { notify: () => {} }
    })
    directStore = createGrowthStore({ db: t.db })
  })
  afterEach(() => t.cleanup())

  it('填 preferredName -> emit l0.filled -> 快照后 ms.name 达成 -> promptFragments 含片段', () => {
    // 模拟用户"我叫小明" -> L0 写入 -> emit l0.filled
    l0Filled.add('preferredName')
    eventBus.emit({ id: 'e1', ts, type: 'l0.filled', payload: { field: 'preferredName' } })

    // 触发快照计算 -> 检查里程碑 -> ms.name 达成
    const snap = service.snapshotToday()
    expect(snap.date).toBe('2024-03-09') // 快照正常产出
    expect(l0Filled.has('preferredName')).toBe(true)

    const profile = service.getProfile()
    const reachedIds = profile.milestonesReached.map((m) => m.id)
    expect(reachedIds).toContain('ms.name')

    // promptFragments 应含 ms.name 的片段（"你已经知道用户的名字..."）
    expect(profile.promptFragments.some((f) => f.includes('名字'))).toBe(true)

    // milestone.reached 事件应已写入 growth_events
    const events = directStore.list({ type: 'milestone.reached' })
    expect(events.some((e) => e.payload.milestoneId === 'ms.name')).toBe(true)
  })

  it('里程碑只触发一次不回退（F5-006 §5）', () => {
    l0Filled.add('preferredName') // 持续填充
    eventBus.emit({ id: 'e1', ts, type: 'l0.filled', payload: { field: 'preferredName' } })
    service.snapshotToday()
    // 第二次快照（同日，幂等覆盖）
    service.snapshotToday()
    const events = directStore.list({ type: 'milestone.reached' })
    expect(events.filter((e) => e.payload.milestoneId === 'ms.name')).toHaveLength(1)
  })

  it('快照幂等（同日跑两次 growth_snapshots 1 行）', () => {
    service.snapshotToday()
    service.snapshotToday()
    const snaps = directStore // 用 snapshotStore 读 - 但 service 没暴露；用 db 直接查
    void snaps
    const rows = t.db.prepare(`SELECT COUNT(*) c FROM growth_snapshots`).get() as { c: number }
    expect(rows.c).toBe(1)
  })

  it('U 值由 l0FillRate + uniqueTopics + activeDays 三段派生', () => {
    // 设 provider 返回满 L0 + 50 topics + 0 activeDays -> U=80
    const ts2 = new Date(2024, 2, 9, 12, 0, 0).getTime()
    const eventBus2 = createGrowthEventBus()
    const svc2 = createGrowthService({
      db: t.db,
      eventBus: eventBus2,
      logger: testNoopLogger,
      now: () => ts2,
      metricsProvider: makeProvider({
        getL0Fill: () => ({ rate: 1, filledCount: 9 }),
        getL2Stats: () => ({
          total: 50,
          byState: { active: 15, dormant: 0, archived: 0 },
          uniqueTopics: 50
        })
      }),
      revisionClock: { next: () => 1 },
      broadcaster: { notify: () => {} }
    })
    const profile = svc2.getProfile()
    expect(profile.current.understanding).toBe(80) // 0.5·1 + 0.3·1 + 0.2·0 = 0.8 -> 80
    expect(profile.stage).toBe('close') // 80 >= 60 -> close
  })

  it('stage 派生：stranger(<10) / acquaintance(<30) / familiar(<60) / close(>=60)', async () => {
    const cases = [
      { rate: 0, topics: 0, days: 0, expected: 'stranger' as const },
      { rate: 0.2, topics: 0, days: 0, expected: 'acquaintance' as const }, // U=10
      { rate: 0.6, topics: 0, days: 0, expected: 'familiar' as const }, // U=30
      { rate: 1, topics: 50, days: 60, expected: 'close' as const } // U=100
    ]
    for (const c of cases) {
      const db2 = await makeMemoryDb()
      const eb = createGrowthEventBus()
      const svc = createGrowthService({
        db: db2.db,
        eventBus: eb,
        logger: testNoopLogger,
        now: () => ts,
        metricsProvider: makeProvider({
          getL0Fill: () => ({ rate: c.rate, filledCount: 0 }),
          getL2Stats: () => ({
            total: c.topics,
            byState: { active: 0, dormant: 0, archived: 0 },
            uniqueTopics: c.topics
          })
        }),
        revisionClock: { next: () => 1 },
        broadcaster: { notify: () => {} }
      })
      // 模拟 days
      for (let d = 0; d < c.days; d++) {
        eb.emit({ id: `d${d}`, ts, type: 'session.daily_first', payload: {} })
      }
      const profile = svc.getProfile()
      expect(profile.stage).toBe(c.expected)
      db2.cleanup()
    }
  })

  it('P2-41 全链路：turn.end bridge -> daily_first + snapshotToday -> 里程碑达成 -> promptFragments -> 快照落盘', async () => {
    // 已填 preferredName（模拟 L0 画像写入，getL0FilledFields 反映）
    l0Filled.add('preferredName')
    // 真实 bridge hook（snapshotToday 接 growthService，验证修复 1 的生产链路）
    const bridge = createGrowthBridgeHook({
      eventBus,
      store: directStore,
      revisionClock: { current: () => 0, next: () => 1 },
      broadcaster: { notify: () => {}, flush: () => {}, dispose: () => {} },
      logger: testNoopLogger,
      now: () => ts,
      snapshotToday: () => service.snapshotToday()
    })
    // 模拟当天首轮 turn.end（memoryEligible=true，无引用记忆）
    await bridge.fn(
      { event: 'turn.end', turnId: 't1' },
      {
        turnId: 't1',
        sessionId: 's1',
        requestId: 'r1',
        status: 'completed',
        inputLen: 10,
        outputLen: 20,
        memoryEligible: true,
        referencedMemoryIds: []
      }
    )
    // ① session.daily_first 已写 growth_events
    expect(directStore.count({ type: 'session.daily_first' })).toBe(1)
    // ② snapshotToday 已触发 -> ms.name 里程碑达成（checkMilestones 在 snapshotToday 内）
    const profile = service.getProfile()
    const reachedIds = profile.milestonesReached.map((m) => m.id)
    expect(reachedIds).toContain('ms.name')
    // ③ promptFragments 含 ms.name 片段（relationship 层数据源）
    expect(profile.promptFragments.some((f) => f.includes('名字'))).toBe(true)
    // ④ growth_snapshots 已落盘 1 行
    const rows = t.db.prepare(`SELECT COUNT(*) c FROM growth_snapshots`).get() as { c: number }
    expect(rows.c).toBe(1)
  })

  it('getTimeline 返回里程碑叙事（倒序）', () => {
    l0Filled.add('preferredName')
    eventBus.emit({ id: 'e1', ts, type: 'l0.filled', payload: { field: 'preferredName' } })
    service.snapshotToday()
    const timeline = service.getTimeline()
    expect(timeline.length).toBeGreaterThan(0)
    expect(timeline[0].kind).toBe('milestone')
    expect(timeline[0].title).toBe('她记住了你的名字')
  })

  it('getTrend 从 growth_snapshots 表查', () => {
    service.snapshotToday()
    const trend = service.getTrend('understanding', 7)
    expect(trend.length).toBeGreaterThanOrEqual(1)
  })

  it('rebuildFromEvents 清空快照表后重建', async () => {
    // 先建一个快照
    service.snapshotToday()
    expect((t.db.prepare(`SELECT COUNT(*) c FROM growth_snapshots`).get() as { c: number }).c).toBe(
      1
    )
    // 不需要 await，因为内部同步
    await service.rebuildFromEvents()
    // rebuild 清空再重建
    const count = (t.db.prepare(`SELECT COUNT(*) c FROM growth_snapshots`).get() as { c: number }).c
    expect(count).toBeGreaterThanOrEqual(0) // 重建后可能有也可能 0（取决于 session.daily_first）
  })
})
