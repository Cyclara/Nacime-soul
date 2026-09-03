// src/main/ipc/handlers/voice.test.ts
// P3B-14：语音 handler 合同——invoke 六通道 + mic port receiver。
// 借 live2d.test.ts 的 electron mock 模式：注册后抓 handle 回调直接调用。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { AppError } from '@shared/errors'
import type { Logger } from '@shared/observability/types'
import {
  isGptRuntimeOverview,
  isGptRuntimeSourceResult,
  type GptRuntimeOverview,
  type GptRuntimeSourceResult
} from '@shared/voice/gpt-runtime-types'
import { configureIpcGuard } from '../register'
import { registerVoiceHandlers } from './voice'
import type { AsrEngineManager } from '../../voice/asr/engine-manager'
import type { VoiceListeningService } from '../../voice/listening-service'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() }
}))

function logger(): Logger {
  const value: Logger = {
    fatal() {
      /* noop */
    },
    error() {
      /* noop */
    },
    warn() {
      /* noop */
    },
    info() {
      /* noop */
    },
    debug() {
      /* noop */
    },
    child: () => value
  }
  return value
}

function event(): Partial<IpcMainInvokeEvent> {
  return {
    sender: { id: 1 } as IpcMainInvokeEvent['sender'],
    senderFrame: { url: 'http://localhost:5173/' } as IpcMainInvokeEvent['senderFrame']
  }
}

function handler(channel: string): (event: unknown, payload: unknown) => Promise<unknown> {
  const found = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel)
  if (!found) throw new Error(`missing ${channel}`)
  return found[1] as (event: unknown, payload: unknown) => Promise<unknown>
}

function portListener(channel: string): (event: unknown) => void {
  const found = vi.mocked(ipcMain.on).mock.calls.find(([name]) => name === channel)
  if (!found) throw new Error(`missing port channel ${channel}`)
  return found[1] as (event: unknown) => void
}

