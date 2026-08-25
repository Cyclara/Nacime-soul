// src/main/ipc/validators-p2-45.test.ts
// P2-45：Phase 2 validators 缺失分支补测（S-004-补充 §3.3 接受/拒绝/边界）。
// 覆盖：chat 边界、test-model 边界、get-last-session undefined、memory/growth 边界、
//   DMAE 面板/基准 validator、DMAE 预设/异常 overrides 边界。
import { describe, it, expect } from 'vitest'
import { validateIpcPayload } from './validators'

function rejectDomain(
  domain: 'model' | 'tts' | 'memory' | 'ui' | 'security',
  patch: Record<string, unknown>
): void {
  expect(
    validateIpcPayload('companion:config:update', {
      expectedSchemaVersion: 1,
      domains: { [domain]: patch } as never
    })
  ).toBe(false)
}

describe('P2-45 chat 边界补测', () => {
  it('list: sessionId 非法被拒绝', () => {
    expect(validateIpcPayload('companion:chat:list', { sessionId: 'bad id', limit: 50 })).toBe(
      false
    )
  })
  it('cancel: requestId 非法被拒绝', () => {
    expect(validateIpcPayload('companion:chat:cancel', { requestId: 'bad id' })).toBe(false)
  })
  it('retry: sessionId/messageId 非法被拒绝', () => {
    expect(
      validateIpcPayload('companion:chat:retry', { sessionId: 'bad id', messageId: 'm1' })
    ).toBe(false)
    expect(
      validateIpcPayload('companion:chat:retry', { sessionId: 's1', messageId: 'bad id' })
    ).toBe(false)
  })
})

describe('P2-45 test-model 边界补测', () => {
  const base = { provider: 'p', baseUrl: 'https://api.example.com', model: 'm' }
  it('apiKey 非字符串被拒绝', () => {
    expect(validateIpcPayload('companion:config:test-model', { ...base, apiKey: 123 })).toBe(false)
  })
  it('timeoutMs 超范围被拒绝', () => {
    expect(validateIpcPayload('companion:config:test-model', { ...base, timeoutMs: 40_000 })).toBe(
      false
    )
  })
  it('非对象被拒绝', () => {
    expect(validateIpcPayload('companion:config:test-model', 'not-object')).toBe(false)
  })
})

describe('P2-45 get-last-session undefined 通道', () => {
  it('undefined 通过，其他拒绝', () => {
    expect(validateIpcPayload('companion:chat:get-last-session', undefined)).toBe(true)
    expect(validateIpcPayload('companion:chat:get-last-session', null)).toBe(false)
    expect(validateIpcPayload('companion:chat:get-last-session', {})).toBe(false)
  })
})

describe('P2-45 memory/growth 边界补测', () => {
  it('isMemoryId 超长被拒绝', () => {
    expect(
      validateIpcPayload('companion:memory:get-detail', { memoryId: 'l2_' + 'x'.repeat(70) })
    ).toBe(false)
  })
  it('list-l2: search 非字符串 / state 非字符串被拒绝', () => {
    expect(
      validateIpcPayload('companion:memory:list-l2', { search: 123, limit: 10, offset: 0 })
    ).toBe(false)
    expect(validateIpcPayload('companion:memory:list-l2', { state: 1, limit: 10, offset: 0 })).toBe(
      false
    )
  })
  it('get-dmae-history: memoryId 非法被拒绝', () => {
    expect(
      validateIpcPayload('companion:memory:get-dmae-history', { memoryId: 'bad', days: 7 })
    ).toBe(false)
  })
  it('get-trend: metric 非字符串被拒绝', () => {
    expect(validateIpcPayload('companion:growth:get-trend', { metric: 1, days: 7 })).toBe(false)
  })
})

