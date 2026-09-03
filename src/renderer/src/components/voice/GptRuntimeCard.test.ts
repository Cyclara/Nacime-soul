// @vitest-environment jsdom
// P3V-16/17/20：运行环境卡按真实 overview 显示；空间不足/根不可用时挡住安装并说明原因；
// 安装中只显示进度与暂停/继续/取消；变体由用户拍板（GPU 检测只给推荐标记）。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import type { AssetDownloadStatus } from '@shared/voice/asset-root-types'
import type { GptRuntimeOverview } from '@shared/voice/gpt-runtime-types'
import { useVoiceStore } from '../../stores/voice'
import GptRuntimeCard from './GptRuntimeCard.vue'

function overview(patch: Partial<GptRuntimeOverview> = {}): GptRuntimeOverview {
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
    rootState: 'ok',
    ...patch
  }
}

function job(patch: Partial<AssetDownloadStatus> = {}): AssetDownloadStatus {
  return {
    assetId: 'gpt-runtime-standard',
    state: 'downloading',
    receivedBytes: 1_000_000_000,
    totalBytes: 4_000_000_000,
    currentFile: 'gpt-sovits-v2pro.7z',
    phase: 'receiving',
    speedBytesPerSec: 5_000_000,
    resumable: true,
    ...patch
  }
}

let pinia: Pinia

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
})

function findButton(wrapper: VueWrapper, label: string): DOMWrapper<Element> {
  const button = wrapper.findAll('button').find((item) => item.text() === label)
  expect(button, label).toBeDefined()
  return button!
}

