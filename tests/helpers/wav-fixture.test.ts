// tests/helpers/wav-fixture.test.ts
// wav-fixture 自测：构造出的 WAV 头部字段与样本字节可被独立解析验证（P3-00C 惯例）。

import { describe, expect, it } from 'vitest'
import { makeSineSamples, makeWavBuffer } from './wav-fixture'

describe('wav-fixture', () => {
  it('s16 mono：头部字段完整、样本值按 int16 LE 落盘', () => {
    const wav = makeWavBuffer({
      sampleRate: 16_000,
      channels: 1,
      sampleFormat: 's16',
      samples: new Float32Array([0, 0.5, -0.5, 1])
    })
    expect(wav.toString('latin1', 0, 4)).toBe('RIFF')
    expect(wav.toString('latin1', 8, 12)).toBe('WAVE')
    expect(wav.toString('latin1', 12, 16)).toBe('fmt ')
    expect(wav.toString('latin1', 36, 40)).toBe('data')
    expect(wav.readUInt16LE(20)).toBe(1) // PCM
    expect(wav.readUInt16LE(22)).toBe(1) // mono
    expect(wav.readUInt32LE(24)).toBe(16_000)
    expect(wav.readUInt16LE(34)).toBe(16)
    expect(wav.readUInt32LE(40)).toBe(8) // 4 samples * 2 bytes
    expect(wav.readInt16LE(44)).toBe(0)
    expect(wav.readInt16LE(46)).toBe(16_384) // 0.5 * 32767
    expect(wav.readInt16LE(48)).toBe(-16_383) // round(-0.5*32767) 半值向 +inf 取整
    expect(wav.readInt16LE(50)).toBe(32_767)
    expect(wav.length).toBe(52)
  })

  it('f32 stereo：format=3、声道 2、样本交错', () => {
    const wav = makeWavBuffer({
      sampleRate: 24_000,
      channels: 2,
      sampleFormat: 'f32',
      samples: new Float32Array([0.25, -0.25, 0.75, -0.75])
    })
    expect(wav.readUInt16LE(20)).toBe(3) // IEEE float
    expect(wav.readUInt16LE(22)).toBe(2)
    expect(wav.readUInt32LE(24)).toBe(24_000)
    expect(wav.readUInt16LE(34)).toBe(32)
    expect(wav.readUInt32LE(40)).toBe(16) // 4 samples * 4 bytes
    expect(wav.readFloatLE(44)).toBeCloseTo(0.25)
    expect(wav.readFloatLE(48)).toBeCloseTo(-0.25)
    expect(wav.readFloatLE(52)).toBeCloseTo(0.75)
    expect(wav.readFloatLE(56)).toBeCloseTo(-0.75)
  })

  it('s8：无符号偏移编码（静音 = 128）', () => {
    const wav = makeWavBuffer({
      sampleRate: 8_000,
      channels: 1,
      sampleFormat: 's8',
      samples: new Float32Array([0, 1, -1])
    })
    expect(wav.readUInt16LE(34)).toBe(8)
    expect(wav.readUInt8(44)).toBe(128)
    expect(wav.readUInt8(45)).toBe(255)
    expect(wav.readUInt8(46)).toBe(1)
  })

  it('makeSineSamples：长度/幅度/通道数正确', () => {
    const samples = makeSineSamples({
      sampleRate: 1_000,
      channels: 2,
      frequencyHz: 250,
      durationMs: 4,
      amplitude: 0.6
    })
    expect(samples.length).toBe(8) // 4 samples * 2 channels
    expect(samples[0]).toBe(0)
    expect(Math.abs(samples[2])).toBeCloseTo(0.6) // 250Hz @ 1kHz = 1/4 周期 -> 峰值
    expect(samples[1]).toBeCloseTo(samples[0]) // 同帧两通道同值
    expect(samples[3]).toBeCloseTo(samples[2]) // 250Hz@1kHz：帧1 为峰值 0.6
  })

  it('样本长度不是通道数整数倍时拒绝构造', () => {
    expect(() =>
      makeWavBuffer({
        sampleRate: 16_000,
        channels: 2,
        sampleFormat: 's16',
        samples: new Float32Array([0.1, 0.2, 0.3])
      })
    ).toThrow(/not divisible/)
  })
})
