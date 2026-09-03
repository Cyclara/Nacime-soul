// src/main/voice/asr/streaming-provider.test.ts
// P3V-07：流式引擎合同——模型加载、PCM 喂入、partial/final/reset 与资源释放。
// 全部使用假 binding/store，不加载真模型或原生 addon。

import { describe, expect, it, vi } from 'vitest'
import { createSherpaStreamingEngine } from './streaming-provider'
import type { AsrFileSetStore } from './model-store'
import type {
  SherpaOnlineBinding,
  SherpaOnlineRecognizerLike,
  SherpaOnlineStreamLike
} from './sherpa-binding'
import type { AsrRuntimeSpec } from './download-catalog'

const TRANS_RUNTIME = {
  kind: 'online-transducer',
  encoderFile: 'encoder.onnx',
  decoderFile: 'decoder.onnx',
  joinerFile: 'joiner.onnx',
  tokensFile: 'tokens.txt',
  modelingUnit: 'cjkchar+bpe',
  bpeVocabFile: 'bpe.vocab'
} satisfies Extract<AsrRuntimeSpec, { kind: 'online-transducer' }>

function makeStore(overrides?: { missing?: boolean; validateError?: Error }): AsrFileSetStore {
  const files = {
    'encoder.onnx': '/models/encoder.onnx',
    'decoder.onnx': '/models/decoder.onnx',
    'joiner.onnx': '/models/joiner.onnx',
    'tokens.txt': '/models/tokens.txt',
    'bpe.vocab': '/models/bpe.vocab'
  }
  return {
    discover: () => (overrides?.missing === true ? null : files),
    validate: async () => {
      if (overrides?.validateError !== undefined) throw overrides.validateError
    }
  }
}

function makeBinding(script?: { texts?: string[]; endpoints?: boolean[] }): {
  binding: SherpaOnlineBinding
  createRecognizer: ReturnType<typeof vi.fn>
  input: () => Record<string, unknown> | null
  accepted: Array<{ samples: Float32Array; sampleRate: number }>
  resets: () => number
  streamCloses: () => number
  recognizerCloses: () => number
  inputFinished: () => number
} {
  const texts = [...(script?.texts ?? ['你', '你好'])]
  const endpoints = [...(script?.endpoints ?? [false])]
  const accepted: Array<{ samples: Float32Array; sampleRate: number }> = []
  let captured: Record<string, unknown> | null = null
  let resets = 0
  let streamCloses = 0
  let recognizerCloses = 0
  let finished = 0

  const stream: SherpaOnlineStreamLike = {
    acceptWaveform(samples, sampleRate) {
      accepted.push({ samples, sampleRate })
    },
    decodeAll: () => texts.shift() ?? '',
    isEndpoint: () => endpoints.shift() ?? false,
    reset: () => {
      resets++
    },
    inputFinished: () => {
      finished++
    },
    close: () => {
      streamCloses++
    }
  }
  const recognizer: SherpaOnlineRecognizerLike = {
    createStream: () => stream,
    close: () => {
      recognizerCloses++
    }
  }
  const createRecognizer = vi.fn((input: Record<string, unknown>) => {
    captured = input
    return recognizer
  })
  return {
    binding: { createOnlineRecognizer: createRecognizer },
    createRecognizer,
    input: () => captured,
    accepted,
    resets: () => resets,
    streamCloses: () => streamCloses,
    recognizerCloses: () => recognizerCloses,
    inputFinished: () => finished
  }
}