function makeFakes(): {
  overview: Record<string, unknown>
  engineManager: AsrEngineManager
  listening: VoiceListeningService
  orchestrator: Record<string, unknown>
  emitAsrOverview: ReturnType<typeof vi.fn>
  downloadModel: ReturnType<typeof vi.fn>
  cancelDownload: ReturnType<typeof vi.fn>
  pauseDownload: ReturnType<typeof vi.fn>
  resumeDownload: ReturnType<typeof vi.fn>
  deleteModel: ReturnType<typeof vi.fn>
  selectEngine: ReturnType<typeof vi.fn>
  acceptMicPort: ReturnType<typeof vi.fn>
  assetRoot: {
    setup: ReturnType<typeof vi.fn>
    root: () => string
    asrRoot: () => string
    gptRuntimeRoot: () => string
    status: () => Record<string, unknown>
    restartRequired: ReturnType<typeof vi.fn>
    setRoot: ReturnType<typeof vi.fn>
    resetRoot: ReturnType<typeof vi.fn>
  }
  chooseAssetDirectory: ReturnType<typeof vi.fn>
  // P3V-16：GPT runtime 下载器假件（不碰网络/磁盘/PowerShell）
  gptRuntime: {
    state: ReturnType<typeof vi.fn>
    status: ReturnType<typeof vi.fn>
    installed: ReturnType<typeof vi.fn>
    download: ReturnType<typeof vi.fn>
    pause: ReturnType<typeof vi.fn>
    resume: ReturnType<typeof vi.fn>
    cancel: ReturnType<typeof vi.fn>
    isActive: ReturnType<typeof vi.fn>
    deleteRuntime: ReturnType<typeof vi.fn>
    recommendedVariant: ReturnType<typeof vi.fn>
  }
  gptRuntimeExternalDetected: ReturnType<typeof vi.fn>
  // P3V-18：音色注册表假件
  voiceProfiles: {
    list: ReturnType<typeof vi.fn>
    get: ReturnType<typeof vi.fn>
    resolveVoiceConfig: ReturnType<typeof vi.fn>
    views: ReturnType<typeof vi.fn>
    add: ReturnType<typeof vi.fn>
    remove: ReturnType<typeof vi.fn>
  }
  currentVoiceId: ReturnType<typeof vi.fn>
  // P3V-20：导入音色暂存槽假件
  staged: Record<string, string | null>
  pickVoiceFile: ReturnType<typeof vi.fn>
  stagedVoiceFiles: ReturnType<typeof vi.fn>
  clearStagedVoiceFiles: ReturnType<typeof vi.fn>
  // P3V-17：运行时来源假件（不碰磁盘，不写偏好文件）
  gptRuntimeSource: {
    resolveInstallation: ReturnType<typeof vi.fn>
    mode: ReturnType<typeof vi.fn>
    active: ReturnType<typeof vi.fn>
    voiceConfigured: ReturnType<typeof vi.fn>
    restartRequired: ReturnType<typeof vi.fn>
    setCustomDirectory: ReturnType<typeof vi.fn>
    clearCustomDirectory: ReturnType<typeof vi.fn>
  }
  chooseGptRuntimeDirectory: ReturnType<typeof vi.fn>
  assetRootStatus: {
    isDefault: boolean
    freeBytes: number
    totalRequiredBytes: number
    state: string
  }
} {
  const overview = {
    selectedEngineId: 'sherpa-sensevoice',
    fallbackEngineId: null,
    engines: [
      { engineId: 'sherpa-sensevoice', selected: true, fallback: false, modelState: 'ready' },
      {
        engineId: 'funasr-paraformer',
        selected: false,
        fallback: false,
        modelState: 'not-downloaded'
      }
    ],
    vadModel: { state: 'ready' }
  }
  const downloadModel = vi.fn()
  const cancelDownload = vi.fn(() => true)
  const pauseDownload = vi.fn(() => true)
  const resumeDownload = vi.fn(() => false)
  const deleteModel = vi.fn(async () => true)
  const selectEngine = vi.fn(async () => true)
  const startListening = vi.fn(async () => {})
  const stopListening = vi.fn(async () => {})
  const acceptMicPort = vi.fn()
  const engineManager = {
    getOverview: () => overview,
    selectedEngineId: () => 'sherpa-sensevoice' as const,
    fallbackEngineId: () => null,
    ensureEngineReady: vi.fn(),
    ensureStreamingEngineReady: vi.fn(),
    selectEngine,
    setFallbackEngine: vi.fn(async () => true),
    downloadModel,
    cancelDownload,
    pauseDownload,
    resumeDownload,
    deleteModel,
    downloadVadModel: vi.fn(),
    cancelVadDownload: vi.fn(),
    vadModelPath: () => null,
    vadModelReady: () => false,
    dispose: vi.fn()
  } as unknown as AsrEngineManager
  const listening = {
    start: startListening,
    stop: stopListening,
    acceptMicPort,
    active: false,
    vadState: 'idle' as const
  } as unknown as VoiceListeningService
  // P3B-18：TTS 编排假件（get-state/test-tts/cancel-speaking 通道验证用）
  const orchestrator = {
    getState: vi.fn(() => ({
      ttsEnabled: true,
      earlyPlaybackEnabled: true,
      providerId: 'fake',
      voiceConfigured: true,
      hostAvailable: true,
      speaking: false,
      speakingRequestId: null,
      lastDegradedReason: null
    })),
    testTts: vi.fn(async () => {}),
    cancelSpeaking: vi.fn(() => true)
  }
  const emitAsrOverview = vi.fn()
  // P3V-10：资源根目录假件（状态快照 + setRoot/reset 行为可注入）
  const assetRootStatus = {
    isDefault: true,
    freeBytes: 123_456_789,
    totalRequiredBytes: 520_509_193,
    state: 'ok' as const
  }
  const setRoot = vi.fn(() => ({
    status: { ...assetRootStatus, isDefault: false },
    changed: true,
    restartRequired: true
  }))
  const resetRoot = vi.fn(() => ({ status: assetRootStatus, changed: true, restartRequired: true }))
  const assetRoot = {
    setup: vi.fn(async () => {}),
    root: () => 'D:/fake/assets',
    asrRoot: () => 'D:/fake/assets/asr',
    gptRuntimeRoot: () => 'D:/fake/assets/gpt-runtime',
    status: () => assetRootStatus,
    restartRequired: vi.fn(() => false),
    setRoot,
    resetRoot
  }
  const chooseAssetDirectory = vi.fn(async () => 'E:/picked/dir')
  // P3V-16：GPT runtime manager 假件——handler 只做门禁与投影，不下载任何东西
  const gptRuntime = {
    state: vi.fn(() => ({ kind: 'idle' as const })),
    status: vi.fn((variant: string) => ({
      assetId: `gpt-runtime-${variant}`,
      state: 'idle' as const,
      receivedBytes: 0,
      totalBytes: 8_185_086_602,
      resumable: true
    })),
    installed: vi.fn(() => null),
    download: vi.fn(async () => {}),
    pause: vi.fn(() => true),
    resume: vi.fn(() => false),
    cancel: vi.fn(() => true),
    isActive: vi.fn(() => false),
    deleteRuntime: vi.fn(async () => true),
    recommendedVariant: vi.fn(async () => 'rtx50' as const)
  }
  const gptRuntimeExternalDetected = vi.fn(() => false)
  const gptRuntimeSource = {
    resolveInstallation: vi.fn(() => null),
    mode: vi.fn(() => 'auto' as const),
    active: vi.fn(() => true),
    voiceConfigured: vi.fn(() => true),
    restartRequired: vi.fn(() => false),
    setCustomDirectory: vi.fn(() => ({ accepted: true, changed: true })),
    clearCustomDirectory: vi.fn(() => ({ changed: true }))
  }
  const chooseGptRuntimeDirectory = vi.fn(async () => 'E:/GPT-SoVITS/pkg/app')
  // P3V-18：音色注册表假件（投影里绝不出现路径）
  const voiceProfiles = {
    list: vi.fn(() => []),
    get: vi.fn(() => null),
    resolveVoiceConfig: vi.fn(() => null),
    views: vi.fn((currentVoiceId: string) => [
      {
        id: 'gpt-sovits:abc123',
        displayName: '爱莉希雅2.0（v2ProPlus）',
        version: 'v2ProPlus',
        promptLang: 'zh',
        defaultTextLang: 'zh',
        state: 'ready' as const,
        source: 'discovered' as const,
        current: currentVoiceId === 'gpt-sovits:abc123'
      }
    ]),
    add: vi.fn(() => ({ added: true, id: 'gpt-sovits:new' })),
    remove: vi.fn(() => true)
  }
  const currentVoiceId = vi.fn(() => 'gpt-sovits:abc123')
  // P3V-20：导入音色的暂存槽假件（默认三件齐全）
  const staged: Record<string, string | null> = {
    'gpt-weights': 'E:/weights/emma-e15.ckpt',
    'sovits-weights': 'E:/weights/emma-e8.pth',
    'ref-audio': 'E:/voices/emma/【默认】おはよう.wav'
  }
  const pickVoiceFile = vi.fn(async (kind: string) => {
    staged[kind] = `E:/picked/${kind}.bin`
    return staged[kind]!
  })
  const stagedVoiceFiles = vi.fn(() => staged)
  const clearStagedVoiceFiles = vi.fn(() => {
    staged['gpt-weights'] = null
    staged['sovits-weights'] = null
    staged['ref-audio'] = null
  })
  return {
    voiceProfiles,
    currentVoiceId,
    staged,
    pickVoiceFile,
    stagedVoiceFiles,
    clearStagedVoiceFiles,
    gptRuntime,
    gptRuntimeExternalDetected,
    gptRuntimeSource,
    chooseGptRuntimeDirectory,
    assetRootStatus,
    overview,
    engineManager,
    listening,
    orchestrator,
    emitAsrOverview,
    downloadModel,
    cancelDownload,
    pauseDownload,
    resumeDownload,
    deleteModel,
    selectEngine,
    acceptMicPort,
    assetRoot,
    chooseAssetDirectory
  }
}

