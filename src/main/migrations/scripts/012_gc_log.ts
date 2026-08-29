// 迁移 012：GC 报告本地审计表。只存 GcReport JSON（无记忆正文）。

import type { Migration } from '../types'

export const migration: Migration = {
  id: 12,
  store: 'db',
  title: 'create GC report log table',
  up({ db }) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS gc_log (
        ran_at INTEGER PRIMARY KEY,
        report TEXT NOT NULL
      );
    `)
  },
  validate({ db }) {
    const columns = new Set(
      (db.prepare(`PRAGMA table_info(gc_log)`).all() as Array<{ name: string }>).map(
        (row) => row.name
      )
    )
    return columns.has('ran_at') && columns.has('report')
      ? { ok: true }
      : { ok: false, detail: 'gc_log schema missing after migration 012' }
  }
}
