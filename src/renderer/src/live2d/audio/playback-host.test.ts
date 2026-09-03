// src/renderer/src/live2d/audio/playback-host.test.ts
// P3B-15（F5-007 §1.14）：stage 侧 PlaybackHost 传输层合同。
//   - attach 后立即发 creditSequence=0 的绝对 credit 冻结 capacity；
//   - 帧驻留到释放才恰好一次回容量（默认 discard sink 立即释放）；
//   - 重复/旧 generation/坏形状帧拒绝；cancel/dispose/换 generation 全部作废；
//   - 出站形状由 main 侧 isStageToMainAudioMessage 认账（本测试也用它断言线格式）。

import { describe, expect, it } from 'vitest'
import { createStagePlaybackHost } from './playback-host'
import type { StageAudioPortLike, StageFrameSink } from './playback-host'
import { isStageToMainAudioMessage } from '@shared/voice/playback-types'
import type { PcmPlaybackRequest } from '@shared/voice/playback-types'

class FakeStagePort implements StageAudioPortLike {
  started = false
  closed = false
  posted: unknown[] = []
  private handlers: Array<(event: { data: unknown }) => void> = []

  start(): void {
    this.started = true
  }

  addEventListener(_type: 'message', listener: (event: { data: unknown }) => void): void {
    this.handlers.push(listener)
  }

  postMessage(message: unknown): void {
    this.posted.push(message)
  }

  close(): void {
    this.closed = true
  }

  emit(data: unknown): void {
    for (const handler of [...this.handlers]) handler({ data })
  }
}

function credits(
  port: FakeStagePort
): Array<{ availableBytes: number; creditSequence: number; capacityBytes: number }> {
  return port.posted
    .filter((m) => isStageToMainAudioMessage(m) && (m as { type: string }).type === 'credit')
    .map((m) => ({
      availableBytes: (m as { availableBytes: number }).availableBytes,
      creditSequence: (m as { creditSequence: number }).creditSequence,
      capacityBytes: (m as { capacityBytes: number }).capacityBytes
    }))
}

function makeFrame(opts: {
  generation?: string
  segmentId?: string
  frameIndex?: number
  bytes?: number
  sequence?: number
}): PcmPlaybackRequest {
  const generation = opts.generation ?? 'gen-1'
  const segmentId = opts.segmentId ?? 's1'
  const frameIndex = opts.frameIndex ?? 0
  const bytes = opts.bytes ?? 48
  return {
    type: 'audio',
    generation,
    turnId: 't1',
    segmentId,
    sequence: opts.sequence ?? 1,
    frameId: `${generation}:${segmentId}:${frameIndex}`,
    frameIndex,
    format: { sampleRate: 24000, channels: 1, sampleFormat: 'f32le', interleaved: true },
    pcm: new ArrayBuffer(bytes),
    finalFrame: true,
    volume: 1
  }
}

