// src/main/voice/vad/silero-binding.ts
// P3B-12：Silero VAD 的原生绑定边界（可注入，测试用假实现）。
//
// 生产实现经 createRequire 懒加载 sherpa-onnx-node 的 `Vad` 类（与 OfflineRecognizer
// 同一 N-API 预编译件，Node/Electron 同 ABI 免 rebuild，P3B-10 已验证装载）。
//
// 用法边界（重要）：原生 Vad 自带一整套分段状态机（threshold/min_silence/
// min_speech + 内部队列）。本项目**只用它做逐窗分类器**——acceptWaveform 后读
// isDetected() 作为当窗语音概率（0/1），话语分段由我们自己的三态机（vad.ts）
// 负责。因此：
//   - 原生 sileroVad.threshold 与 VAD_PROB_THRESHOLD 同值（0.4）只是让原生
//     内部语义不漂移；真正的判定门槛在我们侧。
//   - minSilenceDuration/minSpeechDuration 置 0：原生分段被整体弃用。
//   - **原生分段队列必须排空**（processor 在每帧后 while(!isEmpty()) pop()）：
//     段一旦入队不 pop 会无限累积（内存增长风险，验收红线）。
//
// 原生件无显式 release API（napi finalizer 托管 GC）：close() 只是丢弃引用，
// 与 sherpa-binding 同纪律。provider 固定 'cpu'（ASR/VAD 不占 GPU，主分析 §5.3）。
//
// 构造失败的两种形态（P3B-12 实测，Windows + sherpa-onnx-node 1.13.6）：
//   - 模型路径缺失：原生**不抛错**，返回 nullptr External，方法全为 no-op
//     （isDetected 恒 false、isEmpty 恒 true，错误只打 stderr）→ 本绑定用
//     构造前 statSync 预检兜住，抛确定性错误；
//   - 模型文件损坏（存在但非合法 onnx）：原生构造**直接崩溃进程**（不可
//     catch）。残余风险由上游消除：下载器（P3B-14）落盘前 sha256 校验，
//     model-store validate 同款分级校验；手工放置的文件信任用户。
//
// 模型文件：silero_vad.onnx（~2MB，v4，512 样本窗）由下载器（P3B-14）落到
// {root}/vad/；本模块只收路径。

import { createRequire } from 'node:module'
import { statSync } from 'node:fs'
import { VAD_PROB_THRESHOLD, VAD_WINDOW_SAMPLES } from './vad'

/** 原生 Vad 实例的最小合同（生产 = sherpa-onnx-node Vad；测试用假实现）。 */
export interface SileroVadRecognizer {
  /** 喂原始波形（[-1,1] Float32）。内部按窗口缓冲，可接受任意长度。 */
  acceptWaveform(samples: Float32Array): void
  /** 当窗（最近吃满的一个 window）是否语音——本项目唯一的分类信号。 */
  isDetected(): boolean
  /** 内部分段队列是否非空。 */
  isEmpty(): boolean
  /** 丢弃队首分段（防队列无限累积）。 */
  pop(): void
  /** 复位内部状态。 */
  reset(): void
  /** 丢弃引用（幂等；原生资源由 GC finalizer 托管）。 */
  close(): void
}

export interface SileroVadBinding {
  /**
   * 构造原生 Vad（同步；模型加载在构造内完成）。模型文件坏/不可读时原生层
   * 抛错，由调用方决定错误呈现。
   */
  createVad(input: {
    readonly modelPath: string
    /** 原生侧 Silero 概率门，默认 VAD_PROB_THRESHOLD。 */
    readonly threshold?: number
  }): SileroVadRecognizer
}

/** 原生侧内部音频缓冲秒数：只需容纳被弃用的分段，60s 绰绰有余。 */
const VAD_NATIVE_BUFFER_SECONDS = 60

export function createNodeSileroVadBinding(): SileroVadBinding {
  return {
    createVad(input) {
      // 预检：路径缺失时原生静默返回空 handle（见头注释），必须在此拦截
      let info
      try {
        info = statSync(input.modelPath)
      } catch {
        throw new Error(`silero vad model not found: ${input.modelPath}`)
      }
      if (!info.isFile() || info.size <= 0) {
        throw new Error(`silero vad model empty or not a file: ${input.modelPath}`)
      }
      const addon = loadSherpaAddon()
      const vad = new addon.Vad(
        {
          sileroVad: {
            model: input.modelPath,
            threshold: input.threshold ?? VAD_PROB_THRESHOLD,
            minSilenceDuration: 0,
            minSpeechDuration: 0,
            windowSize: VAD_WINDOW_SAMPLES
          },
          sampleRate: 16_000,
          numThreads: 1,
          provider: 'cpu',
          debug: 0
        },
        VAD_NATIVE_BUFFER_SECONDS
      )
      let closed = false
      let handle: unknown = vad
      const ensureOpen = (): void => {
        if (closed || handle === null) {
          throw new Error('silero vad closed')
        }
      }
      return {
        acceptWaveform(samples) {
          ensureOpen()
          vad.acceptWaveform(samples)
        },
        isDetected() {
          ensureOpen()
          return vad.isDetected()
        },
        isEmpty() {
          ensureOpen()
          return vad.isEmpty()
        },
        pop() {
          ensureOpen()
          vad.pop()
        },
        reset() {
          ensureOpen()
          vad.reset()
        },
        close() {
          closed = true
          handle = null
        }
      }
    }
  }
}

/** require 缓存复用；失败给确定性错误。 */
function loadSherpaAddon(): {
  Vad: new (
    config: unknown,
    bufferSizeInSeconds: number
  ) => {
    acceptWaveform(samples: Float32Array): void
    isDetected(): boolean
    isEmpty(): boolean
    pop(): void
    reset(): void
  }
} {
  const require = createRequire(import.meta.url)
  try {
    return require('sherpa-onnx-node') as ReturnType<typeof loadSherpaAddon>
  } catch (err) {
    throw new Error(
      `sherpa-onnx-node load failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}
