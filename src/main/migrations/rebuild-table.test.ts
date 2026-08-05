// src/main/migrations/rebuild-table.test.ts
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { rebuildTable } from './rebuild-table'

describe('rebuildTable', () => {
  it('rebuilds with column mapping, preserves data and surviving index', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = OFF')
    db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, status TEXT)`)
    db.exec(`CREATE INDEX idx_t_name ON t(name)`)
    const ins = db.prepare(`INSERT INTO t (id, name, status) VALUES (?,?,?)`)
    ins.run(1, 'a', 'archived')
    ins.run(2, 'b', 'aging')
    ins.run(3, 'c', null)

    rebuildTable(
      db,
      't',
      `CREATE TABLE "t__new" (id INTEGER PRIMARY KEY, name TEXT, lifecycle TEXT NOT NULL DEFAULT 'active')`,
      {
        id: 'id',
        name: 'name',
        lifecycle: `CASE status WHEN 'archived' THEN 'archived' WHEN 'aging' THEN 'dormant' ELSE 'active' END`
      }
    )

    const rows = db.prepare(`SELECT id, name, lifecycle FROM t ORDER BY id`).all()
    expect(rows).toEqual([
      { id: 1, name: 'a', lifecycle: 'archived' },
      { id: 2, name: 'b', lifecycle: 'dormant' },
      { id: 3, name: 'c', lifecycle: 'active' }
    ])
    // 幸存列上的索引被重建
    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_t_name'`)
      .get()
    expect(idx).toEqual({ name: 'idx_t_name' })
    db.close()
  })
})
