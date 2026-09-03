// src/renderer/src/live2d/audio/audio-player.test.ts
// P3B-16：AudioContext 播放器——惰性建图、顺序调度、恰好一次释放、RMS 电平、fail-open。
// S-004：全部走内存假图，不加载真实声音设备。

import { describe, expect, it, vi } from 'vitest'
import type { PcmPlaybackRequest } from '@shared/voice/playback-types'
import type {
  AudioBufferLike,
  AudioBufferSourceNodeLike,
  AudioContextLike,
  AnalyserNodeLike
} from './audio-player'
import { createStageAudioPlayer } from './audio-player'

class FakeAudioBuffer implements AudioBufferLike {
  private readonly channels = new Map<number, Float32Array>()
  constructor(
    readonly channelCount: number,
    readonly length: number,
    readonly sampleRate: number
  ) {}
  getChannelData(channel: number): Float32Array {
    let data = this.channels.get(channel)
    if (data === undefined) {
      data = new Float32Array(this.length)
      this.channels.set(channel, data)
    }
    return data
  }
}

class FakeAnalyser implements AnalyserNodeLike {
  fftSize = 2048
  connected: unknown = null
  constructor(readonly samples: Float32Array) {}
  connect(destination: unknown): void {
    this.connected = destination
  }
  getFloatTimeDomainData(target: Float32Array): void {
    target.fill(0)
    for (let i = 0; i < Math.min(target.length, this.samples.length); i += 1) {
      target[i] = this.samples[i]!
    }
  }
}

class FakeSourceNode implements AudioBufferSourceNodeLike {
  buffer: AudioBufferLike | null = null
  connected: unknown = null
  startedAt: number | null = null
  stopCount = 0
  onended: (() => void) | null = null
  connect(destination: unknown): void {
    this.connected = destination
  }
  start(when?: number): void {
    this.startedAt = when ?? 0
  }
  stop(): void {
    this.stopCount += 1
  }
}

class FakeAudioContext implements AudioContextLike {
  currentTime = 0
  readonly sampleRate = 48_000
  readonly destination = { fake: 'destination' }
  state: 'running' | 'suspended' | 'closed' = 'running'
  readonly buffers: FakeAudioBuffer[] = []
  readonly sources: FakeSourceNode[] = []
  readonly analyser: FakeAnalyser
  closeCount = 0
  resumeCount = 0
  constructor(samples: Float32Array = new Float32Array(2048)) {
    this.analyser = new FakeAnalyser(samples)
  }
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike {
    const buffer = new FakeAudioBuffer(channels, length, sampleRate)
    this.buffers.push(buffer)
    return buffer
  }
  createBufferSource(): AudioBufferSourceNodeLike {
    const source = new FakeSourceNode()
    this.sources.push(source)
    return source
  }
  createAnalyser(): AnalyserNodeLike {
    return this.analyser
  }
  async resume(): Promise<void> {
    this.resumeCount += 1
    this.state = 'running'
  }
  async close(): Promise<void> {
    this.closeCount += 1
    this.state = 'closed'
  }
  /** 测试推进音频时钟。 */
  advance(seconds: number): void {
    this.currentTime += seconds
  }
}

function frame(overrides?: Partial<PcmPlaybackRequest>): PcmPlaybackRequest {
  const pcm = new Float32Array([0.1, -0.2, 0.3, -0.4]).buffer
  return {
    type: 'audio',
    generation: 'gen-1',
    turnId: 't1',
    segmentId: 's1',
    sequence: 1,
    frameIndex: 0,
    frameId: 'gen-1:s1:0',
    format: { sampleRate: 24_000, channels: 1, sampleFormat: 'f32le', interleaved: true },
    pcm,
    finalFrame: true,
    volume: 1,
    ...overrides
  }
}

