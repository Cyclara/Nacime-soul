// src/main/voice/tts/gpt-runtime-manager.ts
// P3V-16：GPT-SoVITS 官方整合包下载器与安装器（8GB 级；main-only）。
//
// 资产事实（gpt-runtime-catalog 头注释，2026-09-03 实测核验）：两变体 .7z 归档、
// 三镜像同 hash、Windows 自带 bsdtar 可解 7z（LZMA2 实测）。
//
// 状态机（与 ASR model-downloader 同款语义，独立实现——目标结构完全不同：
// 单文件 8GB + 整树安装，且哈希是下载前预置而非下载后自证）：
//   idle → downloading{progress} → verifying → extracting → installing → done
//   暂停（仅 receiving）：downloading ⇄ paused（保留 .part，Range 续传）
//   失败/中止 → error{code} / cancelled；错误码走 AssetDownloadErrorCode 闭集
//
// 安装事务（不破坏已有安装）：
//   .part 校验通过 → 解压到暂存 extracted/ → root marker 校验 → 写 Nacime meta
//   → 同分区双 rename（旧安装→backup、staging→final；任一步失败回滚；崩溃恢复
//   下次先还原 backup）→ 成功后清理归档与暂存。
//   失败只清理 staging（.part 保留断点；hash/size 证伪的 .part 删除）。
//
// 空间纪律：下载前检查资源根 ≥ GPT_RUNTIME_MIN_FREE_BYTES（20GB，handoff §7 口径）；
// 峰值（归档 8GB + 解压 ~16GB）超出时安装自然失败并清理，不伤已有安装。
//
// 路径纪律：所有绝对路径（.part / extracted / 安装根）只在本文件与组合根出现；
// renderer 经 AssetDownloadStatus 只见 assetId/basename/字节数。

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readFileSync,
  type WriteStream
} from 'node:fs'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  AssetDownloadErrorCode,
  AssetDownloadPhase,
  AssetDownloadStatus
} from '@shared/voice/asset-root-types'
import {
  GPT_RUNTIME_CATALOG,
  GPT_RUNTIME_INSTALL_DIR_NAME,
  GPT_RUNTIME_MARKERS,
  GPT_RUNTIME_META_FILE,
  GPT_RUNTIME_MIN_FREE_BYTES,
  GPT_RUNTIME_PARTIAL_DIR_NAME,
  type GptRuntimePackage,
  type GptRuntimeVariant
} from './gpt-runtime-catalog'

export type GptRuntimeState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'downloading'; readonly progress: number }
  | { readonly kind: 'paused'; readonly progress: number }
  | { readonly kind: 'verifying' }
  | { readonly kind: 'extracting' }
  | { readonly kind: 'installing' }
  | { readonly kind: 'done' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'error'; readonly code: AssetDownloadErrorCode; readonly message: string }

/** 已安装 runtime 的 main 内视图（rootDir 不出 main；renderer 只见 variant/时间）。 */
export interface GptRuntimeInstallation {
  readonly variant: GptRuntimeVariant
  readonly rootDir: string
  readonly installedAt: number
}

export interface GptRuntimeManagerDeps {
  /** 资源根目录（生产 assetRoot.root()；换根重启生效由 AssetRootService 保证）。 */
  readonly assetRootDir: () => string
  /** secureFetch 实例（https 公网 + 重定向复验）。 */
  readonly fetchImpl: typeof globalThis.fetch
  /** 资源根剩余字节（生产查盘；测试注入）。null = 查询失败（按不足处理）。 */
  readonly freeBytes: () => number | null
  /** 下载/安装状态变化（生产桥到 asset-download 事件推送）。 */
  readonly onStateChange?: (variant: GptRuntimeVariant, state: GptRuntimeState) => void
  /** 进度节流间隔（默认 100ms；kind 变化不节流）。 */
  readonly progressThrottleMs?: number
  /** 归档解压（生产 = 系统 bsdtar；测试注入）。 */
  readonly extractArchive?: (archivePath: string, destDir: string) => Promise<void>
  /** 注入 rename（测试回滚分支）；默认 node:fs/promises.rename。 */
  readonly renamePath?: (oldPath: string, newPath: string) => Promise<void>
  /** GPU 名检测（生产 = PowerShell Win32_VideoController；测试注入）。 */
  readonly gpuName?: () => Promise<string | null>
  /** 单测注入小包定义（bytes/sha256/镜像）；生产省略时读钉死的 main-only catalog。 */
  readonly resolvePackage?: (variant: GptRuntimeVariant) => GptRuntimePackage
}

