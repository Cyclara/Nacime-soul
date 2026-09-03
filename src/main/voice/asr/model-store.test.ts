// src/main/voice/asr/model-store.test.ts
// P3B-10：模型资源发现/校验合同（临时目录 + 真文件，不加载真模型）。

import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  SHERPA_MANIFEST_FILE,
  SHERPA_MODEL_FILE,
  SHERPA_TOKENS_FILE,
  createAsrFileSetStore,
  createAsrModelStore
} from './model-store'
import { AsrEngineError } from './engine-error'

let root: string
let modelDir: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'asr-model-store-'))
  modelDir = join(root, 'sense-voice')
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writeModelFiles(
  modelContent = 'fake-model-bytes',
  tokensContent = 'a b c'
): Promise<void> {
  await mkdir(modelDir, { recursive: true })
  await writeFile(join(modelDir, SHERPA_MODEL_FILE), modelContent)
  await writeFile(join(modelDir, SHERPA_TOKENS_FILE), tokensContent)
}

async function writeManifest(entries: {
  modelBytes: number
  modelSha256: string
  tokensBytes: number
  tokensSha256: string
}): Promise<void> {
  await writeFile(
    join(modelDir, SHERPA_MANIFEST_FILE),
    JSON.stringify({
      modelId: 'sense-voice',
      files: {
        [SHERPA_MODEL_FILE]: { bytes: entries.modelBytes, sha256: entries.modelSha256 },
        [SHERPA_TOKENS_FILE]: { bytes: entries.tokensBytes, sha256: entries.tokensSha256 }
      }
    })
  )
}

function sha(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

async function sizeOf(path: string): Promise<number> {
  return (await stat(path)).size
}

describe('P3B-10 discover', () => {
  it('目录/文件缺失或空 -> null', async () => {
    const store = createAsrModelStore(join(root, 'missing'))
    expect(store.discover()).toBeNull()

    const emptyRoot = await mkdtemp(join(tmpdir(), 'asr-empty-'))
    try {
      const emptyStore = createAsrModelStore(emptyRoot)
      expect(emptyStore.discover()).toBeNull() // 目录存在但无文件
      await mkdir(join(emptyRoot, 'sense-voice'), { recursive: true })
      await writeFile(join(emptyRoot, 'sense-voice', SHERPA_MODEL_FILE), 'x')
      expect(emptyStore.discover()).toBeNull() // tokens 缺
      await writeFile(join(emptyRoot, 'sense-voice', SHERPA_TOKENS_FILE), '')
      expect(emptyStore.discover()).toBeNull() // tokens 空文件
    } finally {
      await rm(emptyRoot, { recursive: true, force: true })
    }
  })

  it('文件齐全且非空 -> 路径（forward-slash 归一）', async () => {
    await writeModelFiles()
    const store = createAsrModelStore(root)
    const files = store.discover()
    expect(files).not.toBeNull()
    expect(files!.modelPath.endsWith(`sense-voice/${SHERPA_MODEL_FILE}`)).toBe(true)
    expect(files!.tokensPath.endsWith(`sense-voice/${SHERPA_TOKENS_FILE}`)).toBe(true)
  })
})

describe('P3V-05 通用多文件 model-store', () => {
  it('全部必需文件齐全才 discover；返回文件名到归一路径的映射', async () => {
    const fileRoot = await mkdtemp(join(tmpdir(), 'asr-file-set-'))
    try {
      const dir = join(fileRoot, 'zipformer')
      await mkdir(dir, { recursive: true })
      const store = createAsrFileSetStore(fileRoot, {
        dirName: 'zipformer',
        files: ['encoder.onnx', 'decoder.onnx', 'tokens.txt']
      })
      await writeFile(join(dir, 'encoder.onnx'), 'encoder')
      await writeFile(join(dir, 'decoder.onnx'), 'decoder')
      expect(store.discover()).toBeNull()
      await writeFile(join(dir, 'tokens.txt'), 'tokens')
      expect(store.discover()).toEqual({
        'encoder.onnx': expect.stringMatching(/zipformer\/encoder\.onnx$/),
        'decoder.onnx': expect.stringMatching(/zipformer\/decoder\.onnx$/),
        'tokens.txt': expect.stringMatching(/zipformer\/tokens\.txt$/)
      })
    } finally {
      await rm(fileRoot, { recursive: true, force: true })
    }
  })

  it('manifest 对每个文件做 bytes+sha256 校验，进度按字节单调到 1', async () => {
    const fileRoot = await mkdtemp(join(tmpdir(), 'asr-file-set-'))
    try {
      const dir = join(fileRoot, 'parakeet')
      await mkdir(dir, { recursive: true })
      const contents = { 'encoder.onnx': 'encoder-large', 'tokens.txt': 't' }
      for (const [name, content] of Object.entries(contents)) {
        await writeFile(join(dir, name), content)
      }
      await writeFile(
        join(dir, SHERPA_MANIFEST_FILE),
        JSON.stringify({
          files: Object.fromEntries(
            Object.entries(contents).map(([name, content]) => [
              name,
              { bytes: Buffer.byteLength(content), sha256: sha(content) }
            ])
          )
        })
      )
      const store = createAsrFileSetStore(fileRoot, {
        dirName: 'parakeet',
        files: Object.keys(contents)
      })
      const progress: number[] = []
      await store.validate(store.discover()!, (ratio) => progress.push(ratio))
      expect(progress.at(-1)).toBe(1)
      expect(progress.every((ratio, index) => index === 0 || ratio >= progress[index - 1]!)).toBe(
        true
      )

      await writeFile(join(dir, 'tokens.txt'), 'x')
      await expect(store.validate(store.discover()!)).rejects.toMatchObject({
        asrCode: 'model-corrupt'
      })
    } finally {
      await rm(fileRoot, { recursive: true, force: true })
    }
  })

  it('无 manifest 时兼容手工放置，但空文件仍拒绝 discover', async () => {
    const fileRoot = await mkdtemp(join(tmpdir(), 'asr-file-set-'))
    try {
      const dir = join(fileRoot, 'manual')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'a.onnx'), 'a')
      await writeFile(join(dir, 'tokens.txt'), 'tokens')
      const store = createAsrFileSetStore(fileRoot, {
        dirName: 'manual',
        files: ['a.onnx', 'tokens.txt']
      })
      await expect(store.validate(store.discover()!)).resolves.toBeUndefined()
      await writeFile(join(dir, 'tokens.txt'), '')
      expect(store.discover()).toBeNull()
    } finally {
      await rm(fileRoot, { recursive: true, force: true })
    }
  })
})

