// src/shared/voice/asr-types.ts
// P3B-09：ASR（语音转文字）的共享冻结 ABI。
//
// 依据：S-Phase3 P3B-09（`recognize(audio, options)`、模型状态、进度/错误 DTO；
// DTO 不含任意文件路径；可 mock）+ 2026-08-03 审计裁定 3（ASR 全本地：Sherpa ONNX
// 默认 + FunASR 备用，Groq Whisper 作废--任何实现不得把语音发外部）+
// P3-00C 测试合同（tests/helpers/silent-pcm.ts：ASR/VAD 输入一律 16kHz/mono/s16le）。
//
// 输入音频合同取 **Int16Array（16kHz mono s16le）**：主分析 §5.3 的
// `(audio: Float32Array) => Promise<string>` 是早期草图，被 P3-00C 的 16k/s16 约定
// 取代（麦克风 capture 经 AudioWorklet 产 Float32，进 ASR 前归一为 s16；P3B-13 落地）。
//
// 有界性（反模式「main/renderer 传巨大 JSON 数组」）：转写结果冻结上限
// （文本字符数/segment 数），输入音频冻结时长上限；音频本体不经 JSON IPC
// （P3B-13 有界 transferable，本文件只冻结合同与界）。
//
// 本文件只有类型、冻结常量、判别/校验纯函数：引擎实现（P3B-10 Sherpa / P3B-11
// FunASR）与注册表在 main 侧；renderer 只见到 AsrModelStatus / 转写结果投影。

// ── 输入音频合同（P3-00C 冻结） ──

export interface AsrAudioFormat {
  sampleRate: 16000
  channels: 1
  sampleFormat: 's16le'
}

/** 唯一支持的输入格式；引擎不得自选采样率/声道/采样宽度。 */
export const ASR_AUDIO_FORMAT: AsrAudioFormat = Object.freeze({
  sampleRate: 16_000,
  channels: 1,
  sampleFormat: 's16le'
})

/** 单次识别的音频时长上限（防「巨大数组」进管线；VAD 分段保证单轮话语更短）。 */
export const ASR_AUDIO_MAX_MS = 60_000
/** 60s @ 16kHz。 */
export const ASR_AUDIO_MAX_SAMPLES = 960_000

// ── 识别选项与结果 ──

/**
 * 语言提示。闭集（IPC 校验需要可枚举）：SenseVoice 支持集 + auto。
 * 引擎可以忽略提示（如 FunASR 只做中文）；未来扩语言 = 共享类型变更，可见。
 */
export type AsrLanguageHint = 'auto' | 'zh' | 'en' | 'ja' | 'ko' | 'yue'

export interface AsrRecognizeOptions {
  language?: AsrLanguageHint
}

export interface AsrTranscriptSegment {
  text: string
  startMs: number
  endMs: number
}

export interface AsrTranscriptResult {
  text: string
  segments: AsrTranscriptSegment[]
}

/** 转写文本上限（单轮语音输入的口语转写远小于此；超界=协议错误）。 */
export const ASR_TRANSCRIPT_TEXT_MAX_CHARS = 4_096
/** segment 数上限。 */
export const ASR_TRANSCRIPT_SEGMENTS_MAX = 64
/** engineId / errorCode 的字符串界（与 IPC 其余 id 同量级）。 */
export const ASR_ENGINE_ID_MAX_LENGTH = 64
export const ASR_ERROR_CODE_MAX_LENGTH = 64

// ── 模型状态与错误 ──

export type AsrModelState = 'not-downloaded' | 'downloading' | 'ready' | 'error'

/**
 * 固定错误码（F5-011 纪律：错误码是枚举串，不是给人读的自由文本；
 * 路径/命令行/URL 一律不进 DTO）。adapter 把内部错误映射到此处。
 */
export type AsrErrorCode =
  | 'model-missing'
  | 'model-corrupt'
  | 'model-download-failed'
  | 'engine-init-failed'
  | 'recognize-failed'
  | 'engine-busy'
  | 'audio-invalid'

/**
 * renderer 可见的模型状态投影（`voice:get-state` / voice-state event 的字段来源，
 * P3B-14/18 落地）。**engineId 是注册表 id，不是文件路径**（P3B-09 验收红线）。
 */
export interface AsrModelStatus {
  engineId: string
  state: AsrModelState
  /** 下载/加载进度 0..1；state=downloading 之外可省略。 */
  progressRatio?: number
  errorCode?: AsrErrorCode
}

// ── 引擎接口（冻结 ABI） ──

/**
 * main 侧引擎合同；tests/helpers/fake-asr.ts 结构对齐本接口（P3B-09 冻结后已同步）。
 * 每个引擎（Sherpa / FunASR）一个实现；切换/懒加载/中止下载归 P3B-10 的管理器，
 * 不进本接口。
 */
export interface AsrEngine {
  /** 注册表 id（如 'sherpa-sensevoice'）；非路径。 */
  readonly id: string
  /**
   * 审计裁定 3：ASR 全本地。恒为 true--任何 adapter 不得把语音发外部；
   * 把它改成 false 或删掉 = 变更冻结合同，需走勘误。
   */
  readonly localOnly: true
  readonly state: AsrModelState
  /**
   * 下载 + 懒加载统一入口（busy 态合并为 'downloading'，进度经 onProgress 报 0..1）。
   * ready 后幂等；失败落 'error' 并由管理器映射 AsrErrorCode。
   */
  loadModel(): Promise<void>
  /**
   * 冻结两参 ABI。audio 必须满足 ASR_AUDIO_FORMAT 与 ASR_AUDIO_MAX_SAMPLES；
   * 违反 -> adapter 拒绝（'audio-invalid'），不得截断后继续识别。
   */
  recognize(audio: Int16Array, options?: AsrRecognizeOptions): Promise<AsrTranscriptResult>
  /** 加载进度 0..1；识别期间不发进度。返回退订函数。 */
  onProgress(listener: (ratio: number) => void): () => void
}

