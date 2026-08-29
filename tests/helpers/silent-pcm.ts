// tests/helpers/silent-pcm.ts
// P3-00C：静音/合成 PCM 生成器——测试不碰真实麦克风与声音文件。
//
// 用途：
//   - 语音管线（P3B-09..12）：VAD 三态、分段、前缓冲全用合成帧驱动
//   - 口型/播放：不需要真实音频资产
//
// 约定：一律 16kHz / 16bit / mono（s16le），与 ASR/VAD 输入合同一致；
// 测试需要别的采样率时显式传参，不从环境猜。

export const PCM_SAMPLE_RATE = 16_000

/** 生成全零静音 PCM。durationMs 毫秒。 */
export function makeSilentPcm16(durationMs: number, sampleRate = PCM_SAMPLE_RATE): Int16Array {
  const samples = Math.round((durationMs / 1000) * sampleRate)
  return new Int16Array(samples)
}

/** 生成正弦波 PCM（模拟"有声音"，幅值 0..1）。 */
export function makeSinePcm16(
  frequencyHz: number,
  durationMs: number,
  amplitude = 0.5,
  sampleRate = PCM_SAMPLE_RATE
): Int16Array {
  const samples = Math.round((durationMs / 1000) * sampleRate)
  const pcm = new Int16Array(samples)
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate
    pcm[i] = Math.round(Math.sin(2 * Math.PI * frequencyHz * t) * amplitude * 32767)
  }
  return pcm
}

/** 生成"静音-有声-静音"三段拼接 PCM（VAD 起止测试主力）。 */
export function makeSpeechLikePcm16(opts: {
  leadSilenceMs: number
  speechMs: number
  tailSilenceMs: number
  speechFrequencyHz?: number
  sampleRate?: number
}): Int16Array {
  const rate = opts.sampleRate ?? PCM_SAMPLE_RATE
  const lead = makeSilentPcm16(opts.leadSilenceMs, rate)
  const speech = makeSinePcm16(opts.speechFrequencyHz ?? 220, opts.speechMs, 0.6, rate)
  const tail = makeSilentPcm16(opts.tailSilenceMs, rate)
  const out = new Int16Array(lead.length + speech.length + tail.length)
  out.set(lead, 0)
  out.set(speech, lead.length)
  out.set(tail, lead.length + speech.length)
  return out
}

/** 把 PCM 切成定长帧序列（VAD/分段测试逐帧喂入）。 */
export function slicePcmFrames(pcm: Int16Array, frameSamples: number): Int16Array[] {
  if (frameSamples <= 0) throw new RangeError('frameSamples must be > 0')
  const frames: Int16Array[] = []
  for (let offset = 0; offset + frameSamples <= pcm.length; offset += frameSamples) {
    frames.push(pcm.subarray(offset, offset + frameSamples))
  }
  return frames
}

/** 帧能量（供测试自建断言：静音帧应≈0，正弦帧应明显>0）。 */
export function frameEnergy(frame: Int16Array): number {
  let sum = 0
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i] / 32768
    sum += v * v
  }
  return frame.length === 0 ? 0 : sum / frame.length
}