describe('P3B-10 validate', () => {
  it('无 manifest：非空即过；progress 到 1', async () => {
    await rm(join(modelDir, SHERPA_MANIFEST_FILE), { force: true })
    await writeModelFiles()
    const store = createAsrModelStore(root)
    const files = store.discover()!
    const ratios: number[] = []
    await store.validate(files, (r) => ratios.push(r))
    expect(ratios[ratios.length - 1]).toBe(1)
    expect(ratios.every((r, i) => i === 0 || r >= ratios[i - 1]!)).toBe(true)
  })

  it('manifest 全中 -> 过', async () => {
    await writeModelFiles()
    const model = 'fake-model-bytes'
    const tokens = 'a b c'
    await writeManifest({
      modelBytes: await sizeOf(join(modelDir, SHERPA_MODEL_FILE)),
      modelSha256: sha(model),
      tokensBytes: await sizeOf(join(modelDir, SHERPA_TOKENS_FILE)),
      tokensSha256: sha(tokens)
    })
    const store = createAsrModelStore(root)
    await expect(store.validate(store.discover()!)).resolves.toBeUndefined()
  })

  it('字节不符 -> model-corrupt', async () => {
    await writeModelFiles('different-content')
    await writeManifest({
      modelBytes: 999, // 与实际不符
      modelSha256: sha('fake-model-bytes'),
      tokensBytes: await sizeOf(join(modelDir, SHERPA_TOKENS_FILE)),
      tokensSha256: sha('a b c')
    })
    const store = createAsrModelStore(root)
    await expect(store.validate(store.discover()!)).rejects.toMatchObject({
      asrCode: 'model-corrupt'
    })
  })

  it('sha256 不符 -> model-corrupt', async () => {
    await writeModelFiles()
    await writeManifest({
      modelBytes: await sizeOf(join(modelDir, SHERPA_MODEL_FILE)),
      modelSha256: sha('tampered'),
      tokensBytes: await sizeOf(join(modelDir, SHERPA_TOKENS_FILE)),
      tokensSha256: sha('a b c')
    })
    const store = createAsrModelStore(root)
    await expect(store.validate(store.discover()!)).rejects.toBeInstanceOf(AsrEngineError)
  })

  it('manifest 解析失败 -> model-corrupt（不静默降级）', async () => {
    await writeModelFiles()
    await writeFile(join(modelDir, SHERPA_MANIFEST_FILE), '{not json')
    const store = createAsrModelStore(root)
    await expect(store.validate(store.discover()!)).rejects.toMatchObject({
      asrCode: 'model-corrupt'
    })
  })

  it('manifest 缺条目 -> 该文件按非空校验（手工放置兼容）', async () => {
    await writeModelFiles()
    await writeFile(
      join(modelDir, SHERPA_MANIFEST_FILE),
      JSON.stringify({ files: { [SHERPA_TOKENS_FILE]: { bytes: 5, sha256: sha('a b c') } } })
    )
    const store = createAsrModelStore(root)
    await expect(store.validate(store.discover()!)).resolves.toBeUndefined()
  })
})
