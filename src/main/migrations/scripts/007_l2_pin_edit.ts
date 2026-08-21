// src/main/migrations/scripts/007_l2_pin_edit.ts
// 迁移 007：为 l2_memories 增加 importance_before_pin 与 edited_at 列。
// 依据：M-48（L2 pin 接真豁免：importance 提到豁免档 10 时存原值，unpin 恢复）
//       + M-44（用户手动编辑记忆的 provenance 标记）。
//
// F5-013 铁律：001_init 已合入不得修改，新增列走新编号迁移。
//
// 两列语义：
//   - importance_before_pin INTEGER NULL：pin 前的原始 importance。
//     NULL = 从未 pin 过（旧数据天然语义正确，无需回填）。
//   - edited_at INTEGER NULL：用户最后一次手动编辑内容的时间（ms epoch）。
//     NULL = 从未被用户编辑过（旧数据天然语义正确，无需回填）。

import type { Migration } from '../types'

const DDL = `
ALTER TABLE l2_memories ADD COLUMN importance_before_pin INTEGER NULL;
ALTER TABLE l2_memories ADD COLUMN edited_at INTEGER NULL;
`

export const migration: Migration = {
  id: 7,
  store: 'db',
  title: 'add importance_before_pin + edited_at columns to l2_memories (M-48/M-44)',
  up({ db }) {
    db.exec(DDL)
  },
  validate({ db }) {
    const cols = db.prepare(`PRAGMA table_info(l2_memories)`).all() as Array<{
      name: string
      notnull: number
    }>
    for (const colName of ['importance_before_pin', 'edited_at']) {
      const col = cols.find((c) => c.name === colName)
      if (!col) {
        return { ok: false, detail: `l2_memories.${colName} column missing` }
      }
      // 必须可空：NULL 承载"从未 pin 过 / 从未编辑过"语义
      if (col.notnull !== 0) {
        return { ok: false, detail: `l2_memories.${colName} must be nullable` }
      }
    }
    return { ok: true }
  }
}
