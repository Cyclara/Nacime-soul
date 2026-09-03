// src/main/voice/tts/wav.test.ts
// P3B-03：WAV 解码 + 线性重采样合同（P3B-06 GPT-SoVITS adapter 复用同一实现）。
// 覆盖：各位宽归一 / 立体声下混 / clamp / NaN 拒绝 / 坏容器负例 / 重采样不变速变调。

import { describe, expect, it } from 'vitest'
import { AppError, isAppError } from '@shared/errors'
import { makeSineSamples, makeWavBuffer } from '../../../../tests/helpers/wav-fixture'
import { decodeWavToMonoF32, resampleLinearF32 } from './wav'

function expectDecodeReject(buffer: Buffer, matcher: RegExp): void {
  let caught: unknown
  try {
    decodeWavToMonoF32(buffer)
  } catch (err) {
    caught = err
  }
  expect(isAppError(caught)).toBe(true)
  const cause = (caught as AppError).cause
  expect(cause instanceof Error ? cause.message : String(cause)).toMatch(matcher)
}

/** 按 chunk 拼 WAV（手写 fmt 负例/变体用；正常路径用 wav-fixture）。 */
function buildWavChunks(chunks: Array<{ id: string; data: Buffer }>): Buffer {
  const body = Buffer.concat(
    chunks.map(({ id, data }) => {
      const head = Buffer.alloc(8)
      head.write(id, 0, 'latin1')
      head.writeUInt32LE(data.length, 4)
      // RIFF chunk 2 字节对齐：奇数补 1 字节 padding
      return Buffer.concat([head, data, data.length % 2 === 1 ? Buffer.from([0]) : Buffer.alloc(0)])
    })
  )
  const header = Buffer.alloc(12)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(4 + body.length, 4)
  header.write('WAVE', 8, 'latin1')
  return Buffer.concat([header, body])
}

function fmtChunk(opts: {
  format: number
  channels: number
  sampleRate: number
  bits: number
  /** 提供则写 WAVE_FORMAT_EXTENSIBLE 扩展区；subFormat 写在 GUID 前 2 字节。 */
  cbSize?: number
  subFormat?: number
}): Buffer {
  const size = opts.cbSize !== undefined ? 18 + opts.cbSize : 16
  const b = Buffer.alloc(size)
  b.writeUInt16LE(opts.format, 0)
  b.writeUInt16LE(opts.channels, 2)
  b.writeUInt32LE(opts.sampleRate, 4)
  b.writeUInt32LE(opts.sampleRate * opts.channels * (opts.bits / 8), 8)
  b.writeUInt16LE(opts.channels * (opts.bits / 8), 12)
  b.writeUInt16LE(opts.bits, 14)
  if (opts.cbSize !== undefined) {
    b.writeUInt16LE(opts.cbSize, 16)
    if (opts.subFormat !== undefined) b.writeUInt16LE(opts.subFormat, 24)
  }
  return b
}

