// src/main/voice/asr/funasr-provider.test.ts
// P3B-11：FunASR Paraformer 备用 adapter 合同。
// 核心验收：与同一 ABI（P3B-09 冻结）；本地 paraformer 路由（绝无网络 API）；
// 模型目录与默认引擎隔离；语言提示 advisory 忽略（中文模型）。
// 共用工厂的全量行为（状态机/错误映射/输入输出合同）由 sherpa-provider.test.ts
// 覆盖，这里只测 P3B-11 的差异面。

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AsrEngine } from '@shared/voice/asr-types'
import { makeSilentPcm16, makeSinePcm16 } from '../../../../tests/helpers/silent-pcm'
import {
  createFunasrModelStore,
  createFunasrParaformerEngine,
  FUNASR_PARAFORMER_ENGINE_ID
} from './funasr-provider'
import { createSherpaSenseVoiceEngine } from './sherpa-provider'
import { createAsrModelStore, type AsrModelFiles, type AsrModelStore } from './model-store'
import type {
  SherpaOfflineBinding,
  SherpaRecognitionOutput,
  SherpaRecognizerLike
} from './sherpa-binding'

function makeFakeBinding(): {
  binding: SherpaOfflineBinding
  created: Array<{ modelKind: string; modelPath: string }>
  outputs: SherpaRecognitionOutput[]
  captured: Array<{ samples: Float32Array; sampleRate: number }>
} {
  const created: Array<{ modelKind: string; modelPath: string }> = []
  const outputs: SherpaRecognitionOutput[] = []
  const captured: Array<{ samples: Float32Array; sampleRate: number }> = []
  const binding: SherpaOfflineBinding = {
    createRecognizer(input) {
      created.push({ modelKind: input.modelKind, modelPath: input.modelPath })
      const recognizer: SherpaRecognizerLike = {
        recognize(samples, sampleRate) {
          captured.push({ samples, sampleRate })
          return outputs.shift() ?? { text: '' }
        },
        close() {
          /* noop */
        }
      }
      return recognizer
    }
  }
  return { binding, created, outputs, captured }
}

function makeFakeStore(files: AsrModelFiles | null): AsrModelStore {
  return {
    discover: () => files,
    validate: async (_files, onProgress) => {
      onProgress?.(0.5)
    }
  }
}

const FIXED_FILES: AsrModelFiles = {
  modelPath: 'C:/data/models/asr/paraformer/model.onnx',
  tokensPath: 'C:/data/models/asr/paraformer/tokens.txt'
}

describe('P3B-11 备用引擎：identity 与路由', () => {
  it('id/localOnly 满足冻结 ABI；modelKind 路由到 paraformer', async () => {
    const binding = makeFakeBinding()
    const engine: AsrEngine = createFunasrParaformerEngine({
      binding: binding.binding,
      modelStore: makeFakeStore(FIXED_FILES)
    })
    expect(engine.id).toBe(FUNASR_PARAFORMER_ENGINE_ID)
    expect(engine.localOnly).toBe(true)
    expect(engine.state).toBe('not-downloaded')

    await engine.loadModel()
    expect(engine.state).toBe('ready')
    expect(binding.created).toEqual([{ modelKind: 'paraformer', modelPath: FIXED_FILES.modelPath }])
  })

  it('与默认引擎互不混用：sense-voice 引擎收到的是 sense-voice 路由', async () => {
    const binding = makeFakeBinding()
    const engine = createSherpaSenseVoiceEngine({
      binding: binding.binding,
      modelStore: makeFakeStore(FIXED_FILES)
    })
    await engine.loadModel()
    expect(binding.created[0]!.modelKind).toBe('sense-voice')
    expect(engine.id).toBe('sherpa-sensevoice')
  })
})

describe('P3B-11 备用引擎：模型目录隔离（真实临时目录）', () => {
  let root: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'asr-funasr-'))
    // 只放 paraformer 文件：funasr store 应发现，默认 store 不应发现
    const dir = join(root, 'paraformer')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'model.onnx'), 'paraformer-model')
    await writeFile(join(dir, 'tokens.txt'), '你 好')
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('createFunasrModelStore 发现 paraformer/ 目录；默认 store 探不到同一文件', () => {
    const funasrStore = createFunasrModelStore(root)
    const files = funasrStore.discover()
    expect(files).not.toBeNull()
    expect(files!.modelPath.endsWith('paraformer/model.onnx')).toBe(true)

    const defaultStore = createAsrModelStore(root)
    expect(defaultStore.discover()).toBeNull() // sense-voice 目录不存在
  })
})

describe('P3B-11 备用引擎：识别合同', () => {
  it('语言提示 advisory：中文模型收到非中文提示也照常识别（忽略不重建实例）', async () => {
    const binding = makeFakeBinding()
    binding.outputs.push({ text: '中文结果', timestamps: [0.1, 0.9], tokens: ['中', '文'] })
    const engine = createFunasrParaformerEngine({
      binding: binding.binding,
      modelStore: makeFakeStore(FIXED_FILES)
    })
    await engine.loadModel()
    const result = await engine.recognize(makeSilentPcm16(20), { language: 'en' })
    expect(result.text).toBe('中文结果')
    expect(result.segments).toEqual([{ text: '中文结果', startMs: 100, endMs: 900 }])
    // 实例未按提示重建（中文模型忽略提示，不是按语言重建）
    expect(binding.created).toHaveLength(1)
  })

  it('Int16 -> Float32（÷32768）+ 16kHz 送原生', async () => {
    const binding = makeFakeBinding()
    binding.outputs.push({ text: 'x' })
    const engine = createFunasrParaformerEngine({
      binding: binding.binding,
      modelStore: makeFakeStore(FIXED_FILES)
    })
    await engine.loadModel()
    await engine.recognize(makeSinePcm16(20, 440, 0.5))
    expect(binding.captured[0]!.sampleRate).toBe(16_000)
    expect(Math.max(...binding.captured[0]!.samples.map(Math.abs))).toBeGreaterThan(0.4)
    expect(Math.max(...binding.captured[0]!.samples.map(Math.abs))).toBeLessThanOrEqual(1)
  })

  it('模型缺失 -> model-missing；识别未就绪 -> engine-busy', async () => {
    const binding = makeFakeBinding()
    const engine = createFunasrParaformerEngine({
      binding: binding.binding,
      modelStore: makeFakeStore(null)
    })
    await expect(engine.loadModel()).rejects.toMatchObject({ asrCode: 'model-missing' })
    expect(engine.state).toBe('not-downloaded')
    await expect(engine.recognize(makeSilentPcm16(20))).rejects.toMatchObject({
      asrCode: 'engine-busy'
    })
  })
})
