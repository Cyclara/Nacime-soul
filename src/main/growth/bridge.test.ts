// src/main/growth/bridge.test.ts
// P2-40 growth bridge hook 测试。
// 验收（S-011 §1.6）：memoryEligible=true 时 fan-out l2.referenced；session.daily_first 同日幂等；
//   memoryEligible=false 不发事件；实际发射事件时 revisionClock.next + broadcaster.notify('growth')。
import { describe, it, expect, beforeEach } from 'vitest'
import { createGrowthEventBus } from './event-bus'
import { createGrowthBridgeHook, toLocalDate } from './bridge'
import type { GrowthEvent } from './types'
import type { GrowthStore } from './service'
import { testNoopLogger } from '../../../tests/helpers/test-db'

// === Mock 工厂 ===

function makeMockStore(existingDaily = false): {
  store: GrowthStore
  events: GrowthEvent[]
  setHasDaily: (v: boolean) => void
} {
  const events: GrowthEvent[] = []
  let hasDaily = existingDaily
  return {
    events,
    setHasDaily: (v: boolean) => {
      hasDaily = v
    },
    store: {
      append(e: GrowthEvent) {
        events.push(e)
      },
      list() {
        return events
      },
      count() {
        return events.length
      },
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      hasTypeOnDate(_type: string, _date: string) {
        return hasDaily
      },
      lastTs(type: string) {
        const found = [...events].reverse().find((e) => e.type === type)
        return found ? found.ts : null
      }
    }
  }
}

function makeMockRevisionClock(): {
  clock: { current: () => number; next: () => number }
  readonly nextCalls: number
} {
  let v = 0
  let nextCalls = 0
  return {
    clock: {
      current: () => v,
      next: () => {
        v++
        nextCalls++
        return v
      }
    },
    get nextCalls() {
      return nextCalls
    }
  }
}

function makeMockBroadcaster(): {
  broadcaster: { notify: (h: string) => void; flush: () => void; dispose: () => void }
  hints: string[]
} {
  const hints: string[] = []
  return {
    hints,
    broadcaster: {
      notify: (h: string) => {
        hints.push(h)
      },
      flush: () => {},
      dispose: () => {}
    }
  }
}

// === TurnEndData 构造（只含 bridge 关心的字段）===

interface TurnEndLike {
  turnId: string
  sessionId: string
  status: 'completed' | 'failed' | 'cancelled'
  memoryEligible: boolean
  referencedMemoryIds: readonly string[]
}

function makeTurn(overrides: Partial<TurnEndLike> = {}): TurnEndLike {
  return {
    turnId: 'turn_1',
    sessionId: 'sess_1',
    status: 'completed',
    memoryEligible: true,
    referencedMemoryIds: [],
    ...overrides
  }
}

