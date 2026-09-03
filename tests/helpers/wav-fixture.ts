// tests/helpers/wav-fixture.ts
// P3B-03：测试用 WAV 构造器--语音链路测试不读真实音频文件、不真发声（S-004 惯例）。
//
// 用途：给 TTS provider/decoder 测试提供确定性的 WAV bytes（Edge SAPI fake、
// GPT-SoVITS adapter 测试、坏容器负例都能从这里派生）。

export type WavFixtureFormat = 's8' | 's16' | 's24' | 's32' | 'f32'

const FORMAT_CODES: Record<WavFixtureFormat, number> = {
  s8: 1,
  s16: 1,
  s24: 1,
  s32: 1,
  f32: 3
}

const BITS: Record<WavFixtureFormat, number> = {
  s8: 8,
  s16: 16,
  s24: 24,
  s32: 32,
  f32: 32
}

/**
 * 构造标准 classic-fmt WAV。samples 为 interleaved 浮点（-1..1），长度须是 channels
 * 的整数倍；s16 会做饱和截断到 int16 范围。
 */
export function makeWavBuffer(opts: {
  sampleRate: number
  channels: number
  sampleFormat: WavFixtureFormat
  samples: Float32Array
}): Buffer {
  const { sampleRate, channels, sampleFormat } = opts
  const bits = BITS[sampleFormat]
  const bytesPerSample = bits / 8
  if (!Number.isInteger(opts.samples.length / channels)) {
    throw new Error(`samples length ${opts.samples.length} not divisible by channels ${channels}`)
  }
  const dataLength = opts.samples.length * bytesPerSample
  const buffer = Buffer.alloc(44 + dataLength)

  buffer.write('RIFF', 0, 'latin1')
  buffer.writeUInt32LE(36 + dataLength, 4)
  buffer.write('WAVE', 8, 'latin1')
  buffer.write('fmt ', 12, 'latin1')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(FORMAT_CODES[sampleFormat], 20)
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28)
  buffer.writeUInt16LE(channels * bytesPerSample, 32)
  buffer.writeUInt16LE(bits, 34)
  buffer.write('data', 36, 'latin1')
  buffer.writeUInt32LE(dataLength, 40)

  let offset = 44
  for (const sample of opts.samples) {
    if (sampleFormat === 'f32') {
      buffer.writeFloatLE(sample, offset)
      offset += 4
    } else if (sampleFormat === 's8') {
      const v = Math.round(Math.min(1, Math.max(-1, sample)) * 127) + 128
      buffer.writeUInt8(v, offset)
      offset += 1
    } else {
      const scaled = Math.min(1, Math.max(-1, sample)) * (2 ** (bits - 1) - 1)
      const int = Math.round(scaled)
      buffer.writeIntLE(int, offset, bytesPerSample)
      offset += bytesPerSample
    }
  }
  return buffer
}

/** 生成正弦波 interleaved 样本（通道数任意，各通道同相）。 */
export function makeSineSamples(opts: {
  sampleRate: number
  channels: number
  frequencyHz: number
  durationMs: number
  amplitude?: number
}): Float32Array {
  const amplitude = opts.amplitude ?? 0.5
  const perChannel = Math.round((opts.durationMs / 1000) * opts.sampleRate)
  const out = new Float32Array(perChannel * opts.channels)
  for (let i = 0; i < perChannel; i++) {
    const v = Math.sin((2 * Math.PI * opts.frequencyHz * i) / opts.sampleRate) * amplitude
    for (let ch = 0; ch < opts.channels; ch++) out[i * opts.channels + ch] = v
  }
  return out
}
