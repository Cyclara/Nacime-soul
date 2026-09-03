// @vitest-environment jsdom
// P3V-14：首次语音设置可跳过；开始仅排后台下载，不等待资源完成。
// P3V-20：第 3/4 步换成真实的 GPT-SoVITS 运行环境卡与本地音色库（不再诚实禁用）。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { ASR_MODEL_CATALOG } from '@shared/voice/asr-catalog'
import type { AsrOverview } from '@shared/voice/asr-settings-types'
import type { GptRuntimeOverview } from '@shared/voice/gpt-runtime-types'
import { useVoiceStore } from '../../stores/voice'
import VoiceSetupStep from './VoiceSetupStep.vue'

function makeGptRuntime(): GptRuntimeOverview {
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
    freeBytes: 30_000_000_000,
    rootState: 'ok'
  }
}

function makeOverview(): AsrOverview {
  return {
    selectedEngineId: 'zipformer-bilingual-zh-en',
    fallbackEngineId: 'sherpa-sensevoice',
    engines: ASR_MODEL_CATALOG.map((model) => ({
      engineId: model.engineId,
      label: model.label,
      localOnly: true,
      modelState: 'not-downloaded',
      downloadBytes: model.downloadBytes,
      selected: model.engineId === 'zipformer-bilingual-zh-en',
      fallback: model.engineId === 'sherpa-sensevoice'
    })),
    vadModel: { state: 'not-downloaded' }
  }
}

function setupVoiceApi(): {
  selectAsrEngine: ReturnType<typeof vi.fn>
  setAsrFallbackEngine: ReturnType<typeof vi.fn>
  downloadAsrModel: ReturnType<typeof vi.fn>
  installGptRuntime: ReturnType<typeof vi.fn>
  chooseGptRuntimeDir: ReturnType<typeof vi.fn>
  pickGptVoiceFile: ReturnType<typeof vi.fn>
} {
  const selectAsrEngine = vi.fn(async () => ({ ok: true, data: { ok: true } }))
  const setAsrFallbackEngine = vi.fn(async () => ({ ok: true, data: { ok: true } }))
  const downloadAsrModel = vi.fn(async () => ({ ok: true, data: { ok: true } }))
  const installGptRuntime = vi.fn(async () => ({ ok: true, data: { ok: true } }))
  const chooseGptRuntimeDir = vi.fn(async () => ({
    ok: true,
    data: { accepted: false, changed: false, reason: 'cancelled', overview: makeGptRuntime() }
  }))
  const pickGptVoiceFile = vi.fn(async () => ({
    ok: true,
    data: { picked: true, kind: 'gpt-weights', fileName: 'nacime-e15.ckpt' }
  }))
  Object.defineProperty(window, 'companion', {
    value: {
      voice: {
        getAsrOverview: vi.fn(async () => ({ ok: true, data: makeOverview() })),
        getAssetRoot: vi.fn(async () => ({
          ok: true,
          data: {
            isDefault: true,
            freeBytes: 30_000_000_000,
            totalRequiredBytes: 520_509_193,
            state: 'ok'
          }
        })),
        chooseAssetRoot: vi.fn(),
        resetAssetRoot: vi.fn(),
        selectAsrEngine,
        setAsrFallbackEngine,
        downloadAsrModel,
        cancelAsrDownload: vi.fn(async () => ({
          ok: true,
          data: { ok: true, cancelled: true }
        })),
        deleteAsrModel: vi.fn(),
        getGptRuntime: vi.fn(async () => ({ ok: true, data: makeGptRuntime() })),
        installGptRuntime,
        pauseGptRuntimeDownload: vi.fn(),
        resumeGptRuntimeDownload: vi.fn(),
        cancelGptRuntimeDownload: vi.fn(),
        deleteGptRuntime: vi.fn(),
        chooseGptRuntimeDir,
        clearGptRuntimeDir: vi.fn(),
        pickGptVoiceFile,
        importGptVoice: vi.fn(),
        deleteGptVoice: vi.fn(),
        onAsrOverview: vi.fn(() => () => {}),
        onVoiceState: vi.fn(() => () => {}),
        onAssetDownload: vi.fn(() => () => {})
      }
    },
    writable: true,
    configurable: true
  })
  return {
    selectAsrEngine,
    setAsrFallbackEngine,
    downloadAsrModel,
    installGptRuntime,
    chooseGptRuntimeDir,
    pickGptVoiceFile
  }
}

let pinia: Pinia

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
})

