// src/main/voice/asr/sherpa-binding.ts
// P3B-10 / P3B-11：sherpa-onnx-node 的原生绑定边界（可注入，测试用假实现）。
//
// 生产实现经 createRequire 懒加载 sherpa-onnx-node（N-API 预编译件，Node/Electron
// 同 ABI 免 rebuild；已在 ELECTRON_RUN_AS_NODE 下验证可装载）。本文件把
// stream/decode/getResult 三步折叠成一次 recognize 调用--本项目对离线识别的
// 用法永远是「整段话语一次性识别」（VAD 已切好段），不需要流式喂入。
//
// 两种模型走同一原生运行时（P3B-11 决策）：SenseVoice（默认）与 FunASR
// Paraformer（备用）都由本地 sherpa-onnx 离线推理，**零网络**。
//
// 原生件无显式 release API（napi finalizer 托管 GC）：close() 只是丢弃引用；
// 每引擎恰一个 recognizer 实例、仅重载时替换，泄漏面可控。
//
// CPU-only（provider: 'cpu'）：ASR 不占 GPU，与 GPT-SoVITS（GPU）零冲突
// （主分析 §5.3 硬件约束）；provider 字段不开放注入，改 GPU = 改合同。

import { createRequire } from 'node:module'
import { AsrEngineError } from './engine-error'

/** 离线识别输出（原生 OfflineRecognizerResult 的本仓形状；可选字段容忍版本差异）。 */
export interface SherpaRecognitionOutput {
  readonly text: string
  /** 逐 token 秒级时间戳（F5-008 K1 已核验官方输出含此项；Node addon 形状待 3b 实测）。 */
  readonly timestamps?: readonly number[]
  readonly tokens?: readonly string[]
}

/** 支持的离线模型族：SenseVoice（P3B-10 默认）/ FunASR Paraformer（P3B-11 备用）。 */
export type SherpaOfflineModelKind = 'sense-voice' | 'paraformer'

export interface SherpaRecognizerLike {
  /** 整段识别：samples 为 [-1,1] Float32；sampleRate 恒 16000（ASR_AUDIO_FORMAT）。 */
  recognize(samples: Float32Array, sampleRate: number): SherpaRecognitionOutput
  /** 丢弃引用；幂等。 */
  close(): void
}

export interface SherpaOfflineBinding {
  /**
   * 构造 OfflineRecognizer（同步；离线模型加载在构造内完成）。
   * 模型文件坏/不可读时原生层抛错--由调用方映射错误码。
   */
  createRecognizer(input: {
    modelKind: SherpaOfflineModelKind
    modelPath: string
    tokensPath: string
    /** 仅 sense-voice 使用：'' = auto。paraformer 忽略（模型即中文）。 */
    language?: string
    numThreads: number
  }): SherpaRecognizerLike
}

// ── P3V-06/08：新增绑定（不改上面 P3B 的 SherpaOfflineBinding 签名）──
//
// 为什么分成三个接口而不是往 SherpaOfflineBinding 上加方法：加必需方法会让
// 现有三个测试假件同时失效，而 sherpa-provider / funasr-provider 根本不需要
// 新能力。生产绑定 createNodeSherpaBinding() 返回三者的交集类型，需要哪个能力
// 的模块就只依赖哪个接口。

/**
 * 离线 transducer（Parakeet TDT v2：encoder/decoder/joiner 三件套）。
 * SenseVoice/Paraformer 是单 model 文件，走上面的 createRecognizer；
 * transducer 是三个文件，塞不进那个签名，所以单开一个方法。
 */
export interface SherpaOfflineTransducerBinding {
  createTransducerRecognizer(input: {
    encoderPath: string
    decoderPath: string
    joinerPath: string
    tokensPath: string
    numThreads: number
  }): SherpaRecognizerLike
}

/**
 * 在线（流式）识别流。
 *
 * 设计取舍：把 sherpa 的 `while (isReady) decode()` + `getResult` 折叠成
 * `decodeAll()` 一次调用——调用方每次喂完音频都是这套固定动作，摊开在会话层
 * 只会让每个调用点都有机会漏掉循环。这与上面离线绑定把 stream/decode/getResult
 * 折叠成 recognize() 是同一手法。
 */
