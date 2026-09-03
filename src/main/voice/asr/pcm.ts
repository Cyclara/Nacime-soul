// src/main/voice/asr/pcm.ts
// 共享 PCM 归一：s16le -> Float32 [-1,1]，原生 acceptWaveform 的输入形状。
//
// 单独成文件是因为离线（sherpa-provider）与流式（streaming-provider）两条路径
// 都要做同一件事。同一转换写两遍，哪天有人改了除数（32768 vs 32767）就只会
// 改到一边，然后两条路径的识别质量出现无法解释的差异。

/**
 * 除 32768 而不是 32767：s16 的取值域是 [-32768, 32767]，用 32768 保证
 * 最负样本恰好映射到 -1.0 且绝不越界，这也是 sherpa 官方示例的口径。
 */
export function int16ToFloat32(audio: Int16Array): Float32Array {
  const out = new Float32Array(audio.length)
  for (let i = 0; i < audio.length; i++) {
    out[i] = audio[i]! / 32_768
  }
  return out
}
