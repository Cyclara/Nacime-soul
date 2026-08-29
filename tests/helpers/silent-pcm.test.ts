// tests/helpers/silent-pcm.test.ts
// P3-00C 自测：PCM 生成器的长度/静音/幅值/切帧/能量合同正确。

import { describe, it, expect } from 'vitest'
import {
  PCM_SAMPLE_RATE,
  makeSilentPcm16,
  makeSinePcm16,
  makeSpeechLikePcm16,
  slicePcmFrames,
  frameEnergy
} from './silent-pcm'

describe('silent-pcm 自测', () => {
  it('静音 PCM：长度精确且全零', () => {
    const pcm = makeSilentPcm16(500)
    expect(pcm.length).toBe(8000) // 16kHz × 0.5s
    expect(pcm.every((v) => v === 0)).toBe(true)
    expect(frameEnergy(pcm)).toBe(0)
  })

  it('正弦 PCM：长度精确、幅值不越界、能量明显大于静音', () => {
    const pcm = makeSinePcm16(220, 100, 0.5)
    expect(pcm.length).toBe(1600)
    for (const v of pcm) {
      expect(Math.abs(v)).toBeLessThanOrEqual(32767)
    }
    expect(frameEnergy(pcm)).toBeGreaterThan(0.05)
  })

  it('speech-like 三段拼接：总长 = 三段之和，首尾静音中间有声', () => {
    const pcm = makeSpeechLikePcm16({ leadSilenceMs: 100, speechMs: 200, tailSilenceMs: 100 })
    expect(pcm.length).toBe(1600 + 3200 + 1600)

    const frames = slicePcmFrames(pcm, 160) // 10ms 帧
    expect(frames.length).toBe(40)
    expect(frameEnergy(frames[0])).toBe(0) // 首帧在 lead 静音
    expect(frameEnergy(frames[frames.length - 1])).toBe(0) // 尾帧在 tail 静音
    expect(frameEnergy(frames[20])).toBeGreaterThan(0.05) // 中间帧在正弦段
  })

  it('slicePcmFrames：不足一帧的尾巴丢弃；非法帧长抛错', () => {
    const pcm = makeSilentPcm16(25) // 400 samples
    const frames = slicePcmFrames(pcm, 160)
    expect(frames.length).toBe(2) // 320 samples，余 80 丢弃
    expect(() => slicePcmFrames(pcm, 0)).toThrow(RangeError)
  })

  it('显式采样率覆盖默认 16kHz', () => {
    const pcm = makeSilentPcm16(1000, 8000)
    expect(pcm.length).toBe(8000)
    expect(PCM_SAMPLE_RATE).toBe(16_000)
  })
})
