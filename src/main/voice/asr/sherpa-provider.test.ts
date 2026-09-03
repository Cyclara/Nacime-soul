// src/main/voice/asr/sherpa-provider.test.ts
// P3B-10：Sherpa SenseVoice adapter 的 AsrEngine 合同（假 binding + 假 store，
// 不加载真模型；S-004 静音 buffer mock）。

import { describe, expect, it } from 'vitest'
import type { AsrEngine, AsrTranscriptResult } from '@shared/voice/asr-types'
import { makeSilentPcm16, makeSinePcm16 } from '../../../../tests/helpers/silent-pcm'
import { AsrEngineError } from './engine-error'
import type { AsrModelFiles, AsrModelStore } from './model-store'
import { createSherpaSenseVoiceEngine, SHERPA_SENSEVOICE_ENGINE_ID } from './sherpa-provider'
import type {
  SherpaOfflineBinding,
  SherpaRecognitionOutput,
  SherpaRecognizerLike
} from './sherpa-binding'

const FIXED_FILES: AsrModelFiles = {
  modelPath: 'C:/data/models/asr/sense-voice/model.onnx',
  tokensPath: 'C:/data/models/asr/sense-voice/tokens.txt'
}

interface FakeBinding {
  binding: SherpaOfflineBinding
  created: Array<{
    modelKind: string
    modelPath: string
    tokensPath: string
    language?: string
    numThreads: number
  }>
  setConstructError(err: Error | null): void
  outputs: SherpaRecognitionOutput[]
  recognizeErrors: Error[]
  captured: Array<{ samples: Float32Array; sampleRate: number }>
}

function makeFakeBinding(): FakeBinding {
  const created: FakeBinding['created'] = []
  const outputs: SherpaRecognitionOutput[] = []
  const recognizeErrors: Error[] = []
  const captured: FakeBinding['captured'] = []
  let constructError: Error | null = null

  const binding: SherpaOfflineBinding = {
    createRecognizer(input) {
      created.push(input)
      if (constructError !== null) throw constructError
      const recognizer: SherpaRecognizerLike = {
        recognize(samples, sampleRate) {
          captured.push({ samples, sampleRate })
          const failure = recognizeErrors.shift()
          if (failure !== undefined) throw failure
          return outputs.shift() ?? { text: '' }
        },
        close() {
          /* noop */
        }
      }
      return recognizer
    }
  }
  return {
    binding,
    created,
    setConstructError(err) {
      constructError = err
    },
    outputs,
    recognizeErrors,
    captured
  }
}

interface FakeStore {
  store: AsrModelStore
  setFiles(files: AsrModelFiles | null): void
  setValidateError(err: Error | null): void
  validateCalls: number
}

function makeFakeStore(): FakeStore {
  let files: AsrModelFiles | null = FIXED_FILES
  let validateError: Error | null = null
  let validateCalls = 0
  const store: AsrModelStore = {
    discover: () => files,
    validate: async (_files, onProgress) => {
      validateCalls++
      if (validateError !== null) throw validateError
      onProgress?.(0.5)
    }
  }
  return {
    store,
    setFiles(next) {
      files = next
    },
    setValidateError(err) {
      validateError = err
    },
    get validateCalls() {
      return validateCalls
    }
  }
}

function makeEngine(): {
  engine: AsrEngine
  binding: FakeBinding
  modelStore: FakeStore
  progress: number[]
} {
  const binding = makeFakeBinding()
  const modelStore = makeFakeStore()
  const progress: number[] = []
  const engine = createSherpaSenseVoiceEngine({
    binding: binding.binding,
    modelStore: modelStore.store
  })
  const off = engine.onProgress((r) => progress.push(r))
  void off
  return { engine, binding, modelStore, progress }
}

const flush = (ticks = 2): Promise<void> =>
  new Promise((resolve) => {
    void (async () => {
      for (let i = 0; i < ticks; i++) await Promise.resolve()
      resolve()
    })()
  })

describe('P3B-10 状态机与加载', () => {
  it('模型缺失 -> model-missing，state 停在 not-downloaded', async () => {
    const h = makeEngine()
    h.modelStore.setFiles(null)
    await expect(h.engine.loadModel()).rejects.toMatchObject({ asrCode: 'model-missing' })
    expect(h.engine.state).toBe('not-downloaded')
    expect(h.binding.created).toHaveLength(0)
  })

  it('加载成功：downloading -> ready；binding 收到路径/语言/线程；进度 0..1', async () => {
    const h = makeEngine()
    await h.engine.loadModel()
    await flush()
    expect(h.engine.state).toBe('ready')
    expect(h.binding.created).toHaveLength(1)
    expect(h.binding.created[0]).toEqual({
      modelKind: 'sense-voice',
      modelPath: FIXED_FILES.modelPath,
      tokensPath: FIXED_FILES.tokensPath,
      language: '',
      numThreads: 1
    })
    expect(h.progress[0]).toBe(0)
    expect(h.progress[h.progress.length - 1]).toBe(1)
  })

  it('校验失败 -> model-corrupt + state error；再试可恢复', async () => {
    const h = makeEngine()
    h.modelStore.setValidateError(new AsrEngineError('model-corrupt', 'bad'))
    await expect(h.engine.loadModel()).rejects.toMatchObject({ asrCode: 'model-corrupt' })
    expect(h.engine.state).toBe('error')

    h.modelStore.setValidateError(null)
    await expect(h.engine.loadModel()).resolves.toBeUndefined()
    expect(h.engine.state).toBe('ready')
  })

  it('原生构造抛错 -> model-corrupt 归类', async () => {
    const h = makeEngine()
    h.binding.setConstructError(new Error('native: cannot read model file'))
    await expect(h.engine.loadModel()).rejects.toMatchObject({ asrCode: 'model-corrupt' })
    expect(h.engine.state).toBe('error')
  })

  it('ready 后 loadModel 幂等（binding 只构造一次）', async () => {
    const h = makeEngine()
    await h.engine.loadModel()
    await h.engine.loadModel()
    expect(h.binding.created).toHaveLength(1)
  })
})

