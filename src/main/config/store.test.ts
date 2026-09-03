// src/main/config/store.test.ts
// P1-07 验收测试：ConfigStore
// 依据：S-005 §3.7-§3.8、S-001 P1-07 验收标准

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ESM 命名空间不可直接 spy，用 vi.mock 让 renameSync/readFileSync 可被 mockImplementation
// 默认透传到 actual 实现，仅在特定测试中 mockImplementationOnce
vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: vi.fn(actual.renameSync),
    readFileSync: vi.fn(actual.readFileSync)
  }
})

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { createConfigStore, atomicWriteJson, deepMergeWithDefaults } from './store'
import { DEFAULT_CONFIG_V1 } from './defaults'
import type { AppConfigV1, ConfigChangedEvent } from '@shared/config/types'

let tmpDir: string
let configPath: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nacime-soul-config-'))
  configPath = path.join(tmpDir, 'config.json')
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeRaw(content: string): void {
  fs.writeFileSync(configPath, content, 'utf8')
}

function writeConfig(config: unknown): void {
  writeRaw(JSON.stringify(config, null, 2))
}

function readConfig(): AppConfigV1 {
  return JSON.parse(fs.readFileSync(configPath, 'utf8')) as AppConfigV1
}

describe('P1-07 setup - 缺失配置', () => {
  it('文件不存在 -> status=missing，healed=true，默认配置被写入', () => {
    const store = createConfigStore({ configPath })
    const diag = store.setup()
    expect(diag.status).toBe('missing')
    expect(diag.healed).toBe(true)
    expect(fs.existsSync(configPath)).toBe(true)
    expect(readConfig().model.provider).toBe('deepseek')
  })
})

describe('P1-07 setup - 合法配置', () => {
  it('合法完整配置 -> status=ok，healed=false', () => {
    writeConfig(DEFAULT_CONFIG_V1)
    const store = createConfigStore({ configPath })
    const diag = store.setup()
    expect(diag.status).toBe('ok')
    expect(diag.healed).toBe(false)
    expect(store.get().model.provider).toBe('deepseek')
  })

  it('合法配置含自定义值 -> 正确加载', () => {
    const custom = structuredClone(DEFAULT_CONFIG_V1)
    custom.model.temperature = 0.5
    custom.model.maxTokens = 8192
    writeConfig(custom)
    const store = createConfigStore({ configPath })
    store.setup()
    expect(store.get().model.temperature).toBe(0.5)
    expect(store.get().model.maxTokens).toBe(8192)
  })
})

describe('P1-07 setup - 损坏配置', () => {
  it('非法 JSON -> status=invalid，healed=true，备份 .bak', () => {
    writeRaw('{ invalid json !!!')
    const store = createConfigStore({ configPath })
    const diag = store.setup()
    expect(diag.status).toBe('invalid')
    expect(diag.healed).toBe(true)
    expect(diag.issues?.[0]?.message).toContain('JSON parse failed')
    // .bak 保存了损坏的原文
    expect(fs.existsSync(configPath + '.bak')).toBe(true)
    expect(fs.readFileSync(configPath + '.bak', 'utf8')).toBe('{ invalid json !!!')
    // config.json 被重写为默认
    expect(readConfig().model.provider).toBe('deepseek')
  })

  it('schema 校验失败 -> status=invalid，healed=true，备份 .bak', () => {
    const bad = structuredClone(DEFAULT_CONFIG_V1)
    ;(bad as { model: { temperature: number } }).model.temperature = 99
    writeConfig(bad)
    const store = createConfigStore({ configPath })
    const diag = store.setup()
    expect(diag.status).toBe('invalid')
    expect(diag.healed).toBe(true)
    expect(diag.issues?.length).toBeGreaterThan(0)
    expect(fs.existsSync(configPath + '.bak')).toBe(true)
    // config.json 被重写为默认
    expect(readConfig().model.temperature).toBe(0.8)
  })

  it('读取失败 -> status=read-error，healed=true', () => {
    writeConfig(DEFAULT_CONFIG_V1)
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied')
    })
    const store = createConfigStore({ configPath })
    const diag = store.setup()
    expect(diag.status).toBe('read-error')
    expect(diag.healed).toBe(true)
    expect(diag.issues?.[0]?.message).toContain('read failed')
  })
})

