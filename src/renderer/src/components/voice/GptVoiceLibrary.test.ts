// @vitest-environment jsdom
// P3V-18/20：本地音色库只显示 main 的投影（无路径）；导入前三件文件与提示词缺一不可；
// discovered 音色不给删；「设为当前音色」写 config tts.voiceId（唯一真源）。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import type { PublicConfigSnapshot } from '@shared/config/types'
import type { GptRuntimeOverview, GptVoiceProfileView } from '@shared/voice/gpt-runtime-types'
import { useConfigStore } from '../../stores/config'
import { useVoiceStore } from '../../stores/voice'
import GptVoiceLibrary from './GptVoiceLibrary.vue'

function profile(patch: Partial<GptVoiceProfileView> = {}): GptVoiceProfileView {
  return {
    id: 'gpt-sovits:abcdef123456',
    displayName: '奈奈 · 日常',
    version: 'v2Pro',
    promptLang: 'zh',
    defaultTextLang: 'zh',
    state: 'ready',
    source: 'imported',
    current: false,
    ...patch
  }
}

function overview(voices: readonly GptVoiceProfileView[] = []): GptRuntimeOverview {
  return {
    source: {
      mode: 'auto',
      active: true,
      voiceConfigured: voices.length > 0,
      restartRequired: false
    },
    voices,
    installed: null,
    externalDetected: true,
    variants: [
      {
        variant: 'standard',
        displayName: '通用版',
        downloadBytes: 4_000_000_000,
        recommended: true
      }
    ],
    download: null,
    minFreeBytes: 8_000_000_000,
    freeBytes: 30_000_000_000,
    rootState: 'ok'
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

/** 注入最小 draft；save 的返回值必须是纯 JSON（reactive proxy 会 DataCloneError）。 */
function stubConfig(voiceId = ''): ReturnType<typeof useConfigStore> {
  const config = useConfigStore(pinia)
  config.state.draft = {
    tts: { enabled: true, provider: '', voiceId, earlyPlaybackEnabled: false }
  } as unknown as PublicConfigSnapshot
  return config
}

describe('P3V-18/20 GptVoiceLibrary', () => {
  it('空库如实说没有音色，并说明不附带来源不明的角色音色', () => {
    stubConfig()
    const voice = useVoiceStore(pinia)
    voice.state.gptRuntime = overview()
    const wrapper = mount(GptVoiceLibrary, { global: { plugins: [pinia] } })

    expect(wrapper.text()).toContain('还没有音色')
    expect(wrapper.text()).toContain('不附带来源不明的角色音色')
    expect(wrapper.findAll('.voice-library__item')).toHaveLength(0)
  })

  it('列表显示版本与两个语言，且只显示投影字段——不出现任何路径', () => {
    stubConfig()
    const voice = useVoiceStore(pinia)
    voice.state.gptRuntime = overview([profile({ promptLang: 'ja', defaultTextLang: 'auto' })])
    const wrapper = mount(GptVoiceLibrary, { global: { plugins: [pinia] } })

    const text = wrapper.text()
    expect(text).toContain('奈奈 · 日常')
    expect(text).toContain('v2Pro')
    expect(text).toContain('参考音频日语')
    expect(text).toContain('默认自动判断')
    expect(text).not.toMatch(/[A-Za-z]:[\\/]/)
  })

  it('有音色但这一轮没有运行环境时，如实说只会显示文字', () => {
    stubConfig()
    const voice = useVoiceStore(pinia)
    const base = overview([profile()])
    voice.state.gptRuntime = {
      ...base,
      source: { ...base.source, active: false }
    }
    const wrapper = mount(GptVoiceLibrary, { global: { plugins: [pinia] } })

    expect(wrapper.text()).toContain('还没有可用的 GPT-SoVITS 运行环境，她只会显示文字')
  })

  it('文件丢失的音色如实说发不出声，且不给「设为当前音色」', () => {
    stubConfig()
    const voice = useVoiceStore(pinia)
    voice.state.gptRuntime = overview([profile({ state: 'missing-files' })])
    const wrapper = mount(GptVoiceLibrary, { global: { plugins: [pinia] } })

    expect(wrapper.text()).toContain('现在发不出声')
    expect(wrapper.findAll('button').some((item) => item.text() === '设为当前音色')).toBe(false)
  })

  it('discovered 音色不给删除；imported 才给', () => {
    stubConfig()
    const voice = useVoiceStore(pinia)
    voice.state.gptRuntime = overview([
      profile({ id: 'a', displayName: '安装自带', source: 'discovered' }),
      profile({ id: 'b', displayName: '我导入的', source: 'imported' })
    ])
    const wrapper = mount(GptVoiceLibrary, { global: { plugins: [pinia] } })

    const items = wrapper.findAll('.voice-library__item')
    expect(items).toHaveLength(2)
    expect(items[0]!.text()).toContain('来自你的安装')
    expect(items[0]!.findAll('button').some((item) => item.text() === '删除')).toBe(false)
    expect(items[1]!.findAll('button').some((item) => item.text() === '删除')).toBe(true)
  })

  it('设为当前音色写 config tts.voiceId 并沿用该音色的 provider', async () => {
    const config = stubConfig()
    const save = vi.spyOn(config, 'save').mockResolvedValue(true)
    const voice = useVoiceStore(pinia)
    vi.spyOn(voice, 'hydrateTts').mockResolvedValue()
    voice.state.gptRuntime = overview([profile({ id: 'v1' })])
    voice.state.tts = {
      voices: [{ id: 'v1', providerId: 'gpt-sovits', displayName: '奈奈 · 日常' }]
    } as never
    const wrapper = mount(GptVoiceLibrary, { global: { plugins: [pinia] } })

    await findButton(wrapper, '设为当前音色').trigger('click')
    await flushPromises()
    expect(config.state.draft?.tts.voiceId).toBe('v1')
    expect(config.state.draft?.tts.provider).toBe('gpt-sovits')
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('当前音色标出来，且不再重复给「设为当前音色」', () => {
    stubConfig('v1')
    const voice = useVoiceStore(pinia)
    voice.state.gptRuntime = overview([profile({ id: 'v1', current: true })])
    const wrapper = mount(GptVoiceLibrary, { global: { plugins: [pinia] } })

    expect(wrapper.text()).toContain('当前音色')
    expect(wrapper.findAll('button').some((item) => item.text() === '设为当前音色')).toBe(false)
  })

  it('导入表单：三件文件与提示词缺一不可，缺什么就说什么', async () => {
    stubConfig()
    const voice = useVoiceStore(pinia)
    const pick = vi.spyOn(voice, 'pickGptVoiceFile').mockResolvedValue(true)
    voice.state.gptRuntime = overview()
    const wrapper = mount(GptVoiceLibrary, { global: { plugins: [pinia] } })

    await findButton(wrapper, '从本机导入音色').trigger('click')
    expect(wrapper.text()).toContain('还差：GPT 权重、SoVITS 权重、参考音频')
    expect(findButton(wrapper, '导入这个音色').attributes('disabled')).toBeDefined()

    const pickButtons = wrapper.findAll('.voice-library__file button')
    expect(pickButtons).toHaveLength(3)
    await pickButtons[2]!.trigger('click')
    expect(pick).toHaveBeenCalledWith('ref-audio')

    voice.state.gptVoiceStagedFiles = {
      'gpt-weights': 'nacime-e15.ckpt',
      'sovits-weights': 'nacime_e8_s200.pth',
      'ref-audio': 'ref.wav'
    }
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('nacime-e15.ckpt')
    expect(wrapper.text()).toContain('给这个音色起个名字')

    await wrapper.get('.voice-library__field input').setValue('奈奈')
    expect(wrapper.text()).toContain('请填写参考音频里实际说的那句话')
    expect(findButton(wrapper, '导入这个音色').attributes('disabled')).toBeDefined()
  })

  it('填齐后导入携带用户确认过的元信息，成功即收起表单并回读 TTS 列表', async () => {
    stubConfig()
    const voice = useVoiceStore(pinia)
    const importVoice = vi.spyOn(voice, 'importGptVoice').mockResolvedValue(true)
    const hydrateTts = vi.spyOn(voice, 'hydrateTts').mockResolvedValue()
    voice.state.gptRuntime = overview()
    voice.state.gptVoiceStagedFiles = {
      'gpt-weights': 'nacime-e15.ckpt',
      'sovits-weights': 'nacime_e8_s200.pth',
      'ref-audio': 'ref.wav'
    }
    const wrapper = mount(GptVoiceLibrary, { global: { plugins: [pinia] } })

    await findButton(wrapper, '从本机导入音色').trigger('click')
    await wrapper.get('.voice-library__field input').setValue('  奈奈  ')
    await wrapper.get('textarea').setValue('  你好呀，我在这里。  ')
    const selects = wrapper.findAll('select')
    await selects[0]!.setValue('v4')
    await selects[1]!.setValue('ja')
    await selects[2]!.setValue('auto')

    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(importVoice).toHaveBeenCalledWith({
      displayName: '奈奈',
      version: 'v4',
      promptText: '你好呀，我在这里。',
      promptLang: 'ja',
      defaultTextLang: 'auto'
    })
    expect(hydrateTts).toHaveBeenCalledTimes(1)
    expect(wrapper.find('#voice-import-form').isVisible()).toBe(false)
  })

  it('导入被拒时表单留在原地，人话提示照常显示', async () => {
    stubConfig()
    const voice = useVoiceStore(pinia)
    vi.spyOn(voice, 'importGptVoice').mockImplementation(async () => {
      voice.state.gptRuntimeNotice = '这个音色已经在列表里了'
      return false
    })
    const hydrateTts = vi.spyOn(voice, 'hydrateTts').mockResolvedValue()
    voice.state.gptRuntime = overview()
    voice.state.gptVoiceStagedFiles = {
      'gpt-weights': 'a.ckpt',
      'sovits-weights': 'b.pth',
      'ref-audio': 'c.wav'
    }
    const wrapper = mount(GptVoiceLibrary, { global: { plugins: [pinia] } })

    await findButton(wrapper, '从本机导入音色').trigger('click')
    await wrapper.get('.voice-library__field input').setValue('奈奈')
    await wrapper.get('textarea').setValue('你好呀')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.text()).toContain('这个音色已经在列表里了')
    expect(wrapper.find('#voice-import-form').isVisible()).toBe(true)
    expect(hydrateTts).not.toHaveBeenCalled()
  })
})
