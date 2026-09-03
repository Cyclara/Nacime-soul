// src/shared/voice/mic-types.ts
// P3B-13：麦克风 PCM 数据面协议（renderer→main 专用 port 上的消息合同）。
//
// 传输拓扑（与 TTS 播放 port §1.14 对称的反向数据面）：
//   renderer AudioWorklet（512 样本 Int16 帧，transferable）
//     → renderer 页面线程（capture session 转发，transferable，零拷贝）
//     → MessageChannel port（renderer 建口，port2 经 preload 转交 main）
//     → main MicInputSession（喂 VadProcessor，话语缓冲有界 60s）
// PCM 不走普通 invoke/event IPC（与 TTS 同红线）；port 本身不在账本登记通道名。
//
// 帧合同：16k/mono/s16le（ASR_AUDIO_FORMAT 同源约定），每消息恰一帧 512 样本
// （= VAD_WINDOW_SAMPLES = 32ms；Silero v4 窗口）。上限 2048 样本容错（processor
// 会按 512 切窗，尾部不足一窗丢弃）。

/** 生产帧尺寸：512 样本（32ms @16k）——与 main 侧 VAD_WINDOW_SAMPLES 同值耦合。 */
export const MIC_FRAME_SAMPLES = 512
/** 单消息样本上限（4 窗）：超出视为协议违规，main 侧丢弃并计数。 */
export const MIC_MAX_FRAME_SAMPLES = 2048
/** 采样率（与 ASR/VAD 输入合同一致，仅作文档锚点，不做运行时字段）。 */
export const MIC_SAMPLE_RATE = 16_000

/** port 上唯一的数据消息：一帧 s16le PCM。 */
export interface MicFrameMessage {
  readonly type: 'mic-frame'
  readonly samples: Int16Array
}

/** 运行时校验（main 侧入口用；renderer 侧只生产不消费）。 */
export function isMicFrameMessage(value: unknown): value is MicFrameMessage {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return v['type'] === 'mic-frame' && v['samples'] instanceof Int16Array
}

/** 帧尺寸合法性（空帧/超限都违规）。 */
export function isValidMicFrameSamples(samples: Int16Array): boolean {
  return samples.length > 0 && samples.length <= MIC_MAX_FRAME_SAMPLES
}
