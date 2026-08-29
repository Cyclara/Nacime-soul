// src/main/config/persona.test.ts
// F5-001 C0 验收测试：persona 配置域（CFG-PER-01..12、15、16；13/14 属 C1 集成）
// 依据：S-005-补充 §3.2 测试矩阵 + 开工裁定 §2 C0 验收 5 项

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as v from 'valibot'
import { CONFIG_DOMAINS } from '@shared/config/types'
import type { AppConfigV1, ConfigChangedEvent, PersonaConfig } from '@shared/config/types'
import { DEFAULT_CONFIG_V1 } from './defaults'
import { AppConfigSchema, PersonaConfigSchema } from './schema'
import { createConfigStore } from './store'
import { validateIpcPayload } from '../ipc/validators'

// === 工具 ===

function makePersona(): PersonaConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG_V1.persona)) as PersonaConfig
}

function parsePersona(value: unknown): boolean {
  return v.safeParse(PersonaConfigSchema, value).success
}

/** 改 persona.gate 的一个字段后整体 parse（用于边界矩阵） */
function parseWithGatePatch(patch: Record<string, unknown>): boolean {
  const persona = makePersona()
  Object.assign(persona.compliance.gate, patch)
  return parsePersona(persona)
}

function parseWithAuditPatch(patch: Record<string, unknown>): boolean {
  const persona = makePersona()
  Object.assign(persona.compliance.audit, patch)
  return parsePersona(persona)
}

/** 递归检查深冻结 */
function assertDeepFrozen(value: unknown): void {
  expect(Object.isFrozen(value)).toBe(true)
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) {
      assertDeepFrozen(item)
    }
  }
}

// === CFG-PER-16 + 开工裁定 §2：六域单真源 ===

describe('CFG-PER-16 / 开工裁定 §2：CONFIG_DOMAINS 六域单真源', () => {
  it('CONFIG_DOMAINS 恰为六项且含 persona', () => {
    expect([...CONFIG_DOMAINS]).toEqual(['model', 'tts', 'memory', 'ui', 'security', 'persona'])
  })
})

// === CFG-PER-01：默认配置根校验 ===

describe('CFG-PER-01：DEFAULT_CONFIG_V1 persona 全字段存在并通过 schema；深冻结', () => {
  it('默认配置整体通过根 schema', () => {
    const result = v.safeParse(AppConfigSchema, DEFAULT_CONFIG_V1)
    expect(result.success).toBe(true)
  })

  it('persona 默认值精确等于冻结合同（开工裁定 1.2/1.8）', () => {
    expect(DEFAULT_CONFIG_V1.persona).toEqual({
      compliance: {
        gate: {
          enabled: true, // 裁定 1.8：默认 true + observe
          scope: 'observe',
          firstSegmentMinChars: 32,
          segmentMaxChars: 512,
          budgetMs: 30,
          maxRegenerations: 1,
          maxHoldMs: 400 // 裁定 1.2
        },
        audit: {
          enabled: true,
          sampleRate: 0.25,
          timeoutMs: 20_000,
          recentTurnWindow: 3
        },
        disabledRuleIds: [],
        debugCaptureText: false
      }
    })
  })

  it('DEFAULT_CONFIG_V1 深冻结（含 persona 子树）', () => {
    assertDeepFrozen(DEFAULT_CONFIG_V1)
  })
})

// === CFG-PER-02：老 v1 无 persona → setup healing ===

describe('CFG-PER-02：老 v1 完整五域但无 persona → setup 自动补 persona', () => {
  let tmpDir: string
  let configPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nacime-persona-test-'))
    configPath = path.join(tmpDir, 'config.json')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('setup 成功；内存配置补全 persona；schemaVersion 仍为 1', () => {
    // 构造老 v1：完整五域、无 persona
    const legacy = JSON.parse(JSON.stringify(DEFAULT_CONFIG_V1)) as Record<string, unknown>
    delete legacy.persona
    fs.writeFileSync(configPath, JSON.stringify(legacy), 'utf8')

    const store = createConfigStore({ configPath })
    const diag = store.setup()
    expect(diag.status).toBe('ok')

    const config = store.get()
    expect(config.schemaVersion).toBe(1)
    expect(config.persona).toEqual(DEFAULT_CONFIG_V1.persona)
  })
})

