// src/main/migrations/scripts/009_compliance_history.ts
// 迁移 009：F5-001 C1 合规审查数据持久化——三张表一次建齐（开工裁定 1.7 由两表改三表）。
// 依据：F5-001 §3.11（两张表基线 + 写入纪律）+ F5-勘误-2026-08-24-Phase3开工裁定 §1
// （裁定 1.5 #1 samples 反事实八列；裁定 1.2 时序遥测两列；裁定 1.6 #3 candidate_audit
// 预留两列；裁定 1.7 #3 feedback 独立表 + turns.user_feedback 单槽列废除）。
//
// 关键决策：
//   1. 三表一次建齐占一个号：forward-complete 优于 C3 再占号（裁定 1.6 #3 原文）。
//      candidate_audit_status / candidate_audit_verdict 在 C1 恒 NULL，C3 落码消费。
//   2. 红线守卫进 validate：compliance_samples 永远不得有 content 列（F5-001 §3.11
//      红线 + 台账 §5 禁令）；compliance_turns 不得再出现 user_feedback 列（裁定 1.7
//      废除——单槽在一轮同收 dislike 与 out-of-character 时丢信号）。
//   3. feedback 的 UNIQUE(message_id, kind) 承载 §3.7 幂等：同一消息同一反馈种类
//      重复上报只计一次；一轮同收两种 kind 各占一行（单槽废除的动机）。
//   4. 90 天滚动删除按 turn_id 级联——删除纪律是运行时行为（P3C1-06/07 写库侧），
//      本迁移只建结构；索引按 §3.11 + 级联 JOIN 需要建齐。
//
// F5-013 铁律：不动既有迁移，新增表走新编号。本迁移占号 009（008 被 P2-44 先占，
// 按「谁先落地谁先占号」规则顺延；台账 §5.2 行同步）。

import type { Migration } from '../types'

const DDL = `
-- 逐条违规。§4.1 判据的分子。
CREATE TABLE IF NOT EXISTS compliance_samples (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id           TEXT    NOT NULL,
  occurred_at       INTEGER NOT NULL,            -- epoch ms
  type              TEXT    NOT NULL,            -- ComplianceViolationType
  severity          TEXT    NOT NULL,
  detection_method  TEXT    NOT NULL,            -- 'regex' | 'llm'
  rule_id           TEXT,                        -- regex 来源必填，llm 来源为 NULL
  confidence        REAL    NOT NULL,
  -- 规则声明的动作 vs 实际发生的动作（C1 observe 下 effective 恒 'flag'）
  declared_action   TEXT    NOT NULL,            -- 'block' | 'strip' | 'flag'
  effective_action  TEXT    NOT NULL,            -- 'block' | 'strip' | 'flag'
  span_start        INTEGER,                     -- 全文绝对 UTF-16 偏移（裁定 1.11 S-C14）
  span_length       INTEGER,
  -- ── 裁定 1.5 #1 反事实八列 ──
  attempt_index     INTEGER NOT NULL DEFAULT 0,  -- 0 | 1
  segment_index     INTEGER,
  candidate_id      TEXT,                        -- 一轮一次生成尝试一个
  counterfactual_action TEXT,                    -- 影子策略目标动作
  would_block_first_segment INTEGER,             -- 0/1：影子首段策略下可否介入
  block_ineligible_reason TEXT,                  -- BlockIneligibleReason 八值
  released_chars_before INTEGER,                 -- 命中发生前已放行字符数
  shadow_policy_version TEXT                     -- 影子策略版本（防中途调参混算）
  -- 【红线】没有 content 列，将来也不许加。命中正文只在 dev + debugCaptureText 下进 debug 日志。
);
CREATE INDEX IF NOT EXISTS idx_compliance_samples_rule ON compliance_samples(rule_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_compliance_samples_turn ON compliance_samples(turn_id);

-- 逐轮汇总。§4.1 判据的分母 + 反证来源。1 行/轮（仅门控启用的轮）。
CREATE TABLE IF NOT EXISTS compliance_turns (
  turn_id           TEXT    PRIMARY KEY,
  occurred_at       INTEGER NOT NULL,
  gate_scope        TEXT    NOT NULL,
  gate_blocked      INTEGER NOT NULL DEFAULT 0,  -- 0/1
  regenerations     INTEGER NOT NULL DEFAULT 0,
  degraded_pass     INTEGER NOT NULL DEFAULT 0,
  degraded          INTEGER NOT NULL DEFAULT 0,  -- 超预算或熔断
  checked_segments  INTEGER NOT NULL DEFAULT 0,
  gate_ms           REAL    NOT NULL DEFAULT 0,
  -- 离线审计回填（审计是异步的，写入时刻晚于本行创建）
  audited           INTEGER NOT NULL DEFAULT 0,
  audit_verdict     TEXT,                        -- 'pass' | 'flag' | 'block'
  audit_level       TEXT,
  audit_unavailable INTEGER NOT NULL DEFAULT 0,
  -- ── 裁定 1.2 时序遥测两列（三分量 providerTTFB/gateHold/userTTFB 的数据源）──
  provider_first_delta_ms INTEGER,
  gate_hold_ms      INTEGER,
  -- ── 裁定 1.6 #3：C3 被拦候选审计预留列，C1 恒 NULL ──
  candidate_audit_status  TEXT,
  candidate_audit_verdict TEXT
  -- 裁定 1.7 #3：§3.11 的 user_feedback 单槽列废除，反馈独立成 compliance_feedback。
);
CREATE INDEX IF NOT EXISTS idx_compliance_turns_at ON compliance_turns(occurred_at);

-- 用户反向信号（裁定 1.7 #3 独立表）。只作复核优先级，不作反证统计。
CREATE TABLE IF NOT EXISTS compliance_feedback (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id           TEXT    NOT NULL,
  message_id        TEXT    NOT NULL,
  kind              TEXT    NOT NULL,            -- 'dislike' | 'out-of-character'
  created_at        INTEGER NOT NULL,            -- epoch ms
  UNIQUE(message_id, kind)                       -- §3.7 幂等：同消息同种类重复上报只计一次
);
CREATE INDEX IF NOT EXISTS idx_compliance_feedback_turn ON compliance_feedback(turn_id);
`