describe('P3B-03 decodeWavToMonoF32', () => {
  it('s16 mono：int16/32768 归一，样本值精确（1.0 因整型量化略小于 1）', () => {
    const wav = makeWavBuffer({
      sampleRate: 16_000,
      channels: 1,
      sampleFormat: 's16',
      samples: new Float32Array([0, 0.5, -0.5, 1])
    })
    const decoded = decodeWavToMonoF32(wav)
    expect(decoded.sampleRate).toBe(16_000)
    expect(decoded.sourceChannels).toBe(1)
    expect(decoded.pcm.length).toBe(4)
    expect(decoded.pcm[0]).toBe(0)
    expect(decoded.pcm[1]).toBe(0.5)
    expect(decoded.pcm[2]).toBeCloseTo(-0.5, 4) // int16 量化：-16383/32768
    expect(decoded.pcm[3]).toBeCloseTo(1, 4)
  })

  it('f32 mono：浮点原样，超出 [-1,1] 的样本 clamp 到界内', () => {
    const wav = makeWavBuffer({
      sampleRate: 24_000,
      channels: 1,
      sampleFormat: 'f32',
      samples: new Float32Array([0.25, 1.5, -1.5])
    })
    const decoded = decodeWavToMonoF32(wav)
    expect(decoded.sourceChannels).toBe(1)
    expect(Array.from(decoded.pcm)).toEqual([0.25, 1, -1])
  })

  it('f32 含 NaN：拒绝（ETTS-C18，不产出坏 PCM）', () => {
    const wav = makeWavBuffer({
      sampleRate: 24_000,
      channels: 1,
      sampleFormat: 'f32',
      samples: new Float32Array([0.1, 0.2])
    })
    wav.writeFloatLE(Number.NaN, 44) // 第 0 个样本改写为 NaN
    expectDecodeReject(wav, /NaN\/Inf/)
  })

  it('stereo：左右声道取均值下混为 mono', () => {
    const wav = makeWavBuffer({
      sampleRate: 22_050,
      channels: 2,
      sampleFormat: 's16',
      samples: new Float32Array([1, -1, 0.5, 0.25]) // frame0: L=1,R=-1 -> 0；frame1 -> 0.375
    })
    const decoded = decodeWavToMonoF32(wav)
    expect(decoded.sourceChannels).toBe(2)
    expect(decoded.pcm.length).toBe(2)
    expect(decoded.pcm[0]).toBeCloseTo(0)
    expect(decoded.pcm[1]).toBeCloseTo(0.375, 2)
  })

  it('s8 无符号偏移与 s24 三字节：均可解码归一', () => {
    const s8 = makeWavBuffer({
      sampleRate: 8_000,
      channels: 1,
      sampleFormat: 's8',
      samples: new Float32Array([0, 1, -1])
    })
    expect(Array.from(decodeWavToMonoF32(s8).pcm)).toEqual([0, 127 / 128, -127 / 128])

    const s24Data = Buffer.alloc(3)
    s24Data.writeIntLE(0x40_0000, 0, 3) // 0.5 * 2^23
    const s24 = buildWavChunks([
      { id: 'fmt ', data: fmtChunk({ format: 1, channels: 1, sampleRate: 8_000, bits: 24 }) },
      { id: 'data', data: s24Data }
    ])
    expect(decodeWavToMonoF32(s24).pcm[0]).toBeCloseTo(0.5, 2)
  })

  it('WAVE_FORMAT_EXTENSIBLE(0xFFFE)：SubFormat 前 2 字节解出真实格式', () => {
    const wav = buildWavChunks([
      {
        id: 'fmt ',
        data: fmtChunk({
          format: 0xfffe,
          channels: 1,
          sampleRate: 16_000,
          bits: 16,
          cbSize: 22,
          subFormat: 1
        })
      },
      { id: 'data', data: Buffer.from([0, 0]) } // 一个 int16 样本 = 0
    ])
    const decoded = decodeWavToMonoF32(wav)
    expect(decoded.sampleRate).toBe(16_000)
    expect(decoded.pcm.length).toBe(1)
    expect(decoded.pcm[0]).toBe(0)
  })

  it('fmt 与 data 之间夹杂未知 chunk 不影响解码', () => {
    const wav = buildWavChunks([
      { id: 'fmt ', data: fmtChunk({ format: 1, channels: 1, sampleRate: 16_000, bits: 16 }) },
      { id: 'LIST', data: Buffer.from('INFOwhatever', 'latin1') },
      { id: 'data', data: Buffer.from([0, 0x40]) } // 16384 -> 0.5
    ])
    const decoded = decodeWavToMonoF32(wav)
    expect(decoded.pcm.length).toBe(1)
    expect(decoded.pcm[0]).toBeCloseTo(0.5)
  })

  it('坏容器负例：非 RIFF / 非 WAVE / 截断 / 坏声道数 / 坏采样率 / 压缩格式 / 空数据 / 假 data 大小', () => {
    const good = makeWavBuffer({
      sampleRate: 16_000,
      channels: 1,
      sampleFormat: 's16',
      samples: new Float32Array([0.5, -0.5])
    })

    expectDecodeReject(Buffer.alloc(11), /too short/)
    expectDecodeReject(good.subarray(0, 10), /too short/)

    const notRiff = Buffer.from(good)
    notRiff.write('XXXX', 0, 'latin1')
    expectDecodeReject(notRiff, /not RIFF/)

    const notWave = Buffer.from(good)
    notWave.write('XXXX', 8, 'latin1')
    expectDecodeReject(notWave, /not WAVE/)

    const zeroChannels = Buffer.from(good)
    zeroChannels.writeUInt16LE(0, 22)
    expectDecodeReject(zeroChannels, /bad channel count/)

    const zeroRate = Buffer.from(good)
    zeroRate.writeUInt32LE(0, 24)
    expectDecodeReject(zeroRate, /bad sample rate/)

    const mp3 = Buffer.from(good)
    mp3.writeUInt16LE(85, 20) // MP3-in-WAV
    expectDecodeReject(mp3, /unsupported audio format/)

    const empty = makeWavBuffer({
      sampleRate: 16_000,
      channels: 1,
      sampleFormat: 's16',
      samples: new Float32Array(0)
    })
    expectDecodeReject(empty, /empty data/)

    const truncated = Buffer.from(good)
    truncated.writeUInt32LE(1_000, 40) // data 声称的大小越过缓冲区
    expectDecodeReject(truncated, /truncated chunk/)

    // 只有 fmt 没有 data
    const noData = buildWavChunks([
      { id: 'fmt ', data: fmtChunk({ format: 1, channels: 1, sampleRate: 16_000, bits: 16 }) }
    ])
    expectDecodeReject(noData, /missing fmt or data/)
  })
})

