// src/renderer/src/stores/voice.test.ts
// P3V-09：流式 partial 只进入预览字段，final 才进入聊天消费字段。
// P3V-12：备用引擎选择 + 资源根目录动作。
// P3V-16..20：GPT-SoVITS 运行时安装 / 来源选择 / 音色导入的 store 切片。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { AsrEngineId, AsrOverview } from '@shared/voice/asr-settings-types'
import type { AssetDownloadStatus } from '@shared/voice/asset-root-types'
import type { GptRuntimeOverview, GptVoiceProfileView } from '@shared/voice/gpt-runtime-types'
import { ASR_MODEL_CATALOG } from '@shared/voice/asr-catalog'
import { useVoiceStore } from './voice'

/** GPT runtime 快照工厂：默认「什么都没装」，用例只覆盖关心的字段。 */
function makeGptRuntime(overrides: Partial<GptRuntimeOverview> = {}): GptRuntimeOverview {
  return {
    source: { mode: 'auto', active: false, voiceConfigured: false, restartRequired: false },
    voices: [],
    installed: null,
    externalDetected: false,
    variants: [
      {
        variant: 'standard',
        displayName: '通用版',
        downloadBytes: 4_000_000_000,
        recommended: true
      },
      {
        variant: 'rtx50',
        displayName: 'RTX 50 系版',
        downloadBytes: 4_200_000_000,
        recommended: false
      }
    ],
    download: null,
    minFreeBytes: 8_000_000_000,
    freeBytes: 40_000_000_000,
    rootState: 'ok',
    ...overrides
  }
}

function makeGptVoice(overrides: Partial<GptVoiceProfileView> = {}): GptVoiceProfileView {
  return {
    id: 'gpt-sovits:abcdef123456',
    displayName: '奈奈',
    version: 'v2Pro',
    promptLang: 'zh',
    defaultTextLang: 'zh',
    state: 'ready',
    source: 'imported',
    current: false,
    ...overrides
  }
}

