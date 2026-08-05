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
    store.save(original)
    const loaded = store.load()
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
    store.save(makeStates([['m1', 75, 5, 3]]))
    // 模拟重启：新 store 实例 load
    const store2 = createDmaeStateStore({ filePath, logger: makeLogger() })
    const loaded = store2.load()
    expect(loaded.get('m1')!.activation).toBe(75)
    expect(loaded.get('m1')!.userSilence).toBe(5)
    expect(loaded.get('m1')!.modelSilence).toBe(3)
  })

  it('save 空 Map 也能 load', () => {
    const store = createDmaeStateStore({ filePath, logger: makeLogger() })
    store.save(new Map())
    const loaded = store.load()
    expect(loaded.size).toBe(0)
  })
})

describe('DmaeStateStore 文件缺失 = 首次启动', () => {
  it('文件不存在 -> load 返回空 Map（不 warn）', () => {
    const logger = makeLogger()
    const store = createDmaeStateStore({ filePath, logger })
    const loaded = store.load()
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
    const loaded = store.load()
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
    const loaded = store.load()
    expect(loaded.size).toBe(0)
  })
})

describe('reconcileStates 孤儿清理 + 新增初始化', () => {
  it('孤儿清理：stateFile 有但 L2 已删 -> 删', () => {
    const states = makeStates([
      ['m1', 50, 0, 0],
      ['m2', 30, 0, 0],
      ['m3', 0, 0, 0] // 孤儿
    ])
    const res = reconcileStates(states, ['m1', 'm2'])
    expect(res.removed).toBe(1)
    expect(res.added).toBe(0)
    expect(states.size).toBe(2)
    expect(states.has('m1')).toBe(true)
    expect(states.has('m2')).toBe(true)
    expect(states.has('m3')).toBe(false)
  })

  it('新增初始化：L2 有但 stateFile 没有 -> activation=0（Archived 冷态）', () => {
    const states = makeStates([['m1', 50, 0, 0]])
    const res = reconcileStates(states, ['m1', 'm2_new'])
    expect(res.removed).toBe(0)
    expect(res.added).toBe(1)
    expect(states.get('m2_new')).toEqual(createInitialEntryState())
    expect(states.get('m2_new')!.activation).toBe(0)
  })

  it('混合：删 + 加 + 保留', () => {
    const states = makeStates([
      ['m1', 50, 1, 1], // 保留
      ['m2', 30, 2, 2], // 保留
      ['orphan', 10, 0, 0] // 删
    ])
    const res = reconcileStates(states, ['m1', 'm2', 'm3_new'])
    expect(res.removed).toBe(1)
    expect(res.added).toBe(1)
    expect(states.size).toBe(3)
    expect(states.get('m1')!.activation).toBe(50) // 保留原值
    expect(states.get('m2')!.activation).toBe(30)
    expect(states.get('m3_new')!.activation).toBe(0) // 新增初始
    expect(states.has('orphan')).toBe(false)
  })

  it('空 L2 -> 全部清为空', () => {
    const states = makeStates([
      ['m1', 50, 0, 0],
      ['m2', 30, 0, 0]
    ])
    const res = reconcileStates(states, [])
    expect(res.removed).toBe(2)
    expect(res.added).toBe(0)
    expect(states.size).toBe(0)
  })

  it('L2 全新 -> 全部初始化', () => {
    const states = new Map<string, DmaeEntryState>()
    const res = reconcileStates(states, ['m1', 'm2', 'm3'])
    expect(res.removed).toBe(0)
    expect(res.added).toBe(3)
    expect(states.size).toBe(3)
    for (const st of states.values()) {
      expect(st.activation).toBe(0)
    }
  })
})
