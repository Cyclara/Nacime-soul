// src/main/memory/dmae/state-file.test.ts
// P2-24 / D-04：DMAE 持久化--load/save 往返、损坏阻断启动、孤儿清理。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { createDmaeStateStore, reconcileStates } from './state-file'
import { createInitialEntryState, type DmaeEntryState } from './engine'
import { AppError } from '@shared/errors'
import type { Logger } from '@shared/observability/types'

/** 断言 load() 抛 MEM_DB_CORRUPT fatal，返回错误对象供进一步断言 */
function expectCorruptThrow(fn: () => unknown): AppError {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(AppError)
    const err = e as AppError
    expect(err.code).toBe('MEM_DB_CORRUPT')
    expect(err.severity).toBe('fatal')
    return err
  }
  throw new Error('expected load() to throw MEM_DB_CORRUPT, but it did not throw')
}

function makeLogger(): Logger & { warns: Array<{ msg: string; fields: Record<string, unknown> }> } {
  const warns: Array<{ msg: string; fields: Record<string, unknown> }> = []
  const logger = {
    child: () => logger,
    debug: () => {},
    info: () => {},
    warn: (msg: string, fields?: Record<string, unknown>) =>
      warns.push({ msg, fields: fields ?? {} }),
    error: () => {}
  } as unknown as Logger & { warns: typeof warns }
  logger.warns = warns
  return logger
}

let tmpDir: string
let filePath: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmae-state-'))
  filePath = path.join(tmpDir, 'dmae-state.json')
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function makeStates(entries: Array<[string, number, number, number]>): Map<string, DmaeEntryState> {
  const m = new Map<string, DmaeEntryState>()
  for (const [id, a, us, ms] of entries) {
    m.set(id, { activation: a, userSilence: us, modelSilence: ms, everActivated: a > 0 })
  }
  return m
}

describe('DmaeStateStore load/save 往返', () => {
  it('save -> load 往返一致', () => {
    const store = createDmaeStateStore({ filePath, logger: makeLogger() })
    const original = makeStates([
      ['m1', 50, 3, 2],
      ['m2', 0, 10, 10],
      ['m3', 100, 0, 0]
    ])
    store.save(original, 0)
    const loaded = store.load().states
    expect(loaded.size).toBe(3)
    expect(loaded.get('m1')).toEqual({
      activation: 50,
      userSilence: 3,
      modelSilence: 2,
      everActivated: true
    })
    expect(loaded.get('m2')).toEqual({
      activation: 0,
      userSilence: 10,
      modelSilence: 10,
      everActivated: false
    })
    expect(loaded.get('m3')).toEqual({
      activation: 100,
      userSilence: 0,
      modelSilence: 0,
      everActivated: true
    })
  })

  it('重启后 activation 延续（D-04 核心验收）', () => {
    const store = createDmaeStateStore({ filePath, logger: makeLogger() })
    // 模拟第 1 次运行：保存 activation=75
    store.save(makeStates([['m1', 75, 5, 3]]), 7)
    // 模拟重启：新 store 实例 load
    const store2 = createDmaeStateStore({ filePath, logger: makeLogger() })
    const loaded = store2.load().states
    expect(loaded.get('m1')!.activation).toBe(75)
    expect(loaded.get('m1')!.userSilence).toBe(5)
    expect(loaded.get('m1')!.modelSilence).toBe(3)
  })

  it('save 空 Map 也能 load', () => {
    const store = createDmaeStateStore({ filePath, logger: makeLogger() })
    store.save(new Map(), 0)
    const loaded = store.load().states
    expect(loaded.size).toBe(0)
  })

  it('P0: turn 与 states 同快照往返（重启延续的核心）', () => {
    const store = createDmaeStateStore({ filePath, logger: makeLogger() })
    store.save(makeStates([['m1', 42, 0, 0]]), 7)
    const loaded = store.load()
    expect(loaded.turn).toBe(7)
    expect(loaded.states.get('m1')!.activation).toBe(42)

    // 再存一个更大的 turn，模拟多轮递增
    store.save(makeStates([['m1', 30, 1, 1]]), 9)
    const loaded2 = store.load()
    expect(loaded2.turn).toBe(9)
  })

  it('P0: 非法 turn（缺失/负数/非整数）回退 0，不污染加载', () => {
    // 缺失 turn（防御旧文件）
    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 4, entries: {} }))
    expect(createDmaeStateStore({ filePath, logger: makeLogger() }).load().turn).toBe(0)

    // 负 turn
    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 4, turn: -5, entries: {} }))
    expect(createDmaeStateStore({ filePath, logger: makeLogger() }).load().turn).toBe(0)

    // 非整数
    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 4, turn: 1.5, entries: {} }))
    expect(createDmaeStateStore({ filePath, logger: makeLogger() }).load().turn).toBe(0)
  })
})

