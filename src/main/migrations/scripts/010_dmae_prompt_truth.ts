// 迁移 010：DMAE 逐轮记录补入 PromptBudgeter 最终裁剪真值。
// P3X-01：selection 只表示 selectL2 选择；本迁移持久化 budget 后实际保留/裁掉的 L2 ID，
// 让面板不再把 selected 误说成 injected。旧行保留 NULL，UI 显示“未知”。

import type { Migration } from '../types'

const REQUIRED_COLUMNS = [
  'prompt_included',
  'prompt_trimmed',
  'prompt_included_ids_json',
  'prompt_trimmed_ids_json'
]

export const migration: Migration = {
  id: 10,
  store: 'db',
  title: 'dmae turns: persist final PromptBudgeter included and trimmed L2 truth',
  up({ db }) {
    db.exec(`
      ALTER TABLE dmae_turns ADD COLUMN prompt_included INTEGER;
      ALTER TABLE dmae_turns ADD COLUMN prompt_trimmed INTEGER;
      ALTER TABLE dmae_turns ADD COLUMN prompt_included_ids_json TEXT;
      ALTER TABLE dmae_turns ADD COLUMN prompt_trimmed_ids_json TEXT;
    `)
  },
  validate({ db }) {
    const columns = new Set(
      (db.prepare(`PRAGMA table_info(dmae_turns)`).all() as Array<{ name: string }>).map((row) => row.name)
    )
    for (const column of REQUIRED_COLUMNS) {
      if (!columns.has(column)) return { ok: false, detail: `dmae_turns.${column} missing after migration 010` }
    }
    return { ok: true }
  }
}
