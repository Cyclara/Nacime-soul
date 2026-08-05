// src/main/memory/event-broadcaster.test.ts
// P2-29: MemoryEventBroadcaster 测试。250ms 节流 + hint 合并 + revision 读取。
// 依据：S-012 §1.4（跨 hint 合为 bulk、同 hint 合并取最高 revision）、§3.4 测试矩阵。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMemoryEventBroadcaster } from './event-broadcaster'
import type { MemoryRevisionClock } from './revision-clock'
import type { WebContents } from 'electron'
import type { Logger } from '@shared/observability/types'

const noopLogger: Logger = {
  fatal() {
    /* noop */
  },
  error() {
    /* noop */
  },
  warn() {
    /* noop */
  },
  info() {
    /* noop */
  },
  debug() {
    /* noop */
  },
  child() {
    return noopLogger
  }
}

function makeClock(start = 0): MemoryRevisionClock & { _bump(): number } {
  let v = start
  return {
    current: () => v,
    next: () => ++v,
    _bump: () => v
  }
}

function makeWebContents(): WebContents & { __sent: unknown[][] } {
  const sent: unknown[][] = []
  return {
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => {
      sent.push([channel, payload])
    },
    __sent: sent
  } as unknown as WebContents & { __sent: unknown[][] }
}

describe('P2-29 MemoryEventBroadcaster', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('同 hint 单次 notify -> 250ms 后广播一次', () => {
    const clock = makeClock(5)
    const wc = makeWebContents()
    const bc = createMemoryEventBroadcaster({
      revisionClock: clock,
      getWebContents: () => wc,
      logger: noopLogger,
      now: () => 1000
    })
    bc.notify('l2')
    expect(wc.__sent.length).toBe(0) // 未到 250ms
    vi.advanceTimersByTime(250)
    expect(wc.__sent.length).toBe(1)
    expect(wc.__sent[0]).toEqual([
      'companion:event:memory-updated',
      { revision: 5, hint: 'l2', ts: 1000 }
    ])
    bc.dispose()
  })

  it('同窗口内多次同 hint 合并为一次广播（取最高 revision）', () => {
    const clock = makeClock(0)
    const wc = makeWebContents()
    const bc = createMemoryEventBroadcaster({
      revisionClock: clock,
      getWebContents: () => wc,
      logger: noopLogger
    })
    bc.notify('l2')
    clock.next() // revision 1
    bc.notify('l2')
    clock.next() // revision 2
    bc.notify('l2')
    vi.advanceTimersByTime(250)
    expect(wc.__sent.length).toBe(1)
    // flush 时读 current()，应为 2
    expect((wc.__sent[0][1] as { revision: number }).revision).toBe(2)
    expect((wc.__sent[0][1] as { hint: string }).hint).toBe('l2')
    bc.dispose()
  })

  it('不同 hint 合为 bulk（S-012 §1.4 红线）', () => {
    const clock = makeClock(3)
    const wc = makeWebContents()
    const bc = createMemoryEventBroadcaster({
      revisionClock: clock,
      getWebContents: () => wc,
      logger: noopLogger
    })
    bc.notify('l0')
    bc.notify('l2')
    bc.notify('dmae')
    vi.advanceTimersByTime(250)
    expect(wc.__sent.length).toBe(1)
    expect((wc.__sent[0][1] as { hint: string }).hint).toBe('bulk')
    expect((wc.__sent[0][1] as { revision: number }).revision).toBe(3)
    bc.dispose()
  })

  it('250ms 窗口结束后新 notify 触发新广播', () => {
    const clock = makeClock(0)
    const wc = makeWebContents()
    const bc = createMemoryEventBroadcaster({
      revisionClock: clock,
      getWebContents: () => wc,
      logger: noopLogger
    })
    bc.notify('l0')
    vi.advanceTimersByTime(250)
    expect(wc.__sent.length).toBe(1)
    bc.notify('l2')
    vi.advanceTimersByTime(250)
    expect(wc.__sent.length).toBe(2)
    expect((wc.__sent[0][1] as { hint: string }).hint).toBe('l0')
    expect((wc.__sent[1][1] as { hint: string }).hint).toBe('l2')
    bc.dispose()
  })

  it('webContents 销毁时不抛错（败而不崩）', () => {
    const clock = makeClock(1)
    const wc = makeWebContents()
    wc.isDestroyed = () => true
    const bc = createMemoryEventBroadcaster({
      revisionClock: clock,
      getWebContents: () => wc,
      logger: noopLogger
    })
    bc.notify('l2')
    vi.advanceTimersByTime(250)
    expect(wc.__sent.length).toBe(0) // 销毁不发
    bc.dispose()
  })

  it('getWebContents 返回 null 时不抛错', () => {
    const clock = makeClock(1)
    const bc = createMemoryEventBroadcaster({
      revisionClock: clock,
      getWebContents: () => null,
      logger: noopLogger
    })
    bc.notify('l2')
    vi.advanceTimersByTime(250)
    // 不抛错即通过
    bc.dispose()
  })

  it('flush 立即发送待发事件', () => {
    const clock = makeClock(7)
    const wc = makeWebContents()
    const bc = createMemoryEventBroadcaster({
      revisionClock: clock,
      getWebContents: () => wc,
      logger: noopLogger
    })
    bc.notify('dmae')
    bc.flush()
    expect(wc.__sent.length).toBe(1)
    expect((wc.__sent[0][1] as { hint: string }).hint).toBe('dmae')
    bc.dispose()
  })

  it('dispose 清理定时器，不再广播', () => {
    const clock = makeClock(1)
    const wc = makeWebContents()
    const bc = createMemoryEventBroadcaster({
      revisionClock: clock,
      getWebContents: () => wc,
      logger: noopLogger
    })
    bc.notify('l2')
    bc.dispose()
    vi.advanceTimersByTime(500)
    expect(wc.__sent.length).toBe(0)
  })

  // === 审计 B-6 回归：send 抛错不得穿透到记忆写入路径 ===
  it('webContents.send 抛错时不抛出（败而不崩）', () => {
    const clock = makeClock(3)
    const wc = makeWebContents()
    // 模拟 isDestroyed() 与 send 之间窗口被销毁：检查通过但 send 抛错
    wc.send = () => {
      throw new Error('Object has been destroyed')
    }
    const bc = createMemoryEventBroadcaster({
      revisionClock: clock,
      getWebContents: () => wc,
      logger: noopLogger
    })
    bc.notify('l2')
    // 修复前这里会把异常抛给调用方（记忆已落库却报错）
    expect(() => bc.flush()).not.toThrow()
    bc.dispose()
  })
})
