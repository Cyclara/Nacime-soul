// src/main/voice/asr/model-downloader.ts
// P3B-14：ASR/VAD 模型下载器——固定 URL、可中止、流式进度、解压、sha256、原子落盘。
//
// 资产（URL 与体积 2026-09-01 实测核验 HEAD 200 + Content-Length；归档内文件名
// 经官方 nodejs 示例 test-offline-sense-voice.js / test-offline-paraformer.js 核对）：
//   - SenseVoice int8（默认引擎）：sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-
//     2024-07-17.tar.bz2 ≈163MB，内含 model.int8.onnx + tokens.txt
//   - FunASR Paraformer zh int8（备用）：sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2
//     ≈234MB，内含 model.int8.onnx + tokens.txt
//   - Silero VAD v4：silero_vad.onnx ≈630KB（单文件，无需解压）
//
// 安全/健壮性：
//   - 网络走注入的 secureFetch（https 公网 + 重定向复验；github release 资产 302
//     到 objects.githubusercontent.com 属正常公网跳转）。
//   - 下载产物 sha256 记入 manifest.json（model-store validate 分级校验依据）——
//     自证完整性（防未来磁盘损坏）；上游投毒的预置哈希钉死（expected sha256）
//     留作后续增强，体积粗检（±5%）先挡明显篡改/截断。
//   - 损坏的 onnx 会让原生层**崩溃进程**（P3B-12 实测）——下载器绝不把未过校验
//     的文件落到正式路径：临时目录下载/解压 → 校验 → rename 原子落位。
//   - tar 解压用系统自带 bsdtar（Windows 10+ System32；`tar -xjf -C`；windowsHide）。
//     全量解压到临时目录后只搬两个已知文件，随后删除临时目录（含 test_wavs 等）。
//
// 状态机：idle → downloading{progress} → extracting → installing → done；失败/中止
// → error / cancelled。进度节流 100ms（kind 变化立即发）。
// download() 是长任务：生产调用方（engine-manager → IPC handler）**不 await 完成**，
// 状态经 onStateChange → event 通道推送；Promise 仅用于测试断言。

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WriteStream } from 'node:fs'
import type { AsrEngineId } from '@shared/voice/asr-settings-types'
import type { AssetDownloadPhase, AssetDownloadStatus } from '@shared/voice/asset-root-types'
import { SHERPA_MANIFEST_FILE, SHERPA_MODEL_FILE, SHERPA_TOKENS_FILE } from './model-store'
import {
  ASR_ENGINE_DOWNLOAD_CATALOG,
  type AsrDownloadFile,
  type AsrDownloadSource
} from './download-catalog'

/** 下载目标：引擎模型归档 或 VAD 单文件。 */
export type ModelDownloadTarget = AsrEngineId | 'vad'

export interface AsrModelAsset {
  readonly archiveUrl: string
  /** 预期归档字节数（进度分母 + 完整性粗检）。 */
  readonly archiveBytes: number
  /** 归档内模型文件名（解压后在任意子目录 ≤4 层查找）。 */
  readonly modelFile: string
  readonly tokensFile: string
}

/**
 * 归档口径的引擎资产（P3B 的 SenseVoice / FunASR）。
 *
 * P3V-01 起唯一真源是 download-catalog；这里只是把归档来源投影出来，
 * 避免同一个 URL/体积在两个文件各写一份然后各改各的。**是 Partial**：
 * P3V 新增的四个模型走多文件直下，不在这张表里。
 */
export const ASR_MODEL_ASSETS: Readonly<Partial<Record<AsrEngineId, AsrModelAsset>>> =
  Object.freeze(
    Object.fromEntries(
      Object.values(ASR_ENGINE_DOWNLOAD_CATALOG)
        .filter((entry) => entry.source.kind === 'archive')
        .map((entry) => {
          const source = entry.source as Extract<AsrDownloadSource, { kind: 'archive' }>
          return [
            entry.engineId,
            {
              archiveUrl: source.archiveUrl,
              archiveBytes: source.archiveBytes,
              modelFile: source.modelFile,
              tokensFile: source.tokensFile
            } satisfies AsrModelAsset
          ]
        })
    )
  )

/**
 * 未完成下载的暂存目录名（在模型根目录下）。以点开头，避免被当成某个引擎的
 * 模型目录扫到。
 */
const PARTIAL_DIR_NAME = '.partial'

/** 该引擎是否走多文件直下；不是则返回 null（调用方走归档路径）。 */
function catalogFileSource(
  engineId: AsrEngineId
): Extract<AsrDownloadSource, { kind: 'files' }> | null {
  const source = ASR_ENGINE_DOWNLOAD_CATALOG[engineId].source
  return source.kind === 'files' ? source : null
}

