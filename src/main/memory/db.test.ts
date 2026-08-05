// src/main/memory/db.test.ts
// P2-06：WAL + foreign_keys 生效；损坏文件 → MEM_DB_CORRUPT AppError，不崩溃。
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openMemoryDb } from './db'

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'nacime-db-'))
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

describe('P2-06 openMemoryDb', () => {
  it('opens with WAL and foreign_keys enabled', () => {
    const db = openMemoryDb({ dbPath: join(tmp(), 'm.db') })
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    db.close()
  })

  it('corrupt / non-sqlite file → MEM_DB_CORRUPT AppError (fatal), no crash', () => {
    const dbPath = join(tmp(), 'bad.db')
    writeFileSync(dbPath, 'this is not a sqlite database, just garbage. '.repeat(20))
    let err: unknown
    try {
      openMemoryDb({ dbPath })
    } catch (e) {
      err = e
    }
    expect((err as { code?: string })?.code).toBe('MEM_DB_CORRUPT')
    expect((err as { severity?: string })?.severity).toBe('fatal')
  })
})
