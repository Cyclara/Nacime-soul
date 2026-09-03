// src/main/voice/asr/offline-engine-core.ts
// P3V-08：离线 AsrEngine 的共用内核（状态机 + 合同检查 + 错误映射）。
//
// 由来：P3B 的 SenseVoice / FunASR 共用一个工厂（sherpa-provider 的
// createSherpaOfflineEngine），两者只差 modelKind 和模型目录。P3V 加入
// Parakeet TDT v2 后出现第三种差异——它是 encoder/decoder/joiner 三件套，
// 模型目录也从两文件变成四文件，塞不进原工厂的参数形状。
//
// 与其把状态机复制第二份（然后等着两份慢慢长歪），把「差异」提成两个回调：
//   loadFiles     ——怎么找到并校验模型文件（两文件 store / 多文件 store）
//   buildRecognizer——怎么用这些文件构造原生识别器（单 model / 三件套）
// 其余（状态机、输入合同、输出自检、错误码映射、progress 广播）只此一份。
//
// **实现的是冻结 ABI**（@shared/voice/asr-types 的 AsrEngine）：两参 recognize、
// localOnly 恒 true。流式引擎不走这里，走 streaming-provider。

import {
  ASR_AUDIO_FORMAT,
  isValidAsrAudioInput,
  isValidAsrTranscriptResult,
  type AsrEngine,
  type AsrModelState,
  type AsrTranscriptResult
} from '@shared/voice/asr-types'
import { AsrEngineError } from './engine-error'
import { int16ToFloat32 } from './pcm'
import type { SherpaRecognitionOutput, SherpaRecognizerLike } from './sherpa-binding'

/**
 * token 时间戳 -> 单 segment（整段话语）。tokens/timestamps 缺失或空时退化为
 * [0,0]。逐 token 细分对显示无增益（VAD 已给出话语边界）；F5-008 V2（Phase 5）
 * 再考虑逐字利用。
 */
export function toTranscriptResult(output: SherpaRecognitionOutput): AsrTranscriptResult {
  const text = output.text.trim()
  const timestamps = output.timestamps
  const tokens = output.tokens
  const hasTimestamps =
    timestamps !== undefined && timestamps.length > 0 && tokens !== undefined && tokens.length > 0
  if (!hasTimestamps) {
    return { text, segments: text.length > 0 ? [{ text, startMs: 0, endMs: 0 }] : [] }
  }
  const first = timestamps[0] ?? 0
  const last = timestamps[timestamps.length - 1] ?? 0
  const startMs = Math.max(0, Math.round(first * 1_000))
  const endMs = Math.max(startMs, Math.round(last * 1_000))
  return { text, segments: text.length > 0 ? [{ text, startMs, endMs }] : [] }
}

export interface OfflineEngineCoreDeps<TFiles> {
  readonly engineId: string
  /**
   * 同步探测模型文件；返回 null = 文件不在（model-missing，UI 引导下载）。
   * 与 validate 分成两步不是洁癖：文件根本不在时**不该**先进 'downloading'
   * 态、也不该发 progress(0)，否则 UI 会闪一下进度条再报「未下载」。
   */
  discoverFiles(): TFiles | null
  /** 校验（hash 是进度大头）；坏了抛 AsrEngineError('model-corrupt')。 */
  validateFiles(files: TFiles, onProgress: (ratio: number) => void): Promise<void>
  /** 用已校验的文件构造原生识别器；抛错由内核映射成 model-corrupt。 */
  buildRecognizer(files: TFiles): SherpaRecognizerLike
}

export function createOfflineEngineCore<TFiles>(deps: OfflineEngineCoreDeps<TFiles>): AsrEngine {
  const { engineId, discoverFiles, validateFiles, buildRecognizer } = deps

  let state: AsrModelState = 'not-downloaded'
  const progressListeners = new Set<(ratio: number) => void>()
  let recognizer: SherpaRecognizerLike | null = null
  let loadPromise: Promise<void> | null = null

  function reportProgress(ratio: number): void {
    for (const listener of progressListeners) listener(ratio)
  }

  function failLoad(err: unknown): AsrEngineError {
    state = 'error'
    if (err instanceof AsrEngineError) return err
    // 原生层抛出的未知错误（模型坏/不可读最常见）按 corrupt 归类：
    // discover 只查了存在性，内容坏要到构造才暴露。
    return new AsrEngineError(
      'model-corrupt',
      `sherpa init failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  return {
    id: engineId,
    localOnly: true,

    get state() {
      return state
    },

    async loadModel() {
      if (state === 'ready') return // 幂等
      if (loadPromise !== null) {
        await loadPromise
        return
      }
      const pending = (async () => {
        const files = discoverFiles()
        if (files === null) {
          state = 'not-downloaded'
          throw new AsrEngineError('model-missing', `${engineId} model files not found`)
        }
        state = 'downloading' // busy 态（校验 + 原生构造）合并报 downloading
        reportProgress(0)
        try {
          await validateFiles(files, reportProgress)
        } catch (err) {
          throw failLoad(err)
        }
        try {
          recognizer = buildRecognizer(files)
        } catch (err) {
          throw failLoad(err)
        }
        state = 'ready'
        reportProgress(1)
      })()
      loadPromise = pending
      try {
        await pending
      } finally {
        if (loadPromise === pending) loadPromise = null
      }
    },

    async recognize(audio, options) {
      if (!isValidAsrAudioInput(audio)) {
        throw new AsrEngineError('audio-invalid', 'audio violates asr input contract')
      }
      if (state !== 'ready' || recognizer === null) {
        throw new AsrEngineError('engine-busy', `recognize in state ${state}`)
      }
      // 语言提示是 advisory（共享 ABI 注明引擎可忽略）：SenseVoice 以 auto 构造、
      // 自动检测覆盖全部 AsrLanguageHint；Paraformer/Parakeet 是单语模型，提示同样
      // 忽略（识别质量由模型自身决定）。三条路都不按提示重建实例。
      void options
      let output: SherpaRecognitionOutput
      try {
        output = recognizer.recognize(int16ToFloat32(audio), ASR_AUDIO_FORMAT.sampleRate)
      } catch (err) {
        if (err instanceof AsrEngineError) throw err
        throw new AsrEngineError(
          'recognize-failed',
          `sherpa inference failed: ${err instanceof Error ? err.message : String(err)}`
        )
      }
      const result = toTranscriptResult(output)
      if (!isValidAsrTranscriptResult(result)) {
        throw new AsrEngineError('recognize-failed', 'transcript violates shared contract')
      }
      return result
    },

    onProgress(listener) {
      progressListeners.add(listener)
      return () => {
        progressListeners.delete(listener)
      }
    }
  }
}