export const ASR_VAD_ASSET = {
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
  bytes: 643_854,
  /** VAD 模型安装目录/文件名（{root}/vad/silero_vad.onnx）。 */
  dirName: 'vad',
  fileName: 'silero_vad.onnx'
} as const

export type ModelDownloadState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'downloading'; readonly progress: number }
  | { readonly kind: 'paused'; readonly progress: number }
  | { readonly kind: 'extracting' }
  | { readonly kind: 'installing' }
  | { readonly kind: 'done' }
  | { readonly kind: 'cancelled' }
  | {
      readonly kind: 'error'
      readonly code: 'model-download-failed' | 'model-corrupt'
      /** 下载中心的精确完整性原因；既有 ASR ABI 仍折叠为 model-corrupt。 */
      readonly detailCode?: 'hash-mismatch' | 'size-mismatch'
      readonly message: string
    }

export interface ModelDownloaderDeps {
  /** 模型根目录（生产 userData/models/asr；引擎子目录名同 model-store）。 */
  readonly rootDir: string
  /** secureFetch 实例（网络策略：https 公网 + 重定向复验）。 */
  readonly fetchImpl: typeof globalThis.fetch
  /** 归档解压（生产 = 系统 bsdtar；测试注入）。 */
  readonly extractArchive: (archivePath: string, destDir: string) => Promise<void>
  readonly engineDirName: (engineId: AsrEngineId) => string
  readonly onStateChange?: (target: ModelDownloadTarget, state: ModelDownloadState) => void
  /** 进度节流间隔（默认 100ms；状态 kind 变化不节流）。 */
  readonly progressThrottleMs?: number
  /** 单测注入小文件目录；生产省略时只读钉死的 main-only catalog。 */
  readonly resolveFileSource?: (
    engineId: AsrEngineId
  ) => Extract<AsrDownloadSource, { kind: 'files' }> | null
  /** 单测注入 rename 故障以证明旧安装能回滚；生产使用 fs.rename。 */
  readonly renamePath?: (oldPath: string, newPath: string) => Promise<void>
}

export interface ModelDownloader {
  state(target: ModelDownloadTarget): ModelDownloadState
  /** 下载中心细节投影；不含 URL/路径，currentFile 只给安全 basename。 */
  status(target: ModelDownloadTarget): AssetDownloadStatus
  /**
   * 下载并安装。**长任务**：resolve 在安装完成/失败时；生产调用方不 await 完成
   * （状态经 onStateChange 流转）；同一目标重复调用拒绝。
   */
  download(target: ModelDownloadTarget): Promise<void>
  /** 中止进行中的下载；无进行中返回 false。 */
  cancel(target: ModelDownloadTarget): boolean
  /** 暂停可续传的多文件下载（保留 .part）；归档/VAD/安装阶段返回 false。 */
  pause(target: AsrEngineId): boolean
  /** 从 paused 的 `.part` 继续；非 paused/归档返回 false。 */
  resume(target: AsrEngineId): boolean
  /** 进行中（downloading/extracting/installing）。 */
  isActive(target: ModelDownloadTarget): boolean
  /**
   * P3V-13：删除已安装引擎目录 + 该引擎的 `.partial` 断点目录。
   * 下载进行中拒绝（return false）；未知 id 由类型/IPC validator 先挡。
   */
  deleteModel(engineId: AsrEngineId): Promise<boolean>
}

type DownloaderErrorCode = 'model-download-failed' | 'model-corrupt'

