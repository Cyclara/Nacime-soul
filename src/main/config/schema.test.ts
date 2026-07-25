// src/main/config/schema.test.ts
// P1-06 验收测试：五域 schema + 根 schema + 默认配置
// 依据：S-005 §3.2-§3.7、S-001 P1-06 验收标准

import { describe, it, expect } from 'vitest'
import * as v from 'valibot'
import { AppConfigSchema } from './schema'
import { DEFAULT_CONFIG_V1 } from './defaults'
import {
  ModelConfigSchema,
  TtsConfigSchema,
  MemoryConfigSchema,
  UiConfigSchema,
  SecurityConfigSchema
} from './schema'

/** 深拷贝 frozen 默认配置，供测试修改单个字段 */
function cloneDefaults(): typeof DEFAULT_CONFIG_V1 {
  return structuredClone(DEFAULT_CONFIG_V1)
}

/** 断言 schema 校验成功 */
function expectValid(schema: v.GenericSchema, input: unknown): void {
  const result = v.safeParse(schema, input)
  expect(result.success, JSON.stringify(result)).toBe(true)
}

/** 断言 schema 校验失败 */
function expectInvalid(schema: v.GenericSchema, input: unknown): void {
  const result = v.safeParse(schema, input)
  expect(result.success).toBe(false)
}

describe('P1-06 AppConfigSchema 根 schema', () => {
  it('DEFAULT_CONFIG_V1 通过根 schema 校验', () => {
    const result = v.safeParse(AppConfigSchema, DEFAULT_CONFIG_V1)
    expect(result.success, JSON.stringify(result)).toBe(true)
  })

  it('缺少任一域 -> 失败', () => {
    const partial = cloneDefaults()
    // @ts-expect-error 故意删除域
    delete partial.model
    expectInvalid(AppConfigSchema, partial)
  })

  it('schemaVersion 不为 1 -> 失败', () => {
    const bad = cloneDefaults()
    ;(bad as { schemaVersion: number }).schemaVersion = 2
    expectInvalid(AppConfigSchema, bad)
  })

  it('未知顶层 key 被剥离（S-005 §3.7: 未知 key 默认剔除）', () => {
    const withUnknown = { ...cloneDefaults(), unknownTopKey: 'evil' }
    const result = v.safeParse(AppConfigSchema, withUnknown)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.output).not.toHaveProperty('unknownTopKey')
    }
  })

  it('未知嵌套 key 被剥离', () => {
    const withUnknown = cloneDefaults()
    ;(withUnknown.model as unknown as Record<string, unknown>).unknownField = 'x'
    const result = v.safeParse(AppConfigSchema, withUnknown)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.output.model).not.toHaveProperty('unknownField')
    }
  })
})

