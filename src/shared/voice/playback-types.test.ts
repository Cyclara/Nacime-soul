// src/shared/voice/playback-types.test.ts
// P3B-08：§1.14 port 消息校验器合同（shape/size/token）。

import { describe, expect, it } from 'vitest'
import type { PcmFormat } from './tts-types'
import type { PcmPlaybackRequest } from './playback-types'
import {
  AUDIO_PORT_FRAME_BYTES_MAX,
  isMainToStageAudioMessage,
  isPcmPlaybackRequest,
  isStageToMainAudioMessage
} from './playback-types'

const FORMAT: PcmFormat = {
  sampleRate: 24_000,
  channels: 1,
  sampleFormat: 'f32le',
  interleaved: true
}

function makeFrame(overrides?: Partial<PcmPlaybackRequest>): PcmPlaybackRequest {
  const base: PcmPlaybackRequest = {
    type: 'audio',
    generation: 'g1',
    turnId: 'turn-1',
    segmentId: 'turn-1:tts:0',
    sequence: 0,
    frameId: 'g1:turn-1:tts:0:0',
    frameIndex: 0,
    format: { ...FORMAT },
    pcm: new Float32Array([0, 0.5, -0.5, 0]).buffer,
    finalFrame: true,
    volume: 1
  }
  return { ...base, ...overrides }
}

describe('isPcmPlaybackRequest', () => {
  it('接受完整 frame', () => {
    expect(isPcmPlaybackRequest(makeFrame())).toBe(true)
  })

  it('frameId 三段不一致即拒（token 校验）', () => {
    expect(isPcmPlaybackRequest(makeFrame({ frameId: 'g1:other-seg:0' }))).toBe(false)
  })

  it('frameId 缺 frameIndex 段也拒', () => {
    expect(isPcmPlaybackRequest(makeFrame({ frameId: 'g1:turn-1:tts:0' }))).toBe(false)
  })

  it('pcm 非 ArrayBuffer 拒（Float32Array 本体不算）', () => {
    expect(
      isPcmPlaybackRequest(makeFrame({ pcm: new Float32Array(4) as unknown as ArrayBuffer }))
    ).toBe(false)
  })

  it('pcm 字节超协议上限拒', () => {
    const oversized = makeFrame({
      pcm: new ArrayBuffer(AUDIO_PORT_FRAME_BYTES_MAX + 4)
    })
    expect(isPcmPlaybackRequest(oversized)).toBe(false)
  })

  it('pcm 字节数不是 4 的倍数拒', () => {
    // 构造一个 2 字节 buffer：类型上是 ArrayBuffer 但不是整组 f32
    expect(isPcmPlaybackRequest(makeFrame({ pcm: new ArrayBuffer(2) }))).toBe(false)
  })

  it('format 字面量放宽即拒（立体声/f32 以外/非交错）', () => {
    expect(
      isPcmPlaybackRequest(makeFrame({ format: { ...FORMAT, channels: 2 as unknown as 1 } }))
    ).toBe(false)
    expect(
      isPcmPlaybackRequest(
        makeFrame({ format: { ...FORMAT, sampleFormat: 's16le' as unknown as 'f32le' } })
      )
    ).toBe(false)
    expect(
      isPcmPlaybackRequest(
        makeFrame({ format: { ...FORMAT, interleaved: false as unknown as true } })
      )
    ).toBe(false)
    expect(isPcmPlaybackRequest(makeFrame({ format: { ...FORMAT, sampleRate: 4_000 } }))).toBe(
      false
    )
  })

  it('volume 越界（负数/NaN/超上限）拒', () => {
    expect(isPcmPlaybackRequest(makeFrame({ volume: -0.1 }))).toBe(false)
    expect(isPcmPlaybackRequest(makeFrame({ volume: Number.NaN }))).toBe(false)
    expect(isPcmPlaybackRequest(makeFrame({ volume: 2.1 }))).toBe(false)
  })

  it('多余键拒（防字段走私）', () => {
    const smuggled = makeFrame() as unknown as Record<string, unknown>
    smuggled['extra'] = 'x'
    expect(isPcmPlaybackRequest(smuggled)).toBe(false)
  })
})

