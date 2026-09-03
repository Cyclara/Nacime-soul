// src/main/voice/asr/engine-manager.ts
// P3B-14：ASR 引擎管理器（组合根：引擎选择 + 模型下载 + VAD 模型生命周期）。
//
// 冻结政策落实（P3B-11 funasr-provider.ts 头注释）：
//   - **仅用户显式选择**：selectEngine 是唯一切换路径，配置持久化
//     （voice.asrEngineId，账本登记）；Sherpa 失败绝不静默回落 FunASR。
//   - **切换 = 丢弃旧实例 + 新引擎完整重载**：engineInstances 只保留选中引擎；
//     丢弃即释放引用（recognizer 由 napi finalizer 托管，P3B-10 纪律），
//     两引擎不同时持有原生实例。
//   - **下载可中止、状态可读**：委托 ModelDownloader；下载引擎时若 VAD 模型
//     缺失会一并下载（语音输入的前置依赖，一次点击 = 语音可用）。
//
// overview 的 modelState 语义（UI「下载/就绪/错误」）：
//   - downloader 活动态（downloading/extracting/installing/error/cancelled）优先；
//   - 否则模型文件在场（modelStore.discover）→ 'ready'（懒加载，可立即用）；
//   - 否则 'not-downloaded'（UI 显示下载按钮）。
// 引擎实例的 AsrEngine.state 只在 loadModel 后才是 'ready'——那是推理侧状态，
// 不直接进 overview（overview 表达「是否可用」）。

import { statSync } from 'node:fs'
import { AsrEngineError } from './engine-error'
import { createAsrFileSetStore, createAsrModelStore, type AsrFileSetStore } from './model-store'
import { createSherpaSenseVoiceEngine, SHERPA_SENSEVOICE_ENGINE_ID } from './sherpa-provider'
import { createFunasrParaformerEngine, FUNASR_PARAFORMER_ENGINE_ID } from './funasr-provider'
import { createParakeetEngine, PARAKEET_TDT_V2_ENGINE_ID } from './parakeet-provider'
import { createSherpaStreamingEngine } from './streaming-provider'
import type {
  SherpaOfflineBinding,
  SherpaOfflineTransducerBinding,
  SherpaOnlineBinding
} from './sherpa-binding'
import type { SileroVadBinding } from '../vad/silero-binding'
import {
  ASR_VAD_ASSET,
  createModelDownloader,
  type ModelDownloader,
  type ModelDownloadState
} from './model-downloader'
import {
  ASR_ENGINE_DOWNLOAD_CATALOG,
  asrEngineDirName,
  asrEngineDownloadBytes,
  asrEngineRequiredFiles
} from './download-catalog'
import type { AsrEngine, AsrErrorCode, AsrModelState } from '@shared/voice/asr-types'
import type { AsrStreamingEngine } from '@shared/voice/asr-stream-types'
import {
  isStreamingAsrEngineId,
  type AsrEngineId,
  type AsrOverview,
  type OfflineAsrEngineId,
  type StreamingAsrEngineId
} from '@shared/voice/asr-settings-types'
import { ASR_MODEL_CATALOG, findAsrModelCatalogEntry } from '@shared/voice/asr-catalog'

/**
 * 引擎显示名取自 shared 目录（首次设置向导、设置页、日志用同一个名字）。
 * P3V-01 前这里有一份独立的中文标签表，与目录并存必然漂移，已删。
 */
function engineLabel(engineId: AsrEngineId): string {
  return findAsrModelCatalogEntry(engineId)?.label ?? engineId
}

/**
 * 离线引擎工厂（走冻结的 AsrEngine ABI）。
 * `Record<OfflineAsrEngineId, …>`：加了离线引擎却忘了配工厂即 typecheck 失败。
 */
const OFFLINE_ENGINE_FACTORIES: Record<
  OfflineAsrEngineId,
  (deps: { binding: AsrNativeBinding; rootDir: string }) => AsrEngine
