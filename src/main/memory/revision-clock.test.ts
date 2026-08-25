// src/main/memory/revision-clock.test.ts
// P2-12 MemoryRevisionClock：持久化全局、严格单调、重启延续。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeMemoryDb, type TestDb } from '../../../tests/helpers/test-db'
import { createMemoryRevisionClock } from './revision-clock'
import Database from 'better-sqlite3'

describe('P2-12 MemoryRevisionClock', () => {
  let t: TestDb
  beforeEach(async () => {
    t = await makeMemoryDb()
  })
  afterEach(() => t?.cleanup())

  it('initial revision is 0 (from 002 migration)', () => {
    const clock = createMemoryRevisionClock(t.db)
    expect(clock.current()).toBe(0)
  })

  it('next() increments and persists', () => {
    const clock = createMemoryRevisionClock(t.db)
    expect(clock.next()).toBe(1)
    expect(clock.next()).toBe(2)
    expect(clock.current()).toBe(2)
  })

  it('revision survives restart (new connection on same db file)', () => {
    const clock1 = createMemoryRevisionClock(t.db)
    clock1.next()
    clock1.next()
    clock1.next()
    expect(clock1.current()).toBe(3)

    // 关闭并重开同一 db 文件
    const dbPath = t.dbPath
    t.db.close()
    // 防止 afterEach cleanup 再次 close 已关闭的 db
    t.db = null as unknown as typeof t.db
    const db2 = new Database(dbPath)
    const clock2 = createMemoryRevisionClock(db2)
    expect(clock2.current()).toBe(3)
    expect(clock2.next()).toBe(4)
    db2.close()
  })

  it('next() is transactional (other reads see committed value)', () => {
    const clock = createMemoryRevisionClock(t.db)
    clock.next() // 1
    clock.next() // 2
    // 直接读 app_meta 验证持久化
    const row = t.db.prepare(`SELECT value FROM app_meta WHERE key='memory_revision'`).get() as {
      value: string
    }
    expect(row.value).toBe('2')
  })
})
