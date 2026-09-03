// src/main/voice/playback/audio-port.test.ts
// P3B-08：StageAudioPort 的 generation + 绝对 credit 协议合同（验收 C20）。

import { describe, expect, it } from 'vitest'
import type { Logger } from '@shared/observability/types'
import { isPcmPlaybackRequest } from '@shared/voice/playback-types'
import type { StageToMainAudioMessage } from '@shared/voice/playback-types'
import { createStageAudioPort } from './audio-port'
import type { MessagePortMainLike, OutboundAudioFrame, StageAudioPort } from './types'

function noopLogger(): Logger {
  const l: Logger = {
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
    child: () => l
  }
  return l
}

interface FakePortPair {
  port: MessagePortMainLike
  stage: {
    /** stage -> main 发消息 */
    send(message: unknown): void
    /** stage 侧主动关 port */
    close(): void
    /** main -> stage 已发送的消息 */
    sent: unknown[]
    portClosed: boolean
  }
}

function makeFakePort(): FakePortPair {
  const messageHandlers: Array<(event: { data: unknown }) => void> = []
  const closeHandlers: Array<() => void> = []
  const sent: unknown[] = []
  const state = { portClosed: false }
  const port: MessagePortMainLike = {
    postMessage(message: unknown): void {
      sent.push(message)
    },
    on(event: 'message' | 'close', listener: (event: never) => void): void {
      if (event === 'message') {
        messageHandlers.push(listener as (event: { data: unknown }) => void)
      } else {
        closeHandlers.push(listener as () => void)
      }
    },
    close(): void {
      state.portClosed = true
    }
  }
  return {
    port,
    stage: {
      send(message: unknown): void {
        for (const handler of [...messageHandlers]) handler({ data: message })
      },
      close(): void {
        for (const handler of [...closeHandlers]) handler()
      },
      get sent() {
        return sent
      },
      get portClosed() {
        return state.portClosed
      }
    }
  }
}

const FORMAT = {
  sampleRate: 24_000,
  channels: 1 as const,
  sampleFormat: 'f32le' as const,
  interleaved: true as const
}

function makeFrame(bytes = 8): OutboundAudioFrame {
  return {
    turnId: 'turn-1',
    segmentId: 'turn-1:tts:0',
    sequence: 0,
    frameIndex: 0,
    format: { ...FORMAT },
    pcm: new ArrayBuffer(bytes),
    finalFrame: true,
    volume: 1
  }
}

function makePort(generation = 'g1'): { audio: StageAudioPort; pair: FakePortPair } {
  const pair = makeFakePort()
  const audio = createStageAudioPort({ generation, port: pair.port, logger: noopLogger() })
  return { audio, pair }
}

function credit(
  generation: string,
  seq: number,
  available: number,
  capacity = 1_000
): StageToMainAudioMessage {
  return {
    type: 'credit',
    generation,
    capacityBytes: capacity,
    availableBytes: available,
    creditSequence: seq
  }
}

describe('createStageAudioPort credit 协议（C20）', () => {
  it('无 credit 不发送', () => {
    const { audio } = makePort()
    expect(audio.capacityBytes).toBeNull()
    expect(audio.sendFrame(makeFrame(8))).toBe('no-credit')
  })

  it('首个 credit 冻结 capacity；足额发送后本地扣减', () => {
    const { audio, pair } = makePort()
    pair.stage.send(credit('g1', 0, 100, 100))
    expect(audio.capacityBytes).toBe(100)
    expect(audio.sendFrame(makeFrame(60))).toBe('sent')
    expect(audio.availableBytes).toBe(40)
    expect(pair.stage.sent).toHaveLength(1)
  })

  it('余额不足 -> no-credit（不部分发送）', () => {
    const { audio, pair } = makePort()
    pair.stage.send(credit('g1', 0, 50))
    expect(audio.sendFrame(makeFrame(60))).toBe('no-credit')
    expect(pair.stage.sent).toHaveLength(0)
  })

  it('frame 超过冻结容量 -> frame-too-large（永久不可发）', () => {
    const { audio, pair } = makePort()
    pair.stage.send(credit('g1', 0, 100, 100))
    expect(audio.sendFrame(makeFrame(120))).toBe('frame-too-large')
    expect(pair.stage.sent).toHaveLength(0)
  })

  it('重复/乱序 credit 丢弃且不改变可用量', () => {
    const { audio, pair } = makePort()
    pair.stage.send(credit('g1', 0, 100))
    pair.stage.send(credit('g1', 0, 100)) // 重复
    pair.stage.send(credit('g1', 0, 999)) // 乱序（sequence 不增）
    expect(audio.availableBytes).toBe(100)
    expect(audio.protocolErrors).toBe(2)
  })

  it('credit 改 capacity 被拒（generation 内冻结）', () => {
    const { audio, pair } = makePort()
    pair.stage.send(credit('g1', 0, 100, 100))
    pair.stage.send(credit('g1', 1, 100, 2_000))
    expect(audio.capacityBytes).toBe(100)
    expect(audio.protocolErrors).toBe(1)
  })

  it('availableBytes 超 capacity 被收紧到 capacity', () => {
    const { audio, pair } = makePort()
    pair.stage.send(credit('g1', 0, 5_000, 1_000))
    expect(audio.availableBytes).toBe(1_000)
    expect(audio.protocolErrors).toBe(0)
  })

  it('credit 绝对量整体替换（不做加法）：可用量可能下降', () => {
    const { audio, pair } = makePort()
    pair.stage.send(credit('g1', 0, 100))
    pair.stage.send(credit('g1', 1, 30))
    expect(audio.availableBytes).toBe(30)
  })
})

