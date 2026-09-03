// src/main/voice/asr/streaming-provider.ts
// P3V-07：流式识别引擎（实现 @shared/voice/asr-stream-types 的新增 ABI）。
//
// 与离线 sherpa-provider 的关系：**并列，不继承**。两者共享模型发现/校验
// （AsrFileSetStore）、PCM 归一（pcm.ts）与错误码枚举，但状态机不同——
// 离线是「整段进、一次出」，流式是「帧进、随时能读半成品、endpoint 才定稿」。
//
// 生命周期分层（对应真实开销）：
//   引擎（loadModel）  → 持有原生 OnlineRecognizer，模型只读一次
//   会话（startStream）→ 持有原生 OnlineStream，一次「按住说话」一个
//   一句话             → endpoint 命中后 reset，同一个 stream 继续下一句
//
// 全本地：本模块无任何网络调用（审计裁定 3）。
// 单元测试注入假 binding + 假 store，不加载真模型、不碰麦克风。

import {
  ASR_AUDIO_FORMAT,
  isValidAsrAudioInput,
  type AsrModelState,
  type AsrRecognizeOptions
} from '@shared/voice/asr-types'
import {
  isValidAsrStreamText,
  type AsrStreamFinal,
  type AsrStreamPartial,
  type AsrStreamSession,
  type AsrStreamingEngine
} from '@shared/voice/asr-stream-types'
import type { StreamingAsrEngineId } from '@shared/voice/asr-settings-types'
import { AsrEngineError } from './engine-error'
import { int16ToFloat32 } from './pcm'
import type { AsrFileSetStore } from './model-store'
import type {
  SherpaOnlineBinding,
  SherpaOnlineRecognizerLike,
  SherpaOnlineStreamLike
} from './sherpa-binding'
import type { AsrRuntimeSpec } from './download-catalog'

/** CPU-only 单线程：与 GPT-SoVITS（GPU）零冲突，口径同离线引擎。 */
const STREAMING_NUM_THREADS = 1

/** 只有这两种 runtime 能走流式；其余是调用方配错了表。 */
type OnlineRuntimeSpec = Extract<
  AsrRuntimeSpec,
  { kind: 'online-transducer' } | { kind: 'online-paraformer' }
>

export interface StreamingEngineDeps {
  readonly binding: SherpaOnlineBinding
  readonly modelStore: AsrFileSetStore
  readonly engineId: StreamingAsrEngineId
  readonly runtime: OnlineRuntimeSpec
}

