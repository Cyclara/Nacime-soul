// src/main/voice/tts/wav.ts
// P3B-03/06：WAV 容器解码 + 线性重采样。Edge SAPI 与 GPT-SoVITS adapter 共用
// （P3B-06 验收「容器解码/重采样在 adapter 内完成」的落点就是这里）。
//
// 输出合同：mono / f32 / 已 clamp 到 [-1, 1] / 无 NaN/Inf（ETTS-C18）。
// 坏容器（非 RIFF/WAVE、缺 fmt/data、不支持位宽、截断、空数据、浮点 NaN/Inf）
// 一律抛 AppError(TTS_DECODE)，不返回半份 PCM。

import { AppError } from '@shared/errors'

export interface WavDecodeResult {
  readonly sampleRate: number
  /** 源声道数；输出已下混为 mono。 */
  readonly sourceChannels: number
  readonly pcm: Float32Array
}

function decodeError(detail: string): AppError {
  return new AppError({
    code: 'TTS_DECODE',
    userMessage: '语音数据解码失败。',
    severity: 'error',
    retryable: false,
    cause: new Error(detail)
  })
}

const MAX_CHANNELS = 8
const MAX_SAMPLE_RATE = 384_000

/**
 * 解码 WAV（RIFF/WAVE，classic PCM / IEEE float，含 WAVE_FORMAT_EXTENSIBLE 包装），
 * 任意声道下混为 mono，任意位宽归一为 f32。
 * 不支持的压缩格式（MP3-in-WAV、ADPCM 等）直接拒绝。
 */
export function decodeWavToMonoF32(buffer: Buffer): WavDecodeResult {
  if (buffer.length < 12) throw decodeError('wav: buffer too short for RIFF header')
  if (buffer.readUInt32BE(0) !== 0x5249_4646) throw decodeError('wav: not RIFF') // 'RIFF'
  if (buffer.readUInt32BE(8) !== 0x5741_5645) throw decodeError('wav: not WAVE') // 'WAVE'

  let audioFormat = -1
  let channels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let dataStart = -1
  let dataSize = 0

  // 走 chunk 链而不是假设 44 字节固定头：LIST/FACT 等 chunk 顺序合法可变。
  let offset = 12
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.readUInt32BE(offset)
    const chunkSize = buffer.readUInt32LE(offset + 4)
    const chunkStart = offset + 8
    if (chunkStart + chunkSize > buffer.length) throw decodeError('wav: truncated chunk')
    if (chunkId === 0x666d_7420) {
      // 'fmt '
      if (chunkSize < 16) throw decodeError('wav: fmt chunk too short')
      audioFormat = buffer.readUInt16LE(chunkStart)
      channels = buffer.readUInt16LE(chunkStart + 2)
      sampleRate = buffer.readUInt32LE(chunkStart + 4)
      bitsPerSample = buffer.readUInt16LE(chunkStart + 14)
      if (audioFormat === 0xfffe && chunkSize >= 26) {
        // WAVE_FORMAT_EXTENSIBLE：SubFormat GUID 前 2 字节才是真实格式码
        audioFormat = buffer.readUInt16LE(chunkStart + 24)
      }
    } else if (chunkId === 0x6461_7461) {
      // 'data'
      dataStart = chunkStart
      dataSize = chunkSize
    }
    // RIFF chunk 按 2 字节对齐（奇数 size 后有 1 字节 padding）
    offset = chunkStart + chunkSize + (chunkSize % 2)
  }

  if (audioFormat === -1 || dataStart === -1) throw decodeError('wav: missing fmt or data chunk')
  if (channels < 1 || channels > MAX_CHANNELS)
    throw decodeError(`wav: bad channel count ${channels}`)
  if (sampleRate < 1 || sampleRate > MAX_SAMPLE_RATE) {
    throw decodeError(`wav: bad sample rate ${sampleRate}`)
  }

  const bytesPerSample = bitsPerSample / 8
  if (!Number.isInteger(bytesPerSample) || bytesPerSample < 1 || bytesPerSample > 4) {
    throw decodeError(`wav: unsupported bits per sample ${bitsPerSample}`)
  }
  if (audioFormat !== 1 && audioFormat !== 3) {
    throw decodeError(`wav: unsupported audio format ${audioFormat} (only PCM / IEEE float)`)
  }
  const isFloat = audioFormat === 3
  if (isFloat && bitsPerSample !== 32) {
    throw decodeError(`wav: float wav must be 32-bit, got ${bitsPerSample}`)
  }

  const frameSize = channels * bytesPerSample
  const frameCount = Math.floor(dataSize / frameSize)
  if (frameCount === 0) throw decodeError('wav: empty data chunk')

  const pcm = new Float32Array(frameCount)
  for (let frame = 0; frame < frameCount; frame++) {
    const base = dataStart + frame * frameSize
    let sum = 0
    for (let ch = 0; ch < channels; ch++) {
      const at = base + ch * bytesPerSample
      let v: number
      if (isFloat) {
        v = buffer.readFloatLE(at)
        if (!Number.isFinite(v)) throw decodeError('wav: NaN/Inf in float samples')
      } else if (bitsPerSample === 8) {
        v = (buffer.readUInt8(at) - 128) / 128
      } else if (bitsPerSample === 16) {
        v = buffer.readInt16LE(at) / 32768
      } else if (bitsPerSample === 24) {
        v = buffer.readIntLE(at, 3) / 8_388_608
      } else {
        v = buffer.readInt32LE(at) / 2_147_483_648
      }
      sum += v
    }
    // 下混取均值后 clamp：int 位宽天然在界内，float 源可能超界，播放侧只接受 [-1,1]
    const mono = Math.min(1, Math.max(-1, sum / channels))
    pcm[frame] = mono
  }

  return { sampleRate, sourceChannels: channels, pcm }
}

/**
 * 线性插值重采样（不变速变调的正确做法就是重采样，不是改播放速率）。
 * fromRate === toRate 时原样返回同一引用，不制造无谓拷贝。
 */
export function resampleLinearF32(
  pcm: Float32Array,
  fromRate: number,
  toRate: number
): Float32Array {
  if (!Number.isFinite(fromRate) || fromRate <= 0 || !Number.isFinite(toRate) || toRate <= 0) {
    throw new Error(`resample: invalid rates ${fromRate} -> ${toRate}`)
  }
  if (fromRate === toRate || pcm.length === 0) return pcm
  const outLength = Math.max(1, Math.round((pcm.length * toRate) / fromRate))
  const out = new Float32Array(outLength)
  const step = fromRate / toRate
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * step
    const i0 = Math.floor(srcPos)
    const frac = srcPos - i0
    const i1 = Math.min(i0 + 1, pcm.length - 1)
    out[i] = pcm[i0] * (1 - frac) + pcm[i1] * frac
  }
  return out
}