class DownloaderError extends Error {
  readonly code: DownloaderErrorCode
  readonly detailCode?: 'hash-mismatch' | 'size-mismatch'
  constructor(
    code: DownloaderErrorCode,
    message: string,
    detailCode?: 'hash-mismatch' | 'size-mismatch'
  ) {
    super(message)
    this.code = code
    this.detailCode = detailCode
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

/** 解压目录内按文件名定位（深度 ≤4，防恶意深嵌套）。 */
async function locateFile(dir: string, fileName: string): Promise<string | null> {
  let current = [dir]
  for (let depth = 0; depth < 4 && current.length > 0; depth++) {
    const next: string[] = []
    for (const d of current) {
      for (const entry of await readdir(d, { withFileTypes: true })) {
        const full = join(d, entry.name)
        if (entry.isFile() && entry.name === fileName) return full
        if (entry.isDirectory()) next.push(full)
      }
    }
    current = next
  }
  return null
}

export function createModelDownloader(deps: ModelDownloaderDeps): ModelDownloader {
  const states = new Map<ModelDownloadTarget, ModelDownloadState>()
  const controllers = new Map<ModelDownloadTarget, AbortController>()
  const pauseRequested = new Set<AsrEngineId>()
  const telemetry = new Map<ModelDownloadTarget, AssetDownloadStatus>()
  const throttleMs = deps.progressThrottleMs ?? 100
  const lastEmitAt = new Map<ModelDownloadTarget, number>()
  const resolveFileSource = deps.resolveFileSource ?? catalogFileSource
  const renamePath = deps.renamePath ?? rename
  const speedSamples = new Map<ModelDownloadTarget, { at: number; speed: number }>()

  function sourceOf(target: ModelDownloadTarget): AsrDownloadSource | null {
    return target === 'vad' ? null : ASR_ENGINE_DOWNLOAD_CATALOG[target].source
  }

  function totalBytesOf(target: ModelDownloadTarget): number {
    if (target === 'vad') return ASR_VAD_ASSET.bytes
    const fileSource = resolveFileSource(target)
    if (fileSource !== null) return fileSource.files.reduce((sum, file) => sum + file.bytes, 0)
    const source = sourceOf(target)
    return source?.kind === 'archive' ? source.archiveBytes : 0
  }

  function isResumable(target: ModelDownloadTarget): boolean {
    return target !== 'vad' && resolveFileSource(target) !== null
  }

  function archiveFileName(target: ModelDownloadTarget): string | undefined {
    if (target === 'vad') return ASR_VAD_ASSET.fileName
    const source = sourceOf(target)
    if (source?.kind !== 'archive') return undefined
    const raw = source.archiveUrl.split('/').at(-1)?.split('?')[0]
    return raw === undefined || raw.length === 0 ? 'model-archive' : raw
  }

  function baseStatus(target: ModelDownloadTarget): AssetDownloadStatus {
    return {
      assetId: target,
      state: 'idle',
      receivedBytes: 0,
      totalBytes: totalBytesOf(target),
      resumable: isResumable(target)
    }
  }

  function setReceivingTelemetry(
    target: ModelDownloadTarget,
    receivedBytes: number,
    totalBytes: number,
    currentFile: string,
    resumable: boolean,
    networkDeltaBytes = 0
  ): void {
    const now = Date.now()
    const previous = speedSamples.get(target)
    let speed = previous?.speed ?? 0
    if (previous !== undefined && now > previous.at && networkDeltaBytes > 0) {
      speed = Math.max(0, Math.round((networkDeltaBytes * 1_000) / (now - previous.at)))
    }
    speedSamples.set(target, { at: now, speed })
    telemetry.set(target, {
      assetId: target,
      state: 'downloading',
      receivedBytes: Math.min(Math.max(0, Math.round(receivedBytes)), totalBytes),
      totalBytes,
      currentFile,
      phase: 'receiving',
      speedBytesPerSec: speed,
      resumable
    })
  }

  function setPhaseTelemetry(
    target: ModelDownloadTarget,
    phase: AssetDownloadPhase,
    options?: { readonly currentFile?: string }
  ): void {
    const previous = telemetry.get(target) ?? baseStatus(target)
    telemetry.set(target, {
      assetId: target,
      state: 'downloading',
      receivedBytes: previous.receivedBytes,
      totalBytes: previous.totalBytes,
      ...(options?.currentFile === undefined ? {} : { currentFile: options.currentFile }),
      phase,
      speedBytesPerSec: 0,
      resumable: previous.resumable
    })
  }

  function syncTelemetry(target: ModelDownloadTarget, state: ModelDownloadState): void {
    const previous = telemetry.get(target) ?? baseStatus(target)
    switch (state.kind) {
      case 'idle':
        telemetry.set(target, baseStatus(target))
        break
      case 'downloading':
        if (previous.state !== 'downloading') {
          telemetry.set(target, {
            assetId: target,
            state: 'downloading',
            receivedBytes: Math.min(
              previous.totalBytes,
              Math.max(previous.receivedBytes, Math.round(previous.totalBytes * state.progress))
            ),
            totalBytes: previous.totalBytes,
            ...(previous.currentFile === undefined ? {} : { currentFile: previous.currentFile }),
            phase: previous.phase ?? 'receiving',
            speedBytesPerSec: previous.speedBytesPerSec ?? 0,
            resumable: previous.resumable
          })
        }
        break
      case 'paused':
        telemetry.set(target, {
          assetId: target,
          state: 'paused',
          receivedBytes: previous.receivedBytes,
          totalBytes: previous.totalBytes,
          ...(previous.currentFile === undefined ? {} : { currentFile: previous.currentFile }),
          phase: 'receiving',
          speedBytesPerSec: 0,
          resumable: true
        })
        break
      case 'extracting':
        setPhaseTelemetry(target, 'extracting')
        break
      case 'installing':
        setPhaseTelemetry(target, 'installing')
        break
      case 'done':
        telemetry.set(target, {
          assetId: target,
          state: 'done',
          receivedBytes: previous.totalBytes,
          totalBytes: previous.totalBytes,
          speedBytesPerSec: 0,
          resumable: previous.resumable
        })
        break
      case 'cancelled':
        telemetry.set(target, {
          assetId: target,
          state: 'cancelled',
          receivedBytes: previous.receivedBytes,
          totalBytes: previous.totalBytes,
          ...(previous.currentFile === undefined ? {} : { currentFile: previous.currentFile }),
          speedBytesPerSec: 0,
          resumable: previous.resumable,
          errorCode: 'cancelled'
        })
        break
      case 'error':
        telemetry.set(target, {
          assetId: target,
          state: 'error',
          receivedBytes: previous.receivedBytes,
          totalBytes: previous.totalBytes,
          ...(previous.currentFile === undefined ? {} : { currentFile: previous.currentFile }),
          speedBytesPerSec: 0,
          resumable: previous.resumable,
          errorCode:
            state.detailCode ??
            (state.code === 'model-corrupt' ? 'hash-mismatch' : 'download-failed')
        })
        break
    }
  }

  function setState(
    target: ModelDownloadTarget,
    state: ModelDownloadState,
    forceEmit = false
  ): void {
    const prev = states.get(target)
    states.set(target, state)
    syncTelemetry(target, state)
    if (deps.onStateChange === undefined) return
    const kindChanged = prev === undefined || prev.kind !== state.kind
    if (!kindChanged && !forceEmit) {
      const now = Date.now()
      if (now - (lastEmitAt.get(target) ?? 0) < throttleMs) return
      lastEmitAt.set(target, now)
    } else {
      lastEmitAt.set(target, Date.now())
    }
    deps.onStateChange(target, state)
  }

  async function downloadTo(
    url: string,
    destPath: string,
    expectedBytes: number,
    target: ModelDownloadTarget,
    signal: AbortSignal
  ): Promise<void> {
    const response = await deps.fetchImpl(url, { signal })
    if (!response.ok) {
      throw new DownloaderError('model-download-failed', `HTTP ${response.status}`)
    }
    const declared = Number(response.headers?.get('content-length') ?? '0')
    const total = declared > 0 ? declared : expectedBytes
    if (response.body === null) {
      throw new DownloaderError('model-download-failed', 'empty body')
    }
    const out = createWriteStream(destPath)
    let received = 0
    const fileName = archiveFileName(target) ?? 'model-file'
    setReceivingTelemetry(target, 0, expectedBytes, fileName, false)
    setState(target, { kind: 'downloading', progress: 0 }, true)
    try {
      const reader = (response.body as ReadableStream<Uint8Array>).getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        // 逐块 await 写：abort 时绝无在飞 write（destroy 后无回调炸出
        // ERR_STREAM_DESTROYED 的竞态，见 worklog 2026-09-01）
        await writeChunk(out, value)
        setReceivingTelemetry(target, received, expectedBytes, fileName, false, value.byteLength)
        setState(target, {
          kind: 'downloading',
          progress: Math.min(0.999, received / Math.max(total, 1))
        })
      }
      await endStream(out)
    } catch (err) {
      out.destroy()
      throw err
    }
    if (received === 0) {
      throw new DownloaderError('model-download-failed', 'no bytes received')
    }
    // 完整性粗检：与钉死体积差 >5% 视为篡改/截断/上游更换
    if (Math.abs(received - expectedBytes) / expectedBytes > 0.05) {
      throw new DownloaderError(
        'model-corrupt',
        `size mismatch: got ${received}, expected ~${expectedBytes}`,
        'size-mismatch'
      )
    }
    setReceivingTelemetry(target, expectedBytes, expectedBytes, fileName, false)
    setState(target, { kind: 'downloading', progress: 1 }, true)
  }

  function writeChunk(out: WriteStream, value: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      out.write(value, (err?: Error | null) => {
        if (err !== null && err !== undefined) reject(err)
        else resolve()
      })
    })
  }

  function endStream(out: WriteStream): Promise<void> {
    return new Promise((resolve, reject) => {
      out.end((err?: Error | null) => {
        if (err !== null && err !== undefined) reject(err)
        else resolve()
      })
    })
  }

  async function installEngineFiles(
    workDir: string,
    engineId: AsrEngineId,
    asset: AsrModelAsset
  ): Promise<void> {
    const extracted = join(workDir, 'extracted')
    setPhaseTelemetry(engineId, 'extracting')
    setState(engineId, { kind: 'extracting' })
    await deps.extractArchive(join(workDir, 'archive.tar.bz2'), extracted)
    const modelPath = await locateFile(extracted, asset.modelFile)
    const tokensPath = await locateFile(extracted, asset.tokensFile)
    if (modelPath === null || tokensPath === null) {
      throw new DownloaderError('model-corrupt', 'archive missing model/tokens')
    }
    setPhaseTelemetry(engineId, 'installing')
    setState(engineId, { kind: 'installing' })
    const staging = join(workDir, 'staging')
    await mkdir(staging, { recursive: true })
    // 解压名（model.int8.onnx）→ model-store 约定名（model.onnx / tokens.txt）
    await copyFile(modelPath, join(staging, SHERPA_MODEL_FILE))
    await copyFile(tokensPath, join(staging, SHERPA_TOKENS_FILE))
    const manifest = {
      version: 1,
      files: {
        [SHERPA_MODEL_FILE]: {
          bytes: (await stat(modelPath)).size,
          sha256: await sha256File(modelPath)
        },
        [SHERPA_TOKENS_FILE]: {
          bytes: (await stat(tokensPath)).size,
          sha256: await sha256File(tokensPath)
        }
      }
    }
    await writeFile(join(staging, SHERPA_MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf-8')
    // 归档 staging 在系统临时目录，Windows 上可能与资源根目录跨盘，不能直接 rename。
    // 先复制到资源根目录内的 sibling staging，再用同分区双 rename 安全替换。
    const finalDir = join(deps.rootDir, deps.engineDirName(engineId))
    const installStaging = join(deps.rootDir, `.${deps.engineDirName(engineId)}.installing`)
    const backupDir = join(deps.rootDir, `.${deps.engineDirName(engineId)}.backup`)
    await mkdir(deps.rootDir, { recursive: true })
    await rm(installStaging, { recursive: true, force: true })
    await mkdir(installStaging, { recursive: true })
    await copyFile(join(staging, SHERPA_MODEL_FILE), join(installStaging, SHERPA_MODEL_FILE))
    await copyFile(join(staging, SHERPA_TOKENS_FILE), join(installStaging, SHERPA_TOKENS_FILE))
    await copyFile(join(staging, SHERPA_MANIFEST_FILE), join(installStaging, SHERPA_MANIFEST_FILE))
    await replaceDirectorySafely(installStaging, finalDir, backupDir)
  }

  /**
   * 同分区安全替换目录：旧安装先改名备份，新 staging 再落正式名。
   * 新落位失败时把旧目录改回去；成功后才删备份。这样 rename 的任意一步失败
   * 都不会把原来能用的模型先删掉（`rm(finalDir) → rename` 不满足这一点）。
   */
  async function replaceDirectorySafely(
    staging: string,
    finalDir: string,
    backupDir: string
  ): Promise<void> {
    let hadPrevious = false
    let backupExists = false
    try {
      const info = await stat(finalDir)
      hadPrevious = info.isDirectory()
    } catch {
      hadPrevious = false
    }
    try {
      const info = await stat(backupDir)
      backupExists = info.isDirectory()
    } catch {
      backupExists = false
    }
    // 上次进程若恰好死在 old→backup 与 staging→final 之间，正式目录会缺失但
    // backup 仍完整。先恢复再开始新事务，绝不能把唯一可用的旧安装当垃圾删掉。
    if (!hadPrevious && backupExists) {
      await renamePath(backupDir, finalDir)
      hadPrevious = true
      backupExists = false
    }
    if (hadPrevious && backupExists) {
      // final 已在说明这是一次已完成但没来得及清理的旧事务，backup 才是陈旧副本。
      await rm(backupDir, { recursive: true, force: true })
    }
    if (hadPrevious) await renamePath(finalDir, backupDir)
    try {
      await renamePath(staging, finalDir)
    } catch (err) {
      if (hadPrevious) {
        try {
          await renamePath(backupDir, finalDir)
        } catch (rollbackErr) {
          throw new DownloaderError(
            'model-download-failed',
            `install failed and rollback failed: ${err instanceof Error ? err.message : String(err)}; rollback: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`
          )
        }
      }
      throw err
    }
    if (hadPrevious) await rm(backupDir, { recursive: true, force: true })
  }

  async function installVadFile(workDir: string): Promise<void> {
    const staging = join(workDir, 'staging')
    await mkdir(staging, { recursive: true })
    const src = join(workDir, ASR_VAD_ASSET.fileName)
    await copyFile(src, join(staging, ASR_VAD_ASSET.fileName))
    const manifest = {
      version: 1,
      files: {
        [ASR_VAD_ASSET.fileName]: {
          bytes: (await stat(src)).size,
          sha256: await sha256File(src)
        }
      }
    }
    await writeFile(join(staging, SHERPA_MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf-8')
    const finalDir = join(deps.rootDir, ASR_VAD_ASSET.dirName)
    const installStaging = join(deps.rootDir, `.${ASR_VAD_ASSET.dirName}.installing`)
    const backupDir = join(deps.rootDir, `.${ASR_VAD_ASSET.dirName}.backup`)
    await mkdir(deps.rootDir, { recursive: true })
    await rm(installStaging, { recursive: true, force: true })
    await mkdir(installStaging, { recursive: true })
    await copyFile(
      join(staging, ASR_VAD_ASSET.fileName),
      join(installStaging, ASR_VAD_ASSET.fileName)
    )
    await copyFile(join(staging, SHERPA_MANIFEST_FILE), join(installStaging, SHERPA_MANIFEST_FILE))
    await replaceDirectorySafely(installStaging, finalDir, backupDir)
  }

  // ── P3V-04：多文件直下（Hugging Face 钉死 revision + 逐文件 sha256 + 断点续传）──

  /**
   * 下载单个文件到 `.part`，支持断点续传。
   *
   * 续传逻辑：`.part` 已有 N 字节就发 `Range: bytes=N-`。
   *   - 服务端返回 206：追加写（真续传）。
   *   - 返回 200：说明它不支持 Range 或忽略了请求头，此时**必须从头重写**，
   *     否则会把完整响应追加到已有片段后面，得到一个体积对不上、hash 也对不上
   *     的垃圾文件——这是断点续传最经典的静默损坏。
   */
  async function downloadFileResumable(
    file: AsrDownloadFile,
    partPath: string,
    onBytes: (deltaBytes: number, totalForThisFile: number) => void,
    signal: AbortSignal
  ): Promise<void> {
    let existing = 0
    try {
      const info = await stat(partPath)
      if (info.isFile()) existing = info.size
    } catch {
      existing = 0 // 没有 .part，从头下
    }
    if (existing > file.bytes) {
      // 比目标还大 = 上次写坏了或上游换了文件，直接重来
      await rm(partPath, { force: true })
      existing = 0
    }
    if (existing === file.bytes) {
      onBytes(0, existing)
      return // 字节数已齐，交给后面的 sha256 判定是否可用
    }

    const headers: Record<string, string> = {}
    if (existing > 0) headers['Range'] = `bytes=${existing}-`
    const response = await deps.fetchImpl(file.url, { signal, headers })
    if (!response.ok) {
      throw new DownloaderError('model-download-failed', `HTTP ${response.status}`)
    }
    const resuming = response.status === 206
    if (existing > 0 && !resuming) {
      await rm(partPath, { force: true })
      existing = 0
    }
    if (response.body === null) {
      throw new DownloaderError('model-download-failed', 'empty body')
    }

    const out = createWriteStream(partPath, resuming ? { flags: 'a' } : { flags: 'w' })
    let received = existing
    onBytes(existing, received)
    try {
      const reader = (response.body as ReadableStream<Uint8Array>).getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        // 逐块 await 写：abort 时绝无在飞 write（同归档路径的处理，见 worklog 2026-09-01）
        await writeChunk(out, value)
        onBytes(value.byteLength, received)
      }
      await endStream(out)
    } catch (err) {
      out.destroy()
      throw err
    }
    if (received !== file.bytes) {
      throw new DownloaderError(
        'model-corrupt',
        `size mismatch for ${file.name}: got ${received}, expected ${file.bytes}`,
        'size-mismatch'
      )
    }
  }

  /**
   * 多文件模型安装：全部文件下载 + 逐文件 sha256 → 写 manifest → 原子落位。
   *
   * staging 放在模型根目录下（不是系统临时目录）：一是 `.part` 要能跨 APP 重启
   * 续传，二是 rename 到正式目录必须同分区，跨盘 rename 会失败。
   */
  async function installFileSetEngine(
    engineId: AsrEngineId,
    files: readonly AsrDownloadFile[],
    signal: AbortSignal
  ): Promise<void> {
    const dirName = deps.engineDirName(engineId)
    const staging = join(deps.rootDir, PARTIAL_DIR_NAME, dirName)
    await mkdir(staging, { recursive: true })

    const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0)
    let completedBytes = 0
    for (const file of files) {
      const completedPath = join(staging, file.name)
      // 前一次运行可能已经把这个文件下载、校验并从 .part 改成正式文件名，随后在
      // 后续文件失败/取消。重试先复验 bytes+hash，命中就复用，避免把 330MB encoder
      // 每次都重新下载；验证不通过则删掉，绝不盲信 staging。
      let reuseCompleted = false
      try {
        const info = await stat(completedPath)
        reuseCompleted = info.isFile() && info.size === file.bytes
        if (reuseCompleted) reuseCompleted = (await sha256File(completedPath)) === file.sha256
      } catch {
        reuseCompleted = false
      }
      if (reuseCompleted) {
        completedBytes += file.bytes
        setReceivingTelemetry(engineId, completedBytes, totalBytes, file.name, true)
        setState(engineId, {
          kind: 'downloading',
          progress: Math.min(0.999, completedBytes / Math.max(totalBytes, 1))
        })
        continue
      }
      await rm(completedPath, { force: true })

      const partPath = join(staging, `${file.name}.part`)
      let fileReceived = 0
      await downloadFileResumable(
        file,
        partPath,
        (delta, total) => {
          completedBytes += total - fileReceived
          fileReceived = total
          setReceivingTelemetry(engineId, completedBytes, totalBytes, file.name, true, delta)
          setState(engineId, {
            kind: 'downloading',
            progress: Math.min(0.999, completedBytes / Math.max(totalBytes, 1))
          })
        },
        signal
      )
      // 下载前就钉死的摘要：不匹配即丢弃该 .part，不留坏片段等着下次「续传」
      setPhaseTelemetry(engineId, 'verifying', { currentFile: file.name })
      setState(
        engineId,
        {
          kind: 'downloading',
          progress: Math.min(0.999, completedBytes / Math.max(totalBytes, 1))
        },
        true
      )
      const digest = await sha256File(partPath)
      if (digest !== file.sha256) {
        await rm(partPath, { force: true })
        throw new DownloaderError(
          'model-corrupt',
          `sha256 mismatch for ${file.name}`,
          'hash-mismatch'
        )
      }
      await renamePath(partPath, completedPath)
    }
    setPhaseTelemetry(engineId, 'verifying')
    setState(engineId, { kind: 'downloading', progress: 1 }, true)

    setPhaseTelemetry(engineId, 'installing')
    setState(engineId, { kind: 'installing' })
    const manifestFiles: Record<string, { bytes: number; sha256: string }> = {}
    for (const file of files) {
      manifestFiles[file.name] = { bytes: file.bytes, sha256: file.sha256 }
    }
    await writeFile(
      join(staging, SHERPA_MANIFEST_FILE),
      JSON.stringify({ version: 1, files: manifestFiles }, null, 2),
      'utf-8'
    )
    const finalDir = join(deps.rootDir, dirName)
    const backupDir = join(deps.rootDir, `.${dirName}.backup`)
    await mkdir(deps.rootDir, { recursive: true })
    await replaceDirectorySafely(staging, finalDir, backupDir)
  }

  async function runDownload(target: ModelDownloadTarget): Promise<void> {
    const controller = new AbortController()
    controllers.set(target, controller)
    // 多文件路径自带持久 staging，不需要系统临时目录。
    // 在第一个 await 前同步写状态：controller 已登记却 telemetry 仍 idle 会让 UI 闪回
    // “无任务”，也让调用方误判当前文件/可暂停能力。
    const fileSetSource = target === 'vad' ? null : resolveFileSource(target)
    const previousStatus = telemetry.get(target) ?? baseStatus(target)
    const initialFile =
      previousStatus.currentFile ?? fileSetSource?.files[0]?.name ?? archiveFileName(target)
    if (initialFile !== undefined) {
      setReceivingTelemetry(
        target,
        previousStatus.receivedBytes,
        totalBytesOf(target),
        initialFile,
        fileSetSource !== null
      )
    }
    setState(
      target,
      {
        kind: 'downloading',
        progress:
          previousStatus.totalBytes === 0
            ? 0
            : previousStatus.receivedBytes / previousStatus.totalBytes
      },
      true
    )
    if (fileSetSource !== null) {
      try {
        await installFileSetEngine(target as AsrEngineId, fileSetSource.files, controller.signal)
        setState(target, { kind: 'done' })
      } catch (err) {
        if (controller.signal.aborted) {
          if (pauseRequested.delete(target as AsrEngineId)) {
            // 先释放活动所有权再发 paused 事件；用户收到事件后立即点继续也不会撞 busy。
            controllers.delete(target)
            const previous = telemetry.get(target) ?? baseStatus(target)
            setState(target, {
              kind: 'paused',
              progress: previous.totalBytes === 0 ? 0 : previous.receivedBytes / previous.totalBytes
            })
          } else {
            setState(target, { kind: 'cancelled' })
          }
          return
        }
        const code = err instanceof DownloaderError ? err.code : 'model-download-failed'
        setState(target, {
          kind: 'error',
          code,
          ...(err instanceof DownloaderError && err.detailCode !== undefined
            ? { detailCode: err.detailCode }
            : {}),
          message: err instanceof Error ? err.message : String(err)
        })
        throw err
      } finally {
        controllers.delete(target)
        // 文件恰在 pause 请求同时完成时可能直接 done 而未走 abort 分支；清理标志，
        // 不能让下一次下载被误判成暂停。
        if (states.get(target)?.kind !== 'paused') pauseRequested.delete(target as AsrEngineId)
      }
      return
    }

    const workDir = await mkdtemp(join(tmpdir(), 'nacime-asr-'))
    try {
      if (target === 'vad') {
        await downloadTo(
          ASR_VAD_ASSET.url,
          join(workDir, ASR_VAD_ASSET.fileName),
          ASR_VAD_ASSET.bytes,
          target,
          controller.signal
        )
        await installVadFile(workDir)
      } else {
        const asset = ASR_MODEL_ASSETS[target]
        if (asset === undefined) {
          // catalogFileSource 已在上面拦掉多文件引擎；走到这里 = 目录配置自相矛盾
          throw new DownloaderError('model-download-failed', `no archive asset for ${target}`)
        }
        await downloadTo(
          asset.archiveUrl,
          join(workDir, 'archive.tar.bz2'),
          asset.archiveBytes,
          target,
          controller.signal
        )
        await installEngineFiles(workDir, target, asset)
      }
      setState(target, { kind: 'done' })
    } catch (err) {
      if (controller.signal.aborted) {
        setState(target, { kind: 'cancelled' })
        return
      }
      const code = err instanceof DownloaderError ? err.code : 'model-download-failed'
      setState(target, {
        kind: 'error',
        code,
        ...(err instanceof DownloaderError && err.detailCode !== undefined
          ? { detailCode: err.detailCode }
          : {}),
        message: err instanceof Error ? err.message : String(err)
      })
      throw err
    } finally {
      controllers.delete(target)
      await rm(workDir, { recursive: true, force: true })
    }
  }

  return {
    state(target) {
      return states.get(target) ?? { kind: 'idle' }
    },

    status(target) {
      return telemetry.get(target) ?? baseStatus(target)
    },

    isActive(target) {
      // controller 在 runDownload 入口同步注册、finally 才删除；用它覆盖「第一块网络
      // 数据尚未到、state 仍 idle」的窗口，避免重复下载/删除与刚启动的下载竞态。
      if (controllers.has(target)) return true
      const kind = states.get(target)?.kind
      return kind === 'downloading' || kind === 'extracting' || kind === 'installing'
    },

    async download(target) {
      if (controllers.has(target)) {
        throw new Error(`download already active: ${target}`)
      }
      await runDownload(target)
    },

    cancel(target) {
      pauseRequested.delete(target as AsrEngineId)
      const controller = controllers.get(target)
      if (controller !== undefined) {
        controller.abort()
        return true
      }
      const current = states.get(target)
      if (current?.kind === 'paused') {
        setState(target, { kind: 'cancelled' })
        return true
      }
      return false
    },

    pause(target) {
      const currentStatus = telemetry.get(target)
      if (
        !isResumable(target) ||
        currentStatus?.state !== 'downloading' ||
        currentStatus.phase !== 'receiving'
      ) {
        return false
      }
      const controller = controllers.get(target)
      if (controller === undefined) return false
      pauseRequested.add(target)
      controller.abort()
      return true
    },

    resume(target) {
      const paused = states.get(target)
      if (!isResumable(target) || paused?.kind !== 'paused') return false
      if (controllers.has(target)) return false
      const task = runDownload(target)
      // runDownload 调用时已同步登记 controller；立即推送 downloading，避免 UI 在用户
      // 点继续后仍停在 paused，且第二次 resume 会被 controller 守卫拒绝。
      setState(target, { kind: 'downloading', progress: paused.progress }, true)
      void task.catch(() => {
        /* 状态已写入；恢复入口即发即回 */
      })
      return true
    },

    async deleteModel(engineId) {
      // controllers 覆盖 downloading/extracting/installing 全生命周期（finally 才删除）
      if (controllers.has(engineId)) return false
      const dirName = deps.engineDirName(engineId)
      await Promise.all([
        rm(join(deps.rootDir, dirName), { recursive: true, force: true }),
        // 只删这个引擎的断点目录，不影响其他模型正在/暂停的 .part
        rm(join(deps.rootDir, PARTIAL_DIR_NAME, dirName), { recursive: true, force: true }),
        // 安装事务的陈旧 staging/backup 也归这个引擎所有
        rm(join(deps.rootDir, `.${dirName}.installing`), { recursive: true, force: true }),
        rm(join(deps.rootDir, `.${dirName}.backup`), { recursive: true, force: true })
      ])
      pauseRequested.delete(engineId)
      speedSamples.delete(engineId)
      setState(engineId, { kind: 'idle' }, true)
      return true
    }
  }
}

/** 生产解压器：系统 bsdtar（Windows 10+ 自带；windowsHide 不闪窗）。 */
export function createTarExtractor(logger?: {
  warn(message: string, meta?: unknown): void
}): (archivePath: string, destDir: string) => Promise<void> {
  return async (archivePath, destDir) => {
    await mkdir(destDir, { recursive: true })
    await new Promise<void>((resolve, reject) => {
      const child = spawn('tar', ['-xjf', archivePath, '-C', destDir], {
        windowsHide: true
      })
      let stderr = ''
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString('utf-8')
      })
      child.on('error', (err) => {
        reject(new Error(`tar spawn failed: ${err.message}`))
      })
      child.on('close', (code) => {
        if (code === 0) {
          resolve()
        } else {
          logger?.warn('tar extract failed', { stderr: stderr.slice(0, 500) })
          reject(new Error(`tar exited with ${code}`))
        }
      })
    })
  }
}