// ── 运行时校验（纯函数；未来 IPC validator 与引擎输出自检共用） ──

const MODEL_STATES: readonly AsrModelState[] = ['not-downloaded', 'downloading', 'ready', 'error']

const LANGUAGE_HINTS: readonly AsrLanguageHint[] = ['auto', 'zh', 'en', 'ja', 'ko', 'yue']

const ERROR_CODES: readonly AsrErrorCode[] = [
  'model-missing',
  'model-corrupt',
  'model-download-failed',
  'engine-init-failed',
  'recognize-failed',
  'engine-busy',
  'audio-invalid'
]

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maxLength
}

function isFiniteInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

/** 识别输入合同检查：Int16Array、非空、时长不超上限。 */
export function isValidAsrAudioInput(audio: unknown): audio is Int16Array {
  if (!(audio instanceof Int16Array)) return false
  return audio.length > 0 && audio.length <= ASR_AUDIO_MAX_SAMPLES
}

/**
 * 识别选项检查（renderer -> main 的未来 IPC 入参同界）。
 * undefined 合法：可选字段省略时的到达形态。
 */
export function isValidAsrRecognizeOptions(
  value: unknown
): value is AsrRecognizeOptions | undefined {
  if (value === undefined) return true
  if (typeof value !== 'object' || value === null) return false
  const options = value as Record<string, unknown>
  if (!hasExactKeys(options, ['language'])) return false
  return (
    options['language'] === undefined ||
    LANGUAGE_HINTS.includes(options['language'] as AsrLanguageHint)
  )
}

/** 转写结果检查：形状、字符/segment 上限、时间戳非负且有序。 */
export function isValidAsrTranscriptResult(value: unknown): value is AsrTranscriptResult {
  if (typeof value !== 'object' || value === null) return false
  const result = value as Record<string, unknown>
  if (!hasExactKeys(result, ['text', 'segments'])) return false
  if (typeof result['text'] !== 'string') return false
  if (result['text'].length > ASR_TRANSCRIPT_TEXT_MAX_CHARS) return false
  if (!Array.isArray(result['segments'])) return false
  if (result['segments'].length > ASR_TRANSCRIPT_SEGMENTS_MAX) return false
  for (const raw of result['segments']) {
    if (typeof raw !== 'object' || raw === null) return false
    const segment = raw as Record<string, unknown>
    if (!hasExactKeys(segment, ['text', 'startMs', 'endMs'])) return false
    if (!isBoundedString(segment['text'], ASR_TRANSCRIPT_TEXT_MAX_CHARS)) return false
    if (!isFiniteInt(segment['startMs'], 0, Number.MAX_SAFE_INTEGER)) return false
    if (!isFiniteInt(segment['endMs'], 0, Number.MAX_SAFE_INTEGER)) return false
    if ((segment['endMs'] as number) < (segment['startMs'] as number)) return false
  }
  return true
}

/** 模型状态投影检查：engineId 有界、state/errorCode 枚举、progress 0..1。 */
export function isValidAsrModelStatus(value: unknown): value is AsrModelStatus {
  if (typeof value !== 'object' || value === null) return false
  const status = value as Record<string, unknown>
  if (!hasExactKeys(status, ['engineId', 'state', 'progressRatio', 'errorCode'])) return false
  if (!isBoundedString(status['engineId'], ASR_ENGINE_ID_MAX_LENGTH)) return false
  if (!MODEL_STATES.includes(status['state'] as AsrModelState)) return false
  if (
    status['progressRatio'] !== undefined &&
    !(
      typeof status['progressRatio'] === 'number' &&
      Number.isFinite(status['progressRatio']) &&
      status['progressRatio'] >= 0 &&
      status['progressRatio'] <= 1
    )
  ) {
    return false
  }
  return (
    status['errorCode'] === undefined || ERROR_CODES.includes(status['errorCode'] as AsrErrorCode)
  )
}

// === 编译期护栏（P3B-01 手法：反模式 = 暗改冻结 ABI）===

type AssertIsLiteral<T, V> = T extends V ? true : never

/** recognize 必须恰好两个参数（audio, options）。 */
export const asrRecognizeParamCountAssertion: AssertIsLiteral<
  Parameters<AsrEngine['recognize']>['length'],
  2
> = true

/** 输入是 Int16Array，不是 Float32Array（P3-00C 合同；改回 Float32 = 改合同）。 */
export const asrAudioParamAssertion: AssertIsLiteral<
  Parameters<AsrEngine['recognize']>[0],
  Int16Array
> = true

/** localOnly 恒 true（审计裁定 3：全本地）。 */
export const asrLocalOnlyAssertion: AssertIsLiteral<AsrEngine['localOnly'], true> = true

/** 输入格式三个字面量不许放宽。 */
export const asrSampleRateAssertion: AssertIsLiteral<AsrAudioFormat['sampleRate'], 16000> = true
export const asrChannelsAssertion: AssertIsLiteral<AsrAudioFormat['channels'], 1> = true
export const asrSampleFormatAssertion: AssertIsLiteral<AsrAudioFormat['sampleFormat'], 's16le'> =
  true