describe('P1-07 setup - 部分配置', () => {
  it('只有 model 域 -> merge 补全其他域，status=ok', () => {
    writeConfig({
      schemaVersion: 1,
      model: { ...DEFAULT_CONFIG_V1.model, temperature: 0.5 }
    })
    const store = createConfigStore({ configPath })
    const diag = store.setup()
    expect(diag.status).toBe('ok')
    expect(diag.healed).toBe(false)
    const config = store.get()
    expect(config.model.temperature).toBe(0.5)
    expect(config.tts).toEqual(DEFAULT_CONFIG_V1.tts)
    expect(config.ui).toEqual(DEFAULT_CONFIG_V1.ui)
    expect(config.memory).toEqual(DEFAULT_CONFIG_V1.memory)
    expect(config.security).toEqual(DEFAULT_CONFIG_V1.security)
  })

  it('未知顶层 key 被剔除，status=ok', () => {
    writeConfig({ ...structuredClone(DEFAULT_CONFIG_V1), unknownKey: 'evil' })
    const store = createConfigStore({ configPath })
    const diag = store.setup()
    expect(diag.status).toBe('ok')
    expect(store.get()).not.toHaveProperty('unknownKey')
  })

  it('未知嵌套 key 被剔除', () => {
    const custom = structuredClone(DEFAULT_CONFIG_V1)
    ;(custom.model as unknown as Record<string, unknown>).unknownField = 'x'
    writeConfig(custom)
    const store = createConfigStore({ configPath })
    store.setup()
    expect(store.get().model).not.toHaveProperty('unknownField')
  })

  it('null 字段用默认补全', () => {
    const custom = structuredClone(DEFAULT_CONFIG_V1)
    ;(custom as unknown as { model: null }).model = null
    writeConfig(custom)
    const store = createConfigStore({ configPath })
    const diag = store.setup()
    // model=null -> merge 用默认 model
    expect(diag.status).toBe('ok')
    expect(store.get().model.provider).toBe('deepseek')
  })
})