function stubVoiceApi(overrides?: {
  downloadAsrModel?: (input: { engineId: string }) => Promise<unknown>
  cancelAsrDownload?: (input: { engineId: string }) => Promise<unknown>
  pauseAsrDownload?: (input: { engineId: string }) => Promise<unknown>
  resumeAsrDownload?: (input: { engineId: string }) => Promise<unknown>
  onAsrOverview?: (listener: (overview: AsrOverview) => void) => () => void
  onVoiceState?: (listener: (event: unknown) => void) => () => void
  onAssetDownload?: (listener: (status: AssetDownloadStatus) => void) => () => void
  getGptRuntime?: () => Promise<unknown>
  installGptRuntime?: (input: { variant: string }) => Promise<unknown>
  pauseGptRuntimeDownload?: (input: { variant: string }) => Promise<unknown>
  resumeGptRuntimeDownload?: (input: { variant: string }) => Promise<unknown>
  cancelGptRuntimeDownload?: (input: { variant: string }) => Promise<unknown>
  deleteGptRuntime?: () => Promise<unknown>
  chooseGptRuntimeDir?: () => Promise<unknown>
  clearGptRuntimeDir?: () => Promise<unknown>
  pickGptVoiceFile?: (input: { kind: string }) => Promise<unknown>
  importGptVoice?: (input: unknown) => Promise<unknown>
  deleteGptVoice?: (input: { voiceId: string }) => Promise<unknown>
  deleteAsrModel?: (input: { engineId: string }) => Promise<unknown>
  setAsrFallbackEngine?: (input: { engineId: string | null }) => Promise<unknown>
  getAssetRoot?: () => Promise<unknown>
  chooseAssetRoot?: () => Promise<unknown>
  resetAssetRoot?: () => Promise<unknown>
}): void {
  vi.stubGlobal('window', {
    companion: {
      voice: {
        downloadAsrModel:
          overrides?.downloadAsrModel ?? (async () => ({ ok: true, data: { ok: true } })),
        cancelAsrDownload:
          overrides?.cancelAsrDownload ??
          (async () => ({ ok: true, data: { ok: true, cancelled: true } })),
        pauseAsrDownload:
          overrides?.pauseAsrDownload ??
          (async () => ({ ok: true, data: { ok: true, paused: true } })),
        resumeAsrDownload:
          overrides?.resumeAsrDownload ??
          (async () => ({ ok: true, data: { ok: true, resumed: true } })),
        onAsrOverview: overrides?.onAsrOverview ?? (() => () => {}),
        onVoiceState: overrides?.onVoiceState ?? (() => () => {}),
        onAssetDownload: overrides?.onAssetDownload ?? (() => () => {}),
        deleteAsrModel:
          overrides?.deleteAsrModel ?? (async () => ({ ok: true, data: { ok: true } })),
        setAsrFallbackEngine:
          overrides?.setAsrFallbackEngine ?? (async () => ({ ok: true, data: { ok: true } })),
        getGptRuntime:
          overrides?.getGptRuntime ?? (async () => ({ ok: true, data: makeGptRuntime() })),
        installGptRuntime:
          overrides?.installGptRuntime ?? (async () => ({ ok: true, data: { ok: true } })),
        pauseGptRuntimeDownload:
          overrides?.pauseGptRuntimeDownload ?? (async () => ({ ok: true, data: { ok: true } })),
        resumeGptRuntimeDownload:
          overrides?.resumeGptRuntimeDownload ?? (async () => ({ ok: true, data: { ok: true } })),
        cancelGptRuntimeDownload:
          overrides?.cancelGptRuntimeDownload ?? (async () => ({ ok: true, data: { ok: true } })),
        deleteGptRuntime:
          overrides?.deleteGptRuntime ?? (async () => ({ ok: true, data: { ok: true } })),
        chooseGptRuntimeDir:
          overrides?.chooseGptRuntimeDir ??
          (async () => ({ ok: true, data: { accepted: false, overview: makeGptRuntime() } })),
        clearGptRuntimeDir:
          overrides?.clearGptRuntimeDir ??
          (async () => ({ ok: true, data: { accepted: true, overview: makeGptRuntime() } })),
        pickGptVoiceFile:
          overrides?.pickGptVoiceFile ?? (async () => ({ ok: true, data: { picked: false } })),
        importGptVoice:
          overrides?.importGptVoice ??
          (async () => ({ ok: true, data: { ok: true, overview: makeGptRuntime() } })),
        deleteGptVoice:
          overrides?.deleteGptVoice ??
          (async () => ({ ok: true, data: { ok: true, overview: makeGptRuntime() } })),
        getAssetRoot:
          overrides?.getAssetRoot ??
          (async () => ({
            ok: true,
            data: { isDefault: true, freeBytes: 999, totalRequiredBytes: 520, state: 'ok' }
          })),
        chooseAssetRoot:
          overrides?.chooseAssetRoot ??
          (async () => ({
            ok: true,
            data: {
              status: { isDefault: false, freeBytes: 888, totalRequiredBytes: 520, state: 'ok' },
              changed: true,
              restartRequired: true
            }
          })),
        resetAssetRoot:
          overrides?.resetAssetRoot ??
          (async () => ({
            ok: true,
            data: {
              status: { isDefault: true, freeBytes: 999, totalRequiredBytes: 520, state: 'ok' },
              changed: true,
              restartRequired: false
            }
          }))
      }
    }
  })
}

function makeAsrOverview(
  states: Partial<Record<AsrEngineId, 'not-downloaded' | 'downloading' | 'ready' | 'error'>> = {}
): AsrOverview {
  return {
    selectedEngineId: 'zipformer-bilingual-zh-en',
    fallbackEngineId: 'sherpa-sensevoice',
    engines: ASR_MODEL_CATALOG.map((model) => ({
      engineId: model.engineId,
      label: model.label,
      localOnly: true,
      modelState: states[model.engineId] ?? 'not-downloaded',
      progressRatio: states[model.engineId] === 'downloading' ? 0.4 : undefined,
      errorCode: states[model.engineId] === 'error' ? 'model-download-failed' : undefined,
      downloadBytes: model.downloadBytes,
      selected: model.engineId === 'zipformer-bilingual-zh-en',
      fallback: model.engineId === 'sherpa-sensevoice'
    })),
    vadModel: { state: 'ready' }
  }
}

