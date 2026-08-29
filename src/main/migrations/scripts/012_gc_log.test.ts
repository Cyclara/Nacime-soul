// P3G：GC dry-run/real-run 报告必须有无正文的本地审计落点。

import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { migration } from './012_gc_log'

const log = { fatal() { /* noop */ }, error() { /* noop */ }, warn() { /* noop */ }, info() { /* noop */ }, debug() { /* noop */ }, child() { return this } }

describe('012_gc_log', () => {
  it('创建无正文 gc_log 报告表', async () => {
    const db = new Database(':memory:')
    const context = { db, dataDir: '', log, dryRun: false }
    await migration.up(context)
    expect((await migration.validate(context)).ok).toBe(true)
    db.prepare(`INSERT INTO gc_log (ran_at, report) VALUES (?, ?)`).run(1, JSON.stringify({ scanned: 1 }))
    expect(db.prepare(`SELECT report FROM gc_log`).get()).toEqual({ report: '{"scanned":1}' })
    db.close()
  })
})