describe('P3B-16 StageAudioPlayer', () => {
  it('首次 play 惰性建图：analyser 连到 destination，buffer 收到 volume 缩放后的 PCM', () => {
    const context = new FakeAudioContext()
    const factory = vi.fn(() => context)
    const player = createStageAudioPlayer({ createAudioContext: factory })
    const released: string[] = []

    player.play(frame(), (frameId) => released.push(frameId))

    expect(factory).toHaveBeenCalledTimes(1)
    expect(context.analyser.connected).toBe(context.destination)
    expect(context.buffers).toHaveLength(1)
    const data = context.buffers[0]!.getChannelData(0)
    // f32 spread 后与同源 Float32Array 逐值比较（f64 字面量直接比会有表示误差）
    expect([...data]).toEqual([...new Float32Array([0.1, -0.2, 0.3, -0.4])])
    expect(context.buffers[0]!.sampleRate).toBe(24_000)
    expect(context.sources[0]!.startedAt).toBe(0)

    player.play(frame({ frameIndex: 1, frameId: 'gen-1:s1:1' }), (frameId) =>
      released.push(frameId)
    )
    // 顺序调度：第二帧排在第一帧之后（4 样本 @24kHz ≈ 1/6000s）
    expect(context.sources[1]!.startedAt).toBeCloseTo(4 / 24_000, 10)
    expect(released).toEqual([]) // 都在播，未释放
  })

  it('volume 直接缩放进 AudioBuffer（0/2 边界）', () => {
    const context = new FakeAudioContext()
    const player = createStageAudioPlayer({ createAudioContext: () => context })
    player.play(frame({ volume: 2 }), () => {})
    expect([...context.buffers[0]!.getChannelData(0)]).toEqual([
      ...Float32Array.from([0.1, -0.2, 0.3, -0.4], (value) => value * 2)
    ])
  })

  it('onended 恰好一次释放；重复 onended / stop 后再 onended 都不二次释放', () => {
    const context = new FakeAudioContext()
    const player = createStageAudioPlayer({ createAudioContext: () => context })
    const released: string[] = []
    player.play(frame(), (frameId) => released.push(frameId))
    const source = context.sources[0]!

    source.onended?.()
    source.onended?.()
    expect(released).toEqual(['gen-1:s1:0'])

    player.play(frame({ frameIndex: 1, frameId: 'gen-1:s1:1' }), (frameId) =>
      released.push(frameId)
    )
    player.stop()
    context.sources[1]!.onended?.()
    expect(released).toEqual(['gen-1:s1:0', 'gen-1:s1:1'])
  })

  it('stop() 立即停所有在播 source 并恰好一次释放', () => {
    const context = new FakeAudioContext()
    const player = createStageAudioPlayer({ createAudioContext: () => context })
    const released: string[] = []
    player.play(frame(), (id) => released.push(id))
    player.play(frame({ frameIndex: 1, frameId: 'gen-1:s1:1' }), (id) => released.push(id))

    player.stop()

    expect(context.sources.map((source) => source.stopCount)).toEqual([1, 1])
    expect(released).toEqual(['gen-1:s1:0', 'gen-1:s1:1'])
    player.stop() // 幂等
    expect(released).toHaveLength(2)
  })

  it('readLevel：RMS→(rms-noiseFloor)*gain→0..1，参数可注入', () => {
    const constant = 0.5
    const context = new FakeAudioContext(new Float32Array(1024).fill(constant))
    const player = createStageAudioPlayer({
      createAudioContext: () => context,
      noiseFloor: 0,
      gain: 1,
      fftSize: 1024
    })
    player.play(frame(), () => {})
    expect(player.readLevel()).toBeCloseTo(0.5, 10)
    expect(player.level).toBeCloseTo(0.5, 10)

    // 静音 → 0
    context.analyser.samples.fill(0)
    expect(player.readLevel()).toBe(0)

    // 超增益 clamp 到 1（默认参数：0.5 → (0.5-0.006)*14 远超 1）
    context.analyser.samples.fill(constant)
    const loud = createStageAudioPlayer({ createAudioContext: () => context })
    loud.play(frame(), () => {})
    expect(loud.readLevel()).toBe(1)
  })

  it('未建图时 readLevel 返回 0', () => {
    const player = createStageAudioPlayer({ createAudioContext: () => new FakeAudioContext() })
    expect(player.readLevel()).toBe(0)
  })

  it('建图失败 fail-open：帧立即释放（不卡 credit），playErrors 计数', () => {
    const warn = vi.fn()
    const player = createStageAudioPlayer({
      createAudioContext: () => {
        throw new Error('no audio device')
      },
      warn
    })
    const released: string[] = []
    expect(() => player.play(frame(), (id) => released.push(id))).not.toThrow()
    expect(released).toEqual(['gen-1:s1:0'])
    expect(player.playErrors).toBe(1)
    expect(warn).toHaveBeenCalled()
  })

  it('调度失败 fail-open：createBufferSource 抛错时帧立即释放', () => {
    const context = new FakeAudioContext()
    vi.spyOn(context, 'createBufferSource').mockImplementation(() => {
      throw new Error('node allocation failed')
    })
    const player = createStageAudioPlayer({ createAudioContext: () => context })
    const released: string[] = []
    player.play(frame(), (id) => released.push(id))
    expect(released).toEqual(['gen-1:s1:0'])
    expect(player.playErrors).toBe(1)
  })

  it('suspended 时 play 触发 resume', async () => {
    const context = new FakeAudioContext()
    context.state = 'suspended'
    const player = createStageAudioPlayer({ createAudioContext: () => context })
    player.play(frame(), () => {})
    await Promise.resolve()
    expect(context.resumeCount).toBe(1)
  })

  it('underrun 后立即开播：游标落后 currentTime 时 when=currentTime', () => {
    const context = new FakeAudioContext()
    const player = createStageAudioPlayer({ createAudioContext: () => context })
    player.play(frame(), () => {})
    context.advance(1) // 设备已把进度消化完
    player.play(frame({ frameIndex: 1, frameId: 'gen-1:s1:1' }), () => {})
    expect(context.sources[1]!.startedAt).toBe(1)
  })

  it('dispose：stop + close；dispose 后 play 直接释放且不再建图/调度', () => {
    const context = new FakeAudioContext()
    const player = createStageAudioPlayer({ createAudioContext: () => context })
    player.play(frame(), () => {})
    player.dispose()
    expect(context.closeCount).toBe(1)
    expect(player.dispose()).toBeUndefined() // 幂等
    expect(context.closeCount).toBe(1)

    const released: string[] = []
    player.play(frame({ frameIndex: 2, frameId: 'gen-1:s1:2' }), (id) => released.push(id))
    expect(released).toEqual(['gen-1:s1:2'])
  })
})
