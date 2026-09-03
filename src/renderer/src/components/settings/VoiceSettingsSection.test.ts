// @vitest-environment jsdom
// P3V-15：普通设置页复用首次设置的资源卡/ASR 模型卡，并提供下载中心。
// P3V-20：同页复用 GPT-SoVITS 运行环境卡与本地音色库（与首次设置同一组件）。

import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useVoiceStore } from '../../stores/voice'
import VoiceSettingsSection from './VoiceSettingsSection.vue'

vi.mock('../voice/TtsProviderCard.vue', () => ({
  default: { template: '<div data-test="tts-card" />' }
}))
vi.mock('../voice/AssetRootPicker.vue', () => ({
  default: { props: ['requiredBytes'], template: '<div data-test="asset-root" />' }
}))
vi.mock('../voice/AsrDownloadCenter.vue', () => ({
  default: { template: '<div data-test="download-center" />' }
}))
vi.mock('../voice/AsrModelCard.vue', () => ({
  default: {
    props: ['mode'],
    emits: ['selectionChange'],
    template: '<div data-test="asr-card" :data-mode="mode" />'
  }
}))
vi.mock('../voice/GptRuntimeCard.vue', () => ({
  default: { template: '<div data-test="gpt-runtime" />' }
}))
vi.mock('../voice/GptVoiceLibrary.vue', () => ({
  default: { template: '<div data-test="voice-library" />' }
}))
vi.mock('../voice/MicrophoneSelector.vue', () => ({
  default: { template: '<div data-test="microphone" />' }
}))
vi.mock('../voice/VoiceTestPanel.vue', () => ({
  default: { template: '<div data-test="voice-test" />' }
}))

describe('P3V-15 VoiceSettingsSection', () => {
  it('先订阅并补水 ASR/TTS/资源根/GPT 运行时，挂载共享模型卡与下载中心', async () => {
    Object.defineProperty(window, 'companion', {
      value: { voice: {} },
      configurable: true
    })
    const pinia = createPinia()
    setActivePinia(pinia)
    const voice = useVoiceStore(pinia)
    const calls: string[] = []
    vi.spyOn(voice, 'subscribe').mockImplementation(() => {
      calls.push('subscribe')
      return () => calls.push('unsubscribe')
    })
    vi.spyOn(voice, 'hydrate').mockImplementation(async () => {
      calls.push('hydrate-asr')
    })
    vi.spyOn(voice, 'hydrateTts').mockImplementation(async () => {
      calls.push('hydrate-tts')
    })
    vi.spyOn(voice, 'hydrateAssetRoot').mockImplementation(async () => {
      calls.push('hydrate-root')
    })
    vi.spyOn(voice, 'hydrateGptRuntime').mockImplementation(async () => {
      calls.push('hydrate-gpt')
    })
    vi.spyOn(voice, 'refreshDevices').mockResolvedValue()

    const wrapper = mount(VoiceSettingsSection, { global: { plugins: [pinia] } })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(calls[0]).toBe('subscribe')
    expect(calls).toEqual(
      expect.arrayContaining(['hydrate-asr', 'hydrate-tts', 'hydrate-root', 'hydrate-gpt'])
    )
    expect(wrapper.get('[data-test="asset-root"]').attributes('data-test')).toBe('asset-root')
    expect(wrapper.get('[data-test="download-center"]').attributes('data-test')).toBe(
      'download-center'
    )
    expect(wrapper.get('[data-test="asr-card"]').attributes('data-mode')).toBe('settings')
    expect(wrapper.get('[data-test="gpt-runtime"]').attributes('data-test')).toBe('gpt-runtime')
    expect(wrapper.get('[data-test="voice-library"]').attributes('data-test')).toBe('voice-library')
    expect(wrapper.get('[data-test="microphone"]').attributes('data-test')).toBe('microphone')
    expect(wrapper.get('[data-test="voice-test"]').attributes('data-test')).toBe('voice-test')

    wrapper.unmount()
    expect(calls).toContain('unsubscribe')
  })
})
