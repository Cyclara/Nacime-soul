// src/main/migrations/scripts/005_dmae_turn_stats.ts
// 迁移 005：DMAE 历史表补列（2026-08-10 P1 审计修复）。
// store='db'，id=5（全局唯一递增；dmae 存储版本=4，db 存储版本 3 -> 5）。
//
// 背景：003 建的 dmae_turns/dmae_samples 缺真实聚合所需字段，导致
//   - dmae_daily.dormant/archived/l2Total 硬编码 0、avgActivation 用条目数冒充
//   - 采样无法识别状态迁移（阈值还写死 30）
//   - explainLastTurn 只能从稀疏样本反推 before 值
// 003 不可改（已部署迁移，F5-013 铁律），本迁移以 ADD COLUMN 前向补齐。
//
// 四组字段：
//   1. dmae_turns：真实各态计数 + activation 分布（均值/中位数真源）+ 迁入 Archived 数
//   2. dmae_samples：state_before/state_after（迁移采样真源）
//   3. dmae_samples：before_activation/us/ms + params_json（explainLastTurn 权威值）
//
// SQLite ADD COLUMN NOT NULL 必须带 DEFAULT；旧行填默认 0/null（历史数据不可回溯，可接受——
// 修复后新行全为真实值，趋势/R01 自当日起正确）。

import type { Migration } from '../types'

export const migration: Migration = {
  id: 5,
  store: 'db',
  title: 'dmae turn/sample stats: real counts, activation stats, transitions, before+params',
  up({ db }) {
    // dmae_turns：每日聚合真源
    db.exec(`
      ALTER TABLE dmae_turns ADD COLUMN dormant INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE dmae_turns ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE dmae_turns ADD COLUMN l2_total INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE dmae_turns ADD COLUMN activation_sum REAL NOT NULL DEFAULT 0;
      ALTER TABLE dmae_turns ADD COLUMN activation_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE dmae_turns ADD COLUMN activation_median REAL NOT NULL DEFAULT 0;
      ALTER TABLE dmae_turns ADD COLUMN archived_transitions INTEGER NOT NULL DEFAULT 0;
    `)
    // dmae_samples：迁移采样 + 权威 before/params
    db.exec(`
      ALTER TABLE dmae_samples ADD COLUMN state_before TEXT;
      ALTER TABLE dmae_samples ADD COLUMN state_after TEXT;
      ALTER TABLE dmae_samples ADD COLUMN before_activation REAL;
      ALTER TABLE dmae_samples ADD COLUMN before_user_silence INTEGER;
      ALTER TABLE dmae_samples ADD COLUMN before_model_silence INTEGER;
      ALTER TABLE dmae_samples ADD COLUMN params_json TEXT;
    `)
  },
  validate({ db }) {
    const turnsCols = new Set(
      (db.prepare(`PRAGMA table_info(dmae_turns)`).all() as Array<{ name: string }>).map(
        (c) => c.name
      )
    )
    const requiredTurns = [
      'dormant',
      'archived',
      'l2_total',
      'activation_sum',
      'activation_count',
      'activation_median',
      'archived_transitions'
    ]
    for (const c of requiredTurns) {
      if (!turnsCols.has(c))
        return { ok: false, detail: `dmae_turns.${c} missing after migration 005` }
    }
    const samplesCols = new Set(
      (db.prepare(`PRAGMA table_info(dmae_samples)`).all() as Array<{ name: string }>).map(
        (c) => c.name
      )
    )
    const requiredSamples = [
      'state_before',
      'state_after',
      'before_activation',
      'before_user_silence',
      'before_model_silence',
      'params_json'
    ]
    for (const c of requiredSamples) {
      if (!samplesCols.has(c)) {
        return { ok: false, detail: `dmae_samples.${c} missing after migration 005` }
      }
    }
    return { ok: true }
  }
}
