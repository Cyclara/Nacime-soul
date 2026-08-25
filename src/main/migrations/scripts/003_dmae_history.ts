// src/main/migrations/scripts/003_dmae_history.ts
// 迁移 003：DMAE 历史四表（F5-002 §3.2）。
// store='db'，id=3（F5-013 勘误 §2.2 钉死：003 = db 四表，004 = dmae 状态）。
//
// 四张表：
//   dmae_samples      - 逐条采样点（分层采样，30 天保留）
//   dmae_turns        - 逐轮标量记录（90 天保留）
//   dmae_daily        - 每日聚合（永久保留）
//   dmae_annotations  - 调参事件标注（永久保留）
//
// 依据：F5-002 §3.2 的 SQL DDL + S-Phase2 P2-31.5B 验收标准。
// 旧数据不变（纯加表，不修改已有表）；user_version 由 runner 的 setDbVersion 写入（=3）。

import type { Migration } from '../types'

export const migration: Migration = {
  id: 3,
  store: 'db',
  title: 'dmae history tables: samples/turns/daily/annotations',
  up({ db }) {
    // 逐条采样点：分层采样避免 15k×每轮爆炸。
    // PK (memory_id, turn) 保证同一条记忆同一轮只有一行；WITHOUT ROWID 节省空间。
    db.exec(`
      CREATE TABLE IF NOT EXISTS dmae_samples (
        memory_id TEXT NOT NULL,
        turn INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        activation REAL NOT NULL,
        user_silence INTEGER NOT NULL,
        model_silence INTEGER NOT NULL,
        state TEXT NOT NULL,
        user_hit INTEGER NOT NULL,
        model_hit INTEGER NOT NULL,
        model_reward_effective REAL NOT NULL,
        model_reward_raw REAL NOT NULL,
        model_hit_gated INTEGER NOT NULL,
        decay REAL NOT NULL,
        ever_activated_before INTEGER NOT NULL,
        first_activation INTEGER NOT NULL,
        PRIMARY KEY (memory_id, turn)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_dmae_samples_turn ON dmae_samples(turn);
      CREATE INDEX IF NOT EXISTS idx_dmae_samples_ts ON dmae_samples(ts);
    `)

    // 逐轮标量：占位数、Σ奖励、真实复活数等每轮一个标量。
    // turn 为 PK（全局 DMAE turn 序号，单调递增）。
    db.exec(`
      CREATE TABLE IF NOT EXISTS dmae_turns (
        turn INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        eligible_active INTEGER NOT NULL,
        retrieval_hits INTEGER NOT NULL,
        prompt_selected INTEGER NOT NULL,
        max_active INTEGER NOT NULL,
        user_hits INTEGER NOT NULL,
        model_hits INTEGER NOT NULL,
        model_hits_gated INTEGER NOT NULL,
        model_reward_raw_sum REAL NOT NULL,
        model_reward_effective_sum REAL NOT NULL,
        total_decay REAL NOT NULL,
        floor_revivals INTEGER NOT NULL,
        true_floor_revivals INTEGER NOT NULL,
        params_hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dmae_turns_ts ON dmae_turns(ts);
    `)

    // 每日聚合：趋势图数据源。date 为 PK（YYYY-MM-DD 本地时区）。
    // json 列存 DmaeDailyAggregate 序列化（与 growth_snapshots 同模式）。
    db.exec(`
      CREATE TABLE IF NOT EXISTS dmae_daily (
        date TEXT PRIMARY KEY,
        json TEXT NOT NULL
      );
    `)

    // 调参事件标注：趋势图上画竖线。id 为 ULID。
    // json 列存 before/after/source/sourceRef（DmaeParamAnnotation 序列化）。
    db.exec(`
      CREATE TABLE IF NOT EXISTS dmae_annotations (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        turn INTEGER NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dmae_annotations_ts ON dmae_annotations(ts);
    `)
  },
  validate({ db }) {
    // 验证四张表都存在
    const tables = new Set(
      (
        db
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'dmae_%'`)
          .all() as Array<{ name: string }>
      ).map((r) => r.name)
    )
    const required = ['dmae_samples', 'dmae_turns', 'dmae_daily', 'dmae_annotations']
    for (const t of required) {
      if (!tables.has(t)) {
        return { ok: false, detail: `table ${t} missing after migration 003` }
      }
    }
    // 验证索引存在
    const indexes = new Set(
      (
        db
          .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_dmae_%'`)
          .all() as Array<{ name: string }>
      ).map((r) => r.name)
    )
    const requiredIndexes = [
      'idx_dmae_samples_turn',
      'idx_dmae_samples_ts',
      'idx_dmae_turns_ts',
      'idx_dmae_annotations_ts'
    ]
    for (const idx of requiredIndexes) {
      if (!indexes.has(idx)) {
        return { ok: false, detail: `index ${idx} missing after migration 003` }
      }
    }
    return { ok: true }
  }
}