describe('P3B-15 stage PlaybackHost', () => {
  it('attach 后立即发 creditSequence=0 的绝对 credit 冻结 capacity', () => {
    const port = new FakeStagePort()
    const host = createStagePlaybackHost({ capacityBytes: 1000 })
    host.attach('gen-1', port)

    expect(port.started).toBe(true)
    expect(credits(port)).toEqual([
      { availableBytes: 1000, creditSequence: 0, capacityBytes: 1000 }
    ])
  })

  it('默认 discard sink：帧到达即释放，credit 立刻全额回容量（无驻留）', () => {
    const port = new FakeStagePort()
    const host = createStagePlaybackHost({ capacityBytes: 1000 })
    host.attach('gen-1', port)

    port.emit(makeFrame({ bytes: 48 }))
    expect(host.residentFrameCount).toBe(0)
    expect(credits(port)).toEqual([
      { availableBytes: 1000, creditSequence: 0, capacityBytes: 1000 },
      { availableBytes: 1000, creditSequence: 1, capacityBytes: 1000 } // 释放后回容量
    ])
  })

  it('驻留 sink：帧占容量直到 onReleased；release 恰好一次回容量', () => {
    const port = new FakeStagePort()
    const held = new Map<string, (frameId: string) => void>()
    const sink: StageFrameSink = {
      play(frame, onReleased) {
        held.set(frame.frameId, onReleased)
      },
      stop() {
        /* 由 host 直接清账 */
      }
    }
    const host = createStagePlaybackHost({ capacityBytes: 1000, sink })
    host.attach('gen-1', port)

    port.emit(makeFrame({ bytes: 100 }))
    port.emit(makeFrame({ frameIndex: 1, bytes: 52 }))
    expect(host.residentFrameCount).toBe(2)
    expect(host.residentBytes).toBe(152)
    // 驻留期间只发过初始 credit（发布报告在释放时）
    expect(credits(port)).toHaveLength(1)

    const release0 = held.get('gen-1:s1:0')
    expect(release0).toBeDefined()
    release0!('gen-1:s1:0')
    expect(host.residentFrameCount).toBe(1)
    expect(host.residentBytes).toBe(52)
    expect(credits(port).at(-1)).toEqual({
      availableBytes: 948,
      creditSequence: 1,
      capacityBytes: 1000
    })

    // 同 frame 二次释放：幂等（不再发 credit）
    release0!('gen-1:s1:0')
    expect(credits(port)).toHaveLength(2)
  })

  it('重复 frameId 拒绝；旧 generation / 坏形状消息丢弃并计数', () => {
    const port = new FakeStagePort()
    const sink: StageFrameSink = {
      play() {
        /* 驻留控制由断言驱动 */
      },
      stop() {
        /* 无在播 source */
      }
    }
    const host = createStagePlaybackHost({ capacityBytes: 1000, sink })
    host.attach('gen-1', port)

    port.emit(makeFrame({ bytes: 100 }))
    port.emit(makeFrame({ bytes: 100 })) // 同一 frameId：重复
    port.emit(makeFrame({ generation: 'gen-0' })) // 旧 generation
    port.emit({ type: 'audio', garbage: true }) // 坏形状
    port.emit('nonsense')

    expect(host.residentFrameCount).toBe(1)
    expect(host.protocolErrors).toBe(4)
  })

  it('cancel：清驻留、回容量、回报 cancelled', () => {
    const port = new FakeStagePort()
    const host = createStagePlaybackHost({ capacityBytes: 1000 })
    host.attach('gen-1', port)
    port.emit(makeFrame({ bytes: 200 })) // discard sink 已立即释放
    // 换驻留 sink 验证 cancel 路径
    const held = new Map<string, (frameId: string) => void>()
    const holding: StageFrameSink = {
      play(frame, onReleased) {
        held.set(frame.frameId, onReleased)
      },
      stop() {
        /* 无在播 source */
      }
    }
    const host2 = createStagePlaybackHost({ capacityBytes: 1000, sink: holding })
    const port2 = new FakeStagePort()
    host2.attach('gen-1', port2)
    port2.emit(makeFrame({ bytes: 300 }))
    expect(host2.residentBytes).toBe(300)

    port2.emit({ type: 'cancel', generation: 'gen-1', reason: 'user-cancel' })
    expect(host2.residentFrameCount).toBe(0)
    const last = port2.posted.at(-1) as { type: string; reason: string }
    expect(last.type).toBe('cancelled')
    expect(last.reason).toBe('user-cancel')
    expect(credits(port2).at(-1)).toEqual({
      availableBytes: 1000,
      creditSequence: 1,
      capacityBytes: 1000
    })
  })

  it('换 generation：旧 port 关闭、驻留清零、新 credit 从 seq 0 重新冻结', () => {
    const port1 = new FakeStagePort()
    const port2 = new FakeStagePort()
    const held = new Map<string, (frameId: string) => void>()
    const holding: StageFrameSink = {
      play(frame, onReleased) {
        held.set(frame.frameId, onReleased)
      },
      stop() {
        /* 无在播 source */
      }
    }
    const host = createStagePlaybackHost({ capacityBytes: 1000, sink: holding })
    host.attach('gen-1', port1)
    port1.emit(makeFrame({ bytes: 100 }))
    expect(host.residentFrameCount).toBe(1)

    host.attach('gen-2', port2)
    expect(port1.closed).toBe(true)
    expect(host.residentFrameCount).toBe(0)
    expect(host.generation).toBe('gen-2')
    expect(credits(port2)).toEqual([
      { availableBytes: 1000, creditSequence: 0, capacityBytes: 1000 }
    ])
  })

  it('dispose：停 sink、清驻留、关 port；幂等', () => {
    const port = new FakeStagePort()
    const host = createStagePlaybackHost({ capacityBytes: 1000 })
    host.attach('gen-1', port)
    host.dispose()
    host.dispose() // 幂等
    expect(port.closed).toBe(true)
    expect(host.generation).toBeNull()
    // dispose 后消息不再处理
    port.emit(makeFrame({ bytes: 100 }))
    expect(host.residentFrameCount).toBe(0)
  })

  it('主送多帧（消费 sink 释放节奏）时 available 单调不超 capacity', () => {
    const port = new FakeStagePort()
    const host = createStagePlaybackHost({ capacityBytes: 1000 })
    host.attach('gen-1', port)
    // discard sink：每个帧立即释放；容量回冲后 main 可续发——协议不饿死
    for (let i = 0; i < 5; i++) {
      port.emit(makeFrame({ frameIndex: i, bytes: 48 }))
    }
    const all = credits(port)
    expect(all.length).toBe(6) // 1 初始 + 5 释放
    expect(all.every((c) => c.availableBytes <= c.capacityBytes)).toBe(true)
    expect(all.at(-1)!.availableBytes).toBe(1000)
  })
})

describe('P3B-16 sink 异常路径', () => {
  it('sink.play 抛错：帧立即释放回容量（§1.14 错误时释放），后续帧继续', () => {
    const port = new FakeStagePort()
    const throwing: StageFrameSink = {
      play() {
        throw new Error('audio graph failed')
      },
      stop() {
        /* 无驻留 */
      }
    }
    const host = createStagePlaybackHost({ capacityBytes: 1000, sink: throwing })
    host.attach('gen-1', port)

    port.emit(makeFrame({ bytes: 100 }))
    expect(host.residentFrameCount).toBe(0)
    const last = credits(port).at(-1)!
    expect(last.creditSequence).toBe(1)
    expect(last.availableBytes).toBe(1000)

    // 后续帧继续收（不因一次失败饿死）
    port.emit(makeFrame({ frameIndex: 1, bytes: 100 }))
    expect(credits(port)).toHaveLength(3)
    expect(credits(port).at(-1)!.creditSequence).toBe(2)
  })
})
