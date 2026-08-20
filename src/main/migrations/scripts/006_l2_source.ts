// src/main/migrations/scripts/006_l2_source.ts
// 迁移 006：为 l2_memories 增加 source 列。
// 依据：S-Phase2 P2-37（source 字段 creator/user_explicit/inferred 区分）。
//
// F5-013 铁律：001_init 已合入不得修改，新增列走新编号迁移。
//
// source 列语义：
//   - 'creator'      = seed 加载器创建的条目（P2-36，importance=10，DMAE Decay 豁免）
//   - 'user_explicit' = MemoryJudge 终审通过的用户明确陈述（attribution='user_explicit'）
//   - 'inferred'     = MemoryJudge 降级/推断的条目（attribution='assistant_inferred'/'mixed'）
//
// 旧行默认 'user_explicit'（ADD COLUMN DEFAULT 语义）：旧数据无 source 信息，
// 按最保守的"user 明确陈述"处理--不享受 creator 豁免，也不被当推断降权。

import type { Migration } from '../types'

const DDL = `
ALTER TABLE l2_memories ADD COLUMN source TEXT NOT NULL DEFAULT 'user_explicit'
  CHECK (source IN ('creator','user_explicit','inferred'));
`

export const migration: Migration = {
  id: 6,
  store: 'db',
  title: 'add source column to l2_memories (creator/user_explicit/inferred)',
  up({ db }) {
    db.exec(DDL)
  },
  validate({ db }) {
    const cols = db.prepare(`PRAGMA table_info(l2_memories)`).all() as Array<{
      name: string
      dflt_value: string | null
      notnull: number
    }>
    const sourceCol = cols.find((c) => c.name === 'source')
    if (!sourceCol) {
      return { ok: false, detail: 'l2_memories.source column missing' }
    }
    if (sourceCol.notnull !== 1) {
      return { ok: false, detail: 'l2_memories.source must be NOT NULL' }
    }
    if (sourceCol.dflt_value !== "'user_explicit'") {
      return {
        ok: false,
        detail: `l2_memories.source default must be 'user_explicit', got: ${sourceCol.dflt_value}`
      }
    }
    // CHECK 约束存在（sqlite_master 不存 CHECK 文本，用插入测试验证）
    try {
      db.prepare(
        `INSERT INTO l2_memories (id, content, source) VALUES ('__test_source_check__', 'test', 'invalid_source')`
      ).run()
      // 如果插入成功，说明 CHECK 约束未生效
      db.prepare(`DELETE FROM l2_memories WHERE id = '__test_source_check__'`).run()
      return { ok: false, detail: 'l2_memories.source CHECK constraint not enforced' }
    } catch {
      // 插入失败 = CHECK 约束生效（预期）
    }
    return { ok: true }
  }
}