describe('P3V-07 streaming-provider', () => {
  it('缺模型映射 model-missing；校验失败映射 model-corrupt', async () => {
    const missing = createSherpaStreamingEngine({
      binding: makeBinding().binding,
      modelStore: makeStore({ missing: true }),
      engineId: 'zipformer-bilingual-zh-en',
      runtime: TRANS_RUNTIME
    })
    await expect(missing.loadModel()).rejects.toMatchObject({ asrCode: 'model-missing' })
    expect(missing.state).toBe('not-downloaded')

    const corrupt = createSherpaStreamingEngine({
      binding: makeBinding().binding,
      modelStore: makeStore({ validateError: new Error('bad hash') }),
      engineId: 'zipformer-bilingual-zh-en',
      runtime: TRANS_RUNTIME
    })
    await expect(corrupt.loadModel()).rejects.toMatchObject({ asrCode: 'model-corrupt' })
    expect(corrupt.state).toBe('error')
  })

  it('并发 loadModel 共用同一校验与 recognizer 构造', async () => {
    let releaseValidation!: () => void
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve
    })
    const validate = vi.fn(async () => validationGate)
    const store: AsrFileSetStore = {
      discover: makeStore().discover,
      validate
    }
    const h = makeBinding()
    const engine = createSherpaStreamingEngine({
      binding: h.binding,
      modelStore: store,
      engineId: 'zipformer-bilingual-zh-en',
      runtime: TRANS_RUNTIME
    })
    const first = engine.loadModel()
    const second = engine.loadModel()
    releaseValidation()
    await Promise.all([first, second])
    expect(validate).toHaveBeenCalledTimes(1)
    expect(h.createRecognizer).toHaveBeenCalledTimes(1)
  })

  it('loadModel 只建一次 recognizer，并传齐 transducer/bpe 配置', async () => {
    const h = makeBinding()
    const engine = createSherpaStreamingEngine({
      binding: h.binding,
      modelStore: makeStore(),
      engineId: 'zipformer-bilingual-zh-en',
      runtime: TRANS_RUNTIME
    })
    await engine.loadModel()
    await engine.loadModel()
    expect(h.createRecognizer).toHaveBeenCalledTimes(1)
    expect(h.input()).toMatchObject({
      kind: 'transducer',
      encoderPath: '/models/encoder.onnx',
      decoderPath: '/models/decoder.onnx',
      joinerPath: '/models/joiner.onnx',
      tokensPath: '/models/tokens.txt',
      modelingUnit: 'cjkchar+bpe',
      bpeVocabPath: '/models/bpe.vocab',
      numThreads: 1
    })
    expect(engine.state).toBe('ready')
  })

  it('feed 使用 /32768 PCM；partial 去重；VAD 定稿后 reset', async () => {
    const h = makeBinding({ texts: ['你', '你', '你好'] })
    const engine = createSherpaStreamingEngine({
      binding: h.binding,
      modelStore: makeStore(),
      engineId: 'zipformer-bilingual-zh-en',
      runtime: TRANS_RUNTIME
    })
    await engine.loadModel()
    const session = engine.startStream()
    session.feed(new Int16Array([-32_768, 0, 32_767]))
    expect([...h.accepted[0]!.samples]).toEqual([-1, 0, 32_767 / 32_768])
    expect(h.accepted[0]!.sampleRate).toBe(16_000)
    expect(session.partial()).toEqual({ text: '你' })
    expect(session.partial()).toBeNull()
    session.feed(new Int16Array([1]))
    expect(session.partial()).toBeNull() // 原生结果没变
    session.feed(new Int16Array([1]))
    expect(session.takeFinalNow()).toEqual({ text: '你好' })
    expect(h.resets()).toBe(1)
    expect(session.partial()).toBeNull()
  })

  it('endpoint 命中定稿并 reset；finish 冲刷尾巴且只执行一次', async () => {
    const h = makeBinding({ texts: ['第一段', '尾巴'], endpoints: [true] })
    const engine = createSherpaStreamingEngine({
      binding: h.binding,
      modelStore: makeStore(),
      engineId: 'zipformer-bilingual-zh-en',
      runtime: TRANS_RUNTIME
    })
    await engine.loadModel()
    const session = engine.startStream()
    session.feed(new Int16Array([1]))
    expect(session.takeFinalAtEndpoint()).toEqual({ text: '第一段' })
    expect(h.resets()).toBe(1)
    expect(session.finish()).toEqual({ text: '尾巴' })
    expect(session.finish()).toBeNull()
    expect(h.inputFinished()).toBe(1)
    expect(() => session.feed(new Int16Array([1]))).toThrow(/feed after finish/)
  })

  it('校验未完成时 dispose，load 不得在之后复活 recognizer', async () => {
    let releaseValidation!: () => void
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve
    })
    const store: AsrFileSetStore = {
      discover: makeStore().discover,
      validate: async () => validationGate
    }
    const h = makeBinding()
    const engine = createSherpaStreamingEngine({
      binding: h.binding,
      modelStore: store,
      engineId: 'zipformer-bilingual-zh-en',
      runtime: TRANS_RUNTIME
    })
    const loading = engine.loadModel()
    engine.dispose()
    releaseValidation()
    await expect(loading).rejects.toMatchObject({ asrCode: 'engine-init-failed' })
    expect(h.createRecognizer).not.toHaveBeenCalled()
    expect(engine.state).toBe('not-downloaded')
  })

  it('engine.dispose 关闭所有活跃 stream 与 recognizer，且幂等', async () => {
    const h = makeBinding()
    const engine = createSherpaStreamingEngine({
      binding: h.binding,
      modelStore: makeStore(),
      engineId: 'zipformer-bilingual-zh-en',
      runtime: TRANS_RUNTIME
    })
    await engine.loadModel()
    const first = engine.startStream()
    const second = engine.startStream()
    first.dispose()
    engine.dispose()
    engine.dispose()
    expect(h.streamCloses()).toBe(2)
    expect(h.recognizerCloses()).toBe(1)
    expect(() => second.partial()).toThrow(/disposed/)
    expect(() => engine.startStream()).toThrow(/engine disposed/)
    await expect(engine.loadModel()).rejects.toMatchObject({ asrCode: 'engine-init-failed' })
  })

  it('非法音频拒绝且不会送入原生层', async () => {
    const h = makeBinding()
    const engine = createSherpaStreamingEngine({
      binding: h.binding,
      modelStore: makeStore(),
      engineId: 'zipformer-bilingual-zh-en',
      runtime: TRANS_RUNTIME
    })
    await engine.loadModel()
    const session = engine.startStream()
    expect(() => session.feed(new Int16Array(0))).toThrow(/audio violates/)
    expect(h.accepted).toHaveLength(0)
  })
})
