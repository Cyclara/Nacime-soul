// src/main/migrations/atomic-json.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWriteJson, getJsonVersion, readJsonVersion, setJsonVersion } from './atomic-json'

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'nacime-aj-'))
  dirs.push(d)
  return d
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

describe('atomicWriteJson', () => {
  it('writes JSON that reads back equal', () => {
    const f = join(tmp(), 'x.json')
    atomicWriteJson(f, { a: 1, b: ['x', 'y'], zh: '中文' })
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ a: 1, b: ['x', 'y'], zh: '中文' })
  })

  it('overwrite replaces content atomically', () => {
    const f = join(tmp(), 'x.json')
    atomicWriteJson(f, { v: 1 })
    atomicWriteJson(f, { v: 2 })
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ v: 2 })
  })

  // 复现 2026-09-03 真机故障：COMPANION_USER_DATA 指向尚未创建的目录（隔离测试常见），
  // secretStore.setup() 首次落盘时因父目录不存在而 ENOENT。Electron 正常路径下
  // app.getPath('userData') 恒存在，这条分支只有全新/自定义 userData 目录会走到。
  it('creates missing parent directory before writing', () => {
    const parent = join(tmp(), 'fresh-profile')
    const f = join(parent, 'secrets.json')
    atomicWriteJson(f, { v: 1 })
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ v: 1 })
  })

  it('creates nested missing parent directories', () => {
    const f = join(tmp(), 'a', 'b', 'c', 'x.json')
    atomicWriteJson(f, { v: 1 })
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ v: 1 })
  })
})

describe('getJsonVersion', () => {
  it('missing file → 0', () => {
    expect(getJsonVersion(join(tmp(), 'nope.json'))).toBe(0)
  })
  it('reads integer schemaVersion', () => {
    const f = join(tmp(), 'x.json')
    atomicWriteJson(f, { schemaVersion: 3, data: 1 })
    expect(getJsonVersion(f)).toBe(3)
  })
  it('missing schemaVersion field → 0', () => {
    const f = join(tmp(), 'x.json')
    atomicWriteJson(f, { data: 1 })
    expect(getJsonVersion(f)).toBe(0)
  })
  it('non-integer schemaVersion → 0', () => {
    const f = join(tmp(), 'x.json')
    atomicWriteJson(f, { schemaVersion: 1.5 })
    expect(getJsonVersion(f)).toBe(0)
  })
  it('malformed JSON → 0', () => {
    const f = join(tmp(), 'x.json')
    writeFileSync(f, 'not json{')
    expect(getJsonVersion(f)).toBe(0)
  })
})

describe('readJsonVersion（三态）', () => {
  it('missing file -> { kind: "missing" }', () => {
    expect(readJsonVersion(join(tmp(), 'nope.json'))).toEqual({ kind: 'missing' })
  })

  it('valid integer schemaVersion -> { kind: "ok", version }', () => {
    const f = join(tmp(), 'x.json')
    atomicWriteJson(f, { schemaVersion: 3, data: 1 })
    expect(readJsonVersion(f)).toEqual({ kind: 'ok', version: 3 })
  })

  it('missing schemaVersion field -> { kind: "invalid", reason: "bad-version" }', () => {
    const f = join(tmp(), 'x.json')
    atomicWriteJson(f, { data: 1 })
    expect(readJsonVersion(f)).toEqual({ kind: 'invalid', reason: 'bad-version' })
  })

  it('non-integer schemaVersion -> { kind: "invalid", reason: "bad-version" }', () => {
    const f = join(tmp(), 'x.json')
    atomicWriteJson(f, { schemaVersion: 1.5 })
    expect(readJsonVersion(f)).toEqual({ kind: 'invalid', reason: 'bad-version' })
  })

  it('string schemaVersion "1" -> { kind: "invalid", reason: "bad-version" }（不是 ok）', () => {
    const f = join(tmp(), 'x.json')
    atomicWriteJson(f, { schemaVersion: '1', entries: {} })
    expect(readJsonVersion(f)).toEqual({ kind: 'invalid', reason: 'bad-version' })
  })

  it('malformed JSON -> { kind: "invalid", reason: "bad-json" }', () => {
    const f = join(tmp(), 'x.json')
    writeFileSync(f, 'not json{')
    expect(readJsonVersion(f)).toEqual({ kind: 'invalid', reason: 'bad-json' })
  })
})

describe('setJsonVersion', () => {
  it('updates schemaVersion without touching other fields', () => {
    const f = join(tmp(), 'x.json')
    atomicWriteJson(f, { schemaVersion: 1, entries: { a: 1 }, extra: 'keep' })
    setJsonVersion(f, 4)
    const after = JSON.parse(readFileSync(f, 'utf8'))
    expect(after.schemaVersion).toBe(4)
    expect(after.entries).toEqual({ a: 1 })
    expect(after.extra).toBe('keep')
  })

  it('throws on non-integer version', () => {
    const f = join(tmp(), 'x.json')
    atomicWriteJson(f, { schemaVersion: 1 })
    expect(() => setJsonVersion(f, 1.5)).toThrow(/invalid version/)
    expect(() => setJsonVersion(f, -1)).toThrow(/invalid version/)
  })

  it('throws when file does not exist', () => {
    const f = join(tmp(), 'nope.json')
    expect(() => setJsonVersion(f, 4)).toThrow(/cannot read/)
  })

  it('throws when file is not valid JSON', () => {
    const f = join(tmp(), 'x.json')
    writeFileSync(f, 'not json{')
    expect(() => setJsonVersion(f, 4)).toThrow(/not valid JSON/)
  })
})