describe('P2-45 DMAE 面板/基准 validator 补测', () => {
  it('get-trend: days 非法被拒绝', () => {
    expect(validateIpcPayload('companion:dmae:get-trend', { days: 14 })).toBe(false)
    expect(validateIpcPayload('companion:dmae:get-trend', { days: '7' })).toBe(false)
  })
  it('explain: memoryId 非法被拒绝', () => {
    expect(validateIpcPayload('companion:dmae:explain', { memoryId: 'bad' })).toBe(false)
  })
  it('run-benchmark: windowDays 非法被拒绝', () => {
    expect(validateIpcPayload('companion:dmae:run-benchmark', { windowDays: 14 })).toBe(false)
    expect(validateIpcPayload('companion:dmae:run-benchmark', { windowDays: '7' })).toBe(false)
  })
  it('record-qualitative: q1-q3 超范围 / note 非法被拒绝', () => {
    expect(validateIpcPayload('companion:dmae:record-qualitative', { q1: 4, q2: 1, q3: 1 })).toBe(
      false
    )
    expect(
      validateIpcPayload('companion:dmae:record-qualitative', { q1: 1, q2: 1, q3: 1, note: 123 })
    ).toBe(false)
    expect(
      validateIpcPayload('companion:dmae:record-qualitative', {
        q1: 1,
        q2: 1,
        q3: 1,
        note: 'x'.repeat(201)
      })
    ).toBe(false)
  })
  it('record-qualitative: 合法通过', () => {
    expect(
      validateIpcPayload('companion:dmae:record-qualitative', { q1: 3, q2: 2, q3: 1, note: 'ok' })
    ).toBe(true)
  })
})

describe('P2-45 DMAE 预设/异常 overrides 边界补测', () => {
  function rejectPreset(preset: Record<string, unknown>): void {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { memory: { dmae: { presets: [preset] } } }
      })
    ).toBe(false)
  }
  const validPreset = {
    id: 'preset.user.ok',
    name: 'ok',
    description: '',
    baseline: 'default',
    overrides: {},
    builtin: false,
    createdAt: 1,
    updatedAt: 1
  }
  it('合法 preset 通过', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { memory: { dmae: { presets: [validPreset] } } }
      })
    ).toBe(true)
  })
  it('preset 非对象被拒绝', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { memory: { dmae: { presets: ['x'] } } }
      })
    ).toBe(false)
  })
  it('preset 多余字段被拒绝', () => {
    rejectPreset({ ...validPreset, extra: 1 })
  })
  it('preset id 超短被拒绝', () => {
    rejectPreset({ ...validPreset, id: 'short' })
  })
  it('preset name 为空被拒绝', () => {
    rejectPreset({ ...validPreset, name: '' })
  })
  it('preset description 超长被拒绝', () => {
    rejectPreset({ ...validPreset, description: 'x'.repeat(161) })
  })
  it('preset baseline 非 default 被拒绝', () => {
    rejectPreset({ ...validPreset, baseline: 'custom' })
  })
  it('preset overrides 非法值被拒绝', () => {
    rejectPreset({ ...validPreset, overrides: { promptThreshold: 200 } })
    rejectPreset({ ...validPreset, overrides: { wakeGamma: 5 } })
    rejectPreset({ ...validPreset, overrides: { userRewardBase: 'x' } })
  })
  it('preset createdAt/updatedAt 非法被拒绝', () => {
    rejectPreset({ ...validPreset, createdAt: -1 })
    rejectPreset({ ...validPreset, updatedAt: -1 })
  })
  it('presets 非数组被拒绝', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { memory: { dmae: { presets: 'x' } } }
      })
    ).toBe(false)
  })
  it('presets 超 50 个被拒绝', () => {
    const many = Array.from({ length: 51 }, (_, i) => ({
      ...validPreset,
      id: 'preset.user.' + i
    }))
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { memory: { dmae: { presets: many } } }
      })
    ).toBe(false)
  })
  it('anomaly.muted 非对象被拒绝', () => {
    rejectDomain('memory', { dmae: { anomaly: { muted: 'x' } } })
  })
  it('anomaly.muted until 非法被拒绝', () => {
    rejectDomain('memory', { dmae: { anomaly: { muted: { R07: 'x' } } } })
  })
  it('anomaly.windows 非对象被拒绝', () => {
    rejectDomain('memory', { dmae: { anomaly: { windows: 'x' } } })
  })
  it('anomaly.windows 未知规则被拒绝', () => {
    rejectDomain('memory', { dmae: { anomaly: { windows: { R99: { days: 3 } } } } })
  })
  it('anomaly.windows turns 非法被拒绝', () => {
    rejectDomain('memory', { dmae: { anomaly: { windows: { R10: { turns: -1 } } } } })
  })
  it('anomaly.windows R10 days+turns 合法通过', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { memory: { dmae: { anomaly: { windows: { R10: { days: 5, turns: 100 } } } } } }
      })
    ).toBe(true)
  })
})

