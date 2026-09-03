// @vitest-environment jsdom
// src/renderer/src/components/chat/Composer.test.ts
// M-31/S-01 回归：IME 组合期间按 Enter 不发送（中文输入法核心路径）。
// 旧实现 onEnter 只判断 shiftKey，输入法确认候选词的 Enter 会被当成发送。
// 2026-08-20：思考模式开关"记住上次档位"回归（用户拍板：开启恢复上次档位，不再一律回 high）。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import type { PublicConfigSnapshot } from '@shared/config/types'
import Composer from './Composer.vue'
import { useChatStore } from '../../stores/chat'
import { useConfigStore } from '../../stores/config'

function mockCompanion(): void {
  Object.defineProperty(window, 'companion', {
    value: {
      chat: {
        onStream: vi.fn(() => () => {}),
        send: vi.fn(async () => ({
          ok: true,
          data: { requestId: 'r1', userMessageId: 'u1', assistantMessageId: 'a1' }
        })),
        cancel: vi.fn(async () => ({ ok: true, data: undefined })),
        retry: vi.fn(async () => ({ ok: true, data: { requestId: 'r2' } }))
      },
      config: {
        get: vi.fn(async () => ({ ok: true, data: null })),
        update: vi.fn(async () => ({ ok: true, data: null })),
        testModel: vi.fn(async () => ({ ok: true, data: {} }))
      }
    },
    writable: true,
    configurable: true
  })
}

let pinia: Pinia

describe('Composer IME（S-01 回归）', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    mockCompanion()
  })

  it('IME 组合期间按 Enter（isComposing）不发送、不丢草稿', async () => {
    const chatStore = useChatStore()
    chatStore.state.sessionId = 's1'
    chatStore.setDraft('你好世界')

    const wrapper = mount(Composer, { global: { plugins: [pinia] } })
    // 组合确认候选词：isComposing=true、keyCode=229
    await wrapper.find('textarea').trigger('keydown', {
      key: 'Enter',
      isComposing: true,
      keyCode: 229,
      shiftKey: false
    })

    expect(chatStore.state.draft).toBe('你好世界') // 草稿保留
    expect(window.companion.chat.send).not.toHaveBeenCalled() // 未发送
  })

  it('组合结束后按 Enter 正常发送', async () => {
    const chatStore = useChatStore()
    chatStore.state.sessionId = 's1'
    chatStore.setDraft('你好世界')

    const wrapper = mount(Composer, { global: { plugins: [pinia] } })
    await wrapper.find('textarea').trigger('keydown', {
      key: 'Enter',
      isComposing: false,
      keyCode: 13,
      shiftKey: false
    })

    expect(window.companion.chat.send).toHaveBeenCalled()
  })

  it('Shift+Enter 不发送（换行）', async () => {
    const chatStore = useChatStore()
    chatStore.state.sessionId = 's1'
    chatStore.setDraft('换行测试')

    const wrapper = mount(Composer, { global: { plugins: [pinia] } })
    await wrapper.find('textarea').trigger('keydown', {
      key: 'Enter',
      isComposing: false,
      keyCode: 13,
      shiftKey: true
    })

    expect(window.companion.chat.send).not.toHaveBeenCalled()
  })
})

describe('Composer 思考模式开关（2026-08-20：记住上次档位）', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    mockCompanion()
  })

  /**
   * 注入最小 draft 并让 config.update 回显当前 draft。
   * save() 会用返回值重置 draft（structuredClone），所以 mock 必须返回
   * 纯 JSON 深拷贝——返回 reactive proxy 会抛 DataCloneError（已知坑）。
   */
  function setupWithEffort(effort: 'low' | 'medium' | 'high'): ReturnType<typeof useConfigStore> {
    const configStore = useConfigStore()
    configStore.state.draft = {
      model: { reasoningEffort: effort, supportsThinking: true },
      ui: { chat: { showReasoning: true } }
    } as unknown as PublicConfigSnapshot
    ;(window.companion.config as { update: unknown }).update = vi.fn(async () => ({
      ok: true,
      data: JSON.parse(JSON.stringify(configStore.state.draft)) as unknown
    }))
    return configStore
  }

  it('低档 → 关 → 再开：恢复 low 而非一律回 high', async () => {
    const configStore = setupWithEffort('low')
    const wrapper = mount(Composer, { global: { plugins: [pinia] } })
    const toggle = wrapper.find('button.thinking-toggle')

    await toggle.trigger('click') // 开 → 关
    await flushPromises()
    expect(configStore.state.draft?.model.reasoningEffort).toBe('off')

    await toggle.trigger('click') // 关 → 开：应恢复 low
    await flushPromises()
    expect(configStore.state.draft?.model.reasoningEffort).toBe('low')
  })

  it('设置页改为中档后 → 关 → 再开：恢复 medium', async () => {
    const configStore = setupWithEffort('medium')
    const wrapper = mount(Composer, { global: { plugins: [pinia] } })
    const toggle = wrapper.find('button.thinking-toggle')

    await toggle.trigger('click')
    await flushPromises()
    expect(configStore.state.draft?.model.reasoningEffort).toBe('off')

    await toggle.trigger('click')
    await flushPromises()
    expect(configStore.state.draft?.model.reasoningEffort).toBe('medium')
  })
})

