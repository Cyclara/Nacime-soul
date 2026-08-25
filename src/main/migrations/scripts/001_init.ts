// src/main/migrations/scripts/001_init.ts
// 迁移 001：建立 Phase 2 全部初始表。id=1，store='db'。
// user_version 由 MigrationRunner 在 up 后统一提升到 1（本脚本不写 user_version）。
//
// 表来源合同：
//   l2_memories 14 字段     -> S-Phase2 P2-07（创建时间编码在 id 里，无独立 created_at）
//   l2_vectors / vec_meta   -> F5-003 §3（向量与元数据同库不同表；embedding 不建索引）
//   growth_*                -> F5-006 §3
//   migrations_log          -> F5-013 §3
//   conflict_log            -> S-Phase2 P2-19~21（加分制冲突检测）
//   sessions / messages     -> S-Phase2 P2-43（接替 Phase 1 内存 SessionStore；列对齐 ChatMessage）
//
// 合入后不得修改本脚本（F5-013 铁律）：有 bug 走新编号修复迁移。

import type { Migration } from '../types'

const EXPECTED_TABLES = [
  'l2_memories',
  'l2_vectors',
  'vec_meta',
  'conflict_log',
  'growth_events',
  'growth_snapshots',
  'growth_milestones',
  'migrations_log',
  'sessions',
  'messages'
] as const

const DDL = `
-- ── L2 记忆元数据（14 字段，S-Phase2 P2-07）──
CREATE TABLE IF NOT EXISTS l2_memories (
  id                 TEXT PRIMARY KEY,
  evidence_ids       TEXT NOT NULL DEFAULT '[]',
  source_message_ids TEXT NOT NULL DEFAULT '[]',
  trigger_text       TEXT,
  content            TEXT NOT NULL,
  confidence         REAL NOT NULL DEFAULT 0,
  sync_status        TEXT NOT NULL DEFAULT 'pending'
                       CHECK (sync_status IN ('pending','synced','failed')),
  lifecycle_state    TEXT NOT NULL DEFAULT 'active'
                       CHECK (lifecycle_state IN ('active','dormant','archived','soft_deleted','purged')),
  is_pinned          INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0,1)),
  access_count       INTEGER NOT NULL DEFAULT 0,
  weight             REAL NOT NULL DEFAULT 1,
  type               TEXT NOT NULL DEFAULT 'situational'
                       CHECK (type IN ('one_off','situational','stable')),
  importance         INTEGER NOT NULL DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
  archived_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_l2_lifecycle ON l2_memories(lifecycle_state);
CREATE INDEX IF NOT EXISTS idx_l2_sync ON l2_memories(sync_status);

-- ── 向量（F5-003 §3；embedding 不建索引）──
CREATE TABLE IF NOT EXISTS l2_vectors (
  memory_id TEXT PRIMARY KEY REFERENCES l2_memories(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL,
  dim       INTEGER NOT NULL,
  dtype     TEXT NOT NULL DEFAULT 'f32' CHECK (dtype IN ('f32','f16'))
);
CREATE TABLE IF NOT EXISTS vec_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ── 冲突日志（S-Phase2 P2-21）──
CREATE TABLE IF NOT EXISTS conflict_log (
  id                  TEXT PRIMARY KEY,
  ts                  INTEGER NOT NULL,
  new_memory_id       TEXT,
  existing_memory_id  TEXT,
  score               INTEGER NOT NULL,
  band                TEXT NOT NULL CHECK (band IN ('high','normal','idle','none')),
  signals             TEXT NOT NULL DEFAULT '{}',
  resolution          TEXT CHECK (resolution IN ('supersede','coexist','reject','none')),
  resolved_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_conflict_ts ON conflict_log(ts);

-- ── 成长（F5-006 §3）──
CREATE TABLE IF NOT EXISTS growth_events (
  id      TEXT PRIMARY KEY,
  ts      INTEGER NOT NULL,
  type    TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_growth_events_ts ON growth_events(ts);
CREATE TABLE IF NOT EXISTS growth_snapshots (
  date TEXT PRIMARY KEY,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS growth_milestones (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL
);

-- ── 迁移审计日志（F5-013 §3，非版本真源）──
CREATE TABLE IF NOT EXISTS migrations_log (
  id          INTEGER PRIMARY KEY,
  app_version TEXT NOT NULL,
  ran_at      INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL
);

-- ── 会话持久化（S-Phase2 P2-43；列对齐 shared/chat ChatMessage）──
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  title      TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content    TEXT NOT NULL,
  reasoning  TEXT,
  status     TEXT NOT NULL,
  error_code TEXT,
  turn_id    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
`

export const migration: Migration = {
  id: 1,
  store: 'db',
  title: 'init: create all Phase 2 tables',
  up({ db }) {
    db.exec(DDL)
  },
  validate({ db }) {
    const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{
      name: string
    }>
    const present = new Set(rows.map((r) => r.name))
    const missing = EXPECTED_TABLES.filter((t) => !present.has(t))
    return missing.length === 0
      ? { ok: true }
      : { ok: false, detail: `missing tables: ${missing.join(', ')}` }
  }
}