describe('P1-07 update - 合法更新', () => {
  it('合法 patch 合并、校验、写入、emit', async () => {
    const store = createConfigStore({ configPath })
    store.setup()
    const config = await store.update({ model: { temperature: 0.5 } })
    expect(config.model.temperature).toBe(0.5)
    // 其他字段不变
    expect(config.model.provider).toBe('deepseek')
    // 文件已写入
    expect(readConfig().model.temperature).toBe(0.5)
  })

  it('嵌套 patch 正确合并', async () => {
    const store = createConfigStore({ configPath })
    store.setup()
    await store.update({ ui: { window: { width: 1200 } } })
    expect(store.get().ui.window.width).toBe(1200)
    expect(store.get().ui.window.height).toBe(720) // 默认值保留
  })

  // 66143e6 缺陷回归（08-22 真机验收抓获）：deepMergeWithDefaults 只遍历默认对象的键，
  // 默认值缺 x/y 占位 -> 窗口位置更新被静默剔除，重启后位置丢失（宽高幸存掩盖了它）
  it('窗口位置 x/y 持久化到内存与磁盘', async () => {
    const store = createConfigStore({ configPath })
    store.setup()
    await store.update({
      ui: { window: { width: 1000, height: 700, x: 150, y: 120, maximized: false } }
    })
    expect(store.get().ui.window).toEqual({
      width: 1000,
      height: 700,
      x: 150,
      y: 120,
      maximized: false
    })
    const onDisk = readConfig().ui.window as { x?: number; y?: number }
    expect(onDisk.x).toBe(150)
    expect(onDisk.y).toBe(120)
  })

  it('config 无 x/y（首次启动）-> 读出 undefined，Electron 居中语义不变', () => {
    const store = createConfigStore({ configPath })
    store.setup()
    expect(store.get().ui.window.x).toBeUndefined()
    expect(store.get().ui.window.y).toBeUndefined()
  })

  it('P3G GC policy 默认完整落盘且不会被 deep merge 静默剔除', () => {
    const store = createConfigStore({ configPath })
    store.setup()
    expect(store.get().memory.gc).toMatchObject({
      archiveToSoftDeleteDays: { one_off: 30, situational: 60, stable: null },
      softDeleteToPurgeDays: 90,
      recentAccessGraceDays: 90,
      anchorImportanceMin: 8,
      maxPurgePerRun: 500,
      schedule: { idleMinutes: 5, minIntervalHours: 20, eagerCountThreshold: 5000 }
    })
  })

  it('onboarding 可选 completedAt/voiceSendMode 占位键会跨重启保留，不被 deep merge 静默剔除', async () => {
    const store = createConfigStore({ configPath })
    store.setup()
    await store.update({
      ui: { onboarding: { stage: 'complete', completedAt: 123, voiceSendMode: 'draft' } }
    })
    expect(store.get().ui.onboarding).toEqual({
      version: 1,
      stage: 'complete',
      completedAt: 123,
      voiceSendMode: 'draft'
    })

    const restarted = createConfigStore({ configPath })
    restarted.setup()
    expect(restarted.get().ui.onboarding).toEqual(store.get().ui.onboarding)
  })

  it('P3V-09 主/备引擎键跨重启保留；清除备用必须写空串（null 会被 merge 顶回）', async () => {
    const store = createConfigStore({ configPath })
    store.setup()
    // 旧配置只有 asrEngineId（迁移起点）：主键 undefined，由兼容键兜底
    expect(store.get().voice.asrPrimaryEngineId).toBeUndefined()
    expect(store.get().voice.asrEngineId).toBe('sherpa-sensevoice')

    // 选主 + 设备（接线处双写 asrEngineId / 空串语义清除备用）
    await store.update({
      voice: {
        asrPrimaryEngineId: 'zipformer-bilingual-zh-en',
        asrEngineId: 'zipformer-bilingual-zh-en',
        asrFallbackEngineId: 'sherpa-sensevoice'
      }
    })
    expect(store.get().voice).toEqual({
      asrEngineId: 'zipformer-bilingual-zh-en',
      asrPrimaryEngineId: 'zipformer-bilingual-zh-en',
      asrFallbackEngineId: 'sherpa-sensevoice'
    })
    const onDisk = readConfig().voice
    expect(onDisk.asrPrimaryEngineId).toBe('zipformer-bilingual-zh-en')
    expect(onDisk.asrFallbackEngineId).toBe('sherpa-sensevoice')

    // 清除备用：空串能落盘；null 会被 deepMerge 顶回旧值（这一课写进类型注释）
    await store.update({ voice: { asrFallbackEngineId: '' } })
    expect(store.get().voice.asrFallbackEngineId).toBe('')
    expect(readConfig().voice.asrFallbackEngineId).toBe('')

    // 跨重启：主键与「无备用」状态都保留
    const restarted = createConfigStore({ configPath })
    restarted.setup()
    expect(restarted.get().voice.asrPrimaryEngineId).toBe('zipformer-bilingual-zh-en')
    expect(restarted.get().voice.asrFallbackEngineId).toBe('')
  })
})

describe('P1-07 update - 非法更新', () => {
  it('非法 patch 抛 CFG_INVALID，旧配置不变', async () => {
    const store = createConfigStore({ configPath })
    store.setup()
    await expect(store.update({ model: { temperature: 99 } })).rejects.toThrow()
    expect(store.get().model.temperature).toBe(DEFAULT_CONFIG_V1.model.temperature)
    expect(readConfig().model.temperature).toBe(DEFAULT_CONFIG_V1.model.temperature)
  })

  it('非法 URL patch 被拒绝', async () => {
    const store = createConfigStore({ configPath })
    store.setup()
    await expect(store.update({ model: { baseUrl: 'not-a-url' } })).rejects.toThrow()
    expect(store.get().model.baseUrl).toBe(DEFAULT_CONFIG_V1.model.baseUrl)
  })
})