describe('P1-06 ModelConfigSchema', () => {
  it('合法默认通过', () => {
    expectValid(ModelConfigSchema, DEFAULT_CONFIG_V1.model)
  })

  it('非法 URL -> 失败', () => {
    const bad = { ...DEFAULT_CONFIG_V1.model, baseUrl: 'not-a-url' }
    expectInvalid(ModelConfigSchema, bad)
  })

  it('温度 > 2 -> 失败', () => {
    const bad = { ...DEFAULT_CONFIG_V1.model, temperature: 2.5 }
    expectInvalid(ModelConfigSchema, bad)
  })

  it('温度 < 0 -> 失败', () => {
    const bad = { ...DEFAULT_CONFIG_V1.model, temperature: -0.1 }
    expectInvalid(ModelConfigSchema, bad)
  })

  it('温度 = 0 边界 -> 通过', () => {
    const ok = { ...DEFAULT_CONFIG_V1.model, temperature: 0 }
    expectValid(ModelConfigSchema, ok)
  })

  it('温度 = 2 边界 -> 通过', () => {
    const ok = { ...DEFAULT_CONFIG_V1.model, temperature: 2 }
    expectValid(ModelConfigSchema, ok)
  })

  it('topP > 1 -> 失败', () => {
    const bad = { ...DEFAULT_CONFIG_V1.model, topP: 1.1 }
    expectInvalid(ModelConfigSchema, bad)
  })

  it('maxTokens 非整数 -> 失败', () => {
    const bad = { ...DEFAULT_CONFIG_V1.model, maxTokens: 100.5 }
    expectInvalid(ModelConfigSchema, bad)
  })

  it('maxTokens < 64 -> 失败', () => {
    const bad = { ...DEFAULT_CONFIG_V1.model, maxTokens: 32 }
    expectInvalid(ModelConfigSchema, bad)
  })

  it('maxTokens > 65536 -> 失败', () => {
    const bad = { ...DEFAULT_CONFIG_V1.model, maxTokens: 70_000 }
    expectInvalid(ModelConfigSchema, bad)
  })

  it('timeoutMs < 1000 -> 失败', () => {
    const bad = { ...DEFAULT_CONFIG_V1.model, timeoutMs: 500 }
    expectInvalid(ModelConfigSchema, bad)
  })

  it('timeoutMs > 300000 -> 失败', () => {
    const bad = { ...DEFAULT_CONFIG_V1.model, timeoutMs: 400_000 }
    expectInvalid(ModelConfigSchema, bad)
  })

  it('provider 空串 -> 失败', () => {
    const bad = { ...DEFAULT_CONFIG_V1.model, provider: '' }
    expectInvalid(ModelConfigSchema, bad)
  })

  it('protocol 非法值 -> 失败', () => {
    const bad = { ...DEFAULT_CONFIG_V1.model, protocol: 'gemini' }
    expectInvalid(ModelConfigSchema, bad)
  })

  it('reasoningEffort 非法值 -> 失败', () => {
    const bad = { ...DEFAULT_CONFIG_V1.model, reasoningEffort: 'ultra' }
    expectInvalid(ModelConfigSchema, bad)
  })

  it('compatOverrides 合法覆盖 -> 通过', () => {
    const ok = {
      ...DEFAULT_CONFIG_V1.model,
      compatOverrides: {
        thinkingFormat: 'thinking_type',
        supportsToolCalls: true,
        supportsVision: false,
        maxTokensField: 'max_completion_tokens'
      }
    }
    expectValid(ModelConfigSchema, ok)
  })

  it('compatOverrides 非法 thinkingFormat -> 失败', () => {
    const bad = {
      ...DEFAULT_CONFIG_V1.model,
      compatOverrides: { thinkingFormat: 'bogus' }
    }
    expectInvalid(ModelConfigSchema, bad)
  })

  it('baseUrl 带 localhost 仍通过 schema（https 限制由 network-policy 层执行）', () => {
    const ok = { ...DEFAULT_CONFIG_V1.model, baseUrl: 'http://127.0.0.1:11434/v1' }
    expectValid(ModelConfigSchema, ok)
  })
})

describe('P1-06 TtsConfigSchema', () => {
  it('合法默认通过', () => {
    expectValid(TtsConfigSchema, DEFAULT_CONFIG_V1.tts)
  })

  it('音量 > 1 -> 失败', () => {
    const bad = { ...DEFAULT_CONFIG_V1.tts, volume: 1.1 }
    expectInvalid(TtsConfigSchema, bad)
  })

  it('音量 < 0 -> 失败', () => {
    const bad = { ...DEFAULT_CONFIG_V1.tts, volume: -0.1 }
    expectInvalid(TtsConfigSchema, bad)
  })

  it('音量 = 0 边界 -> 通过', () => {
    const ok = { ...DEFAULT_CONFIG_V1.tts, volume: 0 }
    expectValid(TtsConfigSchema, ok)
  })

  it('音量 = 1 边界 -> 通过', () => {
    const ok = { ...DEFAULT_CONFIG_V1.tts, volume: 1 }
    expectValid(TtsConfigSchema, ok)
  })

  it('speed < 0.5 -> 失败', () => {
    const bad = { ...DEFAULT_CONFIG_V1.tts, speed: 0.3 }
    expectInvalid(TtsConfigSchema, bad)
  })

  it('speed > 2 -> 失败', () => {
    const bad = { ...DEFAULT_CONFIG_V1.tts, speed: 2.5 }
    expectInvalid(TtsConfigSchema, bad)
  })

  it('pitch < -12 -> 失败', () => {
    const bad = { ...DEFAULT_CONFIG_V1.tts, pitch: -13 }
    expectInvalid(TtsConfigSchema, bad)
  })

  it('pitch > 12 -> 失败', () => {
    const bad = { ...DEFAULT_CONFIG_V1.tts, pitch: 13 }
    expectInvalid(TtsConfigSchema, bad)
  })

  it('sampleRate 非法值 -> 失败', () => {
    const bad = { ...DEFAULT_CONFIG_V1.tts, sampleRate: 32000 }
    expectInvalid(TtsConfigSchema, bad)
  })

  it('enabled 非布尔 -> 失败', () => {
    const bad = { ...DEFAULT_CONFIG_V1.tts, enabled: 'yes' }
    expectInvalid(TtsConfigSchema, bad)
  })
})