// ── P3B-18/19：语音输入入口（麦克风按钮）与「她在说话」pill ──
function mockCompanionWithVoice(overview: { ready: boolean }): {
  startListening: ReturnType<typeof vi.fn>
  cancelSpeaking: ReturnType<typeof vi.fn>
  emitVoice: (event: unknown) => void
} {
  let voiceListener: ((event: unknown) => void) | null = null
  const startListening = vi.fn(async () => ({ ok: true, data: { ok: true } }))
  const cancelSpeaking = vi.fn(async () => ({ ok: true, data: undefined }))
  Object.defineProperty(window, 'companion', {
    value: {
      chat: {
        onStream: vi.fn(() => () => {}),
        send: vi.fn(async () => ({
          ok: true,
          data: { requestId: 'r1', userMessageId: 'u1', assistantMessageId: 'a1' }
        })),
        cancel: vi.fn(async () => ({ ok: true, data: undefined })),
        retry: vi.fn(async () => ({ ok: true, data: { requestId: 'r2' } }))
      },
      config: {
        get: vi.fn(async () => ({ ok: true, data: null })),
        update: vi.fn(async () => ({ ok: true, data: null })),
        testModel: vi.fn(async () => ({ ok: true, data: {} }))
      },
      voice: {
        getAsrOverview: vi.fn(async () => ({
          ok: true,
          data: {
            selectedEngineId: 'sherpa-sensevoice',
            engines: [
              {
                engineId: 'sherpa-sensevoice',
                selected: true,
                modelState: overview.ready ? 'ready' : 'not-downloaded'
              }
            ],
            vadModel: { state: overview.ready ? 'ready' : 'not-downloaded' }
          }
        })),
        onAsrOverview: vi.fn(() => () => {}),
        onVoiceState: vi.fn((cb: (event: unknown) => void) => {
          voiceListener = cb
          return () => {
            voiceListener = null
          }
        }),
        onAssetDownload: vi.fn(() => () => {}),
        startListening,
        stopListening: vi.fn(async () => ({ ok: true, data: { ok: true } })),
        cancelSpeaking,
        openMicPort: vi.fn()
      }
    },
    writable: true,
    configurable: true
  })
  return {
    startListening,
    cancelSpeaking,
    emitVoice: (event) => voiceListener?.(event)
  }
}

describe('Composer 语音入口（P3B-18/19）', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
  })

  it('ASR 未就绪：麦克风按钮标 unavailable，点击给出去设置页的提示，不开会话', async () => {
    const voice = mockCompanionWithVoice({ ready: false })
    const wrapper = mount(Composer, { global: { plugins: [pinia] } })
    await flushPromises()
    const mic = wrapper.find('.mic-btn')
    expect(mic.classes()).toContain('is-unavailable')
    await mic.trigger('click')
    await flushPromises()
    expect(voice.startListening).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('设置 → 语音')
  })

  it('ASR 就绪：点击麦克风走 orchestrator.start（startListening 被调）', async () => {
    const voice = mockCompanionWithVoice({ ready: true })
    const wrapper = mount(Composer, { global: { plugins: [pinia] } })
    await flushPromises()
    const mic = wrapper.find('.mic-btn')
    expect(mic.classes()).not.toContain('is-unavailable')
    await mic.trigger('click')
    await flushPromises()
    expect(voice.startListening).toHaveBeenCalledTimes(1)
  })

  it('speaking-started 事件显示「她在说话」pill；点击走 cancel-speaking', async () => {
    const voice = mockCompanionWithVoice({ ready: true })
    const wrapper = mount(Composer, { global: { plugins: [pinia] } })
    await flushPromises()
    expect(wrapper.find('.speaking-pill').exists()).toBe(false)

    voice.emitVoice({ type: 'speaking-started', requestId: 'r1' })
    await flushPromises()
    expect(wrapper.find('.speaking-pill').exists()).toBe(true)

    await wrapper.find('.speaking-pill').trigger('click')
    await flushPromises()
    expect(voice.cancelSpeaking).toHaveBeenCalledTimes(1)

    voice.emitVoice({ type: 'speaking-ended', requestId: 'r1', reason: 'cancelled' })
    await flushPromises()
    expect(wrapper.find('.speaking-pill').exists()).toBe(false)
  })
})