describe('voice store：流式转写投影', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    stubVoiceApi()
  })

  it('partial 只更新灰色预览，不写 lastTranscript；final 清空预览并定稿', () => {
    const voice = useVoiceStore()
    voice.applyEvent({ type: 'listening-started' })
    voice.applyEvent({ type: 'transcript-partial', text: '你' })
    expect(voice.state.partialTranscript).toBe('你')
    expect(voice.state.lastTranscript).toBe('')

    voice.applyEvent({ type: 'transcript-partial', text: '你好' })
    expect(voice.state.partialTranscript).toBe('你好')
    expect(voice.state.lastTranscript).toBe('')

    voice.applyEvent({ type: 'transcript', text: '你好世界' })
    expect(voice.state.partialTranscript).toBe('')
    expect(voice.state.lastTranscript).toBe('你好世界')
  })

  it('停止监听和 resetTest 都清空未定稿 partial', () => {
    const voice = useVoiceStore()
    voice.applyEvent({ type: 'transcript-partial', text: '未完' })
    voice.applyEvent({ type: 'listening-stopped', reason: 'user' })
    expect(voice.state.partialTranscript).toBe('')

    voice.applyEvent({ type: 'transcript-partial', text: '又一段' })
    voice.resetTest()
    expect(voice.state.partialTranscript).toBe('')
  })
})

describe('voice store：P3V-15 顺序下载队列', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('第一项 ready 后才发第二项；重复 downloading overview 不重复发 IPC', async () => {
    const download = vi.fn(async () => ({ ok: true, data: { ok: true } }))
    let emitOverview: ((overview: AsrOverview) => void) | null = null
    stubVoiceApi({
      downloadAsrModel: download,
      onAsrOverview: (listener) => {
        emitOverview = listener
        return () => {}
      }
    })
    const voice = useVoiceStore()
    voice.state.asrOverview = makeAsrOverview()
    const off = voice.subscribe()

    voice.queueModelDownloads(['zipformer-bilingual-zh-en', 'sherpa-sensevoice'])
    await Promise.resolve()
    expect(download).toHaveBeenCalledTimes(1)
    expect(download).toHaveBeenLastCalledWith({ engineId: 'zipformer-bilingual-zh-en' })

    emitOverview!(makeAsrOverview({ 'zipformer-bilingual-zh-en': 'downloading' }))
    emitOverview!(makeAsrOverview({ 'zipformer-bilingual-zh-en': 'downloading' }))
    await Promise.resolve()
    expect(download).toHaveBeenCalledTimes(1)

    emitOverview!(makeAsrOverview({ 'zipformer-bilingual-zh-en': 'ready' }))
    await Promise.resolve()
    expect(download).toHaveBeenCalledTimes(2)
    expect(download).toHaveBeenLastCalledWith({ engineId: 'sherpa-sensevoice' })
    expect(voice.state.asrDownloadQueue).toEqual(['sherpa-sensevoice'])
    off()
  })

  it('VAD 前置下载失败时停住模型队列，重试仍从当前模型入口重新发起', async () => {
    const download = vi.fn(async () => ({ ok: true, data: { ok: true } }))
    let emitOverview: ((overview: AsrOverview) => void) | null = null
    stubVoiceApi({
      downloadAsrModel: download,
      onAsrOverview: (listener) => {
        emitOverview = listener
        return () => {}
      }
    })
    const voice = useVoiceStore()
    voice.state.asrOverview = makeAsrOverview()
    const off = voice.subscribe()
    voice.queueModelDownloads(['zipformer-bilingual-zh-en', 'sherpa-sensevoice'])
    await Promise.resolve()

    const base = makeAsrOverview()
    const vadFailed: AsrOverview = {
      ...base,
      vadModel: { state: 'error', errorCode: 'model-download-failed' }
    }
    emitOverview!(vadFailed)
    expect(voice.state.asrQueueError).toContain('Silero VAD')
    expect(voice.state.asrDownloadQueue).toEqual(['zipformer-bilingual-zh-en', 'sherpa-sensevoice'])
    expect(download).toHaveBeenCalledTimes(1)

    voice.retryDownloadQueue()
    await Promise.resolve()
    expect(download).toHaveBeenCalledTimes(2)
    expect(download).toHaveBeenLastCalledWith({ engineId: 'zipformer-bilingual-zh-en' })
    off()
  })

  it('失败停在当前项且不跳过；显式重试才重新发起', async () => {
    const download = vi.fn(async () => ({ ok: true, data: { ok: true } }))
    let emitOverview: ((overview: AsrOverview) => void) | null = null
    stubVoiceApi({
      downloadAsrModel: download,
      onAsrOverview: (listener) => {
        emitOverview = listener
        return () => {}
      }
    })
    const voice = useVoiceStore()
    voice.state.asrOverview = makeAsrOverview()
    const off = voice.subscribe()
    voice.queueModelDownloads(['zipformer-bilingual-zh-en', 'sherpa-sensevoice'])
    await Promise.resolve()

    emitOverview!(makeAsrOverview({ 'zipformer-bilingual-zh-en': 'error' }))
    expect(voice.state.asrQueueError).toContain('Zipformer Bilingual')
    expect(voice.state.asrDownloadQueue).toEqual(['zipformer-bilingual-zh-en', 'sherpa-sensevoice'])
    expect(download).toHaveBeenCalledTimes(1)

    voice.retryDownloadQueue()
    await Promise.resolve()
    expect(download).toHaveBeenCalledTimes(2)
    expect(download).toHaveBeenLastCalledWith({ engineId: 'zipformer-bilingual-zh-en' })
    off()
  })

  it('取消当前项等待 main 发非 downloading 终态后才推进下一项', async () => {
    const download = vi.fn(async () => ({ ok: true, data: { ok: true } }))
    const cancel = vi.fn(async () => ({ ok: true, data: { ok: true, cancelled: true } }))
    let emitOverview: ((overview: AsrOverview) => void) | null = null
    stubVoiceApi({
      downloadAsrModel: download,
      cancelAsrDownload: cancel,
      onAsrOverview: (listener) => {
        emitOverview = listener
        return () => {}
      }
    })
    const voice = useVoiceStore()
    voice.state.asrOverview = makeAsrOverview()
    const off = voice.subscribe()
    voice.queueModelDownloads(['zipformer-bilingual-zh-en', 'sherpa-sensevoice'])
    emitOverview!(makeAsrOverview({ 'zipformer-bilingual-zh-en': 'downloading' }))

    await voice.cancelQueuedDownload('zipformer-bilingual-zh-en')
    expect(cancel).toHaveBeenCalledWith({ engineId: 'zipformer-bilingual-zh-en' })
    expect(download).toHaveBeenCalledTimes(1)
    expect(voice.state.asrDownloadQueue[0]).toBe('zipformer-bilingual-zh-en')

    emitOverview!(makeAsrOverview({ 'zipformer-bilingual-zh-en': 'not-downloaded' }))
    await Promise.resolve()
    expect(download).toHaveBeenCalledTimes(2)
    expect(download).toHaveBeenLastCalledWith({ engineId: 'sherpa-sensevoice' })
    expect(voice.state.asrDownloadQueue).toEqual(['sherpa-sensevoice'])
    off()
  })
})