const SAMPLES_COLUMNS = 20 // §3.11 原 12 + 裁定 1.5 反事实 8
const TURNS_COLUMNS = 17 // §3.11 原 14 − user_feedback + 时序 2 + candidate_audit 2
const FEEDBACK_COLUMNS = 5

interface TableInfoRow {
  name: string
}

export const migration: Migration = {
  id: 9,
  store: 'db',
  title: 'create compliance_samples/turns/feedback three tables (F5-001 C1)',
  up({ db }) {
    db.exec(DDL)
  },
  validate({ db }) {
    const columnsOf = (table: string): string[] =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as TableInfoRow[]).map((c) => c.name)

    const samples = columnsOf('compliance_samples')
    if (samples.length !== SAMPLES_COLUMNS) {
      return { ok: false, detail: `compliance_samples columns ${samples.length} != ${SAMPLES_COLUMNS}` }
    }
    // 红线守卫：永远不得有 content 列（F5-001 §3.11 + 台账 §5）
    if (samples.includes('content')) {
      return { ok: false, detail: 'compliance_samples must NOT have content column (red line)' }
    }
    for (const col of [
      'attempt_index',
      'segment_index',
      'candidate_id',
      'counterfactual_action',
      'would_block_first_segment',
      'block_ineligible_reason',
      'released_chars_before',
      'shadow_policy_version'
    ]) {
      if (!samples.includes(col)) {
        return { ok: false, detail: `compliance_samples missing counterfactual column ${col}` }
      }
    }

    const turns = columnsOf('compliance_turns')
    if (turns.length !== TURNS_COLUMNS) {
      return { ok: false, detail: `compliance_turns columns ${turns.length} != ${TURNS_COLUMNS}` }
    }
    // 裁定 1.7 #3：单槽列已废除，不得复活
    if (turns.includes('user_feedback')) {
      return { ok: false, detail: 'compliance_turns must NOT resurrect user_feedback (adjudication 1.7)' }
    }
    for (const col of [
      'provider_first_delta_ms',
      'gate_hold_ms',
      'candidate_audit_status',
      'candidate_audit_verdict'
    ]) {
      if (!turns.includes(col)) {
        return { ok: false, detail: `compliance_turns missing column ${col}` }
      }
    }

    const feedback = columnsOf('compliance_feedback')
    if (feedback.length !== FEEDBACK_COLUMNS) {
      return { ok: false, detail: `compliance_feedback columns ${feedback.length} != ${FEEDBACK_COLUMNS}` }
    }
    // UNIQUE(message_id, kind) 幂等约束（裁定 1.7 #3）：查建表 SQL
    const feedbackSql = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'compliance_feedback'`)
      .get() as { sql: string } | undefined
    if (feedbackSql === undefined || !/UNIQUE\s*\(\s*message_id\s*,\s*kind\s*\)/i.test(feedbackSql.sql)) {
      return { ok: false, detail: 'compliance_feedback missing UNIQUE(message_id, kind)' }
    }

    for (const idx of [
      'idx_compliance_samples_rule',
      'idx_compliance_samples_turn',
      'idx_compliance_turns_at',
      'idx_compliance_feedback_turn'
    ]) {
      const row = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
        .get(idx) as { name: string } | undefined
      if (row === undefined) {
        return { ok: false, detail: `index ${idx} missing` }
      }
    }
    return { ok: true }
  }
}
