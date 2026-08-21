// @vitest-environment jsdom
// src/renderer/src/stores/config.test.ts
// P2-31.5A：config store patchDmae 嵌套草稿 merge 测试。
// 依据：S-005-补充 §1.8 / §3.3 CFG-DMAE-10。
//
// 核心验收：连续 patchDmae({decayAlpha})、patchDmae({decayBeta}) 两个草稿改动同时存在，
// 不因浅 merge 丢值。anomaly.muted / anomaly.windows 两层 patch 不丢值。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useConfigStore } from './config'
import type { PublicConfigSnapshot } from '@shared/config/types'

// === window.companion mock ===

function makeSnapshot(): PublicConfigSnapshot {
  return {
    schemaVersion: 1,
    model: {
      provider: 'deepseek',
      protocol: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      displayName: 'DeepSeek',
      temperature: 0.8,
      topP: 0.95,
      maxTokens: 2048,
      timeoutMs: 60_000,
      reasoningEffort: 'off',
      supportsThinking: false,
      hasApiKey: false,
      validated: false
    },
    ui: {
      locale: 'zh-CN',
      theme: 'system',
      fontScale: 1,
      reduceMotion: false,
      window: { width: 900, height: 720, maximized: false },
      chat: { sendOnEnter: true, showTimestamps: false, showReasoning: true },
      live2d: { enabled: false, zoom: 1, alwaysOnTop: true }
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
    }
  }
}

function setupCompanionApi(): {
  config: Record<string, ReturnType<typeof vi.fn>>
  snapshot: PublicConfigSnapshot
} {
  const snapshot = makeSnapshot()

  const config = {
    get: vi.fn(async () => ({ ok: true, data: snapshot })),
    update: vi.fn(async () => ({ ok: true, data: snapshot })),
    testModel: vi.fn(async () => ({ ok: true, data: { ok: true, latencyMs: 50 } }))
  }

  Object.defineProperty(window, 'companion', {
    value: { config },
    writable: true,
    configurable: true
  })

  return { config, snapshot }
}

describe('P2-46: 主题草稿与保存', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    setupCompanionApi()
  })

  it('patch ui.theme 后 save 走既有 config:update 并保留完整 ui 域', async () => {
    const { config, snapshot } = setupCompanionApi()
    config.update.mockImplementation(async (request) => ({
      ok: true,
      data: { ...snapshot, ui: { ...snapshot.ui, theme: request.domains.ui.theme } }
    }))

    const store = useConfigStore()
    await store.load()
    store.patch('ui', { theme: 'dark' })

    expect(store.state.draft!.ui.theme).toBe('dark')
    expect(store.isDirty).toBe(true)
    await expect(store.save()).resolves.toBe(true)
    expect(config.update).toHaveBeenCalledOnce()
    expect(config.update.mock.calls[0][0].domains.ui).toMatchObject({
      theme: 'dark',
      locale: 'zh-CN',
      fontScale: 1
    })
    expect(store.state.saved!.ui.theme).toBe('dark')
    expect(store.state.draft!.ui.theme).toBe('dark')
  })

  it('S-04 回归：保存失败后再次保存可重试成功（不再被永久锁死）', async () => {
    const { config } = setupCompanionApi()
    // 第一次 update 返回业务错误，第二次成功
    config.update.mockImplementationOnce(async () => ({
      ok: false,
      error: {
        code: 'CFG_INVALID',
        message: '配置校验失败',
        severity: 'error',
        retryable: false
      }
    }))
    config.update.mockImplementation(async (request) => ({
      ok: true,
      data: {
        ...makeSnapshot(),
        model: { ...makeSnapshot().model, ...request.domains.model }
      }
    }))

    const store = useConfigStore()
    await store.load()
    store.patch('model', { maxTokens: 4096 })

    // 第一次保存失败 -> validationErrors.save 被设置，canSave 变 false
    await expect(store.save()).resolves.toBe(false)
    expect(store.state.validationErrors.save).toBeDefined()
    expect(store.canSave).toBe(false)

    // 无需 discard，直接再次保存 -> 成功（旧实现在这里被永久锁死）
    await expect(store.save()).resolves.toBe(true)
    expect(store.state.validationErrors).toEqual({})
    expect(store.state.saved!.model.maxTokens).toBe(4096)
  })

  it('discard 可从 reactive saved 恢复草稿且不抛 DataCloneError', async () => {
    const store = useConfigStore()
    await store.load()
    store.patch('memory', { enabled: true })

    expect(store.isDirty).toBe(true)
    expect(() => store.discard()).not.toThrow()
    expect(store.state.draft).toEqual(store.state.saved)
    expect(store.state.draft).not.toBe(store.state.saved)
    expect(store.isDirty).toBe(false)
  })

  it('测试连接传入草稿超时并裁剪到 IPC 的 30 秒上限', async () => {
    const { config } = setupCompanionApi()
    const store = useConfigStore()
    await store.load()
    store.patch('model', { timeoutMs: 60_000 })

    await store.testConnection()

    expect(config.testModel).toHaveBeenCalledWith({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      timeoutMs: 30_000
    })
  })
})