> = {
  'sherpa-sensevoice': ({ binding, rootDir }) =>
    createSherpaSenseVoiceEngine({
      binding,
      modelStore: createAsrModelStore(rootDir, { dirName: asrEngineDirName('sherpa-sensevoice') })
    }),
  'funasr-paraformer': ({ binding, rootDir }) =>
    createFunasrParaformerEngine({
      binding,
      modelStore: createAsrModelStore(rootDir, { dirName: asrEngineDirName('funasr-paraformer') })
    }),
  'parakeet-tdt-v2': ({ binding, rootDir }) => {
    const runtime = ASR_ENGINE_DOWNLOAD_CATALOG['parakeet-tdt-v2'].runtime
    if (runtime.kind !== 'offline-transducer') {
      throw new AsrEngineError('engine-init-failed', 'parakeet runtime spec mismatch')
    }
    return createParakeetEngine({
      binding,
      modelStore: fileSetStoreOf(rootDir, 'parakeet-tdt-v2'),
      runtime
    })
  }
}

/** 流式引擎工厂（走 P3V-02 新增的 AsrStreamingEngine ABI）。 */
const STREAMING_ENGINE_FACTORIES: Record<
  StreamingAsrEngineId,
  (deps: { binding: AsrNativeBinding; rootDir: string }) => AsrStreamingEngine
> = {
  'zipformer-bilingual-zh-en': (deps) => makeStreamingEngine(deps, 'zipformer-bilingual-zh-en'),
  'paraformer-bilingual-zh-en': (deps) => makeStreamingEngine(deps, 'paraformer-bilingual-zh-en'),
  'zipformer-streaming-zh-14m': (deps) => makeStreamingEngine(deps, 'zipformer-streaming-zh-14m')
}

/** 原生绑定的全部能力（生产由 createNodeSherpaBinding 一并提供）。 */
export type AsrNativeBinding = SherpaOfflineBinding &
  SherpaOfflineTransducerBinding &
  SherpaOnlineBinding

function fileSetStoreOf(rootDir: string, engineId: AsrEngineId): AsrFileSetStore {
  return createAsrFileSetStore(rootDir, {
    dirName: asrEngineDirName(engineId),
    files: asrEngineRequiredFiles(engineId)
  })
}

function makeStreamingEngine(
  deps: { binding: AsrNativeBinding; rootDir: string },
  engineId: StreamingAsrEngineId
): AsrStreamingEngine {
  const runtime = ASR_ENGINE_DOWNLOAD_CATALOG[engineId].runtime
  if (runtime.kind !== 'online-transducer' && runtime.kind !== 'online-paraformer') {
    throw new AsrEngineError('engine-init-failed', `${engineId} runtime spec is not online`)
  }
  return createSherpaStreamingEngine({
    binding: deps.binding,
    modelStore: fileSetStoreOf(deps.rootDir, engineId),
    engineId,
    runtime
  })
}

/** 编译期互检：shared 的 AsrEngineId 与 main 侧常量一致（任一侧漂移即失败）。 */
const ENGINE_ID_CHECK: Record<OfflineAsrEngineId, string> = {
  'sherpa-sensevoice': SHERPA_SENSEVOICE_ENGINE_ID,
  'funasr-paraformer': FUNASR_PARAFORMER_ENGINE_ID,
  'parakeet-tdt-v2': PARAKEET_TDT_V2_ENGINE_ID
}
void ENGINE_ID_CHECK

const VAD_MODEL_PATH = `${ASR_VAD_ASSET.dirName}/${ASR_VAD_ASSET.fileName}`