describe('P2-45 各子 validator 非对象/缺键/合法值定向补测（100% branch）', () => {
  it('chat:cancel / chat:retry 非对象被拒绝', () => {
    expect(validateIpcPayload('companion:chat:cancel', 'x')).toBe(false)
    expect(validateIpcPayload('companion:chat:retry', 'x')).toBe(false)
  })
  it('chat:retry 缺 messageId（hasOnlyKeys 假分支）被拒绝', () => {
    expect(validateIpcPayload('companion:chat:retry', { sessionId: 's1' })).toBe(false)
  })
  it('config:reset-domain 非对象被拒绝', () => {
    expect(validateIpcPayload('companion:config:reset-domain', 'x')).toBe(false)
  })
  it('compatOverrides 非对象被拒绝', () => {
    rejectDomain('model', { compatOverrides: 'x' })
  })
  it('compatOverrides 空对象通过（in 假分支）', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { model: { compatOverrides: {} } }
      })
    ).toBe(true)
  })
  it('ui 域非对象被拒绝', () => {
    rejectDomain('ui', 'x' as never)
  })
  it('ui.locale 合法通过（PASS 分支）', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { ui: { locale: 'zh-CN' } }
      })
    ).toBe(true)
  })
  it('ui.fontScale 合法通过', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { ui: { fontScale: 1.0 } }
      })
    ).toBe(true)
    rejectDomain('ui', { fontScale: 0.1 })
  })
  it('ui.reduceMotion 合法通过', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { ui: { reduceMotion: true } }
      })
    ).toBe(true)
  })
  it('security 域非对象被拒绝', () => {
    rejectDomain('security', 'x' as never)
  })
  it('anomaly.windows 只带 turns（days in 假分支）通过', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { memory: { dmae: { anomaly: { windows: { R10: { turns: 100 } } } } } }
      })
    ).toBe(true)
  })
  it('anomaly.windows 只带 days（turns in 假分支）通过', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { memory: { dmae: { anomaly: { windows: { R10: { days: 5 } } } } } }
      })
    ).toBe(true)
  })
  it('memory:list-l2 非对象被拒绝', () => {
    expect(validateIpcPayload('companion:memory:list-l2', 'x')).toBe(false)
  })
  it('memory:get-detail memoryId 非字符串被拒绝', () => {
    expect(validateIpcPayload('companion:memory:get-detail', { memoryId: 123 })).toBe(false)
  })
  it('memory:set-pinned 非对象被拒绝', () => {
    expect(validateIpcPayload('companion:memory:set-pinned', 'x')).toBe(false)
  })
  it('memory:soft-delete 非对象被拒绝', () => {
    expect(validateIpcPayload('companion:memory:soft-delete', 'x')).toBe(false)
  })
  it('memory:restore 非对象被拒绝', () => {
    expect(validateIpcPayload('companion:memory:restore', 'x')).toBe(false)
  })
  it('memory:get-dmae-history 非对象被拒绝', () => {
    expect(validateIpcPayload('companion:memory:get-dmae-history', 'x')).toBe(false)
  })
  it('growth:get-timeline 非对象被拒绝', () => {
    expect(validateIpcPayload('companion:growth:get-timeline', 'x')).toBe(false)
  })
  it('growth:get-trend 非对象被拒绝', () => {
    expect(validateIpcPayload('companion:growth:get-trend', 'x')).toBe(false)
  })
  it('dmae:get-trend 非对象被拒绝', () => {
    expect(validateIpcPayload('companion:dmae:get-trend', 'x')).toBe(false)
  })
  it('dmae:explain 非对象被拒绝', () => {
    expect(validateIpcPayload('companion:dmae:explain', 'x')).toBe(false)
  })
  it('dmae:run-benchmark 非对象被拒绝', () => {
    expect(validateIpcPayload('companion:dmae:run-benchmark', 'x')).toBe(false)
  })
  it('dmae:record-qualitative 非对象被拒绝', () => {
    expect(validateIpcPayload('companion:dmae:record-qualitative', 'x')).toBe(false)
  })
})

