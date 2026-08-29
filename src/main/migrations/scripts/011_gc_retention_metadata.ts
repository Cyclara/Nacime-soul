// 迁移 011：GC 需要独立的软删时间与最近访问时间，不能滥用 archived_at。

import type { Migration } from '../types'

export const migration: Migration = {
  id: 11,
  store: 'db',
  title: 'l2 GC retention metadata: soft-delete and recent-access timestamps',
  up({ db }) {
    db.exec(`
      ALTER TABLE l2_memories ADD COLUMN soft_deleted_at INTEGER;
      ALTER TABLE l2_memories ADD COLUMN last_accessed_at INTEGER;
      CREATE INDEX IF NOT EXISTS idx_l2_gc_soft_deleted ON l2_memories(lifecycle_state, soft_deleted_at);
      CREATE INDEX IF NOT EXISTS idx_l2_gc_archived ON l2_memories(lifecycle_state, archived_at);
    `)
  },
  validate({ db }) {
    const columns = new Set(
      (db.prepare(`PRAGMA table_info(l2_memories)`).all() as Array<{ name: string }>).map((row) => row.name)
    )
    if (!columns.has('soft_deleted_at') || !columns.has('last_accessed_at')) {
      return { ok: false, detail: 'l2_memories GC retention columns missing after migration 011' }
    }
    return { ok: true }
  }
}
