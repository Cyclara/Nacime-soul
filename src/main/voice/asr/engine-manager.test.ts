// src/main/voice/asr/engine-manager.test.ts
// P3B-14：引擎管理器合同——overview 投影、仅显式选择、弃旧实例、下载触发。
// P3V-09：主/备引擎——setFallbackEngine、主备同体拒绝、撞车清除、overview 投影。

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAsrEngineManager } from './engine-manager'
import { asrEngineDirName, asrEngineRequiredFiles } from './download-catalog'
import type { ModelDownloader, ModelDownloadState, ModelDownloadTarget } from './model-downloader'
import type { AsrNativeBinding } from './engine-manager'
import type { SherpaOnlineStreamLike, SherpaRecognizerLike } from './sherpa-binding'
import type { SileroVadBinding, SileroVadRecognizer } from '../vad/silero-binding'
import type { AsrEngineId } from '@shared/voice/asr-settings-types'
import { isStreamingAsrEngineId } from '@shared/voice/asr-settings-types'
import { makeSilentPcm16 } from '../../../../tests/helpers/silent-pcm'

/** 假原生绑定：三种能力都给，且都不碰真模型/GPU。 */
function makeFakeAsrBinding(trace?: { onlineRecognizerCloses: number }): AsrNativeBinding {
  function fakeOfflineRecognizer(): SherpaRecognizerLike {
    return {
      recognize: () => ({ text: 'fake' }),
      close() {
        /* noop */
      }
    }
  }
  function fakeOnlineStream(): SherpaOnlineStreamLike {
    return {
      acceptWaveform() {
        /* noop */
      },
      decodeAll: () => 'fake',
      isEndpoint: () => false,
      reset() {
        /* noop */
      },
      inputFinished() {
        /* noop */
      },
      close() {
        /* noop */
      }
    }
  }
  return {
    createRecognizer: fakeOfflineRecognizer,
    createTransducerRecognizer: fakeOfflineRecognizer,
    createOnlineRecognizer: () => ({
      createStream: fakeOnlineStream,
      close() {
        if (trace !== undefined) trace.onlineRecognizerCloses++
      }
    })
  }
}

function makeFakeVadBinding(): SileroVadBinding {
  return {
    createVad() {
      const vad: SileroVadRecognizer = {
        acceptWaveform() {
          /* noop */
        },
        isDetected: () => false,
        isEmpty: () => true,
        pop() {
          /* noop */
        },
        reset() {
          /* noop */
        },
        close() {
          /* noop */
        }
      }
      return vad
    }
  }
}

/** 假下载器：记录调用 + 可注入每目标的 state。 */
function makeFakeDownloader(options?: { readonly rootDir?: string }): {
  downloader: ModelDownloader
  downloads: ModelDownloadTarget[]
  cancels: ModelDownloadTarget[]
  setState: (t: ModelDownloadTarget, kind: 'idle' | 'downloading' | 'done' | 'error') => void
} {
  const downloads: ModelDownloadTarget[] = []
  const cancels: ModelDownloadTarget[] = []
  const states = new Map<ModelDownloadTarget, ModelDownloadState>()
  function stateOf(target: ModelDownloadTarget): ModelDownloadState {
    return states.get(target) ?? { kind: 'idle' }
  }
  return {
    downloader: {
      state: (target) => stateOf(target),
      status: (target) => ({
        assetId: target,
        state: stateOf(target).kind === 'downloading' ? 'downloading' : 'idle',
        receivedBytes: 0,
        totalBytes: 1,
        resumable: false
      }),
      download: async (target) => {
        downloads.push(target)
        // VAD 小文件在 fake Promise resolve 前已安装完成；识别模型保持活动态供去重断言。
        states.set(
          target,
          target === 'vad' ? { kind: 'done' } : { kind: 'downloading', progress: 0.5 }
        )
        if (target === 'vad' && options?.rootDir !== undefined) {
          await mkdir(join(options.rootDir, 'vad'), { recursive: true })
          await writeFile(join(options.rootDir, 'vad/silero_vad.onnx'), 'vad-model')
        }
      },
      cancel: (target) => {
        cancels.push(target)
        return true
      },
      pause: () => false,
      resume: () => false,
      isActive: (target) => stateOf(target).kind === 'downloading',
      deleteModel: async () => true
    },
    downloads,
    cancels,
    setState: (target, kind) => {
      if (kind === 'downloading') {
        states.set(target, { kind: 'downloading', progress: 0.5 })
      } else if (kind === 'error') {
        states.set(target, { kind: 'error', code: 'model-download-failed', message: 'x' })
      } else {
        states.set(target, { kind })
      }
    }
  }
}

