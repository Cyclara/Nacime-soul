// src/main/migrations/scripts/008_search_fts.ts
// 迁移 008：聊天全文搜索（P2-44）——建 messages_fts FTS5 虚拟表并回填存量消息。
// 依据：2026-08-23 用户验收需求（DeepSeek 式聊天记录搜索，SQLite FTS5 方案）。
//
// 关键决策：
//   1. 独立 FTS5 表（非 content= 外联表）：unicode61 对无空格中文整词成 token，
//      必须先在 TS 侧逐字分隔（segmentForFts）再入索引；SQL 触发器调不到 TS，
//      所以同步责任在 TS 写入路径（sqlite-session-store 的 append/update/delete）。
//   2. rowid 与 messages.rowid 一一对应，JOIN 回主表取正文/时间戳。
//   3. 回填在本迁移事务内完成（迁移框架的 db 迁移已在事务中）；空内容消息
//      （如中断占位行）同样入表——seg 为空串、无 token，保证行数 1:1 不变量。
//
// F5-013 铁律：不动既有迁移，新增表走新编号。本迁移占号 008
// （台账 §5.2「008+ 合规预留」按"谁先落地谁先占号"规则让位，合规审查迁移顺延 009+）。

import type { Migration } from '../types'
import { segmentForFts } from '../../chat/search'

const DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  seg,
  tokenize = 'unicode61'
);
`

interface BackfillRow {
  rowid: number
  content: string
}

export const migration: Migration = {
  id: 8,
  store: 'db',
  title: 'add messages_fts FTS5 table + backfill for chat history search',
  up({ db }) {
    db.exec(DDL)
    const rows = db.prepare(`SELECT rowid, content FROM messages`).all() as BackfillRow[]
    const insert = db.prepare(`INSERT INTO messages_fts (rowid, seg) VALUES (?, ?)`)
    for (const row of rows) {
      insert.run(row.rowid, segmentForFts(row.content))
    }
  },
  validate({ db }) {
    // 表存在
    const table = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'`)
      .get() as { name: string } | undefined
    if (!table) {
      return { ok: false, detail: 'messages_fts table missing' }
    }
    // 行数 1:1（每条消息都有对应索引行，空内容也不例外）
    const messages = db.prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number }
    const fts = db.prepare(`SELECT COUNT(*) AS n FROM messages_fts`).get() as { n: number }
    if (messages.n !== fts.n) {
      return {
        ok: false,
        detail: `row count mismatch: messages=${messages.n} vs messages_fts=${fts.n}`
      }
    }
    return { ok: true }
  }
}
