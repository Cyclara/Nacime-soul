// src/main/memory/l0-store.test.ts
// P2-04 L0Store：显式来源门槛、白名单、pinned 跳过、初始未知、事件、持久化。
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createL0Store } from './l0-store'

const dirs: string[] = []
function f(): string {
  const d = mkdtempSync(join(tmpdir(), 'nacime-l0-'))
  dirs.push(d)
  return join(d, 'l0-profile.json')
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

describe('P2-04 L0Store', () => {
  it('initial profile is all unknown', () => {
    const s = createL0Store({ filePath: f() })
    expect(s.get().fields).toEqual({})
    expect(s.getField('name')).toBeNull()
    expect(s.filledFields()).toEqual([])
  })

  it('writes only explicit + user_explicit candidates', () => {
    const s = createL0Store({ filePath: f(), now: () => 111 })
    expect(
      s.set({
        field: 'preferredName',
        value: '小明',
        certainty: 'explicit',
        attribution: 'user_explicit'
      })
    ).toBe(true)
    expect(s.getField('preferredName')?.value).toBe('小明')
    // 非显式 certainty 拒绝
    expect(
      s.set({
        field: 'occupation',
        value: '工程师',
        certainty: 'inferred',
        attribution: 'user_explicit'
      })
    ).toBe(false)
    // 非 user_explicit 来源拒绝
    expect(
      s.set({
        field: 'occupation',
        value: '工程师',
        certainty: 'explicit',
        attribution: 'inferred'
      })
    ).toBe(false)
    expect(s.getField('occupation')).toBeNull()
  })

  it('rejects non-whitelist fields', () => {
    const s = createL0Store({ filePath: f() })
    expect(
      s.set({
        field: 'secretField',
        value: 'x',
        certainty: 'explicit',
        attribution: 'user_explicit'
      })
    ).toBe(false)
    // 空值拒绝
    expect(
      s.set({ field: 'name', value: '   ', certainty: 'explicit', attribution: 'user_explicit' })
    ).toBe(false)
  })

  it('pinned field skips auto-write', () => {
    const s = createL0Store({ filePath: f() })
    s.setPinned('preferredName', '钦定名')
    expect(
      s.set({
        field: 'preferredName',
        value: '自动名',
        certainty: 'explicit',
        attribution: 'user_explicit'
      })
    ).toBe(false)
    expect(s.getField('preferredName')?.value).toBe('钦定名')
    expect(s.getField('preferredName')?.isPinned).toBe(true)
  })

  it('emits l0.filled on new field, l0.updated on change', () => {
    const s = createL0Store({ filePath: f() })
    const filled: string[] = []
    const updated: string[] = []
    s.on('l0.filled', (x) => filled.push(x))
    s.on('l0.updated', (x) => updated.push(x))
    s.set({ field: 'name', value: 'A', certainty: 'explicit', attribution: 'user_explicit' })
    s.set({ field: 'name', value: 'B', certainty: 'explicit', attribution: 'user_explicit' })
    expect(filled).toEqual(['name'])
    expect(updated).toEqual(['name'])
  })

  it('no-op set (same value) returns false and does not emit', () => {
    const s = createL0Store({ filePath: f() })
    s.set({ field: 'name', value: 'X', certainty: 'explicit', attribution: 'user_explicit' })
    const updated: string[] = []
    s.on('l0.updated', (x) => updated.push(x))
    expect(
      s.set({ field: 'name', value: 'X', certainty: 'explicit', attribution: 'user_explicit' })
    ).toBe(false)
    expect(updated).toEqual([])
  })

  it('persists and reloads across instances (whitelist-filtered)', () => {
    const p = f()
    const s1 = createL0Store({ filePath: p })
    s1.set({ field: 'name', value: '持久', certainty: 'explicit', attribution: 'user_explicit' })
    const s2 = createL0Store({ filePath: p })
    expect(s2.getField('name')?.value).toBe('持久')
    expect(s2.filledFields()).toEqual(['name'])
  })

  it('clearField removes field and emits updated', () => {
    const s = createL0Store({ filePath: f() })
    s.set({ field: 'name', value: 'X', certainty: 'explicit', attribution: 'user_explicit' })
    const updated: string[] = []
    s.on('l0.updated', (x) => updated.push(x))
    s.clearField('name')
    expect(s.getField('name')).toBeNull()
    expect(updated).toEqual(['name'])
  })
})

describe('C-α-2 L0 损坏 = 阻断启动（不许静默清空）', () => {
  it('文件不存在 -> 正常空初始化，不报错', () => {
    const s = createL0Store({ filePath: f() })
    expect(s.get().fields).toEqual({})
  })

  it('JSON 语法错误 -> 抛 MEM_DB_CORRUPT fatal，坏文件不被覆盖', () => {
    const path = f()
    const corrupt = '{ not valid json'

    writeFileSync(path, corrupt)
    expect(() => createL0Store({ filePath: path })).toThrow()
    expect(readFileSync(path, 'utf8')).toBe(corrupt) // 坏文件保留
  })

  it('schemaVersion 不符 -> 抛 MEM_DB_CORRUPT fatal', () => {
    const path = f()

    writeFileSync(path, JSON.stringify({ schemaVersion: 99, fields: {} }))
    expect(() => createL0Store({ filePath: path })).toThrow(/版本不匹配/)
  })

  it('schemaVersion 是字符串 -> 抛（bad-version）', () => {
    const path = f()

    writeFileSync(path, JSON.stringify({ schemaVersion: '1', fields: {} }))
    expect(() => createL0Store({ filePath: path })).toThrow()
  })

  it('正常文件 -> 正常加载', () => {
    const path = f()
    const s1 = createL0Store({ filePath: path, now: () => 111 })
    s1.setPinned('name', '小明')
    const s2 = createL0Store({ filePath: path })
    expect(s2.getField('name')?.value).toBe('小明')
    expect(s2.getField('name')?.isPinned).toBe(true)
  })
})