describe('P1-07 原子写 - 写入中断不损坏旧文件', () => {
  it('残留的 tmp 文件不影响原子写', async () => {
    const store = createConfigStore({ configPath })
    store.setup()
    await store.update({ model: { temperature: 0.3 } })

    // 模拟上次写入中断留下的 tmp 文件
    writeRaw('garbage from interrupted write')
    fs.writeFileSync(configPath + '.tmp', 'garbage tmp', 'utf8')

    await store.update({ model: { temperature: 0.6 } })

    // config.json 正确（未被 tmp 污染）
    expect(readConfig().model.temperature).toBe(0.6)
    // tmp 被清理
    expect(fs.existsSync(configPath + '.tmp')).toBe(false)
  })

  it('rename 失败时旧文件不损坏', async () => {
    const store = createConfigStore({ configPath })
    store.setup()
    await store.update({ model: { temperature: 0.3 } })

    // mock renameSync 失败（模拟写入中断）
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw new Error('EBUSY: resource busy')
    })
    await expect(store.update({ model: { temperature: 0.9 } })).rejects.toThrow()

    // config.json 仍是 0.3（旧文件未损坏）
    expect(readConfig().model.temperature).toBe(0.3)
    // 内存配置也仍是 0.3
    expect(store.get().model.temperature).toBe(0.3)
  })

  it('.bak 备份保存上一个版本', async () => {
    const store = createConfigStore({ configPath })
    store.setup()
    await store.update({ model: { temperature: 0.3 } })

    await store.update({ model: { temperature: 0.7 } })

    // .bak 是上一个版本（0.3）
    const bak = JSON.parse(fs.readFileSync(configPath + '.bak', 'utf8')) as AppConfigV1
    expect(bak.model.temperature).toBe(0.3)
  })
})

describe('P1-07 防抖', () => {
  it('多次 throttled update 合并为一次写入', async () => {
    const store = createConfigStore({ configPath })
    store.setup()

    const p1 = store.update({ model: { temperature: 0.1 } }, { immediate: false })
    const p2 = store.update({ model: { temperature: 0.2 } }, { immediate: false })
    const p3 = store.update({ model: { temperature: 0.3 } }, { immediate: false })

    const [r1, r2, r3] = await Promise.all([p1, p2, p3])

    // 三次都 resolve 到最终值
    expect(r1.model.temperature).toBe(0.3)
    expect(r2.model.temperature).toBe(0.3)
    expect(r3.model.temperature).toBe(0.3)
    expect(store.get().model.temperature).toBe(0.3)
    expect(readConfig().model.temperature).toBe(0.3)
  })

  it('immediate update 取消防抖并合并 pending patch', async () => {
    const store = createConfigStore({ configPath })
    store.setup()

    // 防抖 update（不立即执行）
    const p1 = store.update({ model: { temperature: 0.1 } }, { immediate: false })
    // immediate update 立即执行，合并防抖 patch
    const p2 = store.update({ model: { maxTokens: 4096 } })

    const [r1, r2] = await Promise.all([p1, p2])

    // 两个 Promise 都 resolve 到合并后的配置
    expect(r1.model.temperature).toBe(0.1)
    expect(r1.model.maxTokens).toBe(4096)
    expect(r2.model.temperature).toBe(0.1)
    expect(r2.model.maxTokens).toBe(4096)
  })
})

describe('P1-07 mutex 串行化', () => {
  it('并发 update 按顺序串行执行', async () => {
    const store = createConfigStore({ configPath })
    store.setup()

    const order: number[] = []
    const p1 = store.update({ model: { temperature: 0.1 } }).then(() => {
      order.push(1)
    })
    const p2 = store.update({ model: { temperature: 0.2 } }).then(() => {
      order.push(2)
    })
    const p3 = store.update({ model: { temperature: 0.3 } }).then(() => {
      order.push(3)
    })

    await Promise.all([p1, p2, p3])

    expect(order).toEqual([1, 2, 3])
    expect(store.get().model.temperature).toBe(0.3)
  })
})

describe('P1-07 resetDomain', () => {
  it('重置 model 域为默认值', async () => {
    const store = createConfigStore({ configPath })
    store.setup()
    await store.update({ model: { temperature: 0.5, maxTokens: 4096 } })
    expect(store.get().model.temperature).toBe(0.5)

    await store.resetDomain('model')
    expect(store.get().model.temperature).toBe(DEFAULT_CONFIG_V1.model.temperature)
    expect(store.get().model.maxTokens).toBe(DEFAULT_CONFIG_V1.model.maxTokens)
    expect(readConfig().model.temperature).toBe(DEFAULT_CONFIG_V1.model.temperature)
  })

  it('重置 ui 域不影响 model 域', async () => {
    const store = createConfigStore({ configPath })
    store.setup()
    await store.update({
      model: { temperature: 0.5 },
      ui: { fontScale: 1.2 }
    })

    await store.resetDomain('ui')
    expect(store.get().ui.fontScale).toBe(DEFAULT_CONFIG_V1.ui.fontScale)
    expect(store.get().model.temperature).toBe(0.5) // model 不受影响
  })
})