describe('DmaeStateStore 文件缺失 = 首次启动', () => {
  it('文件不存在 -> load 返回空 Map（不 warn）', () => {
    const logger = makeLogger()
    const store = createDmaeStateStore({ filePath, logger })
    const loaded = store.load().states
    expect(loaded.size).toBe(0)
    expect(logger.warns).toHaveLength(0)
  })
})

describe('DmaeStateStore 损坏 = 阻断启动（C-α-2：不许静默清空）', () => {
  it('无效 JSON -> 抛 MEM_DB_CORRUPT fatal，坏文件不被覆盖', () => {
    const corruptContent = '{ not valid json }}}'
    fs.writeFileSync(filePath, corruptContent)
    const store = createDmaeStateStore({ filePath, logger: makeLogger() })
    expectCorruptThrow(() => store.load())
    // 坏文件必须留着给用户恢复，不许就地重写
    expect(fs.readFileSync(filePath, 'utf8')).toBe(corruptContent)
  })

  it('schemaVersion 不符 -> 抛 MEM_DB_CORRUPT fatal', () => {
    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 99, entries: {} }))
    const store = createDmaeStateStore({ filePath, logger: makeLogger() })
    const err = expectCorruptThrow(() => store.load())
    expect(err.userMessage).toMatch(/版本不匹配/)
  })

  it('schemaVersion 是字符串 -> 抛 MEM_DB_CORRUPT（bad-version）', () => {
    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: '1', entries: {} }))
    const store = createDmaeStateStore({ filePath, logger: makeLogger() })
    expectCorruptThrow(() => store.load())
  })

  it('entries 缺失 -> 抛 MEM_DB_CORRUPT fatal', () => {
    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 4 }))
    const store = createDmaeStateStore({ filePath, logger: makeLogger() })
    const err = expectCorruptThrow(() => store.load())
    expect(err.userMessage).toMatch(/结构损坏/)
  })

  it('单条 entry 损坏 -> 跳过该条，保留合法条目（字段级清理不阻断）', () => {
    const data = {
      schemaVersion: 4,
      entries: {
        m1: { activation: 50, userSilence: 3, modelSilence: 2, everActivated: true }, // 合法
        m2: { activation: 'bad', userSilence: 3, modelSilence: 2, everActivated: false }, // activation 非数字
        m3: { activation: 50, everActivated: true }, // 缺 userSilence/modelSilence
        m4: { activation: 50, userSilence: 3, modelSilence: 2, everActivated: true } // 合法
      }
    }
    fs.writeFileSync(filePath, JSON.stringify(data))
    const store = createDmaeStateStore({ filePath, logger: makeLogger() })
    const loaded = store.load().states
    expect(loaded.size).toBe(2)
    expect(loaded.has('m1')).toBe(true)
    expect(loaded.has('m4')).toBe(true)
    expect(loaded.has('m2')).toBe(false)
    expect(loaded.has('m3')).toBe(false)
  })

  it('NaN/Infinity activation 被拒绝（字段级清理）', () => {
    const data = {
      schemaVersion: 4,
      entries: {
        m1: { activation: NaN, userSilence: 3, modelSilence: 2, everActivated: false },
        m2: { activation: Infinity, userSilence: 3, modelSilence: 2, everActivated: false }
      }
    }
    fs.writeFileSync(filePath, JSON.stringify(data))
    const store = createDmaeStateStore({ filePath, logger: makeLogger() })
    const loaded = store.load().states
    expect(loaded.size).toBe(0)
  })
})