// === CFG-PER-03：maxRegenerations 枚举 ===

describe('CFG-PER-03：maxRegenerations 只接受 0/1', () => {
  it('0 / 1 接受', () => {
    expect(parseWithGatePatch({ maxRegenerations: 0 })).toBe(true)
    expect(parseWithGatePatch({ maxRegenerations: 1 })).toBe(true)
  })

  it('2 / -1 / 1.5 拒绝', () => {
    expect(parseWithGatePatch({ maxRegenerations: 2 })).toBe(false)
    expect(parseWithGatePatch({ maxRegenerations: -1 })).toBe(false)
    expect(parseWithGatePatch({ maxRegenerations: 1.5 })).toBe(false)
  })
})

// === CFG-PER-04：scope 枚举 ===

describe('CFG-PER-04：scope 四值接受；未知值拒绝', () => {
  it('first-segment / all-segments / observe / off 接受', () => {
    for (const scope of ['first-segment', 'all-segments', 'observe', 'off']) {
      expect(parseWithGatePatch({ scope })).toBe(true)
    }
  })

  it('未知 scope 拒绝', () => {
    expect(parseWithGatePatch({ scope: 'everything' })).toBe(false)
    expect(parseWithGatePatch({ scope: '' })).toBe(false)
    expect(parseWithGatePatch({ scope: 1 })).toBe(false)
  })
})

// === CFG-PER-05：数值与交叉边界 ===

describe('CFG-PER-05：gate/audit 数值边界与交叉校验', () => {
  it.each([
    // [字段, 接受值[], 拒绝值[]]
    ['firstSegmentMinChars', [1, 32, 512], [0, 513, 1.5, NaN, Infinity]],
    ['segmentMaxChars', [64, 512, 4096], [63, 4097, 1.5, NaN]],
    ['budgetMs', [1, 30, 100], [0, 101, 1.5]],
    ['maxHoldMs', [100, 400, 2000], [99, 2001, 1.5, NaN]]
  ])('gate.%s 边界', (field, accepts, rejects) => {
    for (const value of accepts) {
      expect(parseWithGatePatch({ [field]: value })).toBe(true)
    }
    for (const value of rejects) {
      expect(parseWithGatePatch({ [field]: value })).toBe(false)
    }
  })

  it.each([
    ['sampleRate', [0, 0.25, 1], [-0.1, 1.1, NaN, Infinity]],
    ['timeoutMs', [1_000, 20_000, 120_000], [999, 120_001, 1.5]],
    ['recentTurnWindow', [1, 3, 20], [0, 21, 1.5]]
  ])('audit.%s 边界', (field, accepts, rejects) => {
    for (const value of accepts) {
      expect(parseWithAuditPatch({ [field]: value })).toBe(true)
    }
    for (const value of rejects) {
      expect(parseWithAuditPatch({ [field]: value })).toBe(false)
    }
  })

  it('firstSegmentMinChars > segmentMaxChars 拒绝（交叉校验）', () => {
    const persona = makePersona()
    persona.compliance.gate.firstSegmentMinChars = 600
    persona.compliance.gate.segmentMaxChars = 512
    expect(parsePersona(persona)).toBe(false)
  })

  it('strictObject：任层未知 key 拒绝', () => {
    const persona = makePersona() as unknown as Record<string, unknown>
    persona.unknownKey = 1
    expect(parsePersona(persona)).toBe(false)

    const persona2 = makePersona()
    ;(persona2.compliance.gate as unknown as Record<string, unknown>).extra = 1
    expect(parsePersona(persona2)).toBe(false)
  })
})