export interface GptRuntimeManager {
  state(variant: GptRuntimeVariant): GptRuntimeState
  /** 下载中心 DTO 投影；assetId = `gpt-runtime-${variant}`，不含路径。 */
  status(variant: GptRuntimeVariant): AssetDownloadStatus
  /** 已安装 runtime（读 meta + marker 校验；未装/损坏返回 null）。 */
  installed(): GptRuntimeInstallation | null
  /** 下载并安装。**长任务**：生产调用方不 await（状态经 onStateChange 流转）。 */
  download(variant: GptRuntimeVariant): Promise<void>
  /** 暂停 receiving 阶段下载（保留 .part）；其他阶段返回 false。 */
  pause(variant: GptRuntimeVariant): boolean
  /** 从 paused 的 .part 继续；非 paused 返回 false。 */
  resume(variant: GptRuntimeVariant): boolean
  /** 中止（.part 保留断点）；无进行中返回 false。 */
  cancel(variant: GptRuntimeVariant): boolean
  /** downloading/verifying/extracting/installing 任一阶段。 */
  isActive(variant: GptRuntimeVariant): boolean
  /** 删除已安装 runtime 与全部暂存（用户确认后调用）。进行中拒绝。 */
  deleteRuntime(): Promise<boolean>
  /** GPU 推荐（RTX 50 系 → rtx50；有 NVIDIA 非 50 系 → standard；检测失败 null）。 */
  recommendedVariant(): Promise<GptRuntimeVariant | null>
}

/** Windows 自带 bsdtar 绝对路径（不经 PATH——防 PATH 劫持；Win10 1803+ 自带）。 */
function systemTarPath(): string {
  const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows'
  return join(systemRoot, 'System32', 'tar.exe')
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
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

class GptRuntimeError extends Error {
  readonly code: AssetDownloadErrorCode
  constructor(code: AssetDownloadErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

function abortError(): Error {
  const err = new Error('gpt runtime download aborted')
  err.name = 'AbortError'
  return err
}

interface RuntimeMeta {
  readonly variant: GptRuntimeVariant
  readonly installedAt: number
}

function readMetaFile(rootDir: string): RuntimeMeta | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(rootDir, GPT_RUNTIME_META_FILE), 'utf-8'))
    if (typeof raw === 'object' && raw !== null) {
      const v = raw as Record<string, unknown>
      if (
        (v['variant'] === 'standard' || v['variant'] === 'rtx50') &&
        typeof v['installedAt'] === 'number'
      ) {
        return { variant: v['variant'], installedAt: v['installedAt'] }
      }
    }
  } catch {
    /* 缺失/损坏 → 未安装 */
  }
  return null
}