describe('P1-06 MemoryConfigSchema', () => {
  it('合法默认通过', () => {
    expectValid(MemoryConfigSchema, DEFAULT_CONFIG_V1.memory)
  })

  it('DMAE maxScore 不为 100 -> 失败', () => {
    const bad = {
      ...DEFAULT_CONFIG_V1.memory,
      dmae: { ...DEFAULT_CONFIG_V1.memory.dmae, maxScore: 99 }
    }
    expectInvalid(MemoryConfigSchema, bad)
  })

  it('DEFAULT_CONFIG_V1 DMAE promptThreshold 为新默认 30（非旧误值 15，S-005 §3.4）', () => {
    expect(DEFAULT_CONFIG_V1.memory.dmae.promptThreshold).toBe(30)
    expect(DEFAULT_CONFIG_V1.memory.dmae.promptThreshold).not.toBe(15)
  })

  it('DEFAULT_CONFIG_V1 DMAE wakeLambda 为新默认 0.3（非旧误值 0.15）', () => {
    expect(DEFAULT_CONFIG_V1.memory.dmae.wakeLambda).toBe(0.3)
    expect(DEFAULT_CONFIG_V1.memory.dmae.wakeLambda).not.toBe(0.15)
  })

  it('DEFAULT_CONFIG_V1 DMAE decayBeta 为新默认 0.3（非旧误值 0.1）', () => {
    expect(DEFAULT_CONFIG_V1.memory.dmae.decayBeta).toBe(0.3)
    expect(DEFAULT_CONFIG_V1.memory.dmae.decayBeta).not.toBe(0.1)
  })

  it('DEFAULT_CONFIG_V1 DMAE 全部默认值符合 S-005 §3.4', () => {
    const d = DEFAULT_CONFIG_V1.memory.dmae
    expect(d).toMatchObject({
      enabled: true,
      maxScore: 100,
      promptThreshold: 30,
      userRewardBase: 20,
      wakeGamma: 0.5,
      modelRewardBase: 8,
      wakeLambda: 0.3,
      decayAlpha: 1.5,
      decayBeta: 0.3
    })
  })

  it('embeddingDimension < 64 -> 失败', () => {
    const bad = { ...DEFAULT_CONFIG_V1.memory, embeddingDimension: 32 }
    expectInvalid(MemoryConfigSchema, bad)
  })

  it('embeddingDimension > 8192 -> 失败', () => {
    const bad = { ...DEFAULT_CONFIG_V1.memory, embeddingDimension: 16_384 }
    expectInvalid(MemoryConfigSchema, bad)
  })

  it('maxActive > 50 -> 失败', () => {
    const bad = { ...DEFAULT_CONFIG_V1.memory, maxActive: 51 }
    expectInvalid(MemoryConfigSchema, bad)
  })

  it('minRetrievalScore < -1 -> 失败', () => {
    const bad = { ...DEFAULT_CONFIG_V1.memory, minRetrievalScore: -1.1 }
    expectInvalid(MemoryConfigSchema, bad)
  })

  it('minRetrievalScore > 1 -> 失败', () => {
    const bad = { ...DEFAULT_CONFIG_V1.memory, minRetrievalScore: 1.1 }
    expectInvalid(MemoryConfigSchema, bad)
  })
})