describe('voice store：P3V-09/12 备用引擎与资源根目录', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('deleteModel：成功清 overviewError；忙/失败写人话错误', async () => {
    stubVoiceApi()
    const voice = useVoiceStore()
    voice.state.overviewError = '旧错误'
    expect(await voice.deleteModel('sherpa-sensevoice')).toBe(true)
    expect(voice.state.overviewError).toBeNull()

    stubVoiceApi({
      deleteAsrModel: async () => ({
        ok: false,
        error: { code: 'ASR_BUSY', message: '模型正在使用或下载中' }
      })
    })
    const failed = useVoiceStore()
    expect(await failed.deleteModel('sherpa-sensevoice')).toBe(false)
    expect(failed.state.overviewError).toBe('模型正在使用或下载中')
  })

  it('pause/resumeDownload 如实返回布尔；IPC 错误写可见提示', async () => {
    stubVoiceApi({
      pauseAsrDownload: async () => ({ ok: true, data: { ok: true, paused: false } }),
      resumeAsrDownload: async () => ({
        ok: false,
        error: { code: 'IPC_ERROR', message: '继续下载失败，请重试' }
      })
    })
    const voice = useVoiceStore()
    expect(await voice.pauseDownload('sherpa-sensevoice')).toBe(false)
    expect(await voice.resumeDownload('zipformer-bilingual-zh-en')).toBe(false)
    expect(voice.state.overviewError).toBe('继续下载失败，请重试')
  })

  it('setFallbackEngine：成功清 overviewError；失败写人话错误', async () => {
    stubVoiceApi()
    const voice = useVoiceStore()
    voice.state.overviewError = '旧错误'
    expect(await voice.setFallbackEngine('sherpa-sensevoice')).toBe(true)
    expect(voice.state.overviewError).toBeNull()

    stubVoiceApi({
      setAsrFallbackEngine: async () => ({
        ok: false,
        error: { code: 'CFG_INVALID', message: '主备不能是同一个模型' }
      })
    })
    const failed = useVoiceStore()
    expect(await failed.setFallbackEngine('sherpa-sensevoice')).toBe(false)
    expect(failed.state.overviewError).toBe('主备不能是同一个模型')
  })

  it('fallbackEngineId 从 overview 投影（null = 未设备用）', () => {
    stubVoiceApi()
    const voice = useVoiceStore()
    expect(voice.fallbackEngineId).toBeNull() // 无 overview
    // overview 事件载荷与 store 投影路径一致（subscribe → applyOverview → state）
    voice.state.asrOverview = {
      selectedEngineId: 'zipformer-bilingual-zh-en',
      fallbackEngineId: 'sherpa-sensevoice',
      engines: [],
      vadModel: { state: 'ready' }
    }
    expect(voice.fallbackEngineId).toBe('sherpa-sensevoice')
  })

  it('hydrateAssetRoot 写入状态；chooseAssetRoot 提示重启生效；resetAssetRoot 清提示', async () => {
    stubVoiceApi()
    const voice = useVoiceStore()
    await voice.hydrateAssetRoot()
    expect(voice.state.assetRoot).toEqual({
      isDefault: true,
      freeBytes: 999,
      totalRequiredBytes: 520,
      state: 'ok'
    })
    expect(voice.state.assetRootRestartRequired).toBe(false)
    expect(voice.state.assetRootNotice).toBeNull()

    await voice.chooseAssetRoot()
    expect(voice.state.assetRoot).toEqual({
      isDefault: false,
      freeBytes: 888,
      totalRequiredBytes: 520,
      state: 'ok'
    })
    expect(voice.state.assetRootRestartRequired).toBe(true)
    expect(voice.state.assetRootNotice).toBe(
      '新的存储位置将在重启应用后生效；重启前不会把模型下载到旧位置'
    )

    await voice.resetAssetRoot()
    expect(voice.state.assetRoot).toEqual({
      isDefault: true,
      freeBytes: 999,
      totalRequiredBytes: 520,
      state: 'ok'
    })
    expect(voice.state.assetRootRestartRequired).toBe(false)
    expect(voice.state.assetRootNotice).toBeNull()
  })

  it('chooseAssetRoot 失败写人话提示（用户取消不算失败——main 返回 ok+changed:false）', async () => {
    stubVoiceApi({
      chooseAssetRoot: async () => ({
        ok: false,
        error: { code: 'IPC_ERROR', message: '对话框打开失败' }
      })
    })
    const voice = useVoiceStore()
    await voice.chooseAssetRoot()
    expect(voice.state.assetRootNotice).toBe('对话框打开失败')
  })
})

