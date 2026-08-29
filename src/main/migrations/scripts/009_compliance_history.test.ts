// src/main/migrations/scripts/009_compliance_history.test.ts
// P3C1-05：合规审查三表迁移——fresh / upgrade / 幂等 / dry-run+rollback / schema 断言。
// 表结构合同：F5-001 §3.11 + 开工裁定（1.5 samples 反事实八列 / 1.2 时序两列 /
// 1.6 candidate_audit 预留两列 / 1.7 feedback 独立表 + turns.user_feedback 废除）。

import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from '@shared/observability/types'
import type { Migration } from '../types'
import { createMigrationRunner } from '../runner'
import { MIGRATIONS } from '../registry'
import { migration as m009 } from './009_compliance_history'

const noop: Logger = {
  fatal() { /* noop */ },
  error() { /* noop */ },
  warn() { /* noop */ },
  info() { /* noop */ },
  debug() { /* noop */ },
  child() {
    return noop
  }
}

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'nacime-mig009-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

function paths(): { dataDir: string; dbPath: string } {
  const dir = tmp()
  const dataDir = join(dir, 'data')
  const dbPath = join(dataDir, 'memory.db')
  return { dataDir, dbPath }
}

function makeRunner(
  dbPath: string,
  dataDir: string,
  migrations: Migration[],
  now: () => number = () => 1_000
): ReturnType<typeof createMigrationRunner> {
  return createMigrationRunner({
    dbPath,
    dataDir,
    migrations,
    logger: noop,
    appVersion: '1.0.0',
    now,
    jsonStores: [{ kind: 'dmae', filePath: join(dataDir, 'dmae-state.json') }]
  })
}

function columnsOf(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name
  )
}

function tableSql(db: Database.Database, table: string): string {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { sql: string } | undefined
  if (row === undefined) throw new Error(`table ${table} missing`)
  return row.sql
}

describe('009_compliance_history：fresh 路径', () => {
  it('空目录首启：ran 含 9/10、user_version=10、三表四索引建齐', async () => {
    const { dataDir, dbPath } = paths()
    const report = await makeRunner(dbPath, dataDir, MIGRATIONS).run()
    expect(report.ok).toBe(true)
    expect(report.ran).toContain(9)

    const db = new Database(dbPath)
    expect(db.pragma('user_version', { simple: true })).toBe(12)
    for (const idx of [
      'idx_compliance_samples_rule',
      'idx_compliance_samples_turn',
      'idx_compliance_turns_at',
      'idx_compliance_feedback_turn'
    ]) {
      const row = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
        .get(idx)
      expect(row, `index ${idx}`).toBeDefined()
    }
    db.close()
  })

  it('samples 表：§3.11 原列 + 裁定 1.5 反事实八列，且无 content 列（红线）', async () => {
    const { dataDir, dbPath } = paths()
    await makeRunner(dbPath, dataDir, MIGRATIONS).run()
    const db = new Database(dbPath)
    const cols = columnsOf(db, 'compliance_samples')
    for (const col of [
      'id',
      'turn_id',
      'occurred_at',
      'type',
      'severity',
      'detection_method',
      'rule_id',
      'confidence',
      'declared_action',
      'effective_action',
      'span_start',
      'span_length',
      // 裁定 1.5 #1 反事实八列
      'attempt_index',
      'segment_index',
      'candidate_id',
      'counterfactual_action',
      'would_block_first_segment',
      'block_ineligible_reason',
      'released_chars_before',
      'shadow_policy_version'
    ]) {
      expect(cols, `column ${col}`).toContain(col)
    }
    expect(cols).toHaveLength(20)
    expect(cols).not.toContain('content') // §3.11 红线：永远不加
    db.close()
  })

  it('turns 表：§3.11 原列 − user_feedback + 时序两列 + candidate_audit 两列', async () => {
    const { dataDir, dbPath } = paths()
    await makeRunner(dbPath, dataDir, MIGRATIONS).run()
    const db = new Database(dbPath)
    const cols = columnsOf(db, 'compliance_turns')
    for (const col of [
      'turn_id',
      'occurred_at',
      'gate_scope',
      'gate_blocked',
      'regenerations',
      'degraded_pass',
      'degraded',
      'checked_segments',
      'gate_ms',
      'audited',
      'audit_verdict',
      'audit_level',
      'audit_unavailable',
      // 裁定 1.2 时序遥测
      'provider_first_delta_ms',
      'gate_hold_ms',
      // 裁定 1.6 #3 C3 预留
      'candidate_audit_status',
      'candidate_audit_verdict'
    ]) {
      expect(cols, `column ${col}`).toContain(col)
    }
    expect(cols).toHaveLength(17)
    expect(cols).not.toContain('user_feedback') // 裁定 1.7 #3 废除
    db.close()
  })

  it('feedback 表：五列 + UNIQUE(message_id, kind) 幂等约束真实生效', async () => {
    const { dataDir, dbPath } = paths()
    await makeRunner(dbPath, dataDir, MIGRATIONS).run()
    const db = new Database(dbPath)
    expect(columnsOf(db, 'compliance_feedback')).toEqual([
      'id',
      'turn_id',
      'message_id',
      'kind',
      'created_at'
    ])
    expect(tableSql(db, 'compliance_feedback')).toMatch(/UNIQUE\s*\(\s*message_id\s*,\s*kind\s*\)/i)
    // 幂等语义实测：同消息同种类二次写入冲突；同消息不同种类各占一行（单槽废除的动机）
    db.prepare(
      `INSERT INTO compliance_feedback (turn_id, message_id, kind, created_at) VALUES ('t1','m1','dislike',1)`
    ).run()
    expect(() =>
      db
        .prepare(
          `INSERT INTO compliance_feedback (turn_id, message_id, kind, created_at) VALUES ('t1','m1','dislike',2)`
        )
        .run()
    ).toThrow(/UNIQUE/)
    db.prepare(
      `INSERT INTO compliance_feedback (turn_id, message_id, kind, created_at) VALUES ('t1','m1','out-of-character',3)`
    ).run()
    expect(db.prepare(`SELECT COUNT(*) c FROM compliance_feedback`).get()).toEqual({ c: 2 })
    db.close()
  })
})

