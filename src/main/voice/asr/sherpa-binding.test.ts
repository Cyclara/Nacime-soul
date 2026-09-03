// src/main/voice/asr/sherpa-binding.test.ts
// P3B-10：生产绑定的原生件冒烟（无模型文件；本测试跑在 ELECTRON_RUN_AS_NODE
// 运行时 = 「Node/Electron 同 ABI 免 rebuild」的直接证据）。
// 真模型识别归 P3B-14（测试录音）/P3B-20（E2E），S-004 不在单测里加载 160MB 模型；
// close 守卫分支由 provider 测试经假 binding 覆盖。

import { describe, expect, it, vi } from 'vitest'
import { createNodeSherpaBinding, type SherpaNodeAddonLike } from './sherpa-binding'

describe('P3V-06 createNodeSherpaBinding（假在线 addon）', () => {
  it('构造 OnlineRecognizer 时传入类式 API 配置、endpoint 规则与 bpe 字段', () => {
    let config: unknown
    const stream = {
      acceptWaveform: vi.fn(),
      inputFinished: vi.fn()
    }
    let readyCalls = 0
    const recognizer = {
      createStream: vi.fn(() => stream),
      isReady: vi.fn(() => readyCalls++ < 2),
      decode: vi.fn(),
      isEndpoint: vi.fn(() => true),
      reset: vi.fn(),
      getResult: vi.fn(() => ({ text: '  中 English  ' }))
    }
    class FakeOnlineRecognizer {
      constructor(input: unknown) {
        config = input
        return recognizer
      }
    }
    class FakeOfflineRecognizer {
      constructor() {
        throw new Error('not used')
      }
    }
    const addon = {
      OnlineRecognizer: FakeOnlineRecognizer,
      OfflineRecognizer: FakeOfflineRecognizer
    } as unknown as SherpaNodeAddonLike
    const binding = createNodeSherpaBinding(() => addon)
    const online = binding.createOnlineRecognizer({
      kind: 'transducer',
      encoderPath: '/m/encoder.onnx',
      decoderPath: '/m/decoder.onnx',
      joinerPath: '/m/joiner.onnx',
      tokensPath: '/m/tokens.txt',
      modelingUnit: 'cjkchar+bpe',
      bpeVocabPath: '/m/bpe.vocab',
      numThreads: 1
    })
    expect(config).toMatchObject({
      featConfig: { sampleRate: 16_000, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: '/m/encoder.onnx',
          decoder: '/m/decoder.onnx',
          joiner: '/m/joiner.onnx'
        },
        tokens: '/m/tokens.txt',
        modelingUnit: 'cjkchar+bpe',
        bpeVocab: '/m/bpe.vocab',
        provider: 'cpu',
        numThreads: 1
      },
      decodingMethod: 'greedy_search',
      enableEndpoint: 1,
      rule1MinTrailingSilence: 2.4,
      rule2MinTrailingSilence: 1.2,
      rule3MinUtteranceLength: 20
    })

    const onlineStream = online.createStream()
    const samples = new Float32Array([0.5])
    onlineStream.acceptWaveform(samples, 16_000)
    expect(stream.acceptWaveform).toHaveBeenCalledWith({ samples, sampleRate: 16_000 })
    expect(onlineStream.decodeAll()).toBe('中 English')
    expect(recognizer.decode).toHaveBeenCalledTimes(2)
    expect(onlineStream.isEndpoint()).toBe(true)
    onlineStream.reset()
    expect(recognizer.reset).toHaveBeenCalledWith(stream)
    onlineStream.inputFinished()
    expect(stream.inputFinished).toHaveBeenCalledTimes(1)
  })

  it('paraformer 配置不混入 transducer/joiner/bpe；close 后拒绝新 stream', () => {
    let config: unknown
    const stream = { acceptWaveform: vi.fn(), inputFinished: vi.fn() }
    const recognizer = {
      createStream: () => stream,
      isReady: () => false,
      decode: vi.fn(),
      isEndpoint: () => false,
      reset: vi.fn(),
      getResult: () => ({ text: '' })
    }
    class FakeOnlineRecognizer {
      constructor(input: unknown) {
        config = input
        return recognizer
      }
    }
    const addon = {
      OnlineRecognizer: FakeOnlineRecognizer,
      OfflineRecognizer: class {}
    } as unknown as SherpaNodeAddonLike
    const binding = createNodeSherpaBinding(() => addon)
    const online = binding.createOnlineRecognizer({
      kind: 'paraformer',
      encoderPath: '/m/encoder.onnx',
      decoderPath: '/m/decoder.onnx',
      tokensPath: '/m/tokens.txt',
      numThreads: 1
    })
    expect(config).toMatchObject({
      modelConfig: {
        paraformer: { encoder: '/m/encoder.onnx', decoder: '/m/decoder.onnx' }
      }
    })
    const modelConfig = (config as { modelConfig: Record<string, unknown> }).modelConfig
    expect(modelConfig).not.toHaveProperty('transducer')
    expect(modelConfig).not.toHaveProperty('bpeVocab')
    online.close()
    expect(() => online.createStream()).toThrow(/recognizer closed/)
  })
})

describe('P3B-10 createNodeSherpaBinding（真原生件）', () => {
  it('原生件可装载；sense-voice 坏模型路径抛错冒通（不吞）', () => {
    const binding = createNodeSherpaBinding()
    expect(() =>
      binding.createRecognizer({
        modelKind: 'sense-voice',
        modelPath: 'Z:/definitely/not/there/model.onnx',
        tokensPath: 'Z:/definitely/not/there/tokens.txt',
        language: '',
        numThreads: 1
      })
    ).toThrow()
  })

  it('paraformer 模型族同样走本地原生构造（坏路径抛错冒通）', () => {
    const binding = createNodeSherpaBinding()
    expect(() =>
      binding.createRecognizer({
        modelKind: 'paraformer',
        modelPath: 'Z:/definitely/not/there/model.onnx',
        tokensPath: 'Z:/definitely/not/there/tokens.txt',
        numThreads: 1
      })
    ).toThrow()
  })
})