describe('reconcileStates 孤儿清理 + 新增初始化', () => {
  const THRESHOLD = 30
  const e = (id: string, importance = 5): { id: string; importance: number } => ({
    id,
    importance
  })

  it('孤儿清理：stateFile 有但 L2 已删 -> 删', () => {
    const states = makeStates([
      ['m1', 50, 0, 0],
      ['m2', 30, 0, 0],
      ['m3', 0, 0, 0] // 孤儿
    ])
    const res = reconcileStates(states, [e('m1'), e('m2')], THRESHOLD)
    expect(res.removed).toBe(1)
    expect(res.added).toBe(0)
    expect(states.size).toBe(2)
    expect(states.has('m1')).toBe(true)
    expect(states.has('m2')).toBe(true)
    expect(states.has('m3')).toBe(false)
  })

  it('新增初始化：M-46 importance 比例初始激活（5 -> 10，Dormant 缓冲带）', () => {
    const states = makeStates([['m1', 50, 0, 0]])
    const res = reconcileStates(states, [e('m1'), e('m2_new')], THRESHOLD)
    expect(res.removed).toBe(0)
    expect(res.added).toBe(1)
    expect(states.get('m2_new')).toEqual(createInitialEntryState(5, THRESHOLD))
    expect(states.get('m2_new')!.activation).toBe(10)
    expect(states.get('m2_new')!.everActivated).toBe(true)
  })

  it('混合：删 + 加 + 保留', () => {
    const states = makeStates([
      ['m1', 50, 1, 1], // 保留
      ['m2', 30, 2, 2], // 保留
      ['orphan', 10, 0, 0] // 删
    ])
    const res = reconcileStates(states, [e('m1'), e('m2'), e('m3_new')], THRESHOLD)
    expect(res.removed).toBe(1)
    expect(res.added).toBe(1)
    expect(states.size).toBe(3)
    expect(states.get('m1')!.activation).toBe(50) // 保留原值
    expect(states.get('m2')!.activation).toBe(30)
    expect(states.get('m3_new')!.activation).toBe(10) // M-46：importance 5 × 2
    expect(states.has('orphan')).toBe(false)
  })

  it('空 L2 -> 全部清为空', () => {
    const states = makeStates([
      ['m1', 50, 0, 0],
      ['m2', 30, 0, 0]
    ])
    const res = reconcileStates(states, [], THRESHOLD)
    expect(res.removed).toBe(2)
    expect(res.added).toBe(0)
    expect(states.size).toBe(0)
  })

  it('L2 全新 -> 全部初始化（M-46：importance 比例初始激活）', () => {
    const states = new Map<string, DmaeEntryState>()
    const res = reconcileStates(states, [e('m1'), e('m2', 8), e('m3', 10)], THRESHOLD)
    expect(res.removed).toBe(0)
    expect(res.added).toBe(3)
    expect(states.size).toBe(3)
    expect(states.get('m1')!.activation).toBe(10) // 5 × 2
    expect(states.get('m2')!.activation).toBe(16) // 8 × 2
    expect(states.get('m3')!.activation).toBe(20) // 10 × 2
  })

  it('M-46：初始激活 clamp 到 threshold-1（初始永不 Active）', () => {
    const states = new Map<string, DmaeEntryState>()
    reconcileStates(states, [e('m1', 10)], 15)
    expect(states.get('m1')!.activation).toBe(14)
  })

  it('M-46 补偿：旧规则出生、从未激活的存量条目（everActivated=false 且 activation=0）补发初始激活', () => {
    const states = new Map<string, DmaeEntryState>([
      // 旧规则受害者：出生即 0 激活，从未有过升温机会
      ['stuck', { activation: 0, userSilence: 12, modelSilence: 12, everActivated: false }],
      // 正常衰减回 Archived 的旧条目：已激活过，不补发
      ['decayed', { activation: 0, userSilence: 30, modelSilence: 30, everActivated: true }],
      // 活着的条目：不受影响
      ['alive', { activation: 50, userSilence: 0, modelSilence: 0, everActivated: true }]
    ])
    const res = reconcileStates(states, [e('stuck', 5), e('decayed', 5), e('alive', 5)], THRESHOLD)
    expect(res.added).toBe(0)
    expect(res.removed).toBe(0)
    expect(res.healed).toBe(1)
    // 补发：初始激活 5×2=10，沉默计数清零（视同新生）
    expect(states.get('stuck')).toEqual({
      activation: 10,
      userSilence: 0,
      modelSilence: 0,
      everActivated: true
    })
    // 已激活过的 Archived 条目不补发（真正淡忘的不灌水）
    expect(states.get('decayed')!.activation).toBe(0)
    expect(states.get('alive')!.activation).toBe(50)
  })

  it('M-46 补偿一次性：补发后的条目再次 reconcile 不重复触发', () => {
    const states = new Map<string, DmaeEntryState>([
      ['stuck', { activation: 0, userSilence: 5, modelSilence: 5, everActivated: false }]
    ])
    const first = reconcileStates(states, [e('stuck', 5)], THRESHOLD)
    expect(first.healed).toBe(1)
    // 模拟补发后又沉默衰减回 0（everActivated 保持 true）
    states.get('stuck')!.activation = 0
    const second = reconcileStates(states, [e('stuck', 5)], THRESHOLD)
    expect(second.healed).toBe(0)
    expect(states.get('stuck')!.activation).toBe(0)
  })
})

// === P2-31.5C1-9/C1-10：state-file 健康度（F5-002 §3.7 R11 数据源）===

