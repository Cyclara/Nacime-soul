// @vitest-environment jsdom
// P3V-14：provider → voice-setup → first-conversation 的持久化阶段路由。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import type { PublicConfigSnapshot } from '@shared/config/types'
import { useConfigStore } from '../../stores/config'
import FirstRunGuide from './FirstRunGuide.vue'

vi.mock('./VoiceSetupStep.vue', () => ({
  default: {
    emits: ['continue'],
    template:
      '<section data-test="voice-setup"><button data-test="voice-continue" @click="$emit(\'continue\', { downloadsStarted: false })">继续</button></section>'
  }
}))

vi.mock('./FirstConversationGuide.vue', () => ({
  default: {
    emits: ['startChat'],
    template: '<section data-test="first-conversation" />'
  }
}))

function snapshot(stage: PublicConfigSnapshot['ui']['onboarding']['stage']): PublicConfigSnapshot {
  return {
    schemaVersion: 1,
    model: {
      provider: 'deepseek',
      protocol: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      displayName: 'DeepSeek',
      temperature: 0.8,
      topP: 0.95,
      maxTokens: 2048,
      timeoutMs: 60_000,
      reasoningEffort: 'off',
      supportsThinking: true,
      hasApiKey: false,
      validated: false
    },
    ui: {
      locale: 'zh-CN',
      theme: 'system',
      fontScale: 1,
      reduceMotion: false,
      onboarding: { version: 1, stage },
      window: { width: 900, height: 720, maximized: false },
      chat: { sendOnEnter: true, showTimestamps: false, showReasoning: true },
      live2d: { enabled: false, zoom: 1, alwaysOnTop: true, offsetX: 0, offsetY: 0 }
    },
    tts: {
      enabled: false,
      provider: 'edge',
      voiceId: '',
      speed: 1,
      pitch: 0,
      volume: 1,
      sampleRate: 24000,
      cacheEnabled: true,
      earlyPlaybackEnabled: false,
      hasApiKey: false
    },
    memory: {
      enabled: false,
      embeddingProvider: '',
      embeddingModel: '',
      embeddingDimension: 1024,
      maxActive: 15,
      minRetrievalScore: 0.35,
      attributionGate: { provider: '', model: '', baseUrl: '' },
      dmae: {
        enabled: true,
        maxScore: 100,
        promptThreshold: 30,
        userRewardBase: 20,
        wakeGamma: 0.5,
        modelRewardBase: 8,
        wakeLambda: 0.3,
        decayAlpha: 1.5,
        decayBeta: 0.3,
        presets: [],
        anomaly: {
          muted: {
            R01: 0,
            R02: 0,
            R03: 0,
            R04: 0,
            R05: 0,
            R06: 0,
            R07: 0,
            R08: 0,
            R09: 0,
            R10: 0,
            R11: 0,
            R12: 0,
            R13: 0
          },
          windows: {
            R01: { days: 3 },
            R02: { days: 7 },
            R03: { days: 3 },
            R04: { turns: 50 },
            R05: { turns: 100 },
            R06: {},
            R07: { turns: 50 },
            R08: { turns: 200 },
            R09: { days: 3 },
            R10: { days: 3, turns: 100 },
            R11: { days: 7 },
            R12: {},
            R13: {}
          }
        },
        historySampleEveryTurns: 1
      }
    },
    security: {
      allowHttpLocalhostInDev: true,
      diagnostics: { logLevel: 'info', retentionDays: 7, maxTotalMb: 50 },
      privacy: { includeCrashDumpsInExport: false, monthlyGcDigest: false }
    },
    persona: {
      compliance: {
        gate: {
          enabled: true,
          scope: 'observe',
          firstSegmentMinChars: 32,
          segmentMaxChars: 512,
          budgetMs: 30,
          maxRegenerations: 1,
          maxHoldMs: 400
        },
        audit: { enabled: true, sampleRate: 0.25, timeoutMs: 20_000, recentTurnWindow: 3 },
        disabledRuleIds: [],
        debugCaptureText: false
      }
    },
    voice: { asrEngineId: 'sherpa-sensevoice', asrFallbackEngineId: '' }
  }
}

function cloneSnapshot(value: PublicConfigSnapshot): PublicConfigSnapshot {
  return JSON.parse(JSON.stringify(value)) as PublicConfigSnapshot
}

let pinia: Pinia

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
})

describe('P3V-14 FirstRunGuide stage routing', () => {
  it('持久化 voice-setup 时重开直接恢复语音设置，不回 provider 表单', () => {
    const config = useConfigStore(pinia)
    config.state.saved = snapshot('voice-setup')
    config.state.draft = cloneSnapshot(config.state.saved)
    const wrapper = mount(FirstRunGuide, { global: { plugins: [pinia] } })

    expect(wrapper.find('[data-test="voice-setup"]').exists()).toBe(true)
    expect(wrapper.find('.form-step').exists()).toBe(false)
  })

  it('连接成功先持久化 voice-setup，不直接跳到第一次见面', async () => {
    const config = useConfigStore(pinia)
    config.state.saved = snapshot('provider-setup')
    config.state.draft = cloneSnapshot(config.state.saved)
    const save = vi.spyOn(config, 'save').mockImplementation(async () => {
      config.state.saved = cloneSnapshot(config.state.draft!)
      return true
    })
    vi.spyOn(config, 'testConnection').mockImplementation(async () => {
      config.state.connectionResult = { ok: true, latencyMs: 12 }
    })

    const wrapper = mount(FirstRunGuide, { global: { plugins: [pinia] } })
    await wrapper.get('input[type="password"]').setValue('sk-local-only')
    await wrapper.get('.primary-btn').trigger('click')
    await flushPromises()

    expect(save).toHaveBeenCalledTimes(2)
    expect(config.state.draft?.ui.onboarding.stage).toBe('voice-setup')
    expect(wrapper.find('[data-test="voice-setup"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="first-conversation"]').exists()).toBe(false)
  })

  it('语音步骤进度保存失败时留在当前页并显示可见错误', async () => {
    const config = useConfigStore(pinia)
    config.state.saved = snapshot('voice-setup')
    config.state.draft = cloneSnapshot(config.state.saved)
    vi.spyOn(config, 'save').mockResolvedValue(false)
    const wrapper = mount(FirstRunGuide, { global: { plugins: [pinia] } })

    await wrapper.get('[data-test="voice-continue"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('语音设置进度没有保存')
    expect(wrapper.find('[data-test="voice-setup"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="first-conversation"]').exists()).toBe(false)
  })

  it('语音步骤继续后只持久化 first-conversation，尚未标记 complete', async () => {
    const config = useConfigStore(pinia)
    config.state.saved = snapshot('voice-setup')
    config.state.draft = cloneSnapshot(config.state.saved)
    const save = vi.spyOn(config, 'save').mockImplementation(async () => {
      config.state.saved = cloneSnapshot(config.state.draft!)
      return true
    })
    const wrapper = mount(FirstRunGuide, { global: { plugins: [pinia] } })

    await wrapper.get('[data-test="voice-continue"]').trigger('click')
    await flushPromises()

    expect(save).toHaveBeenCalledTimes(1)
    expect(config.state.draft?.ui.onboarding.stage).toBe('first-conversation')
    expect(config.state.draft?.ui.onboarding.completedAt).toBeUndefined()
    expect(wrapper.find('[data-test="first-conversation"]').exists()).toBe(true)
  })
})