describe('P3V-16/17 GptRuntimeCard', () => {
  it('显示两个变体与推荐标记；默认选中推荐项，安装按钮带变体名', () => {
    const voice = useVoiceStore(pinia)
    voice.state.gptRuntime = overview()
    const wrapper = mount(GptRuntimeCard, { global: { plugins: [pinia] } })

    expect(wrapper.text()).toContain('通用版')
    expect(wrapper.text()).toContain('4.0 GB')
    expect(wrapper.text()).toContain('与你的显卡匹配')
    expect(wrapper.text()).toContain('未安装')
    const radios = wrapper.findAll<HTMLInputElement>('input[type="radio"]')
    expect(radios).toHaveLength(2)
    expect(radios[0]!.element.checked).toBe(true)
    expect(findButton(wrapper, '安装 通用版').attributes('disabled')).toBeUndefined()
  })

  it('检测不出显卡时两个都不推荐，如实告诉用户自己选', () => {
    const voice = useVoiceStore(pinia)
    const base = overview()
    voice.state.gptRuntime = {
      ...base,
      variants: base.variants.map((item) => ({ ...item, recommended: false }))
    }
    const wrapper = mount(GptRuntimeCard, { global: { plugins: [pinia] } })

    expect(wrapper.text()).toContain('没能读出显卡型号')
    expect(wrapper.text()).not.toContain('与你的显卡匹配')
  })

  it('空间不足 / 根不可用时挡住安装，并说清差多少', () => {
    const voice = useVoiceStore(pinia)
    voice.state.gptRuntime = overview({ freeBytes: 3_000_000_000 })
    const low = mount(GptRuntimeCard, { global: { plugins: [pinia] } })
    expect(low.text()).toContain('至少需要 8.0 GB')
    expect(low.text()).toContain('当前只有 3.0 GB')
    expect(findButton(low, '安装 通用版').attributes('disabled')).toBeDefined()
    low.unmount()

    voice.state.gptRuntime = overview({ rootState: 'missing', freeBytes: 0 })
    const missing = mount(GptRuntimeCard, { global: { plugins: [pinia] } })
    expect(missing.text()).toContain('自定义存储位置当前不存在')
    expect(findButton(missing, '安装 通用版').attributes('disabled')).toBeDefined()
  })

  it('选中非推荐变体后按它安装（不替用户拍板）', async () => {
    const voice = useVoiceStore(pinia)
    const install = vi.spyOn(voice, 'installGptRuntime').mockResolvedValue(true)
    voice.state.gptRuntime = overview()
    const wrapper = mount(GptRuntimeCard, { global: { plugins: [pinia] } })

    await wrapper.findAll('input[type="radio"]')[1]!.setValue(true)
    await findButton(wrapper, '安装 RTX 50 系版').trigger('click')
    expect(install).toHaveBeenCalledWith('rtx50')
  })

  it('安装中显示阶段/进度/ARIA，并把暂停继续取消接到对应变体', async () => {
    const voice = useVoiceStore(pinia)
    const pause = vi.spyOn(voice, 'pauseGptRuntime').mockResolvedValue()
    const resume = vi.spyOn(voice, 'resumeGptRuntime').mockResolvedValue()
    const cancel = vi.spyOn(voice, 'cancelGptRuntime').mockResolvedValue()

    voice.state.gptRuntime = overview({ download: job() })
    const downloading = mount(GptRuntimeCard, { global: { plugins: [pinia] } })
    expect(downloading.text()).toContain('正在安装')
    expect(downloading.text()).toContain('gpt-sovits-v2pro.7z')
    expect(downloading.text()).toContain('1.0 GB / 4.0 GB')
    expect(downloading.text()).toContain('25%')
    expect(downloading.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('25')
    // 安装中不再提供「安装」按钮，避免重复触发
    expect(downloading.findAll('button').some((item) => item.text().startsWith('安装 '))).toBe(
      false
    )
    await findButton(downloading, '暂停').trigger('click')
    expect(pause).toHaveBeenCalledWith('standard')
    await findButton(downloading, '取消').trigger('click')
    expect(cancel).toHaveBeenCalledWith('standard')
    downloading.unmount()

    voice.state.gptRuntime = overview({
      download: job({ state: 'paused', speedBytesPerSec: 0 })
    })
    const paused = mount(GptRuntimeCard, { global: { plugins: [pinia] } })
    expect(paused.text()).toContain('已暂停，断点已保留')
    await findButton(paused, '继续').trigger('click')
    expect(resume).toHaveBeenCalledWith('standard')
  })

  it('解压/校验阶段说人话，且不给暂停（这两步没有断点）', () => {
    const voice = useVoiceStore(pinia)
    voice.state.gptRuntime = overview({
      download: job({ phase: 'extracting', receivedBytes: 4_000_000_000 })
    })
    const wrapper = mount(GptRuntimeCard, { global: { plugins: [pinia] } })

    expect(wrapper.text()).toContain('解压中')
    expect(wrapper.text()).toContain('正在解压（这一步比较慢）')
    expect(wrapper.findAll('button').some((item) => item.text() === '暂停')).toBe(false)
  })

  it('已安装显示删除入口；安装中不许删；custom 模式才给「恢复自动发现」', async () => {
    const voice = useVoiceStore(pinia)
    const remove = vi.spyOn(voice, 'deleteGptRuntime').mockResolvedValue(true)
    const clear = vi.spyOn(voice, 'clearGptRuntimeDir').mockResolvedValue(true)

    voice.state.gptRuntime = overview({
      installed: { variant: 'standard', displayName: '通用版', installedAt: 1_756_000_000_000 }
    })
    const installed = mount(GptRuntimeCard, { global: { plugins: [pinia] } })
    expect(installed.text()).toContain('已安装 · 未启用')
    expect(installed.findAll('button').some((item) => item.text() === '恢复自动发现')).toBe(false)
    await findButton(installed, '删除这份安装').trigger('click')
    expect(remove).toHaveBeenCalledTimes(1)
    installed.unmount()

    voice.state.gptRuntime = overview({
      source: { mode: 'custom', active: true, voiceConfigured: true, restartRequired: false },
      installed: { variant: 'standard', displayName: '通用版', installedAt: 1_756_000_000_000 },
      download: job()
    })
    const busy = mount(GptRuntimeCard, { global: { plugins: [pinia] } })
    expect(findButton(busy, '删除这份安装').attributes('disabled')).toBeDefined()
    await findButton(busy, '恢复自动发现').trigger('click')
    expect(clear).toHaveBeenCalledTimes(1)
  })

  it('选择已有整合包接到 store；待生效与被拒原因都如实显示', async () => {
    const voice = useVoiceStore(pinia)
    const choose = vi.spyOn(voice, 'chooseGptRuntimeDir').mockResolvedValue(false)
    voice.state.gptRuntime = overview({
      source: { mode: 'auto', active: false, voiceConfigured: false, restartRequired: true },
      externalDetected: true
    })
    voice.state.gptRuntimeNotice = '这个文件夹里没有找到 GPT-SoVITS 整合包'
    const wrapper = mount(GptRuntimeCard, { global: { plugins: [pinia] } })

    expect(wrapper.text()).toContain('重启后生效')
    expect(wrapper.text()).toContain('已在本机发现可用的 GPT-SoVITS 整合包')
    expect(wrapper.text()).toContain('没有找到 GPT-SoVITS 整合包')
    await findButton(wrapper, '选择已有整合包').trigger('click')
    expect(choose).toHaveBeenCalledTimes(1)
  })

  it('失败后保留断点并给重试；重试仍走同一变体', async () => {
    const voice = useVoiceStore(pinia)
    const install = vi.spyOn(voice, 'installGptRuntime').mockResolvedValue(true)
    voice.state.gptRuntime = overview({
      download: job({ assetId: 'gpt-runtime-rtx50', state: 'error', errorCode: 'hash-mismatch' })
    })
    const wrapper = mount(GptRuntimeCard, { global: { plugins: [pinia] } })

    expect(wrapper.text()).toContain('RTX 50 系版 安装失败')
    expect(wrapper.text()).toContain('hash-mismatch')
    await findButton(wrapper, '重试').trigger('click')
    expect(install).toHaveBeenCalledWith('rtx50')
  })

  it('快照未回来时只说正在读取，不显示假的安装状态', () => {
    const wrapper = mount(GptRuntimeCard, { global: { plugins: [pinia] } })
    expect(wrapper.text()).toContain('正在读取')
    expect(wrapper.findAll('input[type="radio"]')).toHaveLength(0)
  })
})