describe('voice store：P3V-16..20 GPT-SoVITS 运行时与音色', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('hydrateGptRuntime 写入快照；失败只写提示不清旧快照', async () => {
    stubVoiceApi({
      getGptRuntime: async () => ({
        ok: true,
        data: makeGptRuntime({ externalDetected: true })
      })
    })
    const voice = useVoiceStore()
    await voice.hydrateGptRuntime()
    expect(voice.state.gptRuntime?.externalDetected).toBe(true)
    expect(voice.state.gptRuntimeNotice).toBeNull()

    stubVoiceApi({
      getGptRuntime: async () => ({
        ok: false,
        error: { code: 'IPC_ERROR', message: '读取失败' }
      })
    })
    await voice.hydrateGptRuntime()
    expect(voice.state.gptRuntime?.externalDetected).toBe(true) // 旧快照保留
    expect(voice.state.gptRuntimeNotice).toBe('读取失败')
  })

  it('gptRuntimeReady/gptVoices 从快照投影；download 只认进行中的任务', async () => {
    const download: AssetDownloadStatus = {
      assetId: 'gpt-runtime-standard',
      state: 'done',
      receivedBytes: 10,
      totalBytes: 10
    }
    stubVoiceApi({
      getGptRuntime: async () => ({
        ok: true,
        data: makeGptRuntime({
          source: { mode: 'auto', active: true, voiceConfigured: true, restartRequired: false },
          voices: [makeGptVoice({ current: true })],
          download
        })
      })
    })
    const voice = useVoiceStore()
    expect(voice.gptRuntimeReady).toBe(false) // 未 hydrate 时按「还没准备好」显示
    await voice.hydrateGptRuntime()
    expect(voice.gptRuntimeReady).toBe(true)
    expect(voice.gptVoices.map((v) => v.id)).toEqual(['gpt-sovits:abcdef123456'])
    expect(voice.gptRuntimeDownload).toBeNull() // done 不是「进行中」
  })

  it('applyAssetDownload：只认 gpt-runtime- 前缀；done 触发一次完整快照回读', async () => {
    let hydrateCalls = 0
    stubVoiceApi({
      getGptRuntime: async () => {
        hydrateCalls += 1
        return { ok: true, data: makeGptRuntime() }
      }
    })
    const voice = useVoiceStore()
    voice.applyAssetDownload({
      assetId: 'gpt-runtime-standard',
      state: 'downloading',
      receivedBytes: 1,
      totalBytes: 10
    })
    expect(voice.state.gptRuntime).toBeNull() // 没 hydrate 过就不凭事件凭空造快照

    await voice.hydrateGptRuntime()
    expect(hydrateCalls).toBe(1)

    voice.applyAssetDownload({
      assetId: 'asr-zipformer',
      state: 'downloading',
      receivedBytes: 5,
      totalBytes: 10
    })
    expect(voice.state.gptRuntime?.download).toBeNull() // 不是 GPT runtime 的事件，忽略

    voice.applyAssetDownload({
      assetId: 'gpt-runtime-standard',
      state: 'downloading',
      receivedBytes: 3,
      totalBytes: 10
    })
    expect(voice.gptRuntimeDownload?.receivedBytes).toBe(3)
    expect(hydrateCalls).toBe(1) // 进行中不回读

    voice.applyAssetDownload({
      assetId: 'gpt-runtime-standard',
      state: 'done',
      receivedBytes: 10,
      totalBytes: 10
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(hydrateCalls).toBe(2) // done 回读一次拿 installed/restartRequired 真值
  })

  it('installGptRuntime 失败写人话提示；成功后立刻回读快照', async () => {
    stubVoiceApi({
      installGptRuntime: async () => ({
        ok: false,
        error: { code: 'CFG_INVALID', message: '存储位置不可写，先换个位置' }
      })
    })
    const failed = useVoiceStore()
    expect(await failed.installGptRuntime('standard')).toBe(false)
    expect(failed.state.gptRuntimeNotice).toBe('存储位置不可写，先换个位置')

    stubVoiceApi({
      getGptRuntime: async () => ({
        ok: true,
        data: makeGptRuntime({
          download: {
            assetId: 'gpt-runtime-standard',
            state: 'downloading',
            receivedBytes: 0,
            totalBytes: 10
          }
        })
      })
    })
    const ok = useVoiceStore()
    expect(await ok.installGptRuntime('standard')).toBe(true)
    expect(ok.gptRuntimeDownload?.state).toBe('downloading')
  })

  it('chooseGptRuntimeDir：目录不是整合包时如实说清缺什么；接受则提示重启生效', async () => {
    stubVoiceApi({
      chooseGptRuntimeDir: async () => ({
        ok: true,
        data: { accepted: false, reason: 'not-gpt-sovits', overview: makeGptRuntime() }
      })
    })
    const rejected = useVoiceStore()
    expect(await rejected.chooseGptRuntimeDir()).toBe(false)
    expect(rejected.state.gptRuntimeNotice).toContain('api_v2.py')

    stubVoiceApi({
      chooseGptRuntimeDir: async () => ({
        ok: true,
        data: {
          accepted: true,
          overview: makeGptRuntime({
            source: { mode: 'custom', active: false, voiceConfigured: true, restartRequired: true }
          })
        }
      })
    })
    const accepted = useVoiceStore()
    expect(await accepted.chooseGptRuntimeDir()).toBe(true)
    expect(accepted.state.gptRuntime?.source.mode).toBe('custom')
    expect(accepted.state.gptRuntimeNotice).toBe('已记住这个位置，重启 Nacime 后生效')
  })

  it('chooseGptRuntimeDir 用户取消（cancelled）不写错误提示', async () => {
    stubVoiceApi({
      chooseGptRuntimeDir: async () => ({
        ok: true,
        data: { accepted: false, reason: 'cancelled', overview: makeGptRuntime() }
      })
    })
    const voice = useVoiceStore()
    expect(await voice.chooseGptRuntimeDir()).toBe(false)
    expect(voice.state.gptRuntimeNotice).toBeNull()
  })

  it('pickGptVoiceFile 只记文件名（不落路径）；取消时不动暂存', async () => {
    stubVoiceApi({
      pickGptVoiceFile: async () => ({
        ok: true,
        data: { picked: true, fileName: 'nacime-e15.ckpt' }
      })
    })
    const voice = useVoiceStore()
    expect(await voice.pickGptVoiceFile('gpt-weights')).toBe(true)
    expect(voice.state.gptVoiceStagedFiles['gpt-weights']).toBe('nacime-e15.ckpt')
    expect(voice.state.gptVoiceStagedFiles['ref-audio']).toBeNull()

    stubVoiceApi({ pickGptVoiceFile: async () => ({ ok: true, data: { picked: false } }) })
    const cancelled = useVoiceStore()
    expect(await cancelled.pickGptVoiceFile('ref-audio')).toBe(false)
    expect(cancelled.state.gptVoiceStagedFiles['ref-audio']).toBeNull()
  })

  it('importGptVoice：缺文件/重复各给一句人话；成功清空暂存', async () => {
    const request = {
      displayName: '奈奈',
      version: 'v2Pro' as const,
      promptText: '你好呀',
      promptLang: 'zh' as const,
      defaultTextLang: 'zh' as const
    }

    stubVoiceApi({
      importGptVoice: async () => ({
        ok: true,
        data: { ok: false, reason: 'files-missing', overview: makeGptRuntime() }
      })
    })
    const missing = useVoiceStore()
    expect(await missing.importGptVoice(request)).toBe(false)
    expect(missing.state.gptRuntimeNotice).toContain('还差文件没选')

    stubVoiceApi({
      importGptVoice: async () => ({
        ok: true,
        data: { ok: false, reason: 'duplicate', overview: makeGptRuntime() }
      })
    })
    const duplicate = useVoiceStore()
    expect(await duplicate.importGptVoice(request)).toBe(false)
    expect(duplicate.state.gptRuntimeNotice).toBe('这个音色已经在列表里了')

    stubVoiceApi({
      importGptVoice: async () => ({
        ok: true,
        data: { ok: true, overview: makeGptRuntime({ voices: [makeGptVoice()] }) }
      })
    })
    const ok = useVoiceStore()
    ok.state.gptVoiceStagedFiles = {
      'gpt-weights': 'a.ckpt',
      'sovits-weights': 'b.pth',
      'ref-audio': 'c.wav'
    }
    expect(await ok.importGptVoice(request)).toBe(true)
    expect(ok.gptVoices).toHaveLength(1)
    expect(ok.state.gptVoiceStagedFiles).toEqual({
      'gpt-weights': null,
      'sovits-weights': null,
      'ref-audio': null
    })
  })

  it('deleteGptVoice：discovered 音色不能删，如实说明来源', async () => {
    stubVoiceApi({
      deleteGptVoice: async () => ({
        ok: true,
        data: {
          ok: false,
          overview: makeGptRuntime({ voices: [makeGptVoice({ source: 'discovered' })] })
        }
      })
    })
    const voice = useVoiceStore()
    expect(await voice.deleteGptVoice('gpt-sovits:abcdef123456')).toBe(false)
    expect(voice.state.gptRuntimeNotice).toBe(
      '这个音色来自你的 GPT-SoVITS 安装配置，不能在这里删除'
    )
    expect(voice.gptVoices).toHaveLength(1)
  })
})