describe('P2-31.5C1: DmaeStateStore 健康度', () => {
  it('C1-10a: 初始健康度全清零（lastLoadReset=null, lastSaveOk=true, lastSaveAt=null, saveFailures7d=0）', () => {
    const store = createDmaeStateStore({ filePath, logger: makeLogger() })
    const h = store.getHealth()
    expect(h.lastLoadReset).toBeNull()
    expect(h.lastSaveOk).toBe(true)
    expect(h.lastSaveAt).toBeNull()
    expect(h.saveFailures7d).toBe(0)
  })

  it('C1-10b: 成功 save 后 lastSaveOk=true, lastSaveAt 非空', () => {
    const store = createDmaeStateStore({ filePath, logger: makeLogger() })
    store.save(makeStates([['m1', 50, 0, 0]]), 0)
    const h = store.getHealth()
    expect(h.lastSaveOk).toBe(true)
    expect(h.lastSaveAt).not.toBeNull()
    expect(h.saveFailures7d).toBe(0)
  })

  // atomicWriteJson 2026-09-03 起会自动 mkdir 缺失的父目录（修复真机 ENOENT 故障），
  // 所以「指向不存在的目录」不再能可靠制造失败。改用「父目录段实际是个文件」——
  // mkdirSync(recursive) 在这种路径上必定 ENOTDIR，与平台/该修复无关。
  it('C1-10c: save 失败 -> lastSaveOk=false, saveFailures7d 递增', () => {
    const blocker = path.join(tmpDir, 'blocker')
    fs.writeFileSync(blocker, '')
    const store = createDmaeStateStore({
      filePath: path.join(blocker, 'dmae-state.json'),
      logger: makeLogger()
    })
    store.save(makeStates([['m1', 50, 0, 0]]), 0) // 父目录段是文件 -> mkdir 必然失败
    const h = store.getHealth()
    expect(h.lastSaveOk).toBe(false)
    expect(h.saveFailures7d).toBe(1)
    expect(h.lastSaveAt).toBeNull() // 从未成功 save
  })

  it('C1-10d: 多次 save 失败累计 saveFailures7d', () => {
    const blocker = path.join(tmpDir, 'blocker')
    fs.writeFileSync(blocker, '')
    const store = createDmaeStateStore({
      filePath: path.join(blocker, 'dmae-state.json'),
      logger: makeLogger()
    })
    store.save(makeStates([['m1', 50, 0, 0]]), 0)
    store.save(makeStates([['m2', 30, 0, 0]]), 1)
    store.save(makeStates([['m3', 10, 0, 0]]), 2)
    expect(store.getHealth().saveFailures7d).toBe(3)
  })

  it('C1-10e: 坏 JSON -> load 抛错前 lastLoadReset 被设置', () => {
    fs.writeFileSync(filePath, '{ not valid json }}}')
    const store = createDmaeStateStore({ filePath, logger: makeLogger() })
    try {
      store.load()
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(Error)
    }
    // 即使 load 抛错，健康度记录了 load reset
    const h = store.getHealth()
    expect(h.lastLoadReset).not.toBeNull()
  })

  it('C1-10f: schemaVersion 不符 -> load 抛错前 lastLoadReset 被设置', () => {
    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 99, entries: {} }))
    const store = createDmaeStateStore({ filePath, logger: makeLogger() })
    try {
      store.load()
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(Error)
    }
    expect(store.getHealth().lastLoadReset).not.toBeNull()
  })

  it('P2: reset 原因忠实记录（invalid-json / schema-mismatch / none）', () => {
    // 坏 JSON -> invalid-json
    fs.writeFileSync(filePath, '{ not valid json }}}')
    const store1 = createDmaeStateStore({ filePath, logger: makeLogger() })
    try {
      store1.load()
    } catch {
      /* expected */
    }
    expect(store1.getHealth().lastLoadResetReason).toBe('invalid-json')

    // 版本不符 -> schema-mismatch
    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 99, entries: {} }))
    const store2 = createDmaeStateStore({ filePath, logger: makeLogger() })
    try {
      store2.load()
    } catch {
      /* expected */
    }
    expect(store2.getHealth().lastLoadResetReason).toBe('schema-mismatch')

    // 正常 load -> none
    const store3 = createDmaeStateStore({ filePath, logger: makeLogger() })
    store3.save(new Map(), 0)
    const store4 = createDmaeStateStore({ filePath, logger: makeLogger() })
    store4.load()
    expect(store4.getHealth().lastLoadResetReason).toBeNull()
  })

  it('C1-10g: 正常 load 不设置 lastLoadReset', () => {
    const store = createDmaeStateStore({ filePath, logger: makeLogger() })
    store.save(makeStates([['m1', 50, 0, 0]]), 0)
    // 新 store 实例 load（模拟重启）
    const store2 = createDmaeStateStore({ filePath, logger: makeLogger() })
    store2.load()
    expect(store2.getHealth().lastLoadReset).toBeNull()
  })
})
