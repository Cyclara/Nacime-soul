// P3G-01：idle ≥5min + 间隔门控；用户活动立即让 GC 让路。

import { describe, expect, it, vi } from 'vitest'
import { createIdleScheduler } from './idle-scheduler'

describe('P3G idle scheduler', () => {
  it('达到 idle 和最小间隔后执行，活动重置 idle 时钟', () => {
    let now = 0
    let scheduled: (() => void) | null = null
    const run = vi.fn()
    const scheduler = createIdleScheduler({
      idleMinutes: 5,
      minIntervalHours: 20,
      now: () => now,
      schedule: (callback) => { scheduled = callback; return 1 as never },
      cancel: () => {},
      run
    })
    now = 5 * 60 * 1000
    scheduler.checkNow()
    expect(run).toHaveBeenCalledTimes(1)
    scheduler.markActivity()
    now += 4 * 60 * 1000
    scheduler.checkNow()
    expect(run).toHaveBeenCalledTimes(1)
    void scheduled
  })

  it('最小间隔按真实小时数换算：20h 未到不跑，跨过 20h 才跑第二次', () => {
    let now = 0
    const run = vi.fn()
    const scheduler = createIdleScheduler({
      idleMinutes: 5,
      minIntervalHours: 20,
      now: () => now,
      schedule: () => 1 as never,
      cancel: () => {},
      run
    })
    now = 5 * 60 * 1000
    scheduler.checkNow()
    expect(run).toHaveBeenCalledTimes(1)

    // 19h59m：仍在最小间隔内，不得重复跑（旧实现把 20h 算成 1200h，第二次永远不来）。
    now += 19 * 60 * 60 * 1000 + 59 * 60 * 1000
    scheduler.checkNow()
    expect(run).toHaveBeenCalledTimes(1)

    now += 2 * 60 * 1000
    scheduler.checkNow()
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('dispose 后不再执行已调度任务', () => {
    let scheduled: (() => void) | null = null
    const run = vi.fn()
    const scheduler = createIdleScheduler({
      idleMinutes: 5,
      minIntervalHours: 20,
      now: () => 0,
      schedule: (callback) => { scheduled = callback; return 1 as never },
      cancel: () => {},
      run
    })
    scheduler.dispose()
    const callback = scheduled as (() => void) | null
    callback?.()
    expect(run).not.toHaveBeenCalled()
  })
})