/** P3V-09：主/备选择的可变状态（模拟 config 读写）。 */
interface SelectionState {
  selected: AsrEngineId
  fallback: AsrEngineId | null
}

function makeManager(
  rootDir: string,
  selection: SelectionState,
  downloader: ModelDownloader,
  options?: {
    binding?: AsrNativeBinding
    persistPrimary?: (id: AsrEngineId) => Promise<boolean>
    persistFallback?: (id: AsrEngineId | null) => Promise<boolean>
    onOverviewChange?: () => void
  }
): ReturnType<typeof createAsrEngineManager> {
  return createAsrEngineManager({
    rootDir,
    binding: options?.binding ?? makeFakeAsrBinding(),
    vadBinding: makeFakeVadBinding(),
    getSelectedEngineId: () => selection.selected,
    setSelectedEngineId: async (id) => {
      if (options?.persistPrimary) return options.persistPrimary(id)
      selection.selected = id
      return true
    },
    getFallbackEngineId: () => selection.fallback,
    setFallbackEngineId: async (id) => {
      if (options?.persistFallback) return options.persistFallback(id)
      selection.fallback = id
      return true
    },
    downloader,
    onOverviewChange: options?.onOverviewChange
  })
}

describe('P3B-14 engine-manager：overview 投影', () => {
  let root: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'em-'))
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('默认：六引擎齐全、全 localOnly、SenseVoice 选中、模型未下载', async () => {
    const fake = makeFakeDownloader()
    const manager = makeManager(
      root,
      { selected: 'sherpa-sensevoice', fallback: null },
      fake.downloader
    )
    const overview = manager.getOverview()
    expect(overview.selectedEngineId).toBe('sherpa-sensevoice')
    expect(overview.fallbackEngineId).toBeNull()
    expect(overview.engines.map((e) => e.engineId)).toEqual([
      'zipformer-bilingual-zh-en',
      'paraformer-bilingual-zh-en',
      'zipformer-streaming-zh-14m',
      'sherpa-sensevoice',
      'funasr-paraformer',
      'parakeet-tdt-v2'
    ])
    expect(overview.engines.every((e) => e.localOnly === true)).toBe(true)
    expect(overview.engines.find((e) => e.selected)?.engineId).toBe('sherpa-sensevoice')
    expect(overview.engines.every((e) => e.fallback === false)).toBe(true)
    expect(overview.engines.every((e) => e.modelState === 'not-downloaded')).toBe(true)
    expect(overview.vadModel.state).toBe('not-downloaded')
    expect(overview.engines[0]!.downloadBytes).toBeGreaterThan(100_000_000)
  })

  it('P3V-09：备用引擎进 overview——卡上有 fallback 标志且与 selected 互斥', async () => {
    const fake = makeFakeDownloader()
    const manager = makeManager(
      root,
      { selected: 'zipformer-bilingual-zh-en', fallback: 'sherpa-sensevoice' },
      fake.downloader
    )
    const overview = manager.getOverview()
    expect(overview.selectedEngineId).toBe('zipformer-bilingual-zh-en')
    expect(overview.fallbackEngineId).toBe('sherpa-sensevoice')
    const fallbackCard = overview.engines.find((e) => e.engineId === 'sherpa-sensevoice')
    expect(fallbackCard?.fallback).toBe(true)
    expect(fallbackCard?.selected).toBe(false)
    // 主备同体在投影上不可能出现（validator 亦纵深防御）
    expect(overview.engines.every((e) => !(e.selected && e.fallback))).toBe(true)
  })

  it('下载中：downloading + 进度；下载完成但文件缺失 → error(model-corrupt)', async () => {
    const fake = makeFakeDownloader()
    fake.setState('sherpa-sensevoice', 'downloading')
    const manager = makeManager(
      root,
      { selected: 'sherpa-sensevoice', fallback: null },
      fake.downloader
    )
    const downloading = manager
      .getOverview()
      .engines.find((e) => e.engineId === 'sherpa-sensevoice')
    expect(downloading?.modelState).toBe('downloading')
    expect(downloading?.progressRatio).toBe(0.5)

    fake.setState('sherpa-sensevoice', 'done')
    expect(
      manager.getOverview().engines.find((e) => e.engineId === 'sherpa-sensevoice')?.modelState
    ).toBe('error')
  })

  it('模型文件在场 → ready（懒加载可用）', async () => {
    await mkdir(join(root, 'sense-voice'), { recursive: true })
    await writeFile(join(root, 'sense-voice/model.onnx'), 'model')
    await writeFile(join(root, 'sense-voice/tokens.txt'), 't')
    const fake = makeFakeDownloader()
    const manager = makeManager(
      root,
      { selected: 'sherpa-sensevoice', fallback: null },
      fake.downloader
    )
    expect(
      manager.getOverview().engines.find((e) => e.engineId === 'sherpa-sensevoice')?.modelState
    ).toBe('ready')
    expect(manager.vadModelPath()).toBeNull()
    await rm(join(root, 'sense-voice'), { recursive: true, force: true })
  })

  it('VAD 文件在场 → vadModel ready + 路径可拿', async () => {
    await mkdir(join(root, 'vad'), { recursive: true })
    await writeFile(join(root, 'vad/silero_vad.onnx'), 'vad-model')
    const fake = makeFakeDownloader()
    const manager = makeManager(
      root,
      { selected: 'sherpa-sensevoice', fallback: null },
      fake.downloader
    )
    expect(manager.getOverview().vadModel.state).toBe('ready')
    expect(manager.vadModelPath()).toContain('vad/silero_vad.onnx')
    await rm(join(root, 'vad'), { recursive: true, force: true })
  })
})