export function createGptRuntimeManager(deps: GptRuntimeManagerDeps): GptRuntimeManager {
  const states = new Map<GptRuntimeVariant, GptRuntimeState>()
  const controllers = new Map<GptRuntimeVariant, AbortController>()
  const pauseRequested = new Set<GptRuntimeVariant>()
  const telemetry = new Map<GptRuntimeVariant, AssetDownloadStatus>()
  const throttleMs = deps.progressThrottleMs ?? 100
  const lastEmitAt = new Map<GptRuntimeVariant, number>()
  const speedSamples = new Map<GptRuntimeVariant, { at: number; speed: number }>()
  const renamePath = deps.renamePath ?? rename
  const extractArchive =
    deps.extractArchive ??
    (async (archivePath: string, destDir: string): Promise<void> => {
      await mkdir(destDir, { recursive: true })
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(systemTarPath(), ['-xf', archivePath, '-C', destDir], {
          windowsHide: true
        })
        proc.on('error', reject)
        proc.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`bsdtar exited with ${code}`))
        })
      })
    })

  function assetId(variant: GptRuntimeVariant): string {
    return `gpt-runtime-${variant}`
  }

  const resolvePackage =
    deps.resolvePackage ?? ((variant: GptRuntimeVariant) => GPT_RUNTIME_CATALOG[variant])

  function pkg(variant: GptRuntimeVariant): GptRuntimePackage {
    return resolvePackage(variant)
  }

  function installRoot(): string {
    return join(deps.assetRootDir(), GPT_RUNTIME_INSTALL_DIR_NAME)
  }

  function partialDir(): string {
    return join(deps.assetRootDir(), GPT_RUNTIME_PARTIAL_DIR_NAME)
  }

  function partPath(variant: GptRuntimeVariant): string {
    return join(partialDir(), `${pkg(variant).fileName}.part`)
  }

  function extractedDir(variant: GptRuntimeVariant): string {
    return join(partialDir(), `extracted-${variant}`)
  }

  function baseStatus(variant: GptRuntimeVariant): AssetDownloadStatus {
    return {
      assetId: assetId(variant),
      state: 'idle',
      receivedBytes: 0,
      totalBytes: pkg(variant).bytes,
      resumable: true
    }
  }

  function setReceivingTelemetry(
    variant: GptRuntimeVariant,
    receivedBytes: number,
    networkDeltaBytes: number
  ): void {
    const total = pkg(variant).bytes
    const now = Date.now()
    const previous = speedSamples.get(variant)
    let speed = previous?.speed ?? 0
    if (previous !== undefined && now > previous.at && networkDeltaBytes > 0) {
      speed = Math.max(0, Math.round((networkDeltaBytes * 1_000) / (now - previous.at)))
    }
    speedSamples.set(variant, { at: now, speed })
    telemetry.set(variant, {
      assetId: assetId(variant),
      state: 'downloading',
      receivedBytes: Math.min(Math.max(0, Math.round(receivedBytes)), total),
      totalBytes: total,
      currentFile: pkg(variant).fileName,
      phase: 'receiving',
      speedBytesPerSec: speed,
      resumable: true
    })
  }

  function setPhaseTelemetry(variant: GptRuntimeVariant, phase: AssetDownloadPhase): void {
    const previous = telemetry.get(variant) ?? baseStatus(variant)
    telemetry.set(variant, {
      assetId: previous.assetId,
      state: 'downloading',
      receivedBytes: previous.receivedBytes,
      totalBytes: previous.totalBytes,
      currentFile: pkg(variant).fileName,
      phase,
      speedBytesPerSec: 0,
      resumable: false
    })
  }

  function syncTelemetry(variant: GptRuntimeVariant, state: GptRuntimeState): void {
    const previous = telemetry.get(variant) ?? baseStatus(variant)
    switch (state.kind) {
      case 'idle':
        telemetry.set(variant, baseStatus(variant))
        break
      case 'downloading':
        if (previous.state !== 'downloading') {
          telemetry.set(variant, {
            assetId: previous.assetId,
            state: 'downloading',
            receivedBytes: Math.min(
              previous.totalBytes,
              Math.max(previous.receivedBytes, Math.round(previous.totalBytes * state.progress))
            ),
            totalBytes: previous.totalBytes,
            currentFile: pkg(variant).fileName,
            phase: 'receiving',
            speedBytesPerSec: 0,
            resumable: true
          })
        }
        break
      case 'paused':
        telemetry.set(variant, {
          assetId: previous.assetId,
          state: 'paused',
          receivedBytes: previous.receivedBytes,
          totalBytes: previous.totalBytes,
          currentFile: pkg(variant).fileName,
          phase: 'receiving',
          speedBytesPerSec: 0,
          resumable: true
        })
        break
      case 'verifying':
        setPhaseTelemetry(variant, 'verifying')
        break
      case 'extracting':
        setPhaseTelemetry(variant, 'extracting')
        break
      case 'installing':
        setPhaseTelemetry(variant, 'installing')
        break
      case 'done':
        telemetry.set(variant, {
          assetId: previous.assetId,
          state: 'done',
          receivedBytes: previous.totalBytes,
          totalBytes: previous.totalBytes,
          speedBytesPerSec: 0,
          resumable: true
        })
        break
      case 'cancelled':
        telemetry.set(variant, {
          assetId: previous.assetId,
          state: 'cancelled',
          receivedBytes: previous.receivedBytes,
          totalBytes: previous.totalBytes,
          currentFile: pkg(variant).fileName,
          speedBytesPerSec: 0,
          resumable: true,
          errorCode: 'cancelled'
        })
        break
      case 'error':
        telemetry.set(variant, {
          assetId: previous.assetId,
          state: 'error',
          receivedBytes: previous.receivedBytes,
          totalBytes: previous.totalBytes,
          currentFile: pkg(variant).fileName,
          speedBytesPerSec: 0,
          resumable: true,
          errorCode: state.code
        })
        break
    }
  }

  function setState(variant: GptRuntimeVariant, state: GptRuntimeState, forceEmit = false): void {
    const prev = states.get(variant)
    states.set(variant, state)
    syncTelemetry(variant, state)
    if (deps.onStateChange === undefined) return
    const kindChanged = prev === undefined || prev.kind !== state.kind
    if (!kindChanged && !forceEmit) {
      const now = Date.now()
      if (now - (lastEmitAt.get(variant) ?? 0) < throttleMs) return
      lastEmitAt.set(variant, now)
    } else {
      lastEmitAt.set(variant, Date.now())
    }
    deps.onStateChange(variant, state)
  }

  /**
   * 单文件可续传下载：`.part` 已有 N 字节就发 `Range: bytes=N-`；返回 200 时
   * 覆盖重写。镜像按序回退（网络错误/非 2xx 都换下一个；Range 语义每镜像独立
   * 成立——三源均实测支持 206）。
   */
  async function downloadPart(variant: GptRuntimeVariant, signal: AbortSignal): Promise<void> {
    const asset = pkg(variant)
    const dest = partPath(variant)
    await mkdir(dirname(dest), { recursive: true })
    let existing = 0
    try {
      const info = await stat(dest)
      if (info.isFile()) existing = info.size
    } catch {
      existing = 0
    }
    if (existing > asset.bytes) {
      await rm(dest, { force: true })
      existing = 0
    }
    if (existing === asset.bytes) {
      setReceivingTelemetry(variant, existing, 0)
      return
    }

    let lastError: unknown = null
    for (const url of asset.mirrors) {
      if (signal.aborted) throw abortError()
      const headers: Record<string, string> = {}
      if (existing > 0) headers['Range'] = `bytes=${existing}-`
      let response: Response
      try {
        response = await deps.fetchImpl(url, { signal, headers })
      } catch (err) {
        if (signal.aborted) throw abortError()
        lastError = err
        continue // 镜像回退
      }
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}`)
        continue
      }
      if (response.body === null) {
        lastError = new Error('empty body')
        continue
      }
      const resuming = response.status === 206
      if (existing > 0 && !resuming) {
        await rm(dest, { force: true })
        existing = 0
      }
      const out = createWriteStream(dest, resuming ? { flags: 'a' } : { flags: 'w' })
      let received = existing
      setReceivingTelemetry(variant, received, 0)
      setState(
        variant,
        { kind: 'downloading', progress: asset.bytes > 0 ? received / asset.bytes : 0 },
        true
      )
      try {
        const reader = (response.body as ReadableStream<Uint8Array>).getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          received += value.byteLength
          // 逐块 await 写：abort 时绝无在飞 write（ASR 下载器同款竞态修复）
          await writeChunk(out, value)
          setReceivingTelemetry(variant, received, value.byteLength)
          setState(variant, {
            kind: 'downloading',
            progress: Math.min(0.999, received / asset.bytes)
          })
        }
        await endStream(out)
      } catch (err) {
        out.destroy()
        throw err
      }
      if (received !== asset.bytes) {
        throw new GptRuntimeError(
          'size-mismatch',
          `size mismatch: got ${received}, expected ${asset.bytes}`
        )
      }
      return
    }
    throw new GptRuntimeError(
      'download-failed',
      `all mirrors failed${lastError instanceof Error ? `: ${lastError.message}` : ''}`
    )
  }

  async function verifyArchive(variant: GptRuntimeVariant): Promise<void> {
    const asset = pkg(variant)
    setState(variant, { kind: 'verifying' })
    const digest = await sha256File(partPath(variant))
    if (digest !== asset.sha256) {
      // 哈希证伪的 .part 没有续传价值，删除防止下次 resume 复用坏断点
      await rm(partPath(variant), { force: true })
      throw new GptRuntimeError(
        'hash-mismatch',
        `sha256 mismatch for ${asset.fileName}: got ${digest}`
      )
    }
  }

  async function extractAndInstall(variant: GptRuntimeVariant): Promise<void> {
    const asset = pkg(variant)
    const extractDir = extractedDir(variant)
    await mkdir(partialDir(), { recursive: true })
    await rm(extractDir, { recursive: true, force: true })

    setState(variant, { kind: 'extracting' })
    await extractArchive(partPath(variant), extractDir)
    const topDir = join(extractDir, asset.archiveTopDir)
    try {
      const info = await stat(topDir)
      if (!info.isDirectory()) {
        throw new GptRuntimeError('extract-failed', 'top dir is not a directory')
      }
    } catch {
      throw new GptRuntimeError('extract-failed', `archive top dir missing: ${asset.archiveTopDir}`)
    }

    // root marker 校验（runtime/python.exe、api_v2.py、配置与预训练资源）
    for (const marker of GPT_RUNTIME_MARKERS) {
      if (!existsSync(join(topDir, marker))) {
        throw new GptRuntimeError('extract-failed', `root marker missing: ${marker}`)
      }
    }

    setState(variant, { kind: 'installing' })
    await writeFile(
      join(topDir, GPT_RUNTIME_META_FILE),
      JSON.stringify({ variant, installedAt: Date.now() }, null, 2),
      'utf-8'
    )
    await replaceDirectorySafely(
      topDir,
      installRoot(),
      join(deps.assetRootDir(), `.${GPT_RUNTIME_INSTALL_DIR_NAME}.backup`)
    )
    // 成功：清理归档与整个下载暂存区（backup 已由 replaceDirectorySafely 成功路径删除）
    await rm(partialDir(), { recursive: true, force: true })
  }

  /**
   * 同分区安全替换（ASR 安装器同款事务）：旧安装先改名备份，新目录再落正式名；
   * 失败回滚；崩溃恢复——下次先还原 backup，绝不把唯一可用安装当垃圾删。
   */
  async function replaceDirectorySafely(
    staging: string,
    finalDir: string,
    backupDir: string
  ): Promise<void> {
    let hadPrevious = false
    let backupExists = false
    try {
      hadPrevious = (await stat(finalDir)).isDirectory()
    } catch {
      hadPrevious = false
    }
    try {
      backupExists = (await stat(backupDir)).isDirectory()
    } catch {
      backupExists = false
    }
    if (!hadPrevious && backupExists) {
      await renamePath(backupDir, finalDir)
      hadPrevious = true
      backupExists = false
    }
    if (hadPrevious && backupExists) {
      await rm(backupDir, { recursive: true, force: true })
    }
    if (hadPrevious) await renamePath(finalDir, backupDir)
    try {
      await renamePath(staging, finalDir)
    } catch (err) {
      if (hadPrevious) {
        try {
          await renamePath(backupDir, finalDir)
        } catch {
          /* 回滚失败：backup 仍在，下次启动恢复；正式位缺失由 installed() 报未装 */
        }
      }
      throw err
    }
    if (hadPrevious) {
      await rm(backupDir, { recursive: true, force: true })
    }
  }

  /** 失败清理：只删解压暂存（.part 断点保留；hash/size 证伪的 .part 删除）。 */
  async function cleanupStaging(
    variant: GptRuntimeVariant,
    code: AssetDownloadErrorCode
  ): Promise<void> {
    if (code === 'hash-mismatch' || code === 'size-mismatch') {
      await rm(partPath(variant), { force: true })
    }
    await rm(extractedDir(variant), { recursive: true, force: true })
  }

  function pausedProgress(variant: GptRuntimeVariant): number {
    const snapshot = telemetry.get(variant)
    const total = pkg(variant).bytes
    if (snapshot !== undefined && total > 0) {
      return Math.min(0.999, snapshot.receivedBytes / total)
    }
    return 0
  }

  async function runDownload(variant: GptRuntimeVariant): Promise<void> {
    const controller = new AbortController()
    controllers.set(variant, controller)
    try {
      const free = deps.freeBytes()
      if (free === null || free < GPT_RUNTIME_MIN_FREE_BYTES) {
        throw new GptRuntimeError('disk-full', 'insufficient free space (need ~20GB)')
      }
      await downloadPart(variant, controller.signal)
      await verifyArchive(variant)
      await extractAndInstall(variant)
      setState(variant, { kind: 'done' }, true)
    } catch (err) {
      if (pauseRequested.has(variant) && controller.signal.aborted) {
        // 暂停：controller 已摘（见 pause()），断点保留在 .part
        setState(variant, { kind: 'paused', progress: pausedProgress(variant) }, true)
        return
      }
      if (controller.signal.aborted) {
        setState(variant, { kind: 'cancelled' }, true)
        return
      }
      if (err instanceof GptRuntimeError) {
        await cleanupStaging(variant, err.code)
        setState(variant, { kind: 'error', code: err.code, message: err.message }, true)
        return
      }
      await cleanupStaging(variant, 'download-failed')
      setState(
        variant,
        {
          kind: 'error',
          code: 'download-failed',
          message: err instanceof Error ? err.message : String(err)
        },
        true
      )
    } finally {
      controllers.delete(variant)
      pauseRequested.delete(variant)
      speedSamples.delete(variant)
    }
  }

  return {
    state(variant) {
      return states.get(variant) ?? { kind: 'idle' }
    },
    status(variant) {
      return telemetry.get(variant) ?? baseStatus(variant)
    },
    installed() {
      const rootDir = installRoot()
      const meta = readMetaFile(rootDir)
      if (meta === null) return null
      // meta 在场只代表装过；markers 完整才代表可用（防用户手删子目录）
      for (const marker of GPT_RUNTIME_MARKERS) {
        if (!existsSync(join(rootDir, marker))) return null
      }
      return { variant: meta.variant, rootDir, installedAt: meta.installedAt }
    },
    download(variant) {
      const current = states.get(variant)
      if (
        current !== undefined &&
        (current.kind === 'downloading' ||
          current.kind === 'verifying' ||
          current.kind === 'extracting' ||
          current.kind === 'installing')
      ) {
        return Promise.resolve()
      }
      const task = runDownload(variant)
      setState(variant, { kind: 'downloading', progress: 0 }, true)
      // 调用方即发即回；异常已在 runDownload 内部转状态，Promise 永不 reject
      void task
      return Promise.resolve()
    },
    pause(variant) {
      const current = states.get(variant)
      const controller = controllers.get(variant)
      if (current?.kind !== 'downloading' || controller === undefined) return false
      if (telemetry.get(variant)?.phase !== 'receiving') return false
      pauseRequested.add(variant)
      // 先摘 controller 再 abort：广播 paused 时 resume 不会撞 busy（ASR 同款竞态处理）
      controllers.delete(variant)
      controller.abort()
      return true
    },
    resume(variant) {
      const current = states.get(variant)
      if (current?.kind !== 'paused' || controllers.has(variant)) return false
      const task = runDownload(variant)
      setState(variant, { kind: 'downloading', progress: current.progress }, true)
      void task
      return true
    },
    cancel(variant) {
      const current = states.get(variant)
      if (current?.kind === 'paused' && !controllers.has(variant)) {
        // paused 无进行中任务：直接转 cancelled（.part 保留——重下复用断点）
        setState(variant, { kind: 'cancelled' }, true)
        return true
      }
      const controller = controllers.get(variant)
      if (controller === undefined) return false
      pauseRequested.delete(variant)
      controller.abort()
      return true
    },
    isActive(variant) {
      const kind = states.get(variant)?.kind
      return (
        kind === 'downloading' ||
        kind === 'verifying' ||
        kind === 'extracting' ||
        kind === 'installing'
      )
    },
    async deleteRuntime() {
      for (const variant of Object.keys(GPT_RUNTIME_CATALOG) as GptRuntimeVariant[]) {
        if (this.isActive(variant)) return false
      }
      await rm(installRoot(), { recursive: true, force: true })
      await rm(partialDir(), { recursive: true, force: true })
      for (const variant of Object.keys(GPT_RUNTIME_CATALOG) as GptRuntimeVariant[]) {
        speedSamples.delete(variant)
        setState(variant, { kind: 'idle' }, true)
      }
      return true
    },
    async recommendedVariant() {
      const detect = deps.gpuName
      if (detect === undefined) return null
      const name = await detect()
      if (name === null) return null
      // RTX 50 系（5050/5060/5070/5080/5090 及 Ti/Laptop 变体）→ rtx50；
      // 其他 NVIDIA → standard；无 NVIDIA → null（用户自选，不替无卡用户拍板）
      if (/RTX\s*50\d{2}/i.test(name)) return 'rtx50'
      if (/NVIDIA/i.test(name)) return 'standard'
      return null
    }
  }
}