function createSession(engineId: string, stream: SherpaOnlineStreamLike): AsrStreamSession {
  /** 上次交给调用方的文本：用于 partial() 的「没变化就返回 null」去重。 */
  let lastReportedPartial = ''
  /** 最近一次 decodeAll 的结果，takeFinalAtEndpoint / finish 从这里取定稿。 */
  let currentText = ''
  let disposed = false
  let inputEnded = false

  function assertUsable(): void {
    if (disposed) {
      throw new AsrEngineError('engine-busy', 'stream session disposed')
    }
  }

  /**
   * 定稿并重置。**无论有没有文本都要 reset**：识别器停在「已结束」状态却不重置，
   * 后面的话就再也解不出来了——这条是流式识别最容易踩的哑火。
   */
  function commitAndReset(): AsrStreamFinal | null {
    const text = currentText
    try {
      stream.reset()
    } catch (err) {
      throw new AsrEngineError(
        'recognize-failed',
        `stream reset failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    currentText = ''
    lastReportedPartial = ''
    return text.length > 0 ? { text } : null
  }

  return {
    engineId,
    localOnly: true,

    feed(audio) {
      assertUsable()
      if (inputEnded) {
        // finish() 之后再喂音频是调用方的状态机错误，不是可恢复的输入问题
        throw new AsrEngineError('engine-busy', 'feed after finish')
      }
      if (!isValidAsrAudioInput(audio)) {
        throw new AsrEngineError('audio-invalid', 'audio violates asr input contract')
      }
      try {
        stream.acceptWaveform(int16ToFloat32(audio), ASR_AUDIO_FORMAT.sampleRate)
        currentText = stream.decodeAll()
      } catch (err) {
        if (err instanceof AsrEngineError) throw err
        throw new AsrEngineError(
          'recognize-failed',
          `streaming decode failed: ${err instanceof Error ? err.message : String(err)}`
        )
      }
      if (!isValidAsrStreamText(currentText)) {
        // 原生层给出超界文本 = 结果不可信，丢弃而不是把它塞进 UI
        currentText = ''
        throw new AsrEngineError('recognize-failed', 'streaming text violates shared contract')
      }
    },

    partial(): AsrStreamPartial | null {
      assertUsable()
      if (currentText.length === 0 || currentText === lastReportedPartial) return null
      lastReportedPartial = currentText
      return { text: currentText }
    },

    takeFinalAtEndpoint(): AsrStreamFinal | null {
      assertUsable()
      let atEndpoint: boolean
      try {
        atEndpoint = stream.isEndpoint()
      } catch (err) {
        throw new AsrEngineError(
          'recognize-failed',
          `endpoint check failed: ${err instanceof Error ? err.message : String(err)}`
        )
      }
      if (!atEndpoint) return null
      return commitAndReset()
    },

    takeFinalNow(): AsrStreamFinal | null {
      assertUsable()
      return commitAndReset()
    },

    finish(): AsrStreamFinal | null {
      assertUsable()
      if (inputEnded) return null
      inputEnded = true
      try {
        stream.inputFinished()
        currentText = stream.decodeAll()
      } catch (err) {
        throw new AsrEngineError(
          'recognize-failed',
          `streaming flush failed: ${err instanceof Error ? err.message : String(err)}`
        )
      }
      const text = isValidAsrStreamText(currentText) ? currentText : ''
      currentText = ''
      lastReportedPartial = ''
      return text.length > 0 ? { text } : null
    },

    dispose() {
      if (disposed) return // 幂等
      disposed = true
      try {
        stream.close()
      } catch {
        // 关闭失败不该冒泡：调用点通常在 finally / 会话结束路径上
      }
    }
  }
}

export function createSherpaStreamingEngine(deps: StreamingEngineDeps): AsrStreamingEngine {
  const { binding, modelStore, engineId, runtime } = deps

  let state: AsrModelState = 'not-downloaded'
  let recognizer: SherpaOnlineRecognizerLike | null = null
  let disposed = false
  let loadPromise: Promise<void> | null = null
  const sessions = new Set<AsrStreamSession>()

  function buildRecognizer(files: Readonly<Record<string, string>>): SherpaOnlineRecognizerLike {
    function pathOf(name: string): string {
      const path = files[name]
      if (path === undefined) {
        throw new AsrEngineError('model-corrupt', `missing model file: ${name}`)
      }
      return path
    }
    if (runtime.kind === 'online-paraformer') {
      return binding.createOnlineRecognizer({
        kind: 'paraformer',
        encoderPath: pathOf(runtime.encoderFile),
        decoderPath: pathOf(runtime.decoderFile),
        tokensPath: pathOf(runtime.tokensFile),
        numThreads: STREAMING_NUM_THREADS
      })
    }
    return binding.createOnlineRecognizer({
      kind: 'transducer',
      encoderPath: pathOf(runtime.encoderFile),
      decoderPath: pathOf(runtime.decoderFile),
      joinerPath: pathOf(runtime.joinerFile),
      tokensPath: pathOf(runtime.tokensFile),
      ...(runtime.modelingUnit === undefined ? {} : { modelingUnit: runtime.modelingUnit }),
      ...(runtime.bpeVocabFile === undefined ? {} : { bpeVocabPath: pathOf(runtime.bpeVocabFile) }),
      numThreads: STREAMING_NUM_THREADS
    })
  }

  return {
    id: engineId,
    localOnly: true,
    streaming: true,

    get state() {
      return state
    },

    async loadModel() {
      if (disposed) throw new AsrEngineError('engine-init-failed', 'streaming engine disposed')
      if (state === 'ready') return // 幂等
      if (loadPromise !== null) {
        await loadPromise
        return
      }
      const pending = (async () => {
        const files = modelStore.discover()
        if (files === null) {
          state = 'not-downloaded'
          throw new AsrEngineError('model-missing', `${engineId} model files not found`)
        }
        state = 'downloading' // busy 态合并报 downloading（与离线引擎同口径）
        try {
          await modelStore.validate(files)
        } catch (err) {
          if (disposed) {
            state = 'not-downloaded'
            throw new AsrEngineError(
              'engine-init-failed',
              'streaming engine disposed while loading'
            )
          }
          state = 'error'
          throw err instanceof AsrEngineError
            ? err
            : new AsrEngineError('model-corrupt', 'model validation failed')
        }
        if (disposed) {
          state = 'not-downloaded'
          throw new AsrEngineError('engine-init-failed', 'streaming engine disposed while loading')
        }
        try {
          const nextRecognizer = buildRecognizer(files)
          // buildRecognizer 是同步原生构造，JS 不会在其中并发执行 dispose；赋值前仍
          // 做一次守卫，防未来 binding 改为可重入实现时把已关闭引擎重新置 ready。
          if (disposed) {
            nextRecognizer.close()
            state = 'not-downloaded'
            throw new AsrEngineError(
              'engine-init-failed',
              'streaming engine disposed while loading'
            )
          }
          recognizer = nextRecognizer
        } catch (err) {
          if (disposed) {
            state = 'not-downloaded'
            throw err instanceof AsrEngineError
              ? err
              : new AsrEngineError('engine-init-failed', 'streaming engine disposed while loading')
          }
          state = 'error'
          if (err instanceof AsrEngineError) throw err
          // discover 只查存在性，模型内容坏要到原生构造才暴露
          throw new AsrEngineError(
            'model-corrupt',
            `online recognizer init failed: ${err instanceof Error ? err.message : String(err)}`
          )
        }
        state = 'ready'
      })()
      loadPromise = pending
      try {
        await pending
      } finally {
        if (loadPromise === pending) loadPromise = null
      }
    },

    startStream(options?: AsrRecognizeOptions) {
      // 语言提示对这三个模型无效：它们的语言由权重本身决定（双语/纯中文），
      // 没有运行期切换开关。共享 ABI 已注明引擎可忽略提示。
      void options
      if (disposed) throw new AsrEngineError('engine-init-failed', 'streaming engine disposed')
      if (state !== 'ready' || recognizer === null) {
        // 不在这里隐式 await loadModel：startStream 的调用点在音频帧路径上，
        // 塞长任务会让第一帧卡住整条监听链
        throw new AsrEngineError(
          state === 'not-downloaded' ? 'model-missing' : 'engine-busy',
          `startStream in state ${state}`
        )
      }
      const inner = createSession(engineId, recognizer.createStream())
      let sessionDisposed = false
      const tracked: AsrStreamSession = {
        ...inner,
        dispose() {
          if (sessionDisposed) return
          sessionDisposed = true
          sessions.delete(tracked)
          inner.dispose()
        }
      }
      sessions.add(tracked)
      return tracked
    },

    dispose() {
      if (disposed) return
      disposed = true
      for (const session of [...sessions]) session.dispose()
      sessions.clear()
      recognizer?.close()
      recognizer = null
      state = 'not-downloaded'
    }
  }
}