export interface SherpaOnlineStreamLike {
  /** 喂一段音频（Float32 [-1,1]，16kHz）。 */
  acceptWaveform(samples: Float32Array, sampleRate: number): void
  /** 解码到不能再解码为止，返回当前累计文本（可能是半成品）。 */
  decodeAll(): string
  /** 是否命中 endpoint（一句话说完的静音判定）。 */
  isEndpoint(): boolean
  /** 重置识别状态，准备下一句；不销毁流。 */
  reset(): void
  /** 告知输入结束（后续只能再 decodeAll 一次取尾巴）。 */
  inputFinished(): void
  /** 丢弃引用；幂等。 */
  close(): void
}

/**
 * 在线识别器：**加载一次、长期持有**（zipformer 双语的 encoder 有 330MB，
 * 每次说话都重建等于每次重读模型）。流才是每次监听会话新建的东西。
 */
export interface SherpaOnlineRecognizerLike {
  createStream(): SherpaOnlineStreamLike
  /** 丢弃引用；幂等。 */
  close(): void
}

export interface SherpaOnlineBinding {
  /**
   * 构造在线识别器（同步；模型加载在构造内完成）。
   * endpoint 三条规则用 sherpa 官方示例的实测值；不开放注入——改这些等于改
   * 「说到什么程度算一句话」的产品手感，应走设计变更而不是散落的调参。
   */
  createOnlineRecognizer(input: {
    /** transducer：三件套；paraformer：encoder+decoder（joinerPath 省略）。 */
    kind: 'transducer' | 'paraformer'
    encoderPath: string
    decoderPath: string
    joinerPath?: string
    tokensPath: string
    /** cjkchar / cjkchar+bpe；不给则用模型内置默认。 */
    modelingUnit?: string
    /** cjkchar+bpe 必需；缺它中英混说会切错词。 */
    bpeVocabPath?: string
    numThreads: number
  }): SherpaOnlineRecognizerLike
}

/** 生产绑定同时具备三种能力。 */
export type SherpaNodeBinding = SherpaOfflineBinding &
  SherpaOfflineTransducerBinding &
  SherpaOnlineBinding

/** endpoint 规则（sherpa-onnx 官方流式示例实测值，Orca 生产同款）。 */
const ONLINE_ENDPOINT_RULES = {
  enableEndpoint: 1,
  /** 说完后静音多久算一句结束（秒）。 */
  rule1MinTrailingSilence: 2.4,
  /** 已解出文本后，静音多久算一句结束（秒）——比 rule1 短，因为已经有内容了。 */
  rule2MinTrailingSilence: 1.2,
  /** 一句话最长多久强制切断（秒），防止一直不静音导致永不定稿。 */
  rule3MinUtteranceLength: 20
} as const

/** sherpa-onnx-node 的最小模块面；单测注入假类验证配置与调用顺序。 */
export interface SherpaNodeAddonLike {
  OfflineRecognizer: new (config: unknown) => {
    createStream(): { acceptWaveform(wave: { samples: Float32Array; sampleRate: number }): void }
    decode(stream: unknown): void
    getResult(stream: unknown): unknown
  }
  OnlineRecognizer: new (config: unknown) => {
    createStream(): {
      acceptWaveform(wave: { samples: Float32Array; sampleRate: number }): void
      inputFinished(): void
    }
    isReady(stream: unknown): boolean
    decode(stream: unknown): void
    isEndpoint(stream: unknown): boolean
    reset(stream: unknown): void
    getResult(stream: unknown): unknown
  }
}