describe('P3B-14 engine-manager：切换与下载', () => {
  let root: string
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'em-switch-'))
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('selectEngine：持久化成功 → 弃旧实例 + 新引擎选中', async () => {
    const selection: SelectionState = { selected: 'sherpa-sensevoice', fallback: null }
    const fake = makeFakeDownloader()
    const manager = makeManager(root, selection, fake.downloader)
    await manager.selectEngine('funasr-paraformer')
    expect(selection.selected).toBe('funasr-paraformer')
    expect(manager.selectedEngineId()).toBe('funasr-paraformer')
    expect(manager.getOverview().selectedEngineId).toBe('funasr-paraformer')
    expect(manager.getOverview().engines.find((e) => e.selected)?.engineId).toBe(
      'funasr-paraformer'
    )
  })

  it('selectEngine 持久化失败 → 保持旧引擎', async () => {
    const fake = makeFakeDownloader()
    const manager = makeManager(
      root,
      { selected: 'sherpa-sensevoice', fallback: null },
      fake.downloader,
      { persistPrimary: async () => false }
    )
    expect(await manager.selectEngine('funasr-paraformer')).toBe(false)
    expect(manager.selectedEngineId()).toBe('sherpa-sensevoice')
  })

  it('downloadModel：VAD 缺失时先补 VAD 再下载引擎；已下载的不重复触发', async () => {
    const fake = makeFakeDownloader({ rootDir: root })
    const manager = makeManager(
      root,
      { selected: 'sherpa-sensevoice', fallback: null },
      fake.downloader
    )
    manager.downloadModel('sherpa-sensevoice')
    await vi.waitFor(() => {
      expect(fake.downloads).toContain('sherpa-sensevoice')
    })
    // VAD 缺失 → 先排入 vad（顺序由下载器串行）
    expect(fake.downloads[0]).toBe('vad')
    expect(fake.downloads).toHaveLength(2) // vad + engine

    // 第二发：两者都在 downloading → 不重复触发（守卫）
    manager.downloadModel('sherpa-sensevoice')
    await new Promise((r) => setTimeout(r, 10))
    expect(fake.downloads.filter((d) => d === 'vad').length).toBe(1)
    expect(fake.downloads.filter((d) => d === 'sherpa-sensevoice').length).toBe(1)
  })

  it('ensureEngineReady：模型文件在场 → 懒加载成功（state ready）', async () => {
    await mkdir(join(root, 'sense-voice'), { recursive: true })
    await writeFile(join(root, 'sense-voice/model.onnx'), 'model')
    await writeFile(join(root, 'sense-voice/tokens.txt'), 't')
    const fake = makeFakeDownloader()
    const manager = makeManager(
      root,
      { selected: 'sherpa-sensevoice', fallback: null },
      fake.downloader
    )
    const engine = await manager.ensureEngineReady('sherpa-sensevoice')
    expect(engine.id).toBe('sherpa-sensevoice')
    expect((await engine.recognize(makeSilentPcm16(20))).text).toBe('fake')
    await rm(join(root, 'sense-voice'), { recursive: true, force: true })
  })

  it('ensureEngineReady：模型缺失抛 model-missing；给流式引擎 id 拒绝', async () => {
    const fake = makeFakeDownloader()
    const manager = makeManager(
      root,
      { selected: 'sherpa-sensevoice', fallback: null },
      fake.downloader
    )
    await expect(manager.ensureEngineReady('sherpa-sensevoice')).rejects.toMatchObject({
      asrCode: 'model-missing'
    })
    await expect(manager.ensureEngineReady('zipformer-bilingual-zh-en')).rejects.toMatchObject({
      asrCode: 'engine-init-failed'
    })
  })

  it('三个流式引擎均走新 ABI；离线入口拒绝误用', async () => {
    for (const engineId of [
      'zipformer-bilingual-zh-en',
      'paraformer-bilingual-zh-en',
      'zipformer-streaming-zh-14m'
    ] as const) {
      const dir = join(root, asrEngineDirName(engineId))
      await mkdir(dir, { recursive: true })
      for (const file of asrEngineRequiredFiles(engineId)) await writeFile(join(dir, file), file)

      const fake = makeFakeDownloader()
      const manager = makeManager(root, { selected: engineId, fallback: null }, fake.downloader)
      expect(isStreamingAsrEngineId(engineId)).toBe(true)
      const engine = await manager.ensureStreamingEngineReady(engineId)
      expect(engine.id).toBe(engineId)
      expect(engine.streaming).toBe(true)
      const stream = engine.startStream()
      stream.feed(makeSilentPcm16(20))
      expect(stream.partial()).toEqual({ text: 'fake' })
      stream.dispose()
      await expect(manager.ensureEngineReady(engineId)).rejects.toMatchObject({
        asrCode: 'engine-init-failed'
      })
      manager.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('切换或 dispose 管理器会显式关闭已加载的在线 recognizer', async () => {
    const dir = join(root, asrEngineDirName('zipformer-streaming-zh-14m'))
    await mkdir(dir, { recursive: true })
    for (const file of asrEngineRequiredFiles('zipformer-streaming-zh-14m')) {
      await writeFile(join(dir, file), file)
    }
    const selection: SelectionState = { selected: 'zipformer-streaming-zh-14m', fallback: null }
    const trace = { onlineRecognizerCloses: 0 }
    const fake = makeFakeDownloader()
    const manager = makeManager(root, selection, fake.downloader, {
      binding: makeFakeAsrBinding(trace)
    })
    await manager.ensureStreamingEngineReady('zipformer-streaming-zh-14m')
    expect(trace.onlineRecognizerCloses).toBe(0)
    await manager.selectEngine('sherpa-sensevoice')
    expect(trace.onlineRecognizerCloses).toBe(1)

    selection.selected = 'zipformer-streaming-zh-14m'
    await manager.ensureStreamingEngineReady('zipformer-streaming-zh-14m')
    manager.dispose()
    manager.dispose()
    expect(trace.onlineRecognizerCloses).toBe(2)
    await rm(dir, { recursive: true, force: true })
  })

  it('Parakeet 走冻结离线 ABI；流式入口拒绝误用', async () => {
    const dir = join(root, 'parakeet-tdt-v2')
    await mkdir(dir, { recursive: true })
    for (const file of [
      'encoder.int8.onnx',
      'decoder.int8.onnx',
      'joiner.int8.onnx',
      'tokens.txt'
    ]) {
      await writeFile(join(dir, file), file)
    }
    const fake = makeFakeDownloader()
    const manager = makeManager(
      root,
      { selected: 'parakeet-tdt-v2', fallback: null },
      fake.downloader
    )
    const engine = await manager.ensureEngineReady('parakeet-tdt-v2')
    expect(engine.id).toBe('parakeet-tdt-v2')
    expect((await engine.recognize(makeSilentPcm16(20))).text).toBe('fake')
    await expect(manager.ensureStreamingEngineReady('parakeet-tdt-v2')).rejects.toMatchObject({
      asrCode: 'engine-init-failed'
    })
    manager.dispose()
    await rm(dir, { recursive: true, force: true })
  })
})

describe('P3V-09 engine-manager：主/备引擎', () => {
  let root: string
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'em-fallback-'))
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('setFallbackEngine：设置/清除都持久化，并刷新 overview', async () => {
    const selection: SelectionState = { selected: 'zipformer-bilingual-zh-en', fallback: null }
    const fake = makeFakeDownloader()
    let overviewChanges = 0
    const manager = makeManager(root, selection, fake.downloader, {
      onOverviewChange: () => {
        overviewChanges++
      }
    })
    expect(manager.fallbackEngineId()).toBeNull()

    expect(await manager.setFallbackEngine('sherpa-sensevoice')).toBe(true)
    expect(selection.fallback).toBe('sherpa-sensevoice')
    expect(manager.fallbackEngineId()).toBe('sherpa-sensevoice')

    expect(await manager.setFallbackEngine(null)).toBe(true)
    expect(selection.fallback).toBeNull()
    expect(manager.fallbackEngineId()).toBeNull()
    expect(overviewChanges).toBe(2)
  })

  it('setFallbackEngine：主备同体拒绝；未知 id 拒绝；持久化失败返回 false', async () => {
    const fake = makeFakeDownloader()
    const manager = makeManager(
      root,
      { selected: 'sherpa-sensevoice', fallback: null },
      fake.downloader,
      { persistFallback: async () => false }
    )
    expect(await manager.setFallbackEngine('sherpa-sensevoice')).toBe(false) // 同体
    expect(await manager.setFallbackEngine('groq-whisper' as AsrEngineId)).toBe(false) // 未知
    expect(await manager.setFallbackEngine('funasr-paraformer')).toBe(false) // 写盘失败
    expect(manager.fallbackEngineId()).toBeNull()
  })

  it('selectEngine 撞上旧备用 → 顺手清除备用（回退到自己没有意义）', async () => {
    const selection: SelectionState = {
      selected: 'zipformer-bilingual-zh-en',
      fallback: 'sherpa-sensevoice'
    }
    const fake = makeFakeDownloader()
    const manager = makeManager(root, selection, fake.downloader)
    await manager.selectEngine('sherpa-sensevoice')
    expect(selection.selected).toBe('sherpa-sensevoice')
    expect(selection.fallback).toBeNull()
    expect(manager.getOverview().fallbackEngineId).toBeNull()
  })

  it('selectEngine 不撞备用 → 备用原样保留', async () => {
    const selection: SelectionState = {
      selected: 'zipformer-bilingual-zh-en',
      fallback: 'sherpa-sensevoice'
    }
    const fake = makeFakeDownloader()
    const manager = makeManager(root, selection, fake.downloader)
    await manager.selectEngine('paraformer-bilingual-zh-en')
    expect(selection.fallback).toBe('sherpa-sensevoice')
    expect(manager.getOverview().fallbackEngineId).toBe('sherpa-sensevoice')
  })
})