describe('P1-07 subscribe', () => {
  it('监听变更事件', async () => {
    const store = createConfigStore({ configPath })
    store.setup()

    const events: ConfigChangedEvent[] = []
    const unsub = store.subscribe((e) => events.push(e))

    await store.update({ model: { temperature: 0.5 } })
    expect(events).toHaveLength(1)
    expect(events[0].domain).toBe('model')
    expect(events[0].config.model.temperature).toBe(0.5)

    unsub()
    await store.update({ model: { temperature: 0.7 } })
    expect(events).toHaveLength(1) // 退订后不再收到
  })

  it('listener 抛错不影响其他 listener 和写入', async () => {
    const store = createConfigStore({ configPath })
    store.setup()

    const events: ConfigChangedEvent[] = []
    store.subscribe(() => {
      throw new Error('listener error')
    })
    store.subscribe((e) => events.push(e))

    await store.update({ model: { temperature: 0.5 } })
    expect(events).toHaveLength(1) // 第二个 listener 仍收到
    expect(readConfig().model.temperature).toBe(0.5) // 写入成功
  })
})

describe('P1-07 deepMergeWithDefaults', () => {
  it('未知 key 剔除', () => {
    const merged = deepMergeWithDefaults(DEFAULT_CONFIG_V1, {
      unknownKey: 'evil'
    })
    expect(merged).not.toHaveProperty('unknownKey')
  })

  it('undefined 用默认', () => {
    const merged = deepMergeWithDefaults(DEFAULT_CONFIG_V1, {
      model: undefined
    })
    expect(merged.model).toEqual(DEFAULT_CONFIG_V1.model)
  })

  it('数组整体替换', () => {
    const defaults = { items: [1, 2, 3], name: 'default' }
    const merged = deepMergeWithDefaults(defaults, { items: [9] })
    expect(merged.items).toEqual([9])
  })
})

describe('P1-07 atomicWriteJson', () => {
  it('写入后 tmp 文件被清理', () => {
    atomicWriteJson(configPath, { hello: 'world' })
    expect(fs.existsSync(configPath + '.tmp')).toBe(false)
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({
      hello: 'world'
    })
  })

  it('覆盖已有文件', () => {
    atomicWriteJson(configPath, { v: 1 })
    atomicWriteJson(configPath, { v: 2 })
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({ v: 2 })
  })
})

// === P2-31.5A：DMAE 配置升级/重启/数组语义回归（S-005-补充 §3.3）===