function register(h: ReturnType<typeof makeFakes>): void {
  registerVoiceHandlers({
    logger: logger(),
    engineManager: h.engineManager,
    listening: h.listening,
    orchestrator: h.orchestrator as never,
    emitAsrOverview: h.emitAsrOverview as unknown as () => void,
    assetRoot: h.assetRoot as never,
    chooseAssetDirectory: h.chooseAssetDirectory as unknown as () => Promise<string | null>,
    gptRuntime: h.gptRuntime as never,
    gptRuntimeExternalDetected: h.gptRuntimeExternalDetected as unknown as () => boolean,
    gptRuntimeSource: h.gptRuntimeSource as never,
    voiceProfiles: h.voiceProfiles as never,
    currentVoiceId: h.currentVoiceId as unknown as () => string,
    pickVoiceFile: h.pickVoiceFile as never,
    stagedVoiceFiles: h.stagedVoiceFiles as never,
    clearStagedVoiceFiles: h.clearStagedVoiceFiles as unknown as () => void,
    chooseGptRuntimeDirectory: h.chooseGptRuntimeDirectory as unknown as () => Promise<
      string | null
    >
  })
}

describe('P3B-14 voice handlers（chat capability）', () => {
  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockClear()
    vi.mocked(ipcMain.on).mockClear()
    configureIpcGuard({
      trustedOrigins: new Set(['http://localhost:5173']),
      trustedWebContentsIds: new Set([1]),
      senderCapabilities: new Map([[1, 'chat']])
    })
  })

  it('get-asr-overview 返回 manager 快照', async () => {
    const h = makeFakes()
    register(h)
    const result = await handler('companion:voice:get-asr-overview')(event(), undefined)
    expect(result).toEqual({ ok: true, data: h.overview })
  })

  it('asr-download-model 触发 manager.downloadModel', async () => {
    const h = makeFakes()
    register(h)
    const result = await handler('companion:voice:asr-download-model')(event(), {
      engineId: 'sherpa-sensevoice'
    })
    expect(result).toEqual({ ok: true, data: { ok: true } })
    expect(h.downloadModel).toHaveBeenCalledWith('sherpa-sensevoice')
  })

  it('asr-cancel/pause/resume-download 返回 manager 的真实布尔', async () => {
    const h = makeFakes()
    register(h)
    const cancelled = await handler('companion:voice:asr-cancel-download')(event(), {
      engineId: 'funasr-paraformer'
    })
    expect(cancelled).toEqual({ ok: true, data: { ok: true, cancelled: true } })

    const paused = await handler('companion:voice:asr-pause-download')(event(), {
      engineId: 'zipformer-bilingual-zh-en'
    })
    expect(paused).toEqual({ ok: true, data: { ok: true, paused: true } })
    expect(h.pauseDownload).toHaveBeenCalledWith('zipformer-bilingual-zh-en')

    const resumed = await handler('companion:voice:asr-resume-download')(event(), {
      engineId: 'zipformer-bilingual-zh-en'
    })
    expect(resumed).toEqual({ ok: true, data: { ok: true, resumed: false } })
    expect(h.resumeDownload).toHaveBeenCalledWith('zipformer-bilingual-zh-en')
  })

  it('P3V-13 asr-delete-model：成功 ok；下载/使用中转 ASR_BUSY', async () => {
    const h = makeFakes()
    register(h)
    const ok = await handler('companion:voice:asr-delete-model')(event(), {
      engineId: 'sherpa-sensevoice'
    })
    expect(ok).toEqual({ ok: true, data: { ok: true } })
    expect(h.deleteModel).toHaveBeenCalledWith('sherpa-sensevoice')

    h.deleteModel.mockResolvedValueOnce(false)
    const busy = (await handler('companion:voice:asr-delete-model')(event(), {
      engineId: 'sherpa-sensevoice'
    })) as { ok: false; error: { code: string } }
    expect(busy.ok).toBe(false)
    expect(busy.error.code).toBe('ASR_BUSY')

    h.deleteModel.mockResolvedValueOnce(true)
    Object.defineProperty(h.listening, 'active', { value: true, configurable: true })
    const listeningBusy = (await handler('companion:voice:asr-delete-model')(event(), {
      engineId: 'sherpa-sensevoice'
    })) as { ok: false; error: { code: string; message: string } }
    expect(listeningBusy.ok).toBe(false)
    expect(listeningBusy.error.code).toBe('ASR_BUSY')
    expect(listeningBusy.error.message).toContain('停止语音输入')
    // 监听态在调用 manager 前就拒绝；第三次请求不应再触发 deleteModel。
    expect(h.deleteModel).toHaveBeenCalledTimes(2)
  })

  it('asr-select-engine：成功 ok；持久化失败转 IPC error(CFG_INVALID)', async () => {
    const h = makeFakes()
    register(h)
    const ok = await handler('companion:voice:asr-select-engine')(event(), {
      engineId: 'funasr-paraformer'
    })
    expect(ok).toEqual({ ok: true, data: { ok: true } })

    h.selectEngine.mockResolvedValueOnce(false)
    const failed = (await handler('companion:voice:asr-select-engine')(event(), {
      engineId: 'funasr-paraformer'
    })) as { ok: false; error: { code: string } }
    expect(failed.ok).toBe(false)
    expect(failed.error.code).toBe('CFG_INVALID')
  })

  // ── P3V-09/10：主备选择 + 资源根目录四通道 ──

  it('asr-set-fallback-engine：null 清除与设置都走 manager；失败转 CFG_INVALID', async () => {
    const h = makeFakes()
    register(h)
    const set = await handler('companion:voice:asr-set-fallback-engine')(event(), {
      engineId: 'sherpa-sensevoice'
    })
    expect(set).toEqual({ ok: true, data: { ok: true } })
    expect(h.engineManager.setFallbackEngine).toHaveBeenCalledWith('sherpa-sensevoice')

    const cleared = await handler('companion:voice:asr-set-fallback-engine')(event(), {
      engineId: null
    })
    expect(cleared).toEqual({ ok: true, data: { ok: true } })
    expect(h.engineManager.setFallbackEngine).toHaveBeenCalledWith(null)

    vi.mocked(h.engineManager.setFallbackEngine as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      false
    )
    const failed = (await handler('companion:voice:asr-set-fallback-engine')(event(), {
      engineId: 'sherpa-sensevoice'
    })) as { ok: false; error: { code: string } }
    expect(failed.ok).toBe(false)
    expect(failed.error.code).toBe('CFG_INVALID')
  })

  it('get-asset-root 返回状态快照（无路径）', async () => {
    const h = makeFakes()
    register(h)
    const result = await handler('companion:voice:get-asset-root')(event(), undefined)
    expect(result).toEqual({
      ok: true,
      data: {
        isDefault: true,
        freeBytes: 123_456_789,
        totalRequiredBytes: 520_509_193,
        state: 'ok'
      }
    })
  })

  it('choose-asset-root：选中目录走 setRoot；用户取消 changed=false 不报错', async () => {
    const h = makeFakes()
    register(h)
    const picked = await handler('companion:voice:choose-asset-root')(event(), undefined)
    expect(picked).toEqual({
      ok: true,
      data: {
        status: {
          isDefault: false,
          freeBytes: 123_456_789,
          totalRequiredBytes: 520_509_193,
          state: 'ok'
        },
        changed: true,
        restartRequired: true
      }
    })
    expect(h.assetRoot.setRoot).toHaveBeenCalledWith('E:/picked/dir')

    h.chooseAssetDirectory.mockResolvedValueOnce(null)
    const cancelled = await handler('companion:voice:choose-asset-root')(event(), undefined)
    expect(h.assetRoot.restartRequired).toHaveBeenCalled()
    expect(cancelled).toEqual({
      ok: true,
      data: {
        status: {
          isDefault: true,
          freeBytes: 123_456_789,
          totalRequiredBytes: 520_509_193,
          state: 'ok'
        },
        changed: false,
        restartRequired: false
      }
    })
  })

  it('reset-asset-root 走 resetRoot', async () => {
    const h = makeFakes()
    register(h)
    const result = await handler('companion:voice:reset-asset-root')(event(), undefined)
    expect(result).toEqual({
      ok: true,
      data: {
        status: {
          isDefault: true,
          freeBytes: 123_456_789,
          totalRequiredBytes: 520_509_193,
          state: 'ok'
        },
        changed: true,
        restartRequired: true
      }
    })
    expect(h.assetRoot.resetRoot).toHaveBeenCalled()
  })

  it('P3V-16 get-gpt-runtime：两变体 + GPU 推荐 + 空间口径；DTO 不含任何路径', async () => {
    const h = makeFakes()
    register(h)
    const result = (await handler('companion:voice:get-gpt-runtime')(event(), undefined)) as {
      ok: true
      data: GptRuntimeOverview
    }
    expect(result.ok).toBe(true)
    expect(isGptRuntimeOverview(result.data)).toBe(true)
    expect(result.data.variants.map((v) => v.variant)).toEqual(['standard', 'rtx50'])
    // GPU 探测只推荐一个，另一个必须留给用户自己选
    expect(result.data.variants.filter((v) => v.recommended).map((v) => v.variant)).toEqual([
      'rtx50'
    ])
    expect(result.data.installed).toBeNull()
    expect(result.data.externalDetected).toBe(false)
    expect(result.data.freeBytes).toBe(123_456_789)
    expect(result.data.rootState).toBe('ok')
    expect(result.data.minFreeBytes).toBeGreaterThan(0)
    // 全部空闲 → 无「当前任务」；路径纪律：整个投影 JSON 里不出现盘符
    expect(result.data.download).toBeNull()
    expect(JSON.stringify(result.data)).not.toMatch(/[A-Za-z]:[/\\]/)
  })

  it('P3V-16 get-gpt-runtime：已安装 + 进行中任务如实投影', async () => {
    const h = makeFakes()
    h.gptRuntime.installed.mockReturnValue({
      variant: 'standard',
      rootDir: 'D:/fake/assets/gpt-runtime/gpt-sovits',
      installedAt: 1_756_000_000_000
    } as never)
    h.gptRuntime.isActive.mockImplementation(((v: string) => v === 'standard') as never)
    h.gptRuntime.status.mockImplementation(((v: string) => ({
      assetId: `gpt-runtime-${v}`,
      state: 'downloading',
      receivedBytes: 1_024,
      totalBytes: 8_185_086_602,
      currentFile: 'GPT-SoVITS-v2pro-20250604.7z',
      phase: 'receiving',
      resumable: true
    })) as never)
    h.gptRuntimeExternalDetected.mockReturnValue(true)
    register(h)
    const result = (await handler('companion:voice:get-gpt-runtime')(event(), undefined)) as {
      ok: true
      data: GptRuntimeOverview
    }
    expect(isGptRuntimeOverview(result.data)).toBe(true)
    expect(result.data.installed).toEqual({
      variant: 'standard',
      displayName: 'GPT-SoVITS v2Pro 标准版',
      installedAt: 1_756_000_000_000
    })
    expect(result.data.externalDetected).toBe(true)
    expect(result.data.download?.assetId).toBe('gpt-runtime-standard')
    // installed.rootDir 是 main 内视图，绝不能漏进 DTO
    expect(JSON.stringify(result.data)).not.toMatch(/[A-Za-z]:[/\\]/)
  })

  it('P3V-16 gpt-runtime-install：即发即回；根目录不可用直接拒绝（不白下 8GB）', async () => {
    const h = makeFakes()
    register(h)
    const ok = await handler('companion:voice:gpt-runtime-install')(event(), {
      variant: 'rtx50'
    })
    expect(ok).toEqual({ ok: true, data: { ok: true } })
    expect(h.gptRuntime.download).toHaveBeenCalledWith('rtx50')

    h.assetRootStatus.state = 'missing'
    h.gptRuntime.download.mockClear()
    const rejected = (await handler('companion:voice:gpt-runtime-install')(event(), {
      variant: 'standard'
    })) as { ok: false; error: { code: string } }
    expect(rejected.ok).toBe(false)
    expect(rejected.error.code).toBe('CFG_INVALID')
    expect(h.gptRuntime.download).not.toHaveBeenCalled()
  })

  it('P3V-16 gpt-runtime 暂停/继续/取消返回 manager 的真实布尔', async () => {
    const h = makeFakes()
    register(h)
    await expect(
      handler('companion:voice:gpt-runtime-pause-download')(event(), { variant: 'standard' })
    ).resolves.toEqual({ ok: true, data: { ok: true, paused: true } })
    await expect(
      handler('companion:voice:gpt-runtime-resume-download')(event(), { variant: 'standard' })
    ).resolves.toEqual({ ok: true, data: { ok: true, resumed: false } })
    await expect(
      handler('companion:voice:gpt-runtime-cancel-download')(event(), { variant: 'rtx50' })
    ).resolves.toEqual({ ok: true, data: { ok: true, cancelled: true } })
    expect(h.gptRuntime.pause).toHaveBeenCalledWith('standard')
    expect(h.gptRuntime.resume).toHaveBeenCalledWith('standard')
    expect(h.gptRuntime.cancel).toHaveBeenCalledWith('rtx50')
  })

  it('P3V-16 gpt-runtime-delete：成功 ok；安装/下载中转 TTS_RUNTIME_BUSY', async () => {
    const h = makeFakes()
    register(h)
    await expect(
      handler('companion:voice:gpt-runtime-delete')(event(), undefined)
    ).resolves.toEqual({ ok: true, data: { ok: true } })

    h.gptRuntime.deleteRuntime.mockResolvedValueOnce(false as never)
    const busy = (await handler('companion:voice:gpt-runtime-delete')(event(), undefined)) as {
      ok: false
      error: { code: string }
    }
    expect(busy.ok).toBe(false)
    expect(busy.error.code).toBe('TTS_RUNTIME_BUSY')
  })

  it('P3V-17 choose-gpt-runtime-dir：采纳目录后回 changed + 待重启；取消不改状态', async () => {
    const h = makeFakes()
    h.gptRuntimeSource.restartRequired.mockReturnValue(true)
    register(h)
    const picked = (await handler('companion:voice:choose-gpt-runtime-dir')(
      event(),
      undefined
    )) as { ok: true; data: GptRuntimeSourceResult }
    expect(picked.ok).toBe(true)
    expect(isGptRuntimeSourceResult(picked.data)).toBe(true)
    expect(picked.data).toMatchObject({ changed: true, accepted: true })
    expect(picked.data.overview.source.restartRequired).toBe(true)
    expect(h.gptRuntimeSource.setCustomDirectory).toHaveBeenCalledWith('E:/GPT-SoVITS/pkg/app')
    // 用户选的目录绝不能出现在回给 renderer 的投影里
    expect(JSON.stringify(picked.data)).not.toMatch(/[A-Za-z]:[/\\]/)

    h.chooseGptRuntimeDirectory.mockResolvedValueOnce(null as never)
    h.gptRuntimeSource.setCustomDirectory.mockClear()
    const cancelled = (await handler('companion:voice:choose-gpt-runtime-dir')(
      event(),
      undefined
    )) as { ok: true; data: GptRuntimeSourceResult }
    expect(cancelled.data).toMatchObject({ changed: false, accepted: false, reason: 'cancelled' })
    expect(h.gptRuntimeSource.setCustomDirectory).not.toHaveBeenCalled()
    // 取消不能把已有的「待重启」提示冲掉
    expect(cancelled.data.overview.source.restartRequired).toBe(true)
  })

  it('P3V-17 choose-gpt-runtime-dir：不是整合包目录时 accepted=false + 闭集原因', async () => {
    const h = makeFakes()
    h.gptRuntimeSource.setCustomDirectory.mockReturnValue({
      accepted: false,
      changed: false,
      reason: 'not-gpt-sovits'
    } as never)
    register(h)
    const result = (await handler('companion:voice:choose-gpt-runtime-dir')(
      event(),
      undefined
    )) as {
      ok: true
      data: GptRuntimeSourceResult
    }
    expect(isGptRuntimeSourceResult(result.data)).toBe(true)
    expect(result.data).toMatchObject({
      accepted: false,
      changed: false,
      reason: 'not-gpt-sovits'
    })
  })

  it('P3V-17 clear-gpt-runtime-dir 回自动发现', async () => {
    const h = makeFakes()
    register(h)
    const result = (await handler('companion:voice:clear-gpt-runtime-dir')(event(), undefined)) as {
      ok: true
      data: GptRuntimeSourceResult
    }
    expect(isGptRuntimeSourceResult(result.data)).toBe(true)
    expect(result.data).toMatchObject({ changed: true, accepted: true })
    expect(h.gptRuntimeSource.clearCustomDirectory).toHaveBeenCalled()
  })

  it('P3V-20 pick-gpt-voice-file：只回文件名，绝不回目录', async () => {
    const h = makeFakes()
    h.pickVoiceFile.mockResolvedValueOnce('E:/我的音色/爱莉希雅/【默认】你好呀.wav' as never)
    register(h)
    const result = (await handler('companion:voice:pick-gpt-voice-file')(event(), {
      kind: 'ref-audio'
    })) as { ok: true; data: { picked: boolean; kind: string; fileName?: string } }
    expect(result.data).toEqual({
      picked: true,
      kind: 'ref-audio',
      fileName: '【默认】你好呀.wav'
    })
    expect(JSON.stringify(result.data)).not.toMatch(/[A-Za-z]:[/\\]/)

    h.pickVoiceFile.mockResolvedValueOnce(null as never)
    const cancelled = (await handler('companion:voice:pick-gpt-voice-file')(event(), {
      kind: 'gpt-weights'
    })) as { ok: true; data: { picked: boolean } }
    expect(cancelled.data).toEqual({ picked: false, kind: 'gpt-weights' })
  })

  it('P3V-20 import-gpt-voice：三件齐全才导入，成功后清空暂存', async () => {
    const h = makeFakes()
    register(h)
    const result = (await handler('companion:voice:import-gpt-voice')(event(), {
      displayName: '樱羽艾玛1.0',
      version: 'v2ProPlus',
      promptText: 'おはようございます',
      promptLang: 'ja',
      defaultTextLang: 'ja'
    })) as { ok: true; data: { ok: boolean; voiceId?: string } }
    expect(result.data.ok).toBe(true)
    expect(result.data.voiceId).toBe('gpt-sovits:new')
    expect(h.voiceProfiles.add).toHaveBeenCalledWith({
      displayName: '樱羽艾玛1.0',
      version: 'v2ProPlus',
      gptWeightsPath: 'E:/weights/emma-e15.ckpt',
      sovitsWeightsPath: 'E:/weights/emma-e8.pth',
      refAudioPath: 'E:/voices/emma/【默认】おはよう.wav',
      promptText: 'おはようございます',
      promptLang: 'ja',
      defaultTextLang: 'ja'
    })
    expect(h.clearStagedVoiceFiles).toHaveBeenCalled()
  })

  it('P3V-20 import-gpt-voice：缺文件 files-missing；重复导入 duplicate（都不清暂存）', async () => {
    const h = makeFakes()
    h.staged['ref-audio'] = null
    register(h)
    const missing = (await handler('companion:voice:import-gpt-voice')(event(), {
      displayName: '缺参考音频',
      version: 'v2Pro',
      promptText: '你好',
      promptLang: 'zh',
      defaultTextLang: 'zh'
    })) as { ok: true; data: { ok: boolean; reason?: string } }
    expect(missing.data.ok).toBe(false)
    expect(missing.data.reason).toBe('files-missing')
    expect(h.voiceProfiles.add).not.toHaveBeenCalled()
    expect(h.clearStagedVoiceFiles).not.toHaveBeenCalled()

    h.staged['ref-audio'] = 'E:/voices/emma/ref.wav'
    h.voiceProfiles.add.mockReturnValueOnce({ added: false, id: 'gpt-sovits:dup' } as never)
    const duplicate = (await handler('companion:voice:import-gpt-voice')(event(), {
      displayName: '重复',
      version: 'v2Pro',
      promptText: '你好',
      promptLang: 'zh',
      defaultTextLang: 'zh'
    })) as { ok: true; data: { ok: boolean; reason?: string; voiceId?: string } }
    expect(duplicate.data).toMatchObject({
      ok: false,
      reason: 'duplicate',
      voiceId: 'gpt-sovits:dup'
    })
    expect(h.clearStagedVoiceFiles).not.toHaveBeenCalled()
  })

  it('P3V-20 delete-gpt-voice：删 imported 成功；discovered 如实回 ok=false', async () => {
    const h = makeFakes()
    register(h)
    const removed = (await handler('companion:voice:delete-gpt-voice')(event(), {
      voiceId: 'gpt-sovits:imported'
    })) as { ok: true; data: { ok: boolean } }
    expect(removed.data.ok).toBe(true)
    expect(h.voiceProfiles.remove).toHaveBeenCalledWith('gpt-sovits:imported')

    h.voiceProfiles.remove.mockReturnValueOnce(false as never)
    const kept = (await handler('companion:voice:delete-gpt-voice')(event(), {
      voiceId: 'gpt-sovits:abc123'
    })) as { ok: true; data: { ok: boolean } }
    expect(kept.data.ok).toBe(false)
  })

  it('start-listening：成功 ok；引擎/VAD 缺失（AppError）透传错误码', async () => {
    const h = makeFakes()
    h.listening.start = async () => {
      throw new AppError({
        code: 'ASR_MODEL_MISSING',
        userMessage: '语音模型未下载',
        severity: 'error',
        retryable: true
      })
    }
    register(h)
    const failed = (await handler('companion:voice:start-listening')(event(), undefined)) as {
      ok: false
      error: { code: string }
    }
    expect(failed.ok).toBe(false)
    expect(failed.error.code).toBe('ASR_MODEL_MISSING')

    // 就绪后成功
    h.listening.start = async () => {}
    const ok = await handler('companion:voice:start-listening')(event(), undefined)
    expect(ok).toEqual({ ok: true, data: { ok: true } })
  })

  it('stop-listening ok', async () => {
    const h = makeFakes()
    register(h)
    const result = await handler('companion:voice:stop-listening')(event(), undefined)
    expect(result).toEqual({ ok: true, data: { ok: true } })
    expect(h.listening.stop).toHaveBeenCalled()
  })

  it('mic-port receiver：受信 chat sender 把 port 交给 listening；越权 sender 拒绝', async () => {
    const h = makeFakes()
    register(h)
    const listener = portListener('voice:mic-port')
    const closeMock = vi.fn()

    // 越权（无 capability）→ port 立即 close，不交给 listening
    listener({
      sender: { id: 99 },
      senderFrame: { url: 'http://localhost:5173/' },
      ports: [{ close: closeMock }]
    })
    expect(closeMock).toHaveBeenCalledTimes(1)
    expect(h.acceptMicPort).not.toHaveBeenCalled()

    // 受信 chat → 适配成 MicPortMainLike 交给 listening
    listener({
      sender: { id: 1 },
      senderFrame: { url: 'http://localhost:5173/' },
      ports: [{ close: closeMock }]
    })
    expect(h.acceptMicPort).toHaveBeenCalledTimes(1)
    const adopted = h.acceptMicPort.mock.calls[0]![0] as {
      on: (e: string, l: unknown) => void
      start: () => void
      close: () => void
    }
    expect(typeof adopted.on).toBe('function')
    expect(typeof adopted.start).toBe('function')
    expect(typeof adopted.close).toBe('function')
  })
})
