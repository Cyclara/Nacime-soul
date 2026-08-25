// src/main/migrations/scripts/002_extraction_key.ts
// 迁移 002：为 l2_memories 增加 extraction_key 列 + 部分唯一索引，建 app_meta 表。
// 依据：S-020 §1.6（跨轮/重启幂等由 extractionKey 承担，L2 表建立 UNIQUE），
//       S-022 §1.4（MemoryRevisionClock 真源为 app_meta.memory_revision 单行）。
//
// F5-013 铁律：001_init 已合入不得修改，新增列/表走新编号迁移。
// extraction_key 允许 NULL（旧数据无此列值）；部分唯一索引仅对非 NULL 值去重，
// 多个 NULL 在 SQLite 中视为 distinct（官方语义），兼容旧数据。

import type { Migration } from '../types'

const DDL = `
-- ── extraction_key：跨轮/重启幂等（S-020 §1.6）──
-- sha256(schemaVersion + targetLayer + sourceMessageId + fieldOrType + NFC(trim(content)))
ALTER TABLE l2_memories ADD COLUMN extraction_key TEXT;
-- 部分唯一索引：仅对非 NULL extraction_key 去重；NULL 行允许多条（旧数据兼容）
CREATE UNIQUE INDEX IF NOT EXISTS idx_l2_extraction_key
  ON l2_memories(extraction_key)
  WHERE extraction_key IS NOT NULL;

-- ── app_meta：持久化全局键值（S-022 §1.4 MemoryRevisionClock 真源）──
CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO app_meta (key, value) VALUES ('memory_revision', '0');
`

export const migration: Migration = {
  id: 2,
  store: 'db',
  title: 'add extraction_key to l2_memories + app_meta table for revision clock',
  up({ db }) {
    db.exec(DDL)
  },
  validate({ db }) {
    // extraction_key 列存在
    const cols = db.prepare(`PRAGMA table_info(l2_memories)`).all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'extraction_key')) {
      return { ok: false, detail: 'l2_memories.extraction_key column missing' }
    }
    // idx_l2_extraction_key 索引存在
    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_l2_extraction_key'`)
      .get() as { name: string } | undefined
    if (!idx) {
      return { ok: false, detail: 'idx_l2_extraction_key index missing' }
    }
    // app_meta 表存在且 memory_revision 初始化
    const metaRow = db.prepare(`SELECT value FROM app_meta WHERE key = 'memory_revision'`).get() as
      { value: string } | undefined
    if (!metaRow) {
      return { ok: false, detail: 'app_meta.memory_revision not initialized' }
    }
    const rev = parseInt(metaRow.value, 10)
    if (!Number.isInteger(rev) || rev < 0) {
      return { ok: false, detail: `app_meta.memory_revision invalid value: ${metaRow.value}` }
    }
    return { ok: true }
  }
}
