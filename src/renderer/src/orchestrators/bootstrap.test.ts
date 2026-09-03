// @vitest-environment jsdom
// C-β：bootstrap 聚合 teardown 与 store 订阅所有权测试。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { bootstrapApp } from './bootstrap'
import { useAppStore } from '../stores/app'
import { useChatStore } from '../stores/chat'
import type { ChatStreamEvent } from '@shared/chat/types'
import type { PublicAppError } from '@shared/errors'
import type { AsrOverview } from '@shared/voice/asr-settings-types'
import type { AssetDownloadStatus } from '@shared/voice/asset-root-types'
import type { VoiceEvent } from '@shared/voice/voice-events'

type Callback<T> = (event: T) => void

function setupCompanion(opts: { configFails?: boolean } = {}): {
  api: {
    app: Record<string, ReturnType<typeof vi.fn>>
    window: Record<string, ReturnType<typeof vi.fn>>
    config: Record<string, ReturnType<typeof vi.fn>>
    chat: Record<string, ReturnType<typeof vi.fn>>
    voice: Record<string, ReturnType<typeof vi.fn>>
  }
  counts: () => {
    appErrors: number
    windowStates: number
    chatStreams: number
    asrOverviews: number
    voiceStates: number
    assetDownloads: number
  }
  emitStream: (event: ChatStreamEvent) => void
} {
  const appErrors = new Set<Callback<PublicAppError>>()
  const windowStates = new Set<Callback<{ maximized: boolean }>>()
  const chatStreams = new Set<Callback<ChatStreamEvent>>()
  const asrOverviews = new Set<Callback<AsrOverview>>()
  const voiceStates = new Set<Callback<VoiceEvent>>()
  const assetDownloads = new Set<Callback<AssetDownloadStatus>>()

  const add = <T>(set: Set<Callback<T>>, cb: Callback<T>): (() => void) => {
    set.add(cb)
    return () => set.delete(cb)
  }

  const api = {
    app: {
      getInfo: vi.fn(async () => ({ ok: true, data: { version: '1.0.0' } })),
      onError: vi.fn((cb: Callback<PublicAppError>) => add(appErrors, cb))
    },
    window: {
      onState: vi.fn((cb: Callback<{ maximized: boolean }>) => add(windowStates, cb)),
      getState: vi.fn(async () => ({ ok: true, data: { maximized: false } }))
    },
    config: {
      get: vi.fn(async () => {
        if (opts.configFails) throw new Error('config failed')
        return {
          ok: true,
          data: {
            schemaVersion: 1,
            model: { hasApiKey: true },
            ui: { theme: 'dark' },
            tts: {},
            memory: {},
            security: {}
          }
        }
      })
    },
    chat: {
      createSession: vi.fn(async () => ({ ok: true, data: { sessionId: 's1' } })),
      // P2-43：模拟空库（全新用户），hydrate 落回 createSession
      getLastSession: vi.fn(async () => ({ ok: true, data: { sessionId: null } })),
      list: vi.fn(async ({ sessionId }: { sessionId: string }) => ({
        ok: true,
        data: { sessionId, messages: [] }
      })),
      onStream: vi.fn((cb: Callback<ChatStreamEvent>) => add(chatStreams, cb))
    },
    voice: {
      getAsrOverview: vi.fn(async () => ({
        ok: true,
        data: {
          selectedEngineId: 'sherpa-sensevoice',
          fallbackEngineId: null,
          engines: [],
          vadModel: { state: 'not-downloaded' }
        }
      })),
      getAssetRoot: vi.fn(async () => ({
        ok: true,
        data: {
          isDefault: true,
          freeBytes: 1_000_000_000,
          totalRequiredBytes: 163_646_737,
          state: 'ok'
        }
      })),
      onAsrOverview: vi.fn((cb: Callback<AsrOverview>) => add(asrOverviews, cb)),
      onVoiceState: vi.fn((cb: Callback<VoiceEvent>) => add(voiceStates, cb)),
      onAssetDownload: vi.fn((cb: Callback<AssetDownloadStatus>) => add(assetDownloads, cb))
    }
  }

  ;(window as unknown as { companion: unknown }).companion = api
  return {
    api,
    counts: () => ({
      appErrors: appErrors.size,
      windowStates: windowStates.size,
      chatStreams: chatStreams.size,
      asrOverviews: asrOverviews.size,
      voiceStates: voiceStates.size,
      assetDownloads: assetDownloads.size
    }),
    emitStream(event) {
      for (const cb of [...chatStreams]) cb(event)
    }
  }
}

describe('C-β bootstrap lifecycle', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('重复 bootstrap 仍只保留一组 listener/一个 session，且旧 teardown 不拆新订阅', async () => {
    const { api, counts, emitStream } = setupCompanion()
    const chatStore = useChatStore()

    const teardown1 = (await bootstrapApp()) as unknown as () => void
    const teardown2 = (await bootstrapApp()) as unknown as () => void

    expect(api.chat.createSession).toHaveBeenCalledTimes(1)
    expect(counts()).toEqual({
      appErrors: 1,
      windowStates: 1,
      chatStreams: 1,
      asrOverviews: 1,
      voiceStates: 1,
      assetDownloads: 1
    })

    teardown1()
    expect(counts()).toEqual({
      appErrors: 1,
      windowStates: 1,
      chatStreams: 1,
      asrOverviews: 1,
      voiceStates: 1,
      assetDownloads: 1
    })

    emitStream({
      type: 'started',
      requestId: 'r1',
      sessionId: 's1',
      assistantMessageId: 'a1',
      sequence: 0
    })
    expect(chatStore.state.messages.map((m) => m.id)).toEqual(['a1'])

    teardown2()
    expect(counts()).toEqual({
      appErrors: 0,
      windowStates: 0,
      chatStreams: 0,
      asrOverviews: 0,
      voiceStates: 0,
      assetDownloads: 0
    })
    emitStream({ type: 'chunk', requestId: 'r1', sequence: 1, delta: '不应写入' })
    expect(chatStore.state.messages[0].content).toBe('')
  })

  it('bootstrap 中途失败会清理已注册的 listener，并进入 blocked', async () => {
    const { counts } = setupCompanion({ configFails: true })
    const appStore = useAppStore()

    const teardown = (await bootstrapApp()) as unknown as () => void

    expect(appStore.state.bootStage).toBe('blocked')
    expect(counts()).toEqual({
      appErrors: 0,
      windowStates: 0,
      chatStreams: 0,
      asrOverviews: 0,
      voiceStates: 0,
      assetDownloads: 0
    })
    expect(() => teardown()).not.toThrow()
  })
})
