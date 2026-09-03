// src/main/voice/vad/vad.ts
// P3B-12：VAD 三态状态机（IDLE/ACTIVE/INACTIVE）——纯逻辑，无原生依赖。
//
// 参考实现：Open-LLM-VTuber `vad/silero.py`（已审计核对常量：prob_threshold=0.4、
// db_threshold=60、required_hits=3、required_misses=24、smoothing_window=5、
// pre_buffer=deque(maxlen=20)、512 样本窗 @16k=32ms）。帧判定 = 平滑 prob ≥ 阈值
// **且** 平滑 db ≥ 阈值（双门：Silero 概率门 + int16 尺度能量门，防「阈值绑定
// 设备导致误触发」——能量门可拦下 Silero 对稳态噪声的假阳性）。
//
// 状态语义（主分析 §5.3.1，与参考一致）：
//   IDLE     —— 空闲：chunk 滚动进前缓冲（≤20 块）；连续 3 帧命中 → ACTIVE，
//               发 speech_start（带前缓冲快照，保句首不截断）
//   ACTIVE   —— 说话中：chunk 进话语缓冲；连续 24 帧未命中 → INACTIVE（不发事件）
//   INACTIVE —— 停顿宽限期：chunk 继续进话语缓冲（停顿音频保留在话语内）；
//               再命中 3 帧 → ACTIVE（继续同一话语）；再未命中 24 帧 → IDLE，
//               发 speech_end（audio = 前缓冲 + 全部话语块）
//   即「短停顿」（<48 帧静音）不结束话语；话语总静音 48 帧（≈1.54s）才出段。
//
// 与参考实现的两处刻意差异（修其瑕疵，均有测试钉住）：
//   1. IDLE→ACTIVE 的转移帧不重复入话语缓冲（参考实现把该帧同时写进
//      pre_buffer 与 bytes，拼接时双计入 32ms 音频）；
//   2. 不采纳参考的「话语 <30 帧整段丢弃」守卫——短指令（「嗯」「停」）不足
//      1s，丢弃会吃掉 barge-in 触发词；有界性由 maxUtteranceSamples 强制切段保证。
//
// chunk 所有权：本机持有调用方传入 chunk 的引用（不复制）；调用方（processor）
// 负责传入不被复用的副本。事件载荷（preBuffer/audio）一律是新拼接的数组，
// 与内部状态无别名。

import { ASR_AUDIO_MAX_SAMPLES } from '@shared/voice/asr-types'
import type { VoiceVadState } from '@shared/voice/voice-events'

/** 平滑窗口（帧数）：对 prob/db 做滑动平均，防瞬时噪声触发。 */
export const VAD_SMOOTHING_WINDOW = 5
/** 前缓冲上限（块）：IDLE 最后 20 块随话语一并输出，保句首不截断。 */
export const VAD_PRE_BUFFER_MAX_CHUNKS = 20
/** 确认开始说话所需连续命中帧数。 */
export const VAD_REQUIRED_HITS = 3
/** 确认状态转移所需连续未命中帧数（ACTIVE→INACTIVE 与 INACTIVE→IDLE 各一次）。 */
export const VAD_REQUIRED_MISSES = 24
/** Silero 语音概率门（平滑后）。生产 prob 来自原生 isDetected() 的 0/1。 */
export const VAD_PROB_THRESHOLD = 0.4
/** 能量门（平滑后）：int16 尺度 dB = 20·log10(rms+1e-7)，60 ≈ 幅值 0.03。 */
export const VAD_DB_THRESHOLD = 60
/** Silero v4 @16k 的模型窗口（= 生产 chunk 尺度，32ms）。 */
export const VAD_WINDOW_SAMPLES = 512

/** VAD 三态（单一来源 = shared/voice-events.ts 的 VoiceVadState）。 */
export type VadState = VoiceVadState

/** 单帧判定输入（由 processor 从 Silero + RMS 计算）。 */
export interface VadFrame {
  /** 语音概率 0..1。生产实现为原生 isDetected() 的 0/1；测试可注入连续值。 */
  readonly prob: number
  /** int16 尺度分贝（computeChunkDb）。 */
  readonly db: number
}

/** 话语结束原因。 */
export type VadSpeechEndReason =
  | 'silence' /** 完整话语：INACTIVE 后再 24 帧静音 */
  | 'max-duration' /** 达到 maxUtteranceSamples 上限强制切段（有界性） */
  | 'flush' /** 会话停止时冲刷未完话语（stop-listening 中途说话） */

export type VadEvent =
  | { readonly type: 'speech_start'; readonly preBuffer: Int16Array }
  | {
      readonly type: 'speech_end'
      readonly audio: Int16Array
      readonly reason: VadSpeechEndReason
    }

export interface VadStateMachineOptions {
  readonly smoothingWindow?: number
  readonly preBufferMaxChunks?: number
  readonly requiredHits?: number
  readonly requiredMisses?: number
  readonly probThreshold?: number
  readonly dbThreshold?: number
  /** 话语样本上限（含前缓冲）；默认 ASR 60s 合同上限，达到即强制切段。 */
  readonly maxUtteranceSamples?: number
}