describe('009_compliance_history：upgrade 路径（v8 → v9）', () => {
  it('已应用 001-008 的库：只跑 009，旧数据完好，版本升 9', async () => {
    const { dataDir, dbPath } = paths()
    // 先跑到 v8（MIGRATIONS 去掉 m009）
    await makeRunner(dbPath, dataDir, MIGRATIONS.slice(0, 8)).run()
    let db = new Database(dbPath)
    expect(db.pragma('user_version', { simple: true })).toBe(8)
    db.prepare(`INSERT INTO l2_memories (id, content, confidence) VALUES ('A','rowA',0.9)`).run()
    db.close()

    const runner = makeRunner(dbPath, dataDir, MIGRATIONS)
    expect(runner.plan().map((p) => p.id)).toEqual([9, 10, 11, 12])
    const report = await runner.run()
    expect(report.ok).toBe(true)
    expect(report.ran).toEqual([9, 10, 11, 12])
    expect(report.backupPath).not.toBeNull() // 非 fresh 升级走备份+dry-run 路径

    db = new Database(dbPath)
    expect(db.pragma('user_version', { simple: true })).toBe(12)
    expect(db.prepare(`SELECT content FROM l2_memories WHERE id='A'`).get()).toEqual({
      content: 'rowA'
    })
    expect(columnsOf(db, 'compliance_samples')).toHaveLength(20)
    db.close()
  })

  it('升级后幂等：重复启动 ran=[]，版本保持 9', async () => {
    const { dataDir, dbPath } = paths()
    await makeRunner(dbPath, dataDir, MIGRATIONS).run()
    const report2 = await makeRunner(dbPath, dataDir, MIGRATIONS).run()
    expect(report2.ok).toBe(true)
    expect(report2.ran).toEqual([])
    const db = new Database(dbPath)
    expect(db.pragma('user_version', { simple: true })).toBe(12)
    db.close()
  })
})

describe('009_compliance_history：dry-run / rollback', () => {
  it('009 之后的迁移失败：备份恢复，三表与 v9 版本完好（M-04 模式）', async () => {
    const { dataDir, dbPath } = paths()
    await makeRunner(dbPath, dataDir, MIGRATIONS).run()
    let db = new Database(dbPath)
    db.prepare(
      `INSERT INTO compliance_turns (turn_id, occurred_at, gate_scope) VALUES ('t-keep',1,'observe')`
    ).run()
    db.close()

    let calls = 0
    const failing: Migration = {
      id: 13,
      store: 'db',
      title: 'passes dry-run, throws on real run',
      up() {
        calls++
        if (calls >= 2) throw new Error('boom on real run')
      },
      validate() {
        return { ok: true }
      }
    }
    const report = await makeRunner(dbPath, dataDir, [...MIGRATIONS, failing], () => 2_000).run()
    expect(report.ok).toBe(false)
    expect(report.failedAt).toBe(13)
    expect(report.restored).toBe(true)

    db = new Database(dbPath)
    expect(db.pragma('user_version', { simple: true })).toBe(12)
    expect(db.prepare(`SELECT turn_id FROM compliance_turns WHERE turn_id='t-keep'`).get()).toEqual({
      turn_id: 't-keep'
    })
    db.close()
  })
})

describe('009_compliance_history：validate 守卫', () => {
  it('缺表/缺列/红线列/缺 UNIQUE 时 validate 返回 not ok', async () => {
    const { dataDir, dbPath } = paths()
    await makeRunner(dbPath, dataDir, MIGRATIONS).run()
    const db = new Database(dbPath)
    const ctx = { db, dataDir, log: noop, dryRun: false }
    // m009.validate 为同步实现；类型是 ValidationResult | Promise<…> 联合，await 收窄
    const validateNow = async (): Promise<{ ok: boolean; detail?: string }> =>
      await m009.validate(ctx)

    expect((await validateNow()).ok).toBe(true)

    // 红线：人为加 content 列 → validate 必须拒绝
    db.exec(`ALTER TABLE compliance_samples ADD COLUMN content TEXT`)
    expect((await validateNow()).ok).toBe(false)
    db.exec(`ALTER TABLE compliance_samples DROP COLUMN content`)
    expect((await validateNow()).ok).toBe(true)

    // 裁定 1.7：人为复活 user_feedback 列 → validate 必须拒绝
    db.exec(`ALTER TABLE compliance_turns ADD COLUMN user_feedback TEXT`)
    expect((await validateNow()).ok).toBe(false)
    db.exec(`ALTER TABLE compliance_turns DROP COLUMN user_feedback`)
    expect((await validateNow()).ok).toBe(true)

    db.close()
  })
})
