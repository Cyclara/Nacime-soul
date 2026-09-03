// tests/helpers/fake-asr.ts
// P3-00C：假 ASR 引擎--脚本化识别结果，不加载 sherpa-onnx/funasr 真实模型。
//
// 用途：
//   - P3B-09 shared ASR ABI 的消费者测试（编排层/store/IPC）
//   - P3B-12 VAD 下游的识别触发测试
//
// 形状对齐 src/shared/voice/asr-types.ts 的冻结 ABI（P3B-09 已冻结并同步本文件）：
// recognize(audio: Int16Array, options?) -> AsrTranscriptResult；localOnly 恒 true。

import type {
  AsrLanguageHint,
  AsrModelState,
  AsrRecognizeOptions,
  AsrTranscriptResult,
  AsrTranscriptSegment
} from '@shared/voice/asr-types'

export type FakeAsrModelState = AsrModelState
export type FakeAsrSegment = AsrTranscriptSegment
export type FakeAsrResult = AsrTranscriptResult

export interface FakeAsrEngine {
  readonly id: string
  /** 与冻结 ABI 对齐：全本地声明（审计裁定 3）。 */
  readonly localOnly: true
  readonly state: FakeAsrModelState
  /** 加载模型：fake 立即成功（除非 failLoad），期间按 steps 发进度 0..1 */
  loadModel(opts?: { progressSteps?: number }): Promise<void>
  /** 按脚本返回识别结果；脚本耗尽后返回空文本 */
  recognize(audio: Int16Array, options?: AsrRecognizeOptions): Promise<FakeAsrResult>
  /** 让下一次 recognize 以此 error Reject */
  failNextRecognize(error?: Error): void
  /** 让 loadModel 以 error Reject 并落 error 态 */
  failLoad(error?: Error): void
  onProgress(listener: (ratio: number) => void): () => void
  readonly recognizeCalls: number
}

export interface FakeAsrScriptEntry {
  text: string
  segments?: FakeAsrSegment[]
  language?: AsrLanguageHint
}

/** 测试可断言最后一次识别收到的 options（语言提示透传）。 */
export interface FakeAsrObservations {
  lastAudioSamples: number | null
  lastLanguage: AsrLanguageHint | undefined
}

export function createFakeAsrEngine(
  script: FakeAsrScriptEntry[] = []
): FakeAsrEngine & { observations: FakeAsrObservations } {
  let state: FakeAsrModelState = 'not-downloaded'
  const queue = [...script]
  const pendingRecognizeFailures: Error[] = []
  let loadFailure: Error | null = null
  let recognizeCalls = 0
  const progressListeners = new Set<(ratio: number) => void>()
  const observations: FakeAsrObservations = { lastAudioSamples: null, lastLanguage: undefined }

  return {
    id: 'fake-asr',
    localOnly: true,
    observations,

    get state() {
      return state
    },

    async loadModel(opts) {
      if (state === 'ready') return
      state = 'downloading'
      const steps = Math.max(0, opts?.progressSteps ?? 0)
      for (let i = 1; i <= steps; i++) {
        for (const listener of progressListeners) listener(i / steps)
      }
      if (loadFailure) {
        state = 'error'
        throw loadFailure
      }
      state = 'ready'
    },

    async recognize(audio, options) {
      recognizeCalls++
      observations.lastAudioSamples = audio.length
      observations.lastLanguage = options?.language
      if (state !== 'ready') {
        throw new Error(`fake asr: recognize in state ${state}`)
      }
      const failure = pendingRecognizeFailures.shift()
      if (failure) throw failure
      const entry = queue.shift()
      if (!entry) return { text: '', segments: [] }
      return {
        text: entry.text,
        segments: entry.segments ?? [{ text: entry.text, startMs: 0, endMs: 0 }]
      }
    },

    failNextRecognize(error) {
      pendingRecognizeFailures.push(error ?? new Error('fake asr recognize failure'))
    },

    failLoad(error) {
      loadFailure = error ?? new Error('fake asr load failure')
    },

    onProgress(listener) {
      progressListeners.add(listener)
      return () => {
        progressListeners.delete(listener)
      }
    },

    get recognizeCalls() {
      return recognizeCalls
    }
  }
}