describe('P3B-10 recognize 合同', () => {
  it('未就绪 -> engine-busy（rejected promise，非同步 throw）', async () => {
    const h = makeEngine()
    await expect(h.engine.recognize(makeSilentPcm16(20))).rejects.toMatchObject({
      asrCode: 'engine-busy'
    })
  })

  it('输入合同违例 -> audio-invalid（空/超界；不截断继续）', async () => {
    const h = makeEngine()
    await h.engine.loadModel()
    await expect(h.engine.recognize(new Int16Array(0))).rejects.toMatchObject({
      asrCode: 'audio-invalid'
    })
    const oversized = new Int16Array(960_001)
    await expect(h.engine.recognize(oversized)).rejects.toMatchObject({
      asrCode: 'audio-invalid'
    })
    expect(h.binding.captured).toHaveLength(0)
  })

  it('Int16 -> Float32（÷32768）+ 16kHz 送原生；结果映射 segment', async () => {
    const h = makeEngine()
    h.binding.outputs.push({ text: ' 你好世界 ', timestamps: [0.5, 1.2], tokens: ['你', '好'] })
    await h.engine.loadModel()

    // 幅值 16384 = 0.5；正弦幅值 0.6 也会落 [-1,1]
    const audio = makeSinePcm16(20, 440, 0.5)
    const result = await h.engine.recognize(audio, { language: 'zh' })

    expect(h.binding.captured).toHaveLength(1)
    expect(h.binding.captured[0]!.sampleRate).toBe(16_000)
    const samples = h.binding.captured[0]!.samples
    expect(samples).toBeInstanceOf(Float32Array)
    expect(samples.length).toBe(audio.length)
    // 至少一个样本幅值接近 0.5±（s16 量化后 16384/32768 = 0.5）
    expect(Math.max(...samples.map(Math.abs))).toBeGreaterThan(0.4)
    expect(Math.max(...samples.map(Math.abs))).toBeLessThanOrEqual(1)

    expect(result.text).toBe('你好世界')
    expect(result.segments).toEqual([{ text: '你好世界', startMs: 500, endMs: 1200 }])
  })

  it('无时间戳输出 -> 退化为 [0,0] segment；空文本 -> 空 segments', async () => {
    const h = makeEngine()
    h.binding.outputs.push({ text: '纯文本' })
    await h.engine.loadModel()
    expect((await h.engine.recognize(makeSilentPcm16(20))).segments).toEqual([
      { text: '纯文本', startMs: 0, endMs: 0 }
    ])

    h.binding.outputs.push({ text: '   ' })
    expect((await h.engine.recognize(makeSilentPcm16(20))).segments).toEqual([])
  })

  it('输出违反共享合同（超长文本）-> recognize-failed', async () => {
    const h = makeEngine()
    h.binding.outputs.push({ text: 'a'.repeat(5_000) })
    await h.engine.loadModel()
    await expect(h.engine.recognize(makeSilentPcm16(20))).rejects.toMatchObject({
      asrCode: 'recognize-failed'
    })
  })

  it('原生识别抛错 -> recognize-failed；下一次恢复', async () => {
    const h = makeEngine()
    h.binding.outputs.push({ text: 'ok' })
    await h.engine.loadModel()
    h.binding.recognizeErrors.push(new Error('inference crashed'))
    await expect(h.engine.recognize(makeSilentPcm16(20))).rejects.toMatchObject({
      asrCode: 'recognize-failed'
    })
    const result: AsrTranscriptResult = await h.engine.recognize(makeSilentPcm16(20))
    expect(result.text).toBe('ok')
    expect(h.engine.state).toBe('ready') // 识别失败不落 error 态（可重试）
  })

  it('id/localOnly 满足冻结合同；onProgress 可退订', async () => {
    const h = makeEngine()
    expect(h.engine.id).toBe(SHERPA_SENSEVOICE_ENGINE_ID)
    expect(h.engine.localOnly).toBe(true)
    let hits = 0
    const off = h.engine.onProgress(() => {
      hits++
    })
    off()
    await h.engine.loadModel()
    expect(hits).toBe(0)
  })
})