describe('P2-45 hasOnlyKeys 多余键 + 值域边界定向补测（100% branch）', () => {
  it('chat:retry 多余字段被拒绝（hasOnlyKeys 假分支）', () => {
    expect(
      validateIpcPayload('companion:chat:retry', { sessionId: 's1', messageId: 'm1', extra: 1 })
    ).toBe(false)
  })
  it('window.days=0 / turns=0 被拒绝（值域假分支）', () => {
    rejectDomain('memory', { dmae: { anomaly: { windows: { R10: { days: 0 } } } } })
    rejectDomain('memory', { dmae: { anomaly: { windows: { R10: { turns: 0 } } } } })
  })
  it('memory:get-detail 多余字段被拒绝', () => {
    expect(
      validateIpcPayload('companion:memory:get-detail', { memoryId: 'l2_1_a', extra: 1 })
    ).toBe(false)
  })
  it('memory:set-pinned 多余字段被拒绝', () => {
    expect(
      validateIpcPayload('companion:memory:set-pinned', {
        memoryId: 'l2_1_a',
        pinned: true,
        extra: 1
      })
    ).toBe(false)
  })
  it('memory:soft-delete 多余字段被拒绝', () => {
    expect(
      validateIpcPayload('companion:memory:soft-delete', {
        memoryId: 'l2_1_a',
        confirm: true,
        extra: 1
      })
    ).toBe(false)
  })
  it('memory:restore 多余字段被拒绝', () => {
    expect(validateIpcPayload('companion:memory:restore', { memoryId: 'l2_1_a', extra: 1 })).toBe(
      false
    )
  })
  it('memory:get-dmae-history 多余字段被拒绝', () => {
    expect(
      validateIpcPayload('companion:memory:get-dmae-history', {
        memoryId: 'l2_1_a',
        days: 7,
        extra: 1
      })
    ).toBe(false)
  })
  it('growth:get-timeline 多余字段被拒绝', () => {
    expect(validateIpcPayload('companion:growth:get-timeline', { limit: 10, extra: 1 })).toBe(false)
  })
  it('growth:get-trend 多余字段被拒绝', () => {
    expect(
      validateIpcPayload('companion:growth:get-trend', {
        metric: 'understanding',
        days: 7,
        extra: 1
      })
    ).toBe(false)
  })
  it('dmae:get-trend 多余字段被拒绝', () => {
    expect(validateIpcPayload('companion:dmae:get-trend', { days: 7, extra: 1 })).toBe(false)
  })
  it('dmae:explain 多余字段被拒绝', () => {
    expect(validateIpcPayload('companion:dmae:explain', { memoryId: 'l2_1_a', extra: 1 })).toBe(
      false
    )
  })
  it('dmae:run-benchmark 多余字段被拒绝', () => {
    expect(validateIpcPayload('companion:dmae:run-benchmark', { windowDays: 7, extra: 1 })).toBe(
      false
    )
  })
  it('dmae:record-qualitative 多余字段被拒绝', () => {
    expect(
      validateIpcPayload('companion:dmae:record-qualitative', {
        q1: 1,
        q2: 1,
        q3: 1,
        note: 'x',
        extra: 1
      })
    ).toBe(false)
  })
  it('dmae:record-qualitative 无 note 通过（note in 假分支）', () => {
    expect(validateIpcPayload('companion:dmae:record-qualitative', { q1: 1, q2: 1, q3: 1 })).toBe(
      true
    )
  })
  it('anomaly.windows R10 值为非对象被拒绝（isWindowPatch 非对象分支）', () => {
    rejectDomain('memory', { dmae: { anomaly: { windows: { R10: 'x' } } } })
  })
  it('memory:get-detail 非对象被拒绝（isPlainObject 分支）', () => {
    expect(validateIpcPayload('companion:memory:get-detail', 'x')).toBe(false)
  })
})