export interface AsrEngineManagerDeps {
  /** 模型根目录（生产 userData/models/asr）。 */
  readonly rootDir: string
  readonly binding: AsrNativeBinding
  readonly vadBinding: SileroVadBinding
  /** 主引擎 id（接线处解析 asrPrimaryEngineId ?? asrEngineId 兼容迁移）。 */
  readonly getSelectedEngineId: () => AsrEngineId
  /** 持久化主引擎（接线处双写 asrPrimaryEngineId + asrEngineId 兼容键）。 */
  readonly setSelectedEngineId: (engineId: AsrEngineId) => Promise<boolean>
  /** P3V-09：备用引擎 id（null = 未设备用）。 */
  readonly getFallbackEngineId: () => AsrEngineId | null
  /** P3V-09：持久化备用（null = 清除）。 */
  readonly setFallbackEngineId: (engineId: AsrEngineId | null) => Promise<boolean>
  /** 下载器（可注入假件；默认自建并接 createTarExtractor）。 */
  readonly downloader?: ModelDownloader
  readonly extractArchive?: (archivePath: string, destDir: string) => Promise<void>
  readonly onOverviewChange?: () => void
}

export interface AsrEngineManager {
  getOverview(): AsrOverview
  /**
   * 指定**离线**引擎懒加载（主/备共用入口；loadModel 幂等）。
   * 模型缺失抛 AsrEngineError('model-missing')；给流式引擎 id 抛
   * 'engine-init-failed'——调用方应先用 isStreamingAsrEngineId 分流。
   */
  ensureEngineReady(engineId: AsrEngineId): Promise<AsrEngine>
  /** 指定**流式**引擎懒加载；给离线引擎 id 抛 'engine-init-failed'。 */
  ensureStreamingEngineReady(engineId: AsrEngineId): Promise<AsrStreamingEngine>
  /** 显式切换主引擎（仅用户路径）；失败返回 false（不切换）。 */
  selectEngine(engineId: AsrEngineId): Promise<boolean>
  /** P3V-09：备用引擎 id（null = 未设备用）。 */
  fallbackEngineId(): AsrEngineId | null
  /** P3V-09：设备用（null 清除）。主备同体拒绝（return false）。 */
  setFallbackEngine(engineId: AsrEngineId | null): Promise<boolean>
  /** 下载引擎模型（VAD 缺失时一并下载）；长任务不 await。 */
  downloadModel(engineId: AsrEngineId): void
  cancelDownload(engineId: AsrEngineId): boolean
  /** P3V-15：仅多文件 Range 下载可暂停/继续；归档模型返回 false。 */
  pauseDownload(engineId: AsrEngineId): boolean
  resumeDownload(engineId: AsrEngineId): boolean
  /** P3V-13：删除已安装模型与该模型断点文件；下载中拒绝。 */
  deleteModel(engineId: AsrEngineId): Promise<boolean>
  downloadVadModel(): void
  cancelVadDownload(): boolean
  /** VAD 模型文件路径（未下载返回 null；P3B-14 语音输入前置检查用）。 */
  vadModelPath(): string | null
  /** VAD 模型可用（文件在场）。 */
  vadModelReady(): boolean
  /** 当前主引擎 id（从 config 读）。 */
  selectedEngineId(): AsrEngineId
  dispose(): void
}

function downloadStateToModelState(download: ModelDownloadState): {
  state: AsrModelState
  progressRatio?: number
  errorCode?: AsrErrorCode
} {
  switch (download.kind) {
    case 'downloading':
    case 'paused':
      return { state: 'downloading', progressRatio: download.progress }
    case 'extracting':
    case 'installing':
      return { state: 'downloading', progressRatio: 0.999 }
    case 'error':
      return { state: 'error', errorCode: download.code }
    case 'done':
      return { state: 'ready' }
    default:
      return { state: 'not-downloaded' }
  }
}

