// src/main/voice/playback/stage-host-manager.test.ts
// P3B-15：PlaybackHostManager 生命周期——attachStage 新 generation、port 关闭即失效、
// acquire()=null -> 后续轮 text-only、detach/dispose 幂等。transport 用假 channel。

import { describe, expect, it, vi } from 'vitest'
import type { Logger } from '@shared/observability/types'
import { createPlaybackHostManager } from './stage-host-manager'
import type { StageWebContentsLike } from './stage-host-manager'
import type { MessagePortMainLike } from './types'

class FakePort implements MessagePortMainLike {
  private handlers: Array<(event: { data: unknown }) => void> = []
  private closeHandlers: Array<() => void> = []
  posted: unknown[] = []
  closed = false

  postMessage(message: unknown): void {
    this.posted.push(message)
  }

  on(event: 'message' | 'close', listener: unknown): void {
    if (event === 'message') this.handlers.push(listener as (event: { data: unknown }) => void)
    else this.closeHandlers.push(listener as () => void)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const handler of [...this.closeHandlers]) handler()
  }

  emit(data: unknown): void {
    for (const handler of [...this.handlers]) handler({ data })
  }

  emitClosed(): void {
    this.close()
  }
}

function logger(): Logger {
  const value: Logger = {
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
    child: () => value
  }
  return value
}

function fakeWebContents(id: number): StageWebContentsLike {
  return { id, isDestroyed: () => false, postMessage: () => {} }
}

interface Harness {
  manager: ReturnType<typeof createPlaybackHostManager>
  channels: Array<{ id: number; generation: string; port: FakePort }>
  unavailable: ReturnType<typeof vi.fn>
}

function makeHarness(opts?: { failChannel?: boolean }): Harness {
  const channels: Harness['channels'] = []
  const unavailable = vi.fn()
  const manager = createPlaybackHostManager({
    logger: logger(),
    newGenerationId: (() => {
      let counter = 0
      return () => `gen-${++counter}`
    })(),
    createStageChannel: (webContents, generation) => {
      if (opts?.failChannel === true) return null
      const port = new FakePort()
      channels.push({ id: webContents.id, generation, port })
      return port
    }
  })
  manager.onHostUnavailable(unavailable)
  return { manager, channels, unavailable }
}

describe('P3B-15 PlaybackHostManager', () => {
  it('attachStage 建 port：每 stage ready 一个新 generation', () => {
    const h = makeHarness()
    h.manager.attachStage(fakeWebContents(10))
    expect(h.channels).toHaveLength(1)
    expect(h.channels[0]).toMatchObject({ id: 10, generation: 'gen-1' })

    h.manager.attachStage(fakeWebContents(10)) // stage 重建（新 ready）
    expect(h.channels).toHaveLength(2)
    expect(h.channels[1]!.generation).toBe('gen-2')
    // 旧 port 已被关闭（旧窗口迟到事件全部作废）
    expect(h.channels[0]!.port.closed).toBe(true)
  })

  it('acquire 返回当前 live port；无 host = null（text-only）', () => {
    const h = makeHarness()
    expect(h.manager.acquire()).toBeNull()
    h.manager.attachStage(fakeWebContents(10))
    const port = h.manager.acquire()
    expect(port).not.toBeNull()
    expect(h.manager.generation).toBe('gen-1')
  })

  it('port 意外关闭 -> current 作废 + onHostUnavailable 通知；重建后恢复', () => {
    const h = makeHarness()
    h.manager.attachStage(fakeWebContents(10))
    const first = h.channels[0]!
    first.port.emitClosed()

    expect(h.manager.acquire()).toBeNull()
    expect(h.manager.generation).toBeNull()
    expect(h.unavailable).toHaveBeenCalledTimes(1)

    h.manager.attachStage(fakeWebContents(10))
    expect(h.manager.acquire()).not.toBeNull()
    expect(h.unavailable).toHaveBeenCalledTimes(1) // 恢复本身不重复通知
  })

  it('detachStage 只释放属于该 stage 的 host；其他 stage 不受影响', () => {
    const h = makeHarness()
    h.manager.attachStage(fakeWebContents(10))
    const port = h.manager.acquire()
    h.manager.detachStage(99) // 别的 webContents：no-op
    expect(h.manager.acquire()).toBe(port)
    h.manager.detachStage(10)
    expect(h.manager.acquire()).toBeNull()
    expect(h.unavailable).toHaveBeenCalledTimes(1)
  })

  it('createStageChannel 返回 null（stage 不可用）-> 保持 unavailable + 通知', () => {
    const h = makeHarness({ failChannel: true })
    h.manager.attachStage(fakeWebContents(10))
    expect(h.manager.acquire()).toBeNull()
    expect(h.unavailable).toHaveBeenCalledTimes(1)
  })

  it('dispose 释放当前 host 并清空监听；再 attach 可恢复（同一 manager 生命周期）', () => {
    const h = makeHarness()
    h.manager.attachStage(fakeWebContents(10))
    h.manager.dispose()
    expect(h.manager.acquire()).toBeNull()
    expect(h.unavailable).toHaveBeenCalledTimes(1)

    // dispose 后 onHostUnavailable 监听已清空：不再触发
    h.manager.attachStage(fakeWebContents(11))
    h.manager.detachStage(11)
    expect(h.unavailable).toHaveBeenCalledTimes(1)
  })

  it('真实 credit 协议经 manager 联通：stage 回报 credit 后 sendFrame 可发', () => {
    const h = makeHarness()
    h.manager.attachStage(fakeWebContents(10))
    const port = h.manager.acquire()
    if (port === null) throw new Error('port expected')
    const stage = h.channels[0]!.port

    // 无 credit 时不发（C20）
    expect(
      port.sendFrame({
        turnId: 't1',
        segmentId: 's1',
        sequence: 1,
        frameIndex: 0,
        format: { sampleRate: 24000, channels: 1, sampleFormat: 'f32le', interleaved: true },
        pcm: new ArrayBuffer(48),
        finalFrame: true,
        volume: 1
      })
    ).toBe('no-credit')

    // stage 回报初始 credit（capacity 冻结）
    stage.emit({
      type: 'credit',
      generation: 'gen-1',
      capacityBytes: 1000,
      availableBytes: 1000,
      creditSequence: 0
    })
    expect(
      port.sendFrame({
        turnId: 't1',
        segmentId: 's1',
        sequence: 1,
        frameIndex: 0,
        format: { sampleRate: 24000, channels: 1, sampleFormat: 'f32le', interleaved: true },
        pcm: new ArrayBuffer(48),
        finalFrame: true,
        volume: 1
      })
    ).toBe('sent')
    expect(stage.posted).toHaveLength(1)
  })
})
