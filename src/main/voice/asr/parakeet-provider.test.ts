// src/main/voice/asr/parakeet-provider.test.ts
// P3V-08：Parakeet TDT v2 适配冻结的离线 AsrEngine ABI。

import { describe, expect, it, vi } from 'vitest'
import { createParakeetEngine } from './parakeet-provider'
import type { AsrFileSetStore } from './model-store'
import type { SherpaOfflineTransducerBinding } from './sherpa-binding'
import type { AsrRuntimeSpec } from './download-catalog'

const RUNTIME = {
  kind: 'offline-transducer',
  encoderFile: 'encoder.int8.onnx',
  decoderFile: 'decoder.int8.onnx',
  joinerFile: 'joiner.int8.onnx',
  tokensFile: 'tokens.txt'
} satisfies Extract<AsrRuntimeSpec, { kind: 'offline-transducer' }>

function makeStore(missing = false): AsrFileSetStore {
  return {
    discover: () =>
      missing
        ? null
        : {
            'encoder.int8.onnx': '/m/encoder.int8.onnx',
            'decoder.int8.onnx': '/m/decoder.int8.onnx',
            'joiner.int8.onnx': '/m/joiner.int8.onnx',
            'tokens.txt': '/m/tokens.txt'
          },
    validate: async (_files, onProgress) => onProgress?.(1)
  }
}

describe('P3V-08 parakeet-provider', () => {
  it('构造三件套 recognizer 并沿用两参离线 recognize 合同', async () => {
    const createTransducerRecognizer = vi.fn(() => ({
      recognize: (samples: Float32Array, sampleRate: number) => ({
        text: `${sampleRate}:${samples[0]}`
      }),
      close: () => {}
    }))
    const binding: SherpaOfflineTransducerBinding = { createTransducerRecognizer }
    const engine = createParakeetEngine({ binding, modelStore: makeStore(), runtime: RUNTIME })
    expect(engine.id).toBe('parakeet-tdt-v2')
    expect(engine.localOnly).toBe(true)
    await engine.loadModel()
    expect(createTransducerRecognizer).toHaveBeenCalledWith({
      encoderPath: '/m/encoder.int8.onnx',
      decoderPath: '/m/decoder.int8.onnx',
      joinerPath: '/m/joiner.int8.onnx',
      tokensPath: '/m/tokens.txt',
      numThreads: 1
    })
    await expect(engine.recognize(new Int16Array([-32_768]))).resolves.toMatchObject({
      text: '16000:-1'
    })
    expect(engine.recognize.length).toBe(2)
  })

  it('缺模型映射 model-missing；runtime 文件配错映射 model-corrupt', async () => {
    const binding: SherpaOfflineTransducerBinding = {
      createTransducerRecognizer: () => ({ recognize: () => ({ text: '' }), close: () => {} })
    }
    const missing = createParakeetEngine({ binding, modelStore: makeStore(true), runtime: RUNTIME })
    await expect(missing.loadModel()).rejects.toMatchObject({ asrCode: 'model-missing' })

    const badRuntime = { ...RUNTIME, encoderFile: 'wrong.onnx' }
    const corrupt = createParakeetEngine({
      binding,
      modelStore: makeStore(),
      runtime: badRuntime
    })
    await expect(corrupt.loadModel()).rejects.toMatchObject({ asrCode: 'model-corrupt' })
  })
})