describe('P3B-03 resampleLinearF32', () => {
  it('22.05k -> 24k：1 秒仍是 1 秒（不变速变调），能量近似守恒', () => {
    const samples = makeSineSamples({
      sampleRate: 22_050,
      channels: 1,
      frequencyHz: 220,
      durationMs: 1_000,
      amplitude: 0.5
    })
    const wav = makeWavBuffer({
      sampleRate: 22_050,
      channels: 1,
      sampleFormat: 'f32',
      samples
    })
    const decoded = decodeWavToMonoF32(wav)
    const resampled = resampleLinearF32(decoded.pcm, 22_050, 24_000)
    expect(resampled.length).toBe(24_000)
    expect(resampled[0]).toBeCloseTo(decoded.pcm[0])
    expect(Math.max(...resampled)).toBeGreaterThan(0.4)
    expect(Math.min(...resampled)).toBeLessThan(-0.4)
    const rms = (arr: Float32Array): number =>
      Math.sqrt(arr.reduce((acc, v) => acc + v * v, 0) / arr.length)
    expect(rms(resampled)).toBeCloseTo(rms(decoded.pcm), 1)
  })

  it('同采样率返回同一引用，不制造拷贝', () => {
    const pcm = new Float32Array([0.1, 0.2, 0.3])
    expect(resampleLinearF32(pcm, 24_000, 24_000)).toBe(pcm)
  })

  it('插值落在相邻样本之间（升采样与降采样）', () => {
    // 2 个样本升采样 2 倍 -> 4 个样本，中点是 0 与 1 的线性插值
    const up = resampleLinearF32(new Float32Array([0, 1]), 8_000, 16_000)
    expect(up.length).toBe(4)
    expect(up[0]).toBe(0)
    expect(up[1]).toBeCloseTo(0.5)
    expect(up[2]).toBe(1)
    expect(up[3]).toBe(1) // 尾部保持末样本

    const down = resampleLinearF32(new Float32Array([0, 0.5, 1]), 16_000, 8_000)
    expect(down.length).toBe(2) // round(3 * 0.5)
    expect(down[0]).toBe(0)
    expect(down[1]).toBeCloseTo(1)
  })

  it('非法采样率直接抛错；空输入原样返回', () => {
    expect(() => resampleLinearF32(new Float32Array(1), 0, 24_000)).toThrow(/invalid rates/)
    expect(() => resampleLinearF32(new Float32Array(1), 24_000, -1)).toThrow(/invalid rates/)
    expect(resampleLinearF32(new Float32Array(0), 16_000, 24_000).length).toBe(0)
  })
})