// === CFG-PER-06 / 07：disabledRuleIds ===

describe('CFG-PER-06：disabledRuleIds 形状', () => {
  it('空数组与唯一合法 ID 接受', () => {
    const persona = makePersona()
    persona.compliance.disabledRuleIds = []
    expect(parsePersona(persona)).toBe(true)
    persona.compliance.disabledRuleIds = ['R-MR-01', 'R-AP-02']
    expect(parsePersona(persona)).toBe(true)
  })

  it('重复 / 错误格式 / 257 项拒绝', () => {
    const persona = makePersona()
    persona.compliance.disabledRuleIds = ['R-MR-01', 'R-MR-01']
    expect(parsePersona(persona)).toBe(false)

    persona.compliance.disabledRuleIds = ['mr-01']
    expect(parsePersona(persona)).toBe(false)
    persona.compliance.disabledRuleIds = ['R-M1-01']
    expect(parsePersona(persona)).toBe(false)

    // 257 个唯一且格式合法的 ID：超过 maxLength(256) 上限
    const ids: string[] = []
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    outer: for (const a of letters) {
      for (let n = 0; n < 100; n++) {
        ids.push(`R-A${a}-${String(n).padStart(2, '0')}`)
        if (ids.length === 257) break outer
      }
    }
    expect(ids).toHaveLength(257)
    persona.compliance.disabledRuleIds = ids
    expect(parsePersona(persona)).toBe(false)
  })
})

describe('CFG-PER-07：未知但格式合法规则 ID 不导致启动失败', () => {
  let tmpDir: string
  let configPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nacime-persona-test-'))
    configPath = path.join(tmpDir, 'config.json')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('config 可加载且保留该 ID（compile/setup warn-ignore 属 C1）', () => {
    const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG_V1)) as AppConfigV1
    config.persona.compliance.disabledRuleIds = ['R-ZZ-99'] // 当前版本未知但格式合法
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf8')

    const store = createConfigStore({ configPath })
    const diag = store.setup()
    expect(diag.status).toBe('ok')
    expect(store.get().persona.compliance.disabledRuleIds).toEqual(['R-ZZ-99'])
  })
})

// === CFG-PER-08：IPC 深层白名单 ===

describe('CFG-PER-08：IPC persona 深层白名单', () => {
  it('合法深层局部 patch 通过', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { persona: { compliance: { gate: { enabled: false } } } }
      })
    ).toBe(true)
  })

  it('persona 层多余 key 拒绝', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { persona: { injection: {} } }
      })
    ).toBe(false)
  })

  it('compliance 层多余 key 拒绝', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { persona: { compliance: { injection: {} } } }
      })
    ).toBe(false)
  })

  it('gate 层多余 key 拒绝', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { persona: { compliance: { gate: { enabled: false, injection: 1 } } } }
      })
    ).toBe(false)
  })

  it('audit 层多余 key 拒绝', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { persona: { compliance: { audit: { sampleRate: 0.5, injection: 1 } } } }
      })
    ).toBe(false)
  })

  it('越界值拒绝（maxHoldMs 99 / maxRegenerations 2 / sampleRate 1.1）', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { persona: { compliance: { gate: { maxHoldMs: 99 } } } }
      })
    ).toBe(false)
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { persona: { compliance: { gate: { maxRegenerations: 2 } } } }
      })
    ).toBe(false)
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { persona: { compliance: { audit: { sampleRate: 1.1 } } } }
      })
    ).toBe(false)
  })

  it('disabledRuleIds 重复 / 格式错经 IPC 拒绝', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { persona: { compliance: { disabledRuleIds: ['R-MR-01', 'R-MR-01'] } } }
      })
    ).toBe(false)
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { persona: { compliance: { disabledRuleIds: ['bad'] } } }
      })
    ).toBe(false)
  })

  it('同一 patch 同时给 firstSegmentMinChars > segmentMaxChars 拒绝', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: {
          persona: { compliance: { gate: { firstSegmentMinChars: 600, segmentMaxChars: 512 } } }
        }
      })
    ).toBe(false)
  })
})

