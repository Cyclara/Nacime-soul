// @vitest-environment jsdom
// src/renderer/src/stores/growth.test.ts
// P2-42: growth Pinia store 测试。
// 依据：S-022 §3.4 测试矩阵（growth hint 矩阵、revision 比对、订阅清理、disabled）。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useGrowthStore } from './growth'
import type { MemoryUpdatedEvent } from '@shared/memory/types'

function makeResult<T>(
  ok: boolean,
  data?: T,
  error?: unknown
): { ok: true; data: T } | { ok: false; error: unknown } {
  return ok ? { ok: true, data: data as T } : { ok: false, error }
}

const PROFILE = {
  understanding: 42,
  stage: 'familiar' as const,
  activeDays: 12,
  l2Total: 8,
  startedAt: 1710000000000,
  milestonesReached: [{ id: 'ms.name', title: '她记住了你的名字', ts: 1710000000000 }]
}

const EMPTY_PROFILE = {
  understanding: 0,
  stage: 'stranger' as const,
  activeDays: 0,
  l2Total: 0,
  startedAt: 0,
  milestonesReached: []
}

function setupCompanionApi(
  over: {
    profile?: typeof PROFILE | null
    timelineError?: boolean
  } = {}
): {
  growth: Record<string, ReturnType<typeof vi.fn>>
  onUpdated: ReturnType<typeof vi.fn>
} {
  // 真实 handler 语义：services=null（memory 关）时返回空 profile（ok:true），不是 error
  const profile = over.profile === null ? EMPTY_PROFILE : (over.profile ?? PROFILE)
  const growth = {
    getProfile: vi.fn(async () => makeResult(true, profile)),
    getTimeline: vi.fn(async () =>
      over.timelineError
        ? makeResult(false, undefined, { code: 'IPC_INTERNAL', message: 'err', retryable: false })
        : makeResult(true, [
            {
              ts: 1710000000000,
              kind: 'milestone' as const,
              title: '她记住了你的名字',
              text: '今天她记住了你的名字。'
            }
          ])
    ),
    getTrend: vi.fn(async () =>
      makeResult(true, [
        { date: '2024-03-08', value: 30 },
        { date: '2024-03-09', value: 42 }
      ])
    )
  }
  const onUpdated = vi.fn(() => () => {})
  ;(window as unknown as { companion: unknown }).companion = {
    memory: { onUpdated },
    growth
  }
  return { growth, onUpdated }
}