describe('P3V-14 VoiceSetupStep', () => {
  it('按资源→听力→GPT-SoVITS→音色顺序展示，四步都是真实可操作的卡', async () => {
    setupVoiceApi()
    const wrapper = mount(VoiceSetupStep, { global: { plugins: [pinia] } })
    await flushPromises()

    const text = wrapper.text()
    const steps = wrapper.findAll('.voice-setup__flow > li')
    expect(steps).toHaveLength(4)
    expect(steps[0]!.text()).toContain('资源存储位置')
    expect(steps[1]!.text()).toContain('选择她的“听力”')
    expect(steps[2]!.find('h3').text()).toBe('GPT-SoVITS')
    expect(steps[3]!.find('h3').text()).toBe('本地音色')
    expect(text).toContain('520.5 MB')
    expect(text).toContain('文字聊天已经可以使用')
    expect(wrapper.findAll('article.model-item')).toHaveLength(6)
    expect(wrapper.get('#asr-download-center-title').text()).toBe('听力模型下载')

    // P3V-20：三个曾经诚实禁用的按钮现在真的可点
    for (const label of ['选择已有整合包', '安装 通用版', '从本机导入音色']) {
      const button = wrapper.findAll('button').find((item) => item.text() === label)
      expect(button, label).toBeDefined()
      expect(button?.attributes('disabled'), label).toBeUndefined()
    }
  })

  it('第 3/4 步接线到真实通道：一键安装、选择已有目录、挑音色文件', async () => {
    const api = setupVoiceApi()
    const wrapper = mount(VoiceSetupStep, { global: { plugins: [pinia] } })
    await flushPromises()

    const click = async (label: string): Promise<void> => {
      const button = wrapper.findAll('button').find((item) => item.text() === label)
      expect(button, label).toBeDefined()
      await button!.trigger('click')
      await flushPromises()
    }

    await click('安装 通用版')
    expect(api.installGptRuntime).toHaveBeenCalledWith({ variant: 'standard' })

    await click('选择已有整合包')
    expect(api.chooseGptRuntimeDir).toHaveBeenCalledTimes(1)

    await click('从本机导入音色')
    const pickButtons = wrapper.findAll('.voice-library__file button')
    expect(pickButtons).toHaveLength(3)
    await pickButtons[0]!.trigger('click')
    await flushPromises()
    expect(api.pickGptVoiceFile).toHaveBeenCalledWith({ kind: 'gpt-weights' })
    // 只回文件名，不落任何目录
    expect(wrapper.get('.voice-library__file-name').text()).toBe('nacime-e15.ckpt')
  })

  it('稍后设置立即继续，不写主备、不启动下载', async () => {
    const api = setupVoiceApi()
    const wrapper = mount(VoiceSetupStep, { global: { plugins: [pinia] } })
    await flushPromises()

    await wrapper.get('.voice-setup__skip').trigger('click')
    expect(wrapper.emitted('continue')).toEqual([[{ downloadsStarted: false }]])
    expect(api.selectAsrEngine).not.toHaveBeenCalled()
    expect(api.setAsrFallbackEngine).not.toHaveBeenCalled()
    expect(api.downloadAsrModel).not.toHaveBeenCalled()
  })

  it('开始下载先保存标准主备、只排第一项后立即继续，不等待模型完成', async () => {
    const api = setupVoiceApi()
    const wrapper = mount(VoiceSetupStep, { global: { plugins: [pinia] } })
    await flushPromises()

    await wrapper.get('.voice-setup__start').trigger('click')
    await flushPromises()

    expect(api.selectAsrEngine).toHaveBeenCalledWith({
      engineId: 'zipformer-bilingual-zh-en'
    })
    expect(api.setAsrFallbackEngine).toHaveBeenCalledWith({ engineId: 'sherpa-sensevoice' })
    // 顺序队列只先发主模型；SenseVoice 要等 overview 报主模型 ready 后才发。
    expect(api.downloadAsrModel).toHaveBeenCalledTimes(1)
    expect(api.downloadAsrModel).toHaveBeenCalledWith({
      engineId: 'zipformer-bilingual-zh-en'
    })
    expect(wrapper.emitted('continue')).toEqual([[{ downloadsStarted: true }]])
  })

  it('换根待重启时阻止下载到旧位置，但仍允许稍后进入文字聊天', async () => {
    const api = setupVoiceApi()
    const wrapper = mount(VoiceSetupStep, { global: { plugins: [pinia] } })
    await flushPromises()
    const voice = useVoiceStore(pinia)
    voice.state.assetRootRestartRequired = true
    voice.state.assetRootNotice = '新的存储位置将在重启应用后生效'
    await wrapper.vm.$nextTick()

    const start = wrapper.get<HTMLButtonElement>('.voice-setup__start')
    expect(start.element.disabled).toBe(true)
    expect(wrapper.text()).toContain('请先重启 Nacime')
    await wrapper.get('.voice-setup__skip').trigger('click')
    expect(wrapper.emitted('continue')).toEqual([[{ downloadsStarted: false }]])
    expect(api.downloadAsrModel).not.toHaveBeenCalled()
  })
})