describe('createStageAudioPort generation 与生命周期', () => {
  it('旧 generation 消息丢弃并记协议错误', () => {
    const { audio, pair } = makePort('g1')
    const seen: StageToMainAudioMessage[] = []
    audio.onMessage((m) => seen.push(m))
    pair.stage.send({ type: 'started', generation: 'g0', segmentId: 's', audioStartAt: 1 })
    pair.stage.send(credit('g0', 0, 10))
    expect(seen).toHaveLength(0)
    expect(audio.protocolErrors).toBe(2)
  })

  it('畸形消息丢弃并记协议错误', () => {
    const { audio, pair } = makePort()
    const seen: StageToMainAudioMessage[] = []
    audio.onMessage((m) => seen.push(m))
    pair.stage.send({ type: 'credit', generation: 'g1', capacityBytes: 'x' })
    pair.stage.send(null)
    pair.stage.send(42)
    expect(seen).toHaveLength(0)
    expect(audio.protocolErrors).toBe(3)
  })

  it('credit/started/ended/cancelled/error 合法消息转发给订阅者', () => {
    const { audio, pair } = makePort()
    const seen: StageToMainAudioMessage[] = []
    audio.onMessage((m) => seen.push(m))
    pair.stage.send(credit('g1', 0, 10))
    pair.stage.send({ type: 'started', generation: 'g1', segmentId: 's', audioStartAt: 5 })
    pair.stage.send({ type: 'ended', generation: 'g1', segmentId: 's', playedMs: 120 })
    pair.stage.send({ type: 'cancelled', generation: 'g1', reason: 'user-cancel' })
    pair.stage.send({ type: 'error', generation: 'g1', code: 'boom' })
    expect(seen.map((m) => m.type)).toEqual(['credit', 'started', 'ended', 'cancelled', 'error'])
  })

  it('stage 关闭 port -> onClosed、isAlive=false、后续发送 closed', () => {
    const { audio, pair } = makePort()
    let closed = 0
    audio.onClosed(() => {
      closed += 1
    })
    pair.stage.close()
    expect(closed).toBe(1)
    expect(audio.isAlive).toBe(false)
    expect(audio.sendFrame(makeFrame(4))).toBe('closed')
    expect(audio.sendCancel('app-quit') as unknown).toBeUndefined() // 不抛
  })

  it('main 主动 close 幂等且只通知一次', () => {
    const { audio, pair } = makePort()
    let closed = 0
    audio.onClosed(() => {
      closed += 1
    })
    audio.close()
    audio.close()
    expect(closed).toBe(1)
    expect(pair.stage.portClosed).toBe(true)
  })

  it('sendCancel/sendDispose 携带 generation', () => {
    const { audio, pair } = makePort()
    audio.sendCancel('barge-in')
    audio.sendDispose()
    expect(pair.stage.sent).toEqual([
      { type: 'cancel', generation: 'g1', reason: 'barge-in' },
      { type: 'dispose', generation: 'g1' }
    ])
  })

  it('发送的 frame 满足线格式（isPcmPlaybackRequest + frameId token）', () => {
    const { audio, pair } = makePort()
    pair.stage.send(credit('g1', 0, 1_000))
    const frame = makeFrame(8)
    expect(audio.sendFrame(frame)).toBe('sent')
    const message = pair.stage.sent[0]
    expect(isPcmPlaybackRequest(message)).toBe(true)
    expect((message as { frameId: string }).frameId).toBe('g1:turn-1:tts:0:0')
  })

  it('订阅退订后不再收到消息', () => {
    const { audio, pair } = makePort()
    const seen: unknown[] = []
    const off = audio.onMessage((m) => seen.push(m))
    pair.stage.send(credit('g1', 0, 10))
    off()
    pair.stage.send(credit('g1', 1, 10))
    expect(seen).toHaveLength(1)
  })
})
