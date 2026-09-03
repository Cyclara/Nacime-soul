// src/main/voice/asr/model-store.ts
// P3B-10 / P3B-11：ASR 模型资源发现/校验。
//
// 目录布局（rootDir 由组合根注入，生产 = userData/models/asr；每引擎一个子目录，
// dirName 选项区分默认/备用引擎，互不共享模型文件）：
//   {root}/sense-voice/model.onnx    （SenseVoice int8 ~160MB，下载器负责落盘）
//   {root}/sense-voice/tokens.txt
//   {root}/sense-voice/manifest.json （可选；下载器写入后校验升级为 sha256+字节）
//   {root}/paraformer/…              （FunASR Paraformer 备用，P3B-11；同一套布局）
//
// 校验分级：无 manifest -> 存在且非空即可（允许手工放置）；有 manifest ->
// 字节数 + sha256 必须全中，任一不符 = model-corrupt（P3B-10 验收「模型校验」）。
// sha256 分块流式计算（4MB/块），大文件校验期间经 onProgress 报 0..1
// （P3B-14 加载状态条的数据源）。
//
// 路径纪律：本模块返回的路径只进 main 侧 adapter，不进任何跨进程 DTO
// （P3B-09 红线：DTO 不含任意文件路径）。

import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { open, readFile, stat } from 'node:fs/promises'
import { AsrEngineError } from './engine-error'

/** 每引擎子目录名（P3B-10 默认 / P3B-11 备用；模型文件名两族一致由下载器归一）。 */
export const SHERPA_MODEL_DIR_NAME = 'sense-voice'
export const FUNASR_MODEL_DIR_NAME = 'paraformer'
export const SHERPA_MODEL_FILE = 'model.onnx'
export const SHERPA_TOKENS_FILE = 'tokens.txt'
export const SHERPA_MANIFEST_FILE = 'manifest.json'

const HASH_CHUNK_BYTES = 4 * 1024 * 1024

export interface AsrModelFiles {
  readonly modelPath: string
  readonly tokensPath: string
}

interface ManifestEntry {
  readonly bytes: number
  readonly sha256: string
}

interface Manifest {
  readonly files: Readonly<Record<string, ManifestEntry>>
}

// ── 模块级共用校验原语（两个 store 共享一份实现，防分级校验规则漂移）──

/** 分块流式 sha256（4MB/块）：大 encoder 有 330MB，一次读进内存不可接受。 */
async function fileSha256(
  path: string,
  bytes: number,
  onProgress?: (ratio: number) => void,
  progressBase = 0,
  progressSpan = 1
): Promise<string> {
  const hash = createHash('sha256')
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(HASH_CHUNK_BYTES)
    let read = 0
    while (read < bytes) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(HASH_CHUNK_BYTES, bytes - read),
        read
      )
      if (bytesRead <= 0) break
      hash.update(buffer.subarray(0, bytesRead))
      read += bytesRead
      if (onProgress !== undefined && bytes > 0) {
        onProgress(progressBase + (read / bytes) * progressSpan)
      }
    }
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

function parseManifest(raw: string): Manifest | null {
  try {
    const parsed = JSON.parse(raw) as { files?: Record<string, unknown> }
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.files !== 'object') {
      return null
    }
    const files: Record<string, ManifestEntry> = {}
    for (const [name, entry] of Object.entries(parsed.files)) {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        typeof (entry as Record<string, unknown>)['bytes'] !== 'number' ||
        typeof (entry as Record<string, unknown>)['sha256'] !== 'string'
      ) {
        return null
      }
      files[name] = {
        bytes: (entry as Record<string, unknown>)['bytes'] as number,
        sha256: (entry as Record<string, unknown>)['sha256'] as string
      }
    }
    return { files }
  } catch {
    return null
  }
}

/** 读 manifest；不存在 -> null（降级为非空校验，允许手工放置模型）。 */
async function readManifestAt(manifestPath: string): Promise<Manifest | null> {
  let raw: string
  try {
    raw = await readFile(manifestPath, 'utf-8')
  } catch {
    return null
  }
  const manifest = parseManifest(raw)
  if (manifest === null) {
    throw new AsrEngineError('model-corrupt', 'manifest unparseable')
  }
  return manifest
}

/** 校验单个文件：有 manifest 条目则字节+sha256 全验，无条目则只验非空。 */
async function validateOneFile(
  path: string,
  size: number,
  entry: ManifestEntry | undefined,
  onProgress: ((ratio: number) => void) | undefined,
  progressBase: number,
  progressSpan: number
): Promise<void> {
  if (entry === undefined) {
    if (size <= 0) throw new AsrEngineError('model-corrupt', `empty file: ${path}`)
    onProgress?.(progressBase + progressSpan)
    return
  }
  if (size !== entry.bytes) {
    throw new AsrEngineError('model-corrupt', `size mismatch: ${path}`)
  }
  const digest = await fileSha256(path, size, onProgress, progressBase, progressSpan)
  if (digest !== entry.sha256) {
    throw new AsrEngineError('model-corrupt', `sha256 mismatch: ${path}`)
  }
}