describe('P2-40 growth bridge hook', () => {
  let eventBus: ReturnType<typeof createGrowthEventBus>
  let received: GrowthEvent[]
  let clock: ReturnType<typeof makeMockRevisionClock>
  let bc: ReturnType<typeof makeMockBroadcaster>
  let mockStore: ReturnType<typeof makeMockStore>
  let ts: number
  let snapshotCount: () => number
  let snapshotTodayImpl: () => void

  beforeEach(() => {
    eventBus = createGrowthEventBus()
    received = []
    eventBus.on((e) => received.push(e))
    clock = makeMockRevisionClock()
    bc = makeMockBroadcaster()
    mockStore = makeMockStore(false)
    ts = new Date(2024, 2, 9, 12, 0, 0).getTime() // 本地 2024-03-09
    let calls = 0
    snapshotCount = () => calls
    snapshotTodayImpl = () => {
      calls++
    }
  })

  function makeHook(): ReturnType<typeof createGrowthBridgeHook> {
    return createGrowthBridgeHook({
      eventBus,
      store: mockStore.store,
      revisionClock: clock.clock,
      broadcaster: bc.broadcaster,
      logger: testNoopLogger,
      now: () => ts,
      idGen: () => `evt_${received.length}`,
      snapshotToday: snapshotTodayImpl
    })
  }

  it('memoryEligible=false: 不发事件、不推进 revision、不广播', async () => {
    const hook = makeHook()
    const data = makeTurn({ memoryEligible: false, referencedMemoryIds: ['l2_1'] })
    await hook.fn({ event: 'turn.end', turnId: 'turn_1' }, data)
    expect(received).toHaveLength(0)
    expect(clock.nextCalls).toBe(0)
    expect(bc.hints).toHaveLength(0)
  })

  it('memoryEligible=true + referencedMemoryIds: fan-out l2.referenced（去重）', async () => {
    const hook = makeHook()
    const data = makeTurn({
      referencedMemoryIds: ['l2_a', 'l2_b', 'l2_a', 'l2_c']
    })
    await hook.fn({ event: 'turn.end', turnId: 'turn_1' }, data)
    const referenced = received.filter((e) => e.type === 'l2.referenced')
    expect(referenced).toHaveLength(3) // 去重后 3 条
    expect(referenced.map((e) => e.payload.memoryId)).toEqual(['l2_a', 'l2_b', 'l2_c'])
  })

  it('memoryEligible=true + 当天首次: 发射 session.daily_first', async () => {
    mockStore.setHasDaily(false)
    const hook = makeHook()
    const data = makeTurn({})
    await hook.fn({ event: 'turn.end', turnId: 'turn_1' }, data)
    const daily = received.filter((e) => e.type === 'session.daily_first')
    expect(daily).toHaveLength(1)
  })

  it('session.daily_first 同日幂等（当天已有则不发）', async () => {
    mockStore.setHasDaily(true) // 当天已有 session.daily_first
    const hook = makeHook()
    const data = makeTurn({ referencedMemoryIds: [] })
    await hook.fn({ event: 'turn.end', turnId: 'turn_1' }, data)
    const daily = received.filter((e) => e.type === 'session.daily_first')
    expect(daily).toHaveLength(0)
    // 没有任何事件发射 -> 不推进 revision、不广播
    expect(clock.nextCalls).toBe(0)
    expect(bc.hints).toHaveLength(0)
  })

  it('实际发射事件时：推进 revision + 广播 growth hint', async () => {
    const hook = makeHook()
    const data = makeTurn({ referencedMemoryIds: ['l2_a'] })
    await hook.fn({ event: 'turn.end', turnId: 'turn_1' }, data)
    expect(clock.nextCalls).toBe(1)
    expect(bc.hints).toEqual(['growth'])
  })

  it('P2-41: 当天首次对话（发 session.daily_first）时触发 snapshotToday 每日快照', async () => {
    const hook = makeHook()
    await hook.fn({ event: 'turn.end', turnId: 'turn_1' }, makeTurn({ referencedMemoryIds: [] }))
    expect(snapshotCount()).toBe(1) // 当天首轮触发一次快照
    expect(received.some((e) => e.type === 'session.daily_first')).toBe(true)
  })

  it('P2-41: 同日第二次对话不再触发 snapshotToday（同日幂等）', async () => {
    mockStore.setHasDaily(true) // 当天已有 daily_first
    const hook = makeHook()
    await hook.fn({ event: 'turn.end', turnId: 'turn_1' }, makeTurn({ referencedMemoryIds: [] }))
    expect(snapshotCount()).toBe(0) // 非当天首轮，不触发快照
    expect(mockStore.events.filter((e) => e.type === 'session.daily_first')).toHaveLength(0)
  })

  it('referencedMemoryIds 为空 + 当天已有 daily: 不发事件、不推进 revision', async () => {
    mockStore.setHasDaily(true)
    const hook = makeHook()
    const data = makeTurn({ referencedMemoryIds: [] })
    await hook.fn({ event: 'turn.end', turnId: 'turn_1' }, data)
    expect(received).toHaveLength(0)
    expect(clock.nextCalls).toBe(0)
    expect(bc.hints).toHaveLength(0)
  })

  it('hook 元数据：name/event/priority/failOpen', () => {
    const hook = makeHook()
    expect(hook.name).toBe('growth-bridge')
    expect(hook.event).toBe('turn.end')
    expect(hook.priority).toBe(220) // S-011 §1.6：位于 extraction(250) 之前
    expect(hook.failOpen).toBe(true)
  })

  it('l2.referenced 事件 payload 只含 memoryId，不含内容', async () => {
    const hook = makeHook()
    const data = makeTurn({ referencedMemoryIds: ['l2_x'] })
    await hook.fn({ event: 'turn.end', turnId: 'turn_1' }, data)
    const referenced = received.find((e) => e.type === 'l2.referenced')!
    expect(referenced.payload.memoryId).toBe('l2_x')
    const payloadStr = JSON.stringify(referenced.payload)
    expect(payloadStr).not.toMatch(/content|quote|text/i)
  })
})

describe('toLocalDate', () => {
  it('格式为 YYYY-MM-DD（本地时区）', () => {
    const ts = new Date(2024, 2, 9, 23, 59, 0).getTime()
    expect(toLocalDate(ts)).toBe('2024-03-09')
  })
})
