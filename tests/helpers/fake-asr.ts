// tests/helpers/fake-asr.ts
// P3-00C：假 ASR 引擎——脚本化识别结果，不加载 sherpa-onnx/funasr 真实模型。
//
// 用途：
//   - P3B-09 shared ASR ABI 的消费者测试（编排层/store/IPC）
//   - P3B-12 VAD 下游的识别触发测试
//
// 形状对齐 S-Phase3 文件清单的 shared ASR ABI（recognize(audio, options) + 模型状态 +
// 进度/错误 DTO）；真实 ABI 冻结（P3B-09）后如有出入，改本文件一处即可。

export type FakeAsrModelState = 'not-downloaded' | 'downloading' | 'ready' | 'error'

export interface FakeAsrSegment {
  text: string
  startMs: number
  endMs: number
}

export interface FakeAsrResult {
  text: string
  segments: FakeAsrSegment[]
}

export interface FakeAsrEngine {
  readonly state: FakeAsrModelState
  /** 加载模型：fake 立即成功（除非 failLoad），期间按 steps 发进度 0..1 */
  loadModel(opts?: { progressSteps?: number }): Promise<void>
  /** 按脚本返回识别结果；脚本耗尽后返回空文本 */
  recognize(audio: Int16Array, options?: { language?: string }): Promise<FakeAsrResult>
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
}

export function createFakeAsrEngine(script: FakeAsrScriptEntry[] = []): FakeAsrEngine {
  let state: FakeAsrModelState = 'not-downloaded'
  const queue = [...script]
  const pendingRecognizeFailures: Error[] = []
  let loadFailure: Error | null = null
  let recognizeCalls = 0
  const progressListeners = new Set<(ratio: number) => void>()

  return {
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
      void audio
      void options
      recognizeCalls++
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