describe('P2-42 growth store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('hydrate: 拉 profile + timeline', async () => {
    const { growth } = setupCompanionApi()
    const store = useGrowthStore()
    await store.hydrate()
    expect(growth.getProfile).toHaveBeenCalledTimes(1)
    expect(growth.getTimeline).toHaveBeenCalledWith({ limit: 50 })
    expect(store.state.profile?.understanding).toBe(42)
    expect(store.state.profile?.stage).toBe('familiar')
    expect(store.state.timeline).toHaveLength(1)
  })

  it('stageLabel: stage -> 中文标签', async () => {
    setupCompanionApi()
    const store = useGrowthStore()
    expect(store.stageLabel).toBe('初识') // 默认 stranger
    await store.hydrate()
    expect(store.stageLabel).toBe('熟悉') // familiar
  })

  it('loadTrend: 拉趋势 + 记录 metric/days', async () => {
    const { growth } = setupCompanionApi()
    const store = useGrowthStore()
    await store.loadTrend('l2Total', 30)
    expect(growth.getTrend).toHaveBeenCalledWith({ metric: 'l2Total', days: 30 })
    expect(store.state.trend).toHaveLength(2)
    expect(store.state.trendMetric).toBe('l2Total')
    expect(store.state.trendDays).toBe(30)
    expect(store.state.trendLoading).toBe(false)
  })

  it('首屏 hydrate 与 loadTrend 并发时互不作废', async () => {
    let resolveProfile!: (value: ReturnType<typeof makeResult<typeof PROFILE>>) => void
    let resolveTimeline!: (value: ReturnType<typeof makeResult<unknown[]>>) => void
    let resolveTrend!: (value: ReturnType<typeof makeResult<unknown[]>>) => void
    const getProfile = vi.fn(() => new Promise((resolve) => (resolveProfile = resolve)))
    const getTimeline = vi.fn(() => new Promise((resolve) => (resolveTimeline = resolve)))
    const getTrend = vi.fn(() => new Promise((resolve) => (resolveTrend = resolve)))
    ;(window as unknown as { companion: unknown }).companion = {
      memory: { onUpdated: vi.fn(() => () => {}) },
      growth: { getProfile, getTimeline, getTrend }
    }

    const store = useGrowthStore()
    const hydrate = store.hydrate()
    const trend = store.loadTrend('understanding', 30)
    expect(store.state.loading).toBe(true)
    expect(store.state.trendLoading).toBe(true)

    resolveTrend(makeResult(true, [{ date: '2024-03-09', value: 0 }]))
    await trend
    expect(store.state.trend).toHaveLength(1)
    expect(store.state.loading).toBe(true)
    expect(store.state.trendLoading).toBe(false)

    resolveProfile(makeResult(true, PROFILE))
    resolveTimeline(makeResult(true, []))
    await hydrate
    expect(store.state.profile?.understanding).toBe(42)
    expect(store.state.loading).toBe(false)
  })

  it('applyUpdate: growth hint -> 拉 profile + timeline + 推进 revision', async () => {
    const { growth } = setupCompanionApi()
    const store = useGrowthStore()
    const e: MemoryUpdatedEvent = { revision: 5, hint: 'growth', ts: 1000 }
    store.applyUpdate(e)
    await vi.waitFor(() => {
      expect(growth.getProfile).toHaveBeenCalled()
    })
    await vi.waitFor(() => {
      expect(store.state.revision).toBe(5)
    })
    expect(store.state.profile?.understanding).toBe(42)
  })

  it('applyUpdate: 非 growth/bulk hint 忽略', async () => {
    const { growth } = setupCompanionApi()
    const store = useGrowthStore()
    const e: MemoryUpdatedEvent = { revision: 5, hint: 'l2', ts: 1000 }
    store.applyUpdate(e)
    await vi.waitFor(() => {
      expect(growth.getProfile).not.toHaveBeenCalled()
    })
    expect(store.state.revision).toBe(0)
  })

  it('applyUpdate: 旧 revision 丢弃', async () => {
    const { growth } = setupCompanionApi()
    const store = useGrowthStore()
    // 先推进到 5
    store.applyUpdate({ revision: 5, hint: 'growth', ts: 1000 })
    await vi.waitFor(() => {
      expect(store.state.revision).toBe(5)
    })
    const callsBefore = growth.getProfile.mock.calls.length
    // 旧 revision 4 丢弃
    store.applyUpdate({ revision: 4, hint: 'growth', ts: 1000 })
    await vi.waitFor(() => {
      expect(growth.getProfile.mock.calls.length).toBe(callsBefore)
    })
  })

  it('applyUpdate: bulk hint -> 同 hydrate（profile + timeline）', async () => {
    const { growth } = setupCompanionApi()
    const store = useGrowthStore()
    store.applyUpdate({ revision: 3, hint: 'bulk', ts: 1000 })
    await vi.waitFor(() => {
      expect(growth.getProfile).toHaveBeenCalled()
    })
    expect(growth.getTimeline).toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(store.state.revision).toBe(3)
    })
  })

  it('subscribe: 注册 onUpdated + focus 监听，卸载后移除', async () => {
    setupCompanionApi()
    const store = useGrowthStore()
    const unsub = store.subscribe()
    expect(window.companion.memory.onUpdated).toHaveBeenCalled()
    unsub()
    // 不再抛错即可（cleanup）
  })

  it('disabled: main 返回空投影（memory 关）时 hydrate 不崩', async () => {
    setupCompanionApi({ profile: null })
    const store = useGrowthStore()
    await store.hydrate()
    expect(store.state.profile).not.toBeNull()
    expect(store.state.profile?.understanding).toBe(0) // 空投影（U 值 0）
    expect(store.state.loading).toBe(false)
    expect(store.state.lastError).toBeNull()
  })

  it('reset: 清空全部投影', async () => {
    const { growth } = setupCompanionApi()
    const store = useGrowthStore()
    await store.hydrate()
    await store.loadTrend('understanding', 7)
    expect(store.state.profile).not.toBeNull()
    expect(store.state.trend).toHaveLength(2)
    store.reset()
    expect(store.state.profile).toBeNull()
    expect(store.state.timeline).toHaveLength(0)
    expect(store.state.trend).toHaveLength(0)
    expect(store.state.revision).toBe(0)
    void growth
  })
})