describe('P1-06 UiConfigSchema', () => {
  it('合法默认通过', () => {
    expectValid(UiConfigSchema, DEFAULT_CONFIG_V1.ui)
  })

  it('fontScale < 0.8 -> 失败', () => {
    const bad = { ...DEFAULT_CONFIG_V1.ui, fontScale: 0.7 }
    expectInvalid(UiConfigSchema, bad)
  })

  it('fontScale > 1.5 -> 失败', () => {
    const bad = { ...DEFAULT_CONFIG_V1.ui, fontScale: 1.6 }
    expectInvalid(UiConfigSchema, bad)
  })

  it('window.width < 480 -> 失败', () => {
    const bad = {
      ...DEFAULT_CONFIG_V1.ui,
      window: { ...DEFAULT_CONFIG_V1.ui.window, width: 320 }
    }
    expectInvalid(UiConfigSchema, bad)
  })

  it('window.height < 600 -> 失败', () => {
    const bad = {
      ...DEFAULT_CONFIG_V1.ui,
      window: { ...DEFAULT_CONFIG_V1.ui.window, height: 400 }
    }
    expectInvalid(UiConfigSchema, bad)
  })

  it('locale 非法值 -> 失败', () => {
    const bad = { ...DEFAULT_CONFIG_V1.ui, locale: 'ja-JP' }
    expectInvalid(UiConfigSchema, bad)
  })

  it('theme 非法值 -> 失败', () => {
    const bad = { ...DEFAULT_CONFIG_V1.ui, theme: 'solarized' }
    expectInvalid(UiConfigSchema, bad)
  })

  it('live2d.zoom < 0.25 -> 失败', () => {
    const bad = {
      ...DEFAULT_CONFIG_V1.ui,
      live2d: { ...DEFAULT_CONFIG_V1.ui.live2d, zoom: 0.1 }
    }
    expectInvalid(UiConfigSchema, bad)
  })

  it('window.x 可选，省略 -> 通过', () => {
    const ok = cloneDefaults().ui
    expectValid(UiConfigSchema, ok)
  })
})

describe('P1-06 SecurityConfigSchema', () => {
  it('合法默认通过', () => {
    expectValid(SecurityConfigSchema, DEFAULT_CONFIG_V1.security)
  })

  it('diagnostics.retentionDays < 1 -> 失败', () => {
    const bad = {
      ...DEFAULT_CONFIG_V1.security,
      diagnostics: { ...DEFAULT_CONFIG_V1.security.diagnostics, retentionDays: 0 }
    }
    expectInvalid(SecurityConfigSchema, bad)
  })

  it('diagnostics.retentionDays > 30 -> 失败', () => {
    const bad = {
      ...DEFAULT_CONFIG_V1.security,
      diagnostics: { ...DEFAULT_CONFIG_V1.security.diagnostics, retentionDays: 31 }
    }
    expectInvalid(SecurityConfigSchema, bad)
  })

  it('diagnostics.maxTotalMb < 10 -> 失败', () => {
    const bad = {
      ...DEFAULT_CONFIG_V1.security,
      diagnostics: { ...DEFAULT_CONFIG_V1.security.diagnostics, maxTotalMb: 5 }
    }
    expectInvalid(SecurityConfigSchema, bad)
  })

  it('diagnostics.maxTotalMb > 500 -> 失败', () => {
    const bad = {
      ...DEFAULT_CONFIG_V1.security,
      diagnostics: { ...DEFAULT_CONFIG_V1.security.diagnostics, maxTotalMb: 600 }
    }
    expectInvalid(SecurityConfigSchema, bad)
  })

  it('diagnostics.logLevel 非法值 -> 失败', () => {
    const bad = {
      ...DEFAULT_CONFIG_V1.security,
      diagnostics: { ...DEFAULT_CONFIG_V1.security.diagnostics, logLevel: 'trace' }
    }
    expectInvalid(SecurityConfigSchema, bad)
  })
})

describe('P1-06 DEFAULT_CONFIG_V1 不可变性', () => {
  it('默认配置被深度冻结', () => {
    expect(Object.isFrozen(DEFAULT_CONFIG_V1)).toBe(true)
    expect(Object.isFrozen(DEFAULT_CONFIG_V1.model)).toBe(true)
    expect(Object.isFrozen(DEFAULT_CONFIG_V1.model.compatOverrides)).toBe(true)
    expect(Object.isFrozen(DEFAULT_CONFIG_V1.memory.dmae)).toBe(true)
    expect(Object.isFrozen(DEFAULT_CONFIG_V1.ui.window)).toBe(true)
    expect(Object.isFrozen(DEFAULT_CONFIG_V1.security.diagnostics)).toBe(true)
  })

  it('修改 frozen 默认配置在严格模式下抛错', () => {
    'use strict'
    expect(() => {
      ;(DEFAULT_CONFIG_V1.model as { temperature: number }).temperature = 1.5
    }).toThrow(TypeError)
  })
})