describe('P2-31.5A CFG-DMAE-10: patchDmae 嵌套草稿 merge', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    setupCompanionApi()
  })

  it('连续 patchDmae({decayAlpha})、patchDmae({decayBeta}) 两个改动同时留在草稿', async () => {
    const store = useConfigStore()
    await store.load()
    const savedThreshold = store.state.saved!.memory.dmae.promptThreshold
    const savedBu = store.state.saved!.memory.dmae.userRewardBase

    // 连续改两个参数（旧 patch('memory', { dmae: ... }) 会让第二次覆盖第一次）
    store.patchDmae({ decayAlpha: 0.8 })
    store.patchDmae({ decayBeta: 0.2 })

    const dmae = store.state.draft!.memory.dmae
    expect(dmae.decayAlpha).toBe(0.8)
    expect(dmae.decayBeta).toBe(0.2)
    // 未改的字段保留原值
    expect(dmae.promptThreshold).toBe(savedThreshold)
    expect(dmae.userRewardBase).toBe(savedBu)
  })

  it('patchDmae({anomaly.muted.R07}) 后 patchDmae({anomaly.muted.R03}) 不丢 R07', async () => {
    const store = useConfigStore()
    await store.load()

    store.patchDmae({ anomaly: { muted: { R07: 9999 } } })
    store.patchDmae({ anomaly: { muted: { R03: 8888 } } })

    const muted = store.state.draft!.memory.dmae.anomaly.muted
    expect(muted.R07).toBe(9999)
    expect(muted.R03).toBe(8888)
    // 其余 11 项仍为 0
    expect(muted.R01).toBe(0)
    expect(muted.R13).toBe(0)
  })

  it('patchDmae({anomaly.windows.R10.days}) 后 patchDmae({anomaly.windows.R10.turns}) 不丢 days', async () => {
    const store = useConfigStore()
    await store.load()

    store.patchDmae({ anomaly: { windows: { R10: { days: 5 } } } })
    store.patchDmae({ anomaly: { windows: { R10: { turns: 200 } } } })

    const w = store.state.draft!.memory.dmae.anomaly.windows
    expect(w.R10.days).toBe(5)
    expect(w.R10.turns).toBe(200)
  })

  it('patchDmae({anomaly.windows.R01.days}) 不影响 R10 的值', async () => {
    const store = useConfigStore()
    await store.load()

    store.patchDmae({ anomaly: { windows: { R01: { days: 10 } } } })
    const w = store.state.draft!.memory.dmae.anomaly.windows
    expect(w.R01.days).toBe(10)
    // R10 保持默认 { days: 3, turns: 100 }
    expect(w.R10.days).toBe(3)
    expect(w.R10.turns).toBe(100)
  })

  it('patchDmae({historySampleEveryTurns}) 保留已改的 decayAlpha', async () => {
    const store = useConfigStore()
    await store.load()

    store.patchDmae({ decayAlpha: 0.5 })
    store.patchDmae({ historySampleEveryTurns: 5 })

    const dmae = store.state.draft!.memory.dmae
    expect(dmae.decayAlpha).toBe(0.5)
    expect(dmae.historySampleEveryTurns).toBe(5)
  })

  it('patchDmae({presets}) 整体替换数组', async () => {
    const store = useConfigStore()
    await store.load()

    const preset = {
      id: 'preset.user.test',
      name: '测试',
      description: '',
      baseline: 'default' as const,
      overrides: { decayAlpha: 0.5 },
      builtin: false as const,
      createdAt: 1_000,
      updatedAt: 1_000
    }
    store.patchDmae({ presets: [preset] })
    expect(store.state.draft!.memory.dmae.presets).toHaveLength(1)
    expect(store.state.draft!.memory.dmae.presets[0].id).toBe('preset.user.test')
  })
})
