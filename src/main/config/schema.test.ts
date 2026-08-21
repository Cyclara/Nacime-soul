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

  it('M-42: attributionGate 默认全空合法（回退提取同款）；独立模型配置合法', () => {
    expectValid(MemoryConfigSchema, DEFAULT_CONFIG_V1.memory)
    const independent = {
      ...DEFAULT_CONFIG_V1.memory,
      attributionGate: {
        provider: 'qwen',
        model: 'qwen-turbo',
        baseUrl: 'https://dashscope.example.com'
      }
    }
    expectValid(MemoryConfigSchema, independent)
  })

  it('M-42: attributionGate 缺键 -> 失败（required，旧配置由 deepMergeWithDefaults 补齐）', () => {
    const rest: Record<string, unknown> = { ...DEFAULT_CONFIG_V1.memory }
    delete rest.attributionGate
    expectInvalid(MemoryConfigSchema, rest)
  })

  it('M-42: attributionGate 严格键 + 类型/长度校验', () => {
    const base = DEFAULT_CONFIG_V1.memory
    // 多余键拒绝（strictObject）
    expectInvalid(MemoryConfigSchema, {
      ...base,
      attributionGate: { ...base.attributionGate, apiKey: 'x' }
    })
    // 非字符串拒绝
    expectInvalid(MemoryConfigSchema, {
      ...base,
      attributionGate: { ...base.attributionGate, model: 42 }
    })
    // 超长拒绝（provider 64 / model 128 / baseUrl 256）
    expectInvalid(MemoryConfigSchema, {
      ...base,
      attributionGate: { ...base.attributionGate, provider: 'p'.repeat(65) }
    })
    expectInvalid(MemoryConfigSchema, {
      ...base,
      attributionGate: { ...base.attributionGate, baseUrl: 'u'.repeat(257) }
    })
  })
})

// === P2-31.5A：DMAE 可视化前置门配置 schema 测试（S-005-补充 §3.3）===