/** 生产绑定：懒加载原生件；装载失败映射 engine-init-failed。 */
export function createNodeSherpaBinding(
  addonLoader: () => SherpaNodeAddonLike = loadSherpaAddon
): SherpaNodeBinding {
  return {
    createTransducerRecognizer(input) {
      const addon = addonLoader()
      const recognizer = new addon.OfflineRecognizer({
        featConfig: {},
        modelConfig: {
          transducer: {
            encoder: input.encoderPath,
            decoder: input.decoderPath,
            joiner: input.joinerPath
          },
          tokens: input.tokensPath,
          numThreads: input.numThreads,
          debug: 0,
          provider: 'cpu'
        }
      })
      let closed = false
      return {
        recognize(samples, sampleRate) {
          if (closed) throw new AsrEngineError('engine-init-failed', 'recognizer closed')
          const stream = recognizer.createStream()
          stream.acceptWaveform({ samples, sampleRate })
          recognizer.decode(stream)
          return recognizer.getResult(stream) as SherpaRecognitionOutput
        },
        close() {
          closed = true
        }
      }
    },

    createOnlineRecognizer(input) {
      const addon = addonLoader()
      const modelConfig =
        input.kind === 'transducer'
          ? {
              transducer: {
                encoder: input.encoderPath,
                decoder: input.decoderPath,
                joiner: input.joinerPath
              }
            }
          : { paraformer: { encoder: input.encoderPath, decoder: input.decoderPath } }
      const recognizer = new addon.OnlineRecognizer({
        featConfig: { sampleRate: 16_000, featureDim: 80 },
        modelConfig: {
          ...modelConfig,
          tokens: input.tokensPath,
          numThreads: input.numThreads,
          debug: 0,
          provider: 'cpu',
          ...(input.modelingUnit === undefined ? {} : { modelingUnit: input.modelingUnit }),
          ...(input.bpeVocabPath === undefined ? {} : { bpeVocab: input.bpeVocabPath })
        },
        decodingMethod: 'greedy_search',
        ...ONLINE_ENDPOINT_RULES
      })
      let recognizerClosed = false

      return {
        createStream(): SherpaOnlineStreamLike {
          if (recognizerClosed) {
            throw new AsrEngineError('engine-init-failed', 'online recognizer closed')
          }
          const stream = recognizer.createStream()
          let streamClosed = false

          function assertOpen(): void {
            if (streamClosed || recognizerClosed) {
              throw new AsrEngineError('engine-init-failed', 'online stream closed')
            }
          }

          return {
            acceptWaveform(samples, sampleRate) {
              assertOpen()
              stream.acceptWaveform({ samples, sampleRate })
            },
            decodeAll() {
              assertOpen()
              while (recognizer.isReady(stream)) recognizer.decode(stream)
              const result = recognizer.getResult(stream) as { text?: string }
              return (result.text ?? '').trim()
            },
            isEndpoint() {
              assertOpen()
              return recognizer.isEndpoint(stream)
            },
            reset() {
              assertOpen()
              recognizer.reset(stream)
            },
            inputFinished() {
              assertOpen()
              stream.inputFinished()
            },
            close() {
              // 丢弃引用即可：原生件无显式 release API，由 napi finalizer 托管
              streamClosed = true
            }
          }
        },
        close() {
          recognizerClosed = true
        }
      }
    },

    createRecognizer(input) {
      const addon = addonLoader()
      try {
        const recognizer = new addon.OfflineRecognizer({
          featConfig: {},
          modelConfig: {
            ...(input.modelKind === 'sense-voice'
              ? {
                  senseVoice: {
                    model: input.modelPath,
                    language: input.language ?? '',
                    useInverseTextNormalization: 1
                  }
                }
              : { paraformer: { model: input.modelPath } }),
            tokens: input.tokensPath,
            numThreads: input.numThreads,
            debug: 0,
            provider: 'cpu'
          }
        })
        let closed = false
        let handle: unknown = recognizer
        return {
          recognize(samples, sampleRate) {
            if (closed || handle === null) {
              throw new AsrEngineError('engine-init-failed', 'recognizer closed')
            }
            const stream = recognizer.createStream()
            stream.acceptWaveform({ samples, sampleRate })
            recognizer.decode(stream)
            return recognizer.getResult(stream) as SherpaRecognitionOutput
          },
          close() {
            closed = true
            handle = null
          }
        }
      } catch (err) {
        // 原生构造抛错（模型不可读/格式坏）：原样上抛文本供日志，code 由 provider 决定
        throw err instanceof Error ? err : new Error(String(err))
      }
    }
  }
}

/** require 缓存复用；失败给确定性错误码。 */
function loadSherpaAddon(): SherpaNodeAddonLike {
  const require = createRequire(import.meta.url)
  try {
    return require('sherpa-onnx-node') as SherpaNodeAddonLike
  } catch (err) {
    throw new AsrEngineError(
      'engine-init-failed',
      `sherpa-onnx-node load failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}
