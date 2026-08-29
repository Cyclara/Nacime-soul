// P3G-02：GC retention 元数据前向迁移不得损坏既有 L2 行。

import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { migration as m001 } from './001_init'
import { migration as m011 } from './011_gc_retention_metadata'

const log = { fatal() { /* noop */ }, error() { /* noop */ }, warn() { /* noop */ }, info() { /* noop */ }, debug() { /* noop */ }, child() { return this } }

describe('011_gc_retention_metadata', () => {
  it('新增 soft_deleted_at / last_accessed_at 并保留既有 L2 数据', async () => {
    const db = new Database(':memory:')
    const context = { db, dataDir: '', log, dryRun: false }
    await m001.up(context)
    db.prepare(`INSERT INTO l2_memories (id, content, confidence) VALUES ('l2_1_a','old',0.9)`).run()
    await m011.up(context)
    expect((await m011.validate(context)).ok).toBe(true)
    expect(db.prepare(`SELECT content, soft_deleted_at, last_accessed_at FROM l2_memories WHERE id='l2_1_a'`).get()).toEqual({
      content: 'old',
      soft_deleted_at: null,
      last_accessed_at: null
    })
    db.close()
  })
})