describe('P2-31.5A CFG-DMAE: DMAE 四字段 schema + 默认', () => {
  // CFG-DMAE-01：DEFAULT_CONFIG_V1 根校验，四字段存在；muted/windows 恰好 R01～R13
  it('CFG-DMAE-01: DEFAULT_CONFIG_V1 含四字段；muted/windows 恰好 R01~R13', () => {
    const d = DEFAULT_CONFIG_V1.memory.dmae
    expect(d.presets).toEqual([])
    expect(d.historySampleEveryTurns).toBe(1)
    // muted 13 个键全 0
    expect(Object.keys(d.anomaly.muted).sort()).toEqual([
      'R01',
      'R02',
      'R03',
      'R04',
      'R05',
      'R06',
      'R07',
      'R08',
      'R09',
      'R10',
      'R11',
      'R12',
      'R13'
    ])
    for (const v of Object.values(d.anomaly.muted)) expect(v).toBe(0)
    // windows 13 个键
    expect(Object.keys(d.anomaly.windows).sort()).toEqual([
      'R01',
      'R02',
      'R03',
      'R04',
      'R05',
      'R06',
      'R07',
      'R08',
      'R09',
      'R10',
      'R11',
      'R12',
      'R13'
    ])
    // DEFAULT_CONFIG_V1 通过根 schema
    expectValid(MemoryConfigSchema, DEFAULT_CONFIG_V1.memory)
  })

  // CFG-DMAE-06：historySampleEveryTurns 边界
  it('CFG-DMAE-06: historySampleEveryTurns 1/10 接受；0/11/1.5/NaN/Infinity 拒绝', () => {
    const base = DEFAULT_CONFIG_V1.memory
    expectValid(MemoryConfigSchema, { ...base, dmae: { ...base.dmae, historySampleEveryTurns: 1 } })
    expectValid(MemoryConfigSchema, {
      ...base,
      dmae: { ...base.dmae, historySampleEveryTurns: 10 }
    })
    const bad = (v: number): typeof DEFAULT_CONFIG_V1.memory => ({
      ...base,
      dmae: { ...base.dmae, historySampleEveryTurns: v }
    })
    expectInvalid(MemoryConfigSchema, bad(0))
    expectInvalid(MemoryConfigSchema, bad(11))
    expectInvalid(MemoryConfigSchema, bad(1.5))
    expectInvalid(MemoryConfigSchema, bad(NaN))
    expectInvalid(MemoryConfigSchema, bad(Infinity))
  })

  // CFG-DMAE-07：presets 空数组接受；默认不含 builtin
  it('CFG-DMAE-07: presets=[] 接受；默认不含任何 builtin', () => {
    const base = DEFAULT_CONFIG_V1.memory
    expectValid(MemoryConfigSchema, { ...base, dmae: { ...base.dmae, presets: [] } })
    expect(DEFAULT_CONFIG_V1.memory.dmae.presets).toEqual([])
  })

  // CFG-DMAE-08：第 51 个预设、重复 id、builtin:true 拒绝
  it('CFG-DMAE-08: 第 51 个预设 / 重复 id / builtin:true -> schema 拒绝', () => {
    const base = DEFAULT_CONFIG_V1.memory
    const validPreset = {
      id: 'preset.user.test',
      name: '测试预设',
      description: 'desc',
      baseline: 'default' as const,
      overrides: {},
      builtin: false as const,
      createdAt: 1_000,
      updatedAt: 1_000
    }
    // 50 个预设接受
    const fifty = Array.from({ length: 50 }, (_, i) => ({
      ...validPreset,
      id: `preset.user.t${i}`,
      name: `预设${i}`
    }))
    expectValid(MemoryConfigSchema, { ...base, dmae: { ...base.dmae, presets: fifty } })
    // 51 个拒绝
    const fiftyOne = [...fifty, { ...validPreset, id: 'preset.user.extra', name: 'x' }]
    expectInvalid(MemoryConfigSchema, { ...base, dmae: { ...base.dmae, presets: fiftyOne } })
    // 重复 id 拒绝
    const dup = [
      { ...validPreset, id: 'preset.user.dup', name: 'a' },
      { ...validPreset, id: 'preset.user.dup', name: 'b' }
    ]
    expectInvalid(MemoryConfigSchema, { ...base, dmae: { ...base.dmae, presets: dup } })
    // builtin:true 拒绝
    const builtinPreset = { ...validPreset, builtin: true as unknown as false }
    expectInvalid(MemoryConfigSchema, { ...base, dmae: { ...base.dmae, presets: [builtinPreset] } })
  })

  // CFG-DMAE-09：preset override 每个参数上下界
  it('CFG-DMAE-09: preset override 边界接受，越界拒绝；未知参数拒绝', () => {
    const base = DEFAULT_CONFIG_V1.memory
    const mk = (overrides: Record<string, unknown>): typeof DEFAULT_CONFIG_V1.memory => ({
      ...base,
      dmae: {
        ...base.dmae,
        presets: [
          {
            id: 'preset.user.test',
            name: 't',
            description: '',
            baseline: 'default',
            overrides,
            builtin: false,
            createdAt: 1,
            updatedAt: 1
          }
        ]
      }
    })
    // 空 overrides 接受
    expectValid(MemoryConfigSchema, mk({}))
    // 边界接受
    expectValid(MemoryConfigSchema, mk({ decayAlpha: 0.3 }))
    expectValid(MemoryConfigSchema, mk({ decayAlpha: 2 }))
    expectValid(MemoryConfigSchema, mk({ decayBeta: 0.05 }))
    expectValid(MemoryConfigSchema, mk({ decayBeta: 0.5 }))
    // 越界拒绝
    expectInvalid(MemoryConfigSchema, mk({ decayAlpha: 0.29 }))
    expectInvalid(MemoryConfigSchema, mk({ decayAlpha: 2.01 }))
    expectInvalid(MemoryConfigSchema, mk({ decayBeta: 0.04 }))
    expectInvalid(MemoryConfigSchema, mk({ decayBeta: 0.51 }))
    // 未知参数拒绝（strictObject + partial）
    expectInvalid(MemoryConfigSchema, mk({ unknownParam: 1 }))
  })

  // CFG-DMAE-05（schema 部分）：windows 带 R14 或给 R06 写 days -> schema 拒绝
  it('CFG-DMAE-05: windows R14 / R06.days -> schema 拒绝', () => {
    const base = DEFAULT_CONFIG_V1.memory
    const windows = { ...base.dmae.anomaly.windows }
    // R14 不在 13 键中 -> strictObject 拒绝
    const withR14 = { ...windows, R14: { days: 3 } }
    expectInvalid(MemoryConfigSchema, {
      ...base,
      dmae: { ...base.dmae, anomaly: { ...base.dmae.anomaly, windows: withR14 } }
    })
    // R06 写 days -> NoWindowSchema 拒绝
    const r06Days = { ...windows, R06: { days: 3 } }
    expectInvalid(MemoryConfigSchema, {
      ...base,
      dmae: { ...base.dmae, anomaly: { ...base.dmae.anomaly, windows: r06Days } }
    })
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