export interface VadStateMachine {
  readonly state: VadState
  /** 喂一帧（chunk 引用被本机持有）。至多返回一个事件。 */
  process(frame: VadFrame, chunk: Int16Array): VadEvent | null
  /** 非 IDLE 时结束当前话语（reason='flush'）；IDLE 返回 null。 */
  flush(): VadEvent | null
  /** 硬复位：丢弃一切缓冲与计数，不产事件。 */
  reset(): void
}

/** int16 尺度分贝：20·log10(rms+1e-7)。全零帧 → -140（低于任何合理阈值）。 */
export function computeChunkDb(chunk: Int16Array): number {
  if (chunk.length === 0) return -140
  let sum = 0
  for (let i = 0; i < chunk.length; i++) {
    const v = chunk[i]
    sum += v * v
  }
  const rms = Math.sqrt(sum / chunk.length)
  return 20 * Math.log10(rms + 1e-7)
}

function concatChunks(chunks: readonly Int16Array[]): Int16Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Int16Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

export function createVadStateMachine(options?: VadStateMachineOptions): VadStateMachine {
  const smoothingWindow = options?.smoothingWindow ?? VAD_SMOOTHING_WINDOW
  const preBufferMaxChunks = options?.preBufferMaxChunks ?? VAD_PRE_BUFFER_MAX_CHUNKS
  const requiredHits = options?.requiredHits ?? VAD_REQUIRED_HITS
  const requiredMisses = options?.requiredMisses ?? VAD_REQUIRED_MISSES
  const probThreshold = options?.probThreshold ?? VAD_PROB_THRESHOLD
  const dbThreshold = options?.dbThreshold ?? VAD_DB_THRESHOLD
  const maxUtteranceSamples = options?.maxUtteranceSamples ?? ASR_AUDIO_MAX_SAMPLES

  let state: VadState = 'idle'
  let hitCount = 0
  let missCount = 0
  const probWindow: number[] = []
  const dbWindow: number[] = []
  let preBuffer: Int16Array[] = []
  let audioBuffer: Int16Array[] = []
  let preSamples = 0
  let audioSamples = 0

  function pushCapped(window: number[], value: number): void {
    window.push(value)
    if (window.length > smoothingWindow) window.shift()
  }

  function mean(values: readonly number[]): number {
    if (values.length === 0) return 0
    let sum = 0
    for (const v of values) sum += v
    return sum / values.length
  }

  function endUtterance(reason: VadSpeechEndReason): VadEvent {
    const audio = concatChunks([...preBuffer, ...audioBuffer])
    state = 'idle'
    hitCount = 0
    missCount = 0
    preBuffer = []
    audioBuffer = []
    preSamples = 0
    audioSamples = 0
    return { type: 'speech_end', audio, reason }
  }

  function resetAll(): void {
    state = 'idle'
    hitCount = 0
    missCount = 0
    probWindow.length = 0
    dbWindow.length = 0
    preBuffer = []
    audioBuffer = []
    preSamples = 0
    audioSamples = 0
  }

  return {
    get state(): VadState {
      return state
    },

    process(frame, chunk) {
      pushCapped(probWindow, frame.prob)
      pushCapped(dbWindow, frame.db)
      const pass = mean(probWindow) >= probThreshold && mean(dbWindow) >= dbThreshold

      if (state === 'idle') {
        preBuffer.push(chunk)
        preSamples += chunk.length
        if (preBuffer.length > preBufferMaxChunks) {
          const dropped = preBuffer.shift()
          preSamples -= dropped?.length ?? 0
        }
        if (pass) {
          hitCount++
          if (hitCount >= requiredHits) {
            state = 'active'
            hitCount = 0
            missCount = 0
            // 转移帧已在 preBuffer 中，不重复入话语缓冲（修参考实现双计入）
            return { type: 'speech_start', preBuffer: concatChunks(preBuffer) }
          }
        } else {
          hitCount = 0
        }
        return null
      }

      // ACTIVE / INACTIVE：话语缓冲 + 有界性检查
      audioBuffer.push(chunk)
      audioSamples += chunk.length
      if (preSamples + audioSamples >= maxUtteranceSamples) {
        return endUtterance('max-duration')
      }

      if (state === 'active') {
        if (pass) {
          missCount = 0
        } else {
          missCount++
          if (missCount >= requiredMisses) {
            state = 'inactive'
            missCount = 0
          }
        }
        return null
      }

      // inactive
      if (pass) {
        hitCount++
        if (hitCount >= requiredHits) {
          state = 'active'
          hitCount = 0
          missCount = 0
        }
      } else {
        hitCount = 0
        missCount++
        if (missCount >= requiredMisses) {
          return endUtterance('silence')
        }
      }
      return null
    },

    flush() {
      if (state === 'idle') return null
      return endUtterance('flush')
    },

    reset() {
      resetAll()
    }
  }
}