export function createAsrEngineManager(deps: AsrEngineManagerDeps): AsrEngineManager {
  const rootDir = deps.rootDir.replaceAll('\\', '/')
  /** 只用于「模型文件在不在」的探测；识别用的 store 由各引擎工厂自建。 */
  const presenceStores = new Map<AsrEngineId, AsrFileSetStore>()
  const offlineInstances = new Map<OfflineAsrEngineId, AsrEngine>()
  const streamingInstances = new Map<StreamingAsrEngineId, AsrStreamingEngine>()
  let disposed = false
  /** VAD 是所有识别模型的前置；共享 Promise 防重复点击并发启动多份 VAD 下载。 */
  let vadDownloadPromise: Promise<boolean> | null = null
  /** 已被用户请求、正在等 VAD 或进入 downloader 的模型；等待期同样可取消/不可删除。 */
  const pendingDownloads = new Set<AsrEngineId>()

  const downloader =
    deps.downloader ??
    createModelDownloader({
      rootDir,
      fetchImpl: globalThis.fetch,
      extractArchive:
        deps.extractArchive ??
        (async () => {
          throw new AsrEngineError('model-download-failed', 'no extractor')
        }),
      engineDirName: asrEngineDirName,
      onStateChange: (target) => {
        void target
        deps.onOverviewChange?.()
      }
    })

  /** 「模型文件是否齐全」的探测器；文件清单来自下载目录，六个引擎统一口径。 */
  function presenceStoreOf(engineId: AsrEngineId): AsrFileSetStore {
    let store = presenceStores.get(engineId)
    if (store === undefined) {
      store = fileSetStoreOf(rootDir, engineId)
      presenceStores.set(engineId, store)
    }
    return store
  }

  function offlineEngineOf(engineId: OfflineAsrEngineId): AsrEngine {
    let engine = offlineInstances.get(engineId)
    if (engine === undefined) {
      engine = OFFLINE_ENGINE_FACTORIES[engineId]({ binding: deps.binding, rootDir })
      offlineInstances.set(engineId, engine)
    }
    return engine
  }

  function streamingEngineOf(engineId: StreamingAsrEngineId): AsrStreamingEngine {
    let engine = streamingInstances.get(engineId)
    if (engine === undefined) {
      engine = STREAMING_ENGINE_FACTORIES[engineId]({ binding: deps.binding, rootDir })
      streamingInstances.set(engineId, engine)
    }
    return engine
  }

  /** 切换引擎时丢弃全部旧实例：两个原生 recognizer 不同时在内存里（P3B-11 冻结政策）。 */
  function dropAllEngineInstances(): void {
    // 在线 recognizer 会长期持有数十到数百 MB 模型；只 clear Map 不会立即释放，
    // 且仍在监听的 OnlineStream 可能继续引用它。先显式关闭全部 session/recognizer。
    for (const engine of streamingInstances.values()) engine.dispose()
    offlineInstances.clear()
    streamingInstances.clear()
  }

  function engineModelState(engineId: AsrEngineId): {
    state: AsrModelState
    progressRatio?: number
    errorCode?: AsrErrorCode
  } {
    const download = downloader.state(engineId)
    if (pendingDownloads.has(engineId) && download.kind === 'idle') {
      return { state: 'downloading', progressRatio: 0 }
    }
    if (download.kind !== 'idle' && download.kind !== 'done') {
      return downloadStateToModelState(download)
    }
    // 下载完成但模型文件被人删/损坏：以 store 为准
    if (presenceStoreOf(engineId).discover() !== null) {
      return { state: 'ready' }
    }
    return download.kind === 'done'
      ? { state: 'error', errorCode: 'model-corrupt' }
      : { state: 'not-downloaded' }
  }

  function vadModelState(): {
    state: AsrModelState
    progressRatio?: number
    errorCode?: AsrErrorCode
  } {
    const download = downloader.state('vad')
    if (download.kind !== 'idle' && download.kind !== 'done') {
      return downloadStateToModelState(download)
    }
    if (vadModelPath() !== null) {
      return { state: 'ready' }
    }
    return download.kind === 'done'
      ? { state: 'error', errorCode: 'model-corrupt' }
      : { state: 'not-downloaded' }
  }

  function vadModelPath(): string | null {
    const path = `${rootDir}/${VAD_MODEL_PATH}`
    try {
      const info = statSync(path)
      return info.isFile() && info.size > 0 ? path : null
    } catch {
      return null
    }
  }

  function ensureVadDownloaded(): Promise<boolean> {
    if (vadModelPath() !== null) return Promise.resolve(true)
    if (vadDownloadPromise !== null) return vadDownloadPromise
    // 所有生产入口都经本 manager；若注入方另起了活动下载却没有交出 Promise，
    // 保守不并发启动识别模型，等用户下一次操作根据终态重试。
    if (downloader.isActive('vad')) return Promise.resolve(false)
    vadDownloadPromise = downloader
      .download('vad')
      .then(() => downloader.state('vad').kind === 'done' && vadModelPath() !== null)
      .catch(() => false)
      .finally(() => {
        vadDownloadPromise = null
      })
    return vadDownloadPromise
  }

  return {
    getOverview(): AsrOverview {
      const selected = deps.getSelectedEngineId()
      const fallback = deps.getFallbackEngineId()
      return {
        selectedEngineId: selected,
        fallbackEngineId: fallback,
        // 顺序以 shared 目录为准（推荐在前），让首次设置与设置页的卡片顺序一致
        engines: ASR_MODEL_CATALOG.map((entry) => {
          const engineId = entry.engineId
          const model = engineModelState(engineId)
          return {
            engineId,
            label: engineLabel(engineId),
            localOnly: true,
            modelState: model.state,
            progressRatio: model.progressRatio,
            errorCode: model.errorCode,
            downloadBytes: asrEngineDownloadBytes(engineId),
            download: downloader.status(engineId),
            selected: engineId === selected,
            fallback: engineId === fallback
          }
        }),
        vadModel: { ...vadModelState(), download: downloader.status('vad') }
      }
    },

    selectedEngineId() {
      return deps.getSelectedEngineId()
    },

    fallbackEngineId() {
      return deps.getFallbackEngineId()
    },

    async ensureEngineReady(engineId) {
      if (disposed) throw new AsrEngineError('engine-init-failed', 'manager disposed')
      if (isStreamingAsrEngineId(engineId)) {
        throw new AsrEngineError(
          'engine-init-failed',
          `${engineId} is a streaming engine; use ensureStreamingEngineReady`
        )
      }
      const engine = offlineEngineOf(engineId)
      if (engine.state !== 'ready') {
        await engine.loadModel()
      }
      return engine
    },

    async ensureStreamingEngineReady(engineId) {
      if (disposed) throw new AsrEngineError('engine-init-failed', 'manager disposed')
      if (!isStreamingAsrEngineId(engineId)) {
        throw new AsrEngineError(
          'engine-init-failed',
          `${engineId} is an offline engine; use ensureEngineReady`
        )
      }
      const engine = streamingEngineOf(engineId)
      if (engine.state !== 'ready') {
        await engine.loadModel()
      }
      return engine
    },

    async selectEngine(engineId) {
      if (disposed) return false
      if (!(engineId in ASR_ENGINE_DOWNLOAD_CATALOG)) return false
      if (engineId === deps.getSelectedEngineId()) return true
      // 仅用户显式选择：先持久化成功再切换（失败保持旧引擎，P3A-15 同款事务精神）
      const ok = await deps.setSelectedEngineId(engineId)
      if (!ok) return false
      // 弃旧实例（释放引用，napi finalizer 托管）；不预建新实例（ensure* 懒加载）
      dropAllEngineInstances()
      // 新主引擎撞上旧备用：备用回退=回退到自己，没有意义，顺手清除
      //（overview 会刷新，UI 立即看到备用位空了；不清会留下永不触发的假配置）
      if (deps.getFallbackEngineId() === engineId) {
        const cleared = await deps.setFallbackEngineId(null)
        if (!cleared) {
          // 清除失败（写盘异常）：保持主切换成功。主备同体的配置无害——
          // 回退路径会因 fallback === activeEngineId 而跳过，不会真的切换。
          deps.onOverviewChange?.()
          return true
        }
      }
      deps.onOverviewChange?.()
      return true
    },

    async setFallbackEngine(engineId) {
      if (disposed) return false
      if (engineId === null) {
        const ok = await deps.setFallbackEngineId(null)
        if (ok) deps.onOverviewChange?.()
        return ok
      }
      if (!(engineId in ASR_ENGINE_DOWNLOAD_CATALOG)) return false
      // 主备同体拒绝：回退到自己 = 永不触发的假配置，宁可在选择时报错
      if (engineId === deps.getSelectedEngineId()) return false
      const ok = await deps.setFallbackEngineId(engineId)
      if (ok) deps.onOverviewChange?.()
      return ok
    },

    downloadModel(engineId) {
      if (
        disposed ||
        !(engineId in ASR_ENGINE_DOWNLOAD_CATALOG) ||
        pendingDownloads.has(engineId) ||
        downloader.isActive(engineId)
      ) {
        return
      }
      // VAD 是语音输入前置：严格等待它成功后再下识别模型。pendingDownloads 让
      // 等待期也可取消、可见、不可删除；取消/失败不会误启动模型。
      pendingDownloads.add(engineId)
      deps.onOverviewChange?.()
      void (async () => {
        try {
          const vadReady = await ensureVadDownloaded()
          if (!vadReady || disposed || !pendingDownloads.has(engineId)) return
          await downloader.download(engineId)
        } finally {
          pendingDownloads.delete(engineId)
          deps.onOverviewChange?.()
        }
      })().catch(() => {
        /* 状态已入 downloader state；不冒泡到 IPC 调用方 */
      })
    },

    cancelDownload(engineId) {
      const wasPending = pendingDownloads.delete(engineId)
      const cancelled = downloader.cancel(engineId)
      // VAD 是所有排队模型共享的 0.64 MB 前置；取消当前模型不自动中止 VAD，
      // 否则下一项会与正在收尾的 AbortController 竞态。VAD 完成后可直接复用。
      if (wasPending) deps.onOverviewChange?.()
      return wasPending || cancelled
    },

    pauseDownload(engineId) {
      if (disposed) return false
      // 等 VAD 时 downloader 尚无该引擎 controller，自然返回 false；进入可续传接收阶段后
      // 即使 manager 的总任务 Promise 仍在 pendingDownloads，也必须允许暂停。
      return downloader.pause(engineId)
    },

    resumeDownload(engineId) {
      if (disposed) return false
      return downloader.resume(engineId)
    },

    async deleteModel(engineId) {
      if (disposed || !(engineId in ASR_ENGINE_DOWNLOAD_CATALOG)) return false
      if (pendingDownloads.has(engineId) || downloader.isActive(engineId)) return false
      // Windows 上原生 recognizer 可能持有 onnx/tokens 文件句柄；先全部弃旧再删目录。
      // 离线 recognizer 按冻结 ABI 只释放 JS 引用（napi finalizer 托管）；在线显式 close。
      dropAllEngineInstances()
      const ok = await downloader.deleteModel(engineId)
      if (ok) {
        presenceStores.delete(engineId)
        deps.onOverviewChange?.()
      }
      return ok
    },

    downloadVadModel() {
      if (disposed) return
      void ensureVadDownloaded()
    },

    cancelVadDownload() {
      return downloader.cancel('vad')
    },

    vadModelPath() {
      return vadModelPath()
    },

    vadModelReady() {
      return vadModelPath() !== null
    },

    dispose() {
      if (disposed) return
      disposed = true
      pendingDownloads.clear()
      dropAllEngineInstances()
      presenceStores.clear()
    }
  }
}