// === CFG-PER-09/10/11：store 行为 ===

describe('CFG-PER-09/10/11：ConfigStore persona 写入 / 重置 / 变更事件', () => {
  let tmpDir: string
  let configPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nacime-persona-test-'))
    configPath = path.join(tmpDir, 'config.json')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('CFG-PER-09：update 后 get() 与磁盘四处一致（store/get/disk；snapshot 见 config-handler 测试）', async () => {
    const store = createConfigStore({ configPath })
    store.setup()

    await store.update({ persona: { compliance: { gate: { enabled: false, maxHoldMs: 600 } } } })

    // 内存 get()
    const mem = store.get()
    expect(mem.persona.compliance.gate.enabled).toBe(false)
    expect(mem.persona.compliance.gate.maxHoldMs).toBe(600)
    // 未改的键保留
    expect(mem.persona.compliance.gate.scope).toBe('observe')
    expect(mem.persona.compliance.audit.sampleRate).toBe(0.25)

    // 磁盘
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8')) as AppConfigV1
    expect(onDisk.persona.compliance.gate.enabled).toBe(false)
    expect(onDisk.persona.compliance.gate.maxHoldMs).toBe(600)
    expect(onDisk.persona).toEqual(mem.persona)

    // 默认值不被污染
    expect(DEFAULT_CONFIG_V1.persona.compliance.gate.enabled).toBe(true)
  })

  it('CFG-PER-10：reset persona 只重置 persona，model/memory 不变', async () => {
    const store = createConfigStore({ configPath })
    store.setup()

    await store.update({
      model: { temperature: 1.5 },
      persona: { compliance: { gate: { enabled: false } } }
    })
    expect(store.get().persona.compliance.gate.enabled).toBe(false)

    await store.resetDomain('persona')
    const config = store.get()
    expect(config.persona).toEqual(DEFAULT_CONFIG_V1.persona)
    expect(config.model.temperature).toBe(1.5)
    expect(config.memory).toEqual(DEFAULT_CONFIG_V1.memory)
  })

  it('CFG-PER-11：只改 persona 时 ConfigChangedEvent.domain === persona', async () => {
    const store = createConfigStore({ configPath })
    store.setup()

    const events: ConfigChangedEvent[] = []
    store.subscribe((e) => events.push(e))

    await store.update({ persona: { compliance: { audit: { sampleRate: 0.5 } } } })
    expect(events).toHaveLength(1)
    expect(events[0].domain).toBe('persona')
  })

  it('等值重写（无域变化）不发事件——detectChangedDomain 无 model 兜底（开工裁定 §2.2）', async () => {
    const store = createConfigStore({ configPath })
    store.setup()

    const events: ConfigChangedEvent[] = []
    store.subscribe((e) => events.push(e))

    // 写入与当前完全相同的值：无域变化 → 不 emit（旧实现会误报 domain:'model'）
    await store.update({ persona: { compliance: { audit: { sampleRate: 0.25 } } } })
    expect(events).toHaveLength(0)
  })
})

// === CFG-PER-15：不新增 config migration ===

describe('CFG-PER-15：无 config migration，缺域靠 defaults healing', () => {
  it('schemaVersion 仍为 1（v.literal(1) 锁定，v2 由 T-12 拒绝启动路径处理）', () => {
    expect(DEFAULT_CONFIG_V1.schemaVersion).toBe(1)
    const result = v.safeParse(AppConfigSchema, {
      ...JSON.parse(JSON.stringify(DEFAULT_CONFIG_V1)),
      schemaVersion: 2
    })
    expect(result.success).toBe(false)
  })
})