describe('isStageToMainAudioMessage', () => {
  it('接受合法 credit', () => {
    expect(
      isStageToMainAudioMessage({
        type: 'credit',
        generation: 'g1',
        capacityBytes: 1_000,
        availableBytes: 400,
        creditSequence: 3
      })
    ).toBe(true)
  })

  it('availableBytes 超 capacity 仍属形状合法（clamp 是 main 侧协议层职责）', () => {
    expect(
      isStageToMainAudioMessage({
        type: 'credit',
        generation: 'g1',
        capacityBytes: 100,
        availableBytes: 999,
        creditSequence: 1
      })
    ).toBe(true)
  })

  it('credit 负数/小数拒', () => {
    expect(
      isStageToMainAudioMessage({
        type: 'credit',
        generation: 'g1',
        capacityBytes: -1,
        availableBytes: 0,
        creditSequence: 0
      })
    ).toBe(false)
    expect(
      isStageToMainAudioMessage({
        type: 'credit',
        generation: 'g1',
        capacityBytes: 10,
        availableBytes: 0.5,
        creditSequence: 0
      })
    ).toBe(false)
  })

  it('started/ended 数值字段非法拒', () => {
    expect(
      isStageToMainAudioMessage({
        type: 'started',
        generation: 'g1',
        segmentId: 's',
        audioStartAt: -1
      })
    ).toBe(false)
    expect(
      isStageToMainAudioMessage({ type: 'ended', generation: 'g1', segmentId: 's', playedMs: 1.5 })
    ).toBe(false)
  })

  it('cancelled 可省 segmentId（host 级）；reason 必须枚举内', () => {
    expect(
      isStageToMainAudioMessage({ type: 'cancelled', generation: 'g1', reason: 'user-cancel' })
    ).toBe(true)
    expect(
      isStageToMainAudioMessage({
        type: 'cancelled',
        generation: 'g1',
        segmentId: 's',
        reason: 'user-cancel'
      })
    ).toBe(true)
    expect(
      isStageToMainAudioMessage({
        type: 'cancelled',
        generation: 'g1',
        segmentId: 's',
        reason: 'not-a-reason'
      })
    ).toBe(false)
  })

  it('error code 空串/超长拒', () => {
    expect(isStageToMainAudioMessage({ type: 'error', generation: 'g1', code: 'x' })).toBe(true)
    expect(isStageToMainAudioMessage({ type: 'error', generation: 'g1', code: '' })).toBe(false)
    expect(
      isStageToMainAudioMessage({ type: 'error', generation: 'g1', code: 'a'.repeat(65) })
    ).toBe(false)
  })

  it('未知 type 拒', () => {
    expect(isStageToMainAudioMessage({ type: 'frames', generation: 'g1' })).toBe(false)
    expect(isStageToMainAudioMessage(null)).toBe(false)
    expect(isStageToMainAudioMessage('credit')).toBe(false)
  })
})

describe('isMainToStageAudioMessage', () => {
  it('cancel/dispose 携带 generation 与枚举 reason', () => {
    expect(
      isMainToStageAudioMessage({ type: 'cancel', generation: 'g1', reason: 'app-quit' })
    ).toBe(true)
    expect(isMainToStageAudioMessage({ type: 'dispose', generation: 'g1' })).toBe(true)
    expect(isMainToStageAudioMessage({ type: 'cancel', generation: 'g1', reason: 'nope' })).toBe(
      false
    )
    expect(isMainToStageAudioMessage({ type: 'dispose' })).toBe(false)
  })

  it('audio frame 委托 isPcmPlaybackRequest', () => {
    expect(isMainToStageAudioMessage(makeFrame())).toBe(true)
    expect(isMainToStageAudioMessage(makeFrame({ frameId: 'bad' }))).toBe(false)
  })
})