export interface AsrModelStore {
  /** 同步探测：文件齐全返回路径；任何文件缺失/空 -> null（= model-missing，UI 引导下载）。 */
  discover(): AsrModelFiles | null
  /**
   * 校验（异步，分块 hash）：manifest 在场则字节+sha256 全验，缺场验非空。
   * 失败抛 AsrEngineError('model-corrupt')。onProgress 覆盖整个校验过程 0..1。
   */
  validate(files: AsrModelFiles, onProgress?: (ratio: number) => void): Promise<void>
}

/**
 * P3V-05：任意文件集的模型目录（P3V 新模型有 3~5 个文件，不再是 model+tokens 两个）。
 * 文件名 -> 绝对路径的映射；键是 download-catalog 的 `asrEngineRequiredFiles`。
 */
export type AsrModelFileSet = Readonly<Record<string, string>>

export interface AsrFileSetStore {
  /** 全部必需文件齐全且非空才返回映射；缺任一个 -> null。 */
  discover(): AsrModelFileSet | null
  /**
   * 逐文件校验：manifest 在场则字节+sha256 全验，缺场验非空。
   * 进度按文件字节数加权——大 encoder 校验慢，等权会让进度条卡在小文件上跳。
   */
  validate(files: AsrModelFileSet, onProgress?: (ratio: number) => void): Promise<void>
}

/**
 * 通用文件集实现。`createAsrModelStore` 是它 `files = [model.onnx, tokens.txt]`
 * 的特例包装——只保留一份校验/hash 逻辑，避免两条路径的分级校验规则漂移。
 */
export function createAsrFileSetStore(
  rootDir: string,
  options: { readonly dirName: string; readonly files: readonly string[] }
): AsrFileSetStore {
  const modelDir = `${rootDir}/${options.dirName}`.replaceAll('\\', '/')
  const required = options.files

  function pathOf(file: string): string {
    return `${modelDir}/${file}`
  }

  return {
    discover() {
      try {
        const out: Record<string, string> = {}
        for (const file of required) {
          const info = statSync(pathOf(file))
          if (!info.isFile() || info.size <= 0) return null
          out[file] = pathOf(file)
        }
        return out
      } catch {
        return null
      }
    },

    async validate(files, onProgress) {
      const manifest = await readManifestAt(pathOf(SHERPA_MANIFEST_FILE))
      // 按实际字节数加权分配进度区间：encoder 占 330MB 时它就该占 90% 的进度条
      const sizes = new Map<string, number>()
      let total = 0
      for (const name of required) {
        const path = files[name]
        if (path === undefined) {
          throw new AsrEngineError('model-corrupt', `missing file in set: ${name}`)
        }
        const info = await stat(path)
        if (!info.isFile()) throw new AsrEngineError('model-corrupt', `not a file: ${path}`)
        sizes.set(name, info.size)
        total += info.size
      }
      let base = 0
      for (const name of required) {
        const path = files[name]!
        const size = sizes.get(name) ?? 0
        const span = total > 0 ? size / total : 0
        await validateOneFile(path, size, manifest?.files[name], onProgress, base, span)
        base += span
      }
      onProgress?.(1)
    }
  }
}

export function createAsrModelStore(
  rootDir: string,
  options?: { readonly dirName?: string }
): AsrModelStore {
  const modelDir = `${rootDir}/${options?.dirName ?? SHERPA_MODEL_DIR_NAME}`.replaceAll('\\', '/')

  function pathOf(file: string): string {
    return `${modelDir}/${file}`
  }

  async function fileSize(path: string): Promise<number> {
    const info = await stat(path)
    if (!info.isFile()) throw new AsrEngineError('model-corrupt', `not a file: ${path}`)
    return info.size
  }

  async function validateFile(
    path: string,
    entry: ManifestEntry | undefined,
    onProgress: ((ratio: number) => void) | undefined,
    progressBase: number,
    progressSpan: number
  ): Promise<void> {
    await validateOneFile(path, await fileSize(path), entry, onProgress, progressBase, progressSpan)
  }

  return {
    discover() {
      // 同步探测用 statSync（每轮 recognize 前都可能调，保持廉价）；
      // 失败一律 null，不区分「目录不存在」与「文件缺」--都叫 model-missing。
      try {
        for (const file of [SHERPA_MODEL_FILE, SHERPA_TOKENS_FILE]) {
          const info = statSync(pathOf(file))
          if (!info.isFile() || info.size <= 0) return null
        }
        return { modelPath: pathOf(SHERPA_MODEL_FILE), tokensPath: pathOf(SHERPA_TOKENS_FILE) }
      } catch {
        return null
      }
    },

    async validate(files, onProgress) {
      const manifest = await readManifestAt(pathOf(SHERPA_MANIFEST_FILE))
      // model 文件占进度 0..0.9（大头），tokens 占 0.9..1
      await validateFile(files.modelPath, manifest?.files[SHERPA_MODEL_FILE], onProgress, 0, 0.9)
      await validateFile(
        files.tokensPath,
        manifest?.files[SHERPA_TOKENS_FILE],
        onProgress,
        0.9,
        0.1
      )
      onProgress?.(1)
    }
  }
}