describe('P2-31.5A CFG-DMAE: 升级/重启/数组语义', () => {
  // CFG-DMAE-02：旧 v1 config 只有原 9 个 dmae 字段 -> setup 自动补四字段；schemaVersion 仍为 1
  it('CFG-DMAE-02: 旧 v1 config（9 字段 dmae）自动补四字段，schemaVersion 仍为 1', () => {
    // 构造只有旧 9 字段的 dmae 配置
    const oldConfig = {
      ...DEFAULT_CONFIG_V1,
      memory: {
        ...DEFAULT_CONFIG_V1.memory,
        dmae: {
          enabled: true,
          maxScore: 100,
          promptThreshold: 30,
          userRewardBase: 20,
          wakeGamma: 0.5,
          modelRewardBase: 8,
          wakeLambda: 0.3,
          decayAlpha: 1.5,
          decayBeta: 0.3
        }
      }
    }
    writeConfig(oldConfig)
    const store = createConfigStore({ configPath })
    const diag = store.setup()
    expect(diag.status).toBe('ok')
    // 运行时自动补齐四字段（deepMergeWithDefaults 在内存中补齐，setup 不写回磁盘）
    const dmae = store.get().memory.dmae
    expect(dmae.presets).toEqual([])
    expect(dmae.historySampleEveryTurns).toBe(1)
    expect(Object.keys(dmae.anomaly.muted)).toHaveLength(13)
    expect(Object.keys(dmae.anomaly.windows)).toHaveLength(13)
    // schemaVersion 仍为 1（不写 config 迁移）
    expect(store.get().schemaVersion).toBe(1)
  })

  // CFG-DMAE-03：muted.R07=未来时间戳后保存并重启 -> R07 保留，其他 12 项为 0
  it('CFG-DMAE-03: muted.R07=未来时间戳 -> 保存重启后 R07 保留，其余 12 项为 0', async () => {
    writeConfig(DEFAULT_CONFIG_V1)
    const store = createConfigStore({ configPath })
    store.setup()
    const futureTs = Date.now() + 7 * 24 * 60 * 60 * 1000
    await store.update({
      memory: {
        dmae: {
          anomaly: {
            muted: { R07: futureTs } as unknown as Record<string, number>
          }
        }
      }
    })
    // 重启：新 store 实例
    const store2 = createConfigStore({ configPath })
    store2.setup()
    const muted = store2.get().memory.dmae.anomaly.muted
    expect(muted.R07).toBe(futureTs)
    // 其余 12 项仍为 0
    for (const [key, value] of Object.entries(muted)) {
      if (key !== 'R07') expect(value).toBe(0)
    }
  })

  // CFG-DMAE-04：windows.R10.days 局部改为 5 -> 保存/重启后 days=5 且 turns=100 未丢
  it('CFG-DMAE-04: windows.R10.days=5 -> 保存重启后 days=5 且 turns=100 未丢', async () => {
    writeConfig(DEFAULT_CONFIG_V1)
    const store = createConfigStore({ configPath })
    store.setup()
    await store.update({
      memory: {
        dmae: {
          anomaly: {
            windows: {
              R10: { days: 5 }
            } as unknown as Record<string, { days?: number; turns?: number }>
          }
        }
      }
    })
    // 重启
    const store2 = createConfigStore({ configPath })
    store2.setup()
    const w = store2.get().memory.dmae.anomaly.windows
    expect(w.R10.days).toBe(5)
    expect(w.R10.turns).toBe(100) // 默认值未丢
  })

  // CFG-DMAE-12：参数真实变化时已有 muted 值 -> 13 个 muted 全清 0；
  //   只改 windows/采样频率时不清
  //   注意：S-005-补充 §1.9 第 4 条说"任一 DMAE 可调参数真实变化后，main 比较旧值/新值
  //   并把 13 个 muted 全部清零"。此行为在 P2-31.5A 阶段尚未实现（属于 P2-33 的 mute-anomaly
  //   handler 职责）。这里先测试当前可验证的部分：windows 改动不清 muted。
  it('CFG-DMAE-04b: 只改 windows 不清 muted（muted 值保留）', async () => {
    writeConfig(DEFAULT_CONFIG_V1)
    const store = createConfigStore({ configPath })
    store.setup()
    const futureTs = Date.now() + 7 * 24 * 60 * 60 * 1000
    // 先设 muted.R03
    await store.update({
      memory: {
        dmae: {
          anomaly: {
            muted: { R03: futureTs } as unknown as Record<string, number>
          }
        }
      }
    })
    // 改 windows.R01.days
    await store.update({
      memory: {
        dmae: {
          anomaly: {
            windows: {
              R01: { days: 5 }
            } as unknown as Record<string, { days?: number; turns?: number }>
          }
        }
      }
    })
    const muted = store.get().memory.dmae.anomaly.muted
    expect(muted.R03).toBe(futureTs) // windows 改动不清 muted
  })
})

describe('M-15/M-16 setup 健壮性', () => {
  it('M-15：schemaVersion 超前 -> setup 抛 CFG_MIGRATE_FAIL 且原文件不被覆盖', () => {
    // 模拟"数据由更高版本应用写入"：schemaVersion=2 > 当前支持 1
    writeConfig({ schemaVersion: 2, model: { provider: 'future-model' } })
    const store = createConfigStore({ configPath })

    expect(() => store.setup()).toThrowError(/CFG_MIGRATE_FAIL|高于当前应用支持/)

    // 原文件保留（仍是 v2，未被静默重置为默认）
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { schemaVersion: number }
    expect(raw.schemaVersion).toBe(2)
  })

  it('M-16：healing 自愈写失败不抛错，返回 healed 状态', () => {
    // read-error 路径：readFileSync 抛错；heal 写（renameSync）抛错
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
      throw new Error('disk locked')
    })
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw new Error('rename failed')
    })
    writeRaw('placeholder')

    const store = createConfigStore({ configPath })
    // 旧实现这里会抛错 -> 启动链无窗口；现在返回 healed 状态
    const diag = store.setup()
    expect(diag.status).toBe('read-error')
    expect(diag.healed).toBe(true)
  })
})
