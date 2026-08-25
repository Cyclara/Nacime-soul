// src/main/migrations/rebuild-table.ts
// SQLite 12 步重建表助手（官方 ALTER 限制的标准解法）。依据 F5-013 §3。
// Phase 2 的 001_init 是全新建表，用不到本助手；它为 Phase 3+ 的改列/删列/改约束迁移预留。

import type { Database } from 'better-sqlite3'

/**
 * 重建表：建新表 → 拷数据（按 columnMap 映射）→ 删旧表 → 改名 → 重建索引/触发器。
 *
 * 约定：
 * - 调用方（MigrationRunner）保证会话级 `PRAGMA foreign_keys=OFF`，
 *   因为 SQLite 的 foreign_keys pragma 在事务内是 no-op，必须在事务外先关。
 * - `newDdl` 必须建一个名为 `<table>__new` 的新表。
 * - `columnMap`：新列名 → 取自旧表的 SELECT 表达式，
 *   如 `{ lifecycle_state: "COALESCE(status,'active')" }`。
 * - 旧表上的显式索引/触发器会被自动捕获并在改名后重建（DDL 引用的表名与改名后一致）。
 */
export function rebuildTable(
  db: Database,
  table: string,
  newDdl: string,
  columnMap: Record<string, string>
): void {
  const newTmp = `${table}__new`

  // 记住旧表上的索引/触发器 DDL（sqlite 自动索引 sql 为 NULL，自动排除）
  const aux = db
    .prepare(
      `SELECT sql FROM sqlite_master
       WHERE type IN ('index','trigger') AND tbl_name = ? AND sql IS NOT NULL`
    )
    .all(table) as Array<{ sql: string }>

  db.exec(newDdl) // 建 <table>__new

  const cols = Object.keys(columnMap)
  const selectExprs = cols.map((c) => `${columnMap[c]} AS "${c}"`).join(', ')
  const colList = cols.map((c) => `"${c}"`).join(', ')
  db.exec(`INSERT INTO "${newTmp}" (${colList}) SELECT ${selectExprs} FROM "${table}"`)

  db.exec(`DROP TABLE "${table}"`)
  db.exec(`ALTER TABLE "${newTmp}" RENAME TO "${table}"`)

  for (const a of aux) {
    db.exec(a.sql)
  }
}
