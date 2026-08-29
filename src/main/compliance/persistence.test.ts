// src/main/compliance/persistence.test.ts
// P3C1-08：合规持久化 sink--turns 先行 INSERT / samples 批写 / 审计回填 + llm 行 /
// 90 天级联清理 / retry 轮 REPLACE 语义。
// 依据：F5-001 §3.11 三条写入纪律 + 开工裁定 1.4 #4（llm 行异步补写）+
//      裁定 1.5 #1（反事实八列）/ 1.7 #3（feedback 独立表）。

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { Logger } from '@shared/observability/types'
import type { ComplianceDecisionRecord } from '@shared/compliance/types'
import { migration as m009 } from '../migrations/scripts/009_compliance_history'
import {
  createCompliancePersistence,
  sampleRowFromRecord,
  type ComplianceSampleRow
} from './persistence'
import type { ComplianceAuditResult } from './auditor'

// === 测试辅助 ===

function noopLogger(): Logger {
  const l: Logger = {
    fatal() {
      /* noop */
    },
    error() {
      /* noop */
    },
    warn() {
      /* noop */
    },
    info() {
      /* noop */
    },
    debug() {
      /* noop */
    },
    child: () => l
  }
  return l
}

const dbs: Database.Database[] = []
const tempRoots: string[] = []
afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      db.close()
    } catch {
      /* best-effort */
    }
  }
  for (const root of tempRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  dbs.push(db)
  m009.up({ db, dataDir: '.', log: noopLogger(), dryRun: false })
  return db
}

function record(overrides: Partial<ComplianceDecisionRecord> = {}): ComplianceDecisionRecord {
  return {
    candidateId: 'cand-1',
    turnId: 't-1',
    attemptIndex: 0,
    segmentIndex: 1,
    ruleId: 'R-MR-01',
    span: { start: 12, length: 7 },
    confidence: 0.97,
    declaredAction: 'flag',
    effectiveAction: 'flag',
    counterfactualAction: 'block',
    wouldBlockUnderFirstSegmentPolicy: true,
    blockIneligibleReason: undefined,
    releasedCharsBefore: 5,
    shadowPolicyVersion: 'shadow-v1',
    ...overrides
  }
}

const PASS_AUDIT: ComplianceAuditResult = {
  verdict: 'pass',
  level: 'none',
  violations: [],
  reviewedChars: 10,
  latencyMs: 5,
  unavailable: false
}

const BLOCK_AUDIT: ComplianceAuditResult = {
  verdict: 'block',
  level: 'overt',
  violations: [
    {
      type: 'meta-reference',
      severity: 'critical',
      confidence: 0.9,
      detectionMethod: 'llm'
    }
  ],
  reviewedChars: 10,
  latencyMs: 5,
  unavailable: false
}

// === recordTurn（§3.11 纪律 1：TURN_END 先 INSERT） ===

describe('P3C1-08 persistence：recordTurn', () => {
  it('写入全列（含时序遥测两列），默认审计列为 NULL', () => {
    const db = makeDb()
    const p = createCompliancePersistence({ db })
    p.recordTurn({
      turnId: 't-1',
      occurredAt: 1000,
      gateScope: 'observe',
      blocked: false,
      regenerations: 0,
      degradedPass: false,
      degraded: false,
      checkedSegments: 3,
      gateMs: 1.5,
      providerFirstDeltaMs: 210,
      gateHoldMs: 0
    })
    const row = db.prepare(`SELECT * FROM compliance_turns WHERE turn_id = 't-1'`).get() as Record<
      string,
      unknown
    >
    expect(row['occurred_at']).toBe(1000)
    expect(row['gate_scope']).toBe('observe')
    expect(row['gate_blocked']).toBe(0)
    expect(row['regenerations']).toBe(0)
    expect(row['degraded_pass']).toBe(0)
    expect(row['degraded']).toBe(0)
    expect(row['checked_segments']).toBe(3)
    expect(row['gate_ms']).toBe(1.5)
    expect(row['provider_first_delta_ms']).toBe(210)
    expect(row['gate_hold_ms']).toBe(0)
    // 审计回填列初始态：未审计（§3.11：审计是后来的 UPDATE）
    expect(row['audited']).toBe(0)
    expect(row['audit_verdict']).toBeNull()
    expect(row['audit_unavailable']).toBe(0)
    // 裁定 1.6 #3：C3 预留列 C1 恒 NULL
    expect(row['candidate_audit_status']).toBeNull()
    expect(row['candidate_audit_verdict']).toBeNull()
  })

  it('时序遥测两列可为 NULL（provider 零 delta 的空回复轮）', () => {
    const db = makeDb()
    const p = createCompliancePersistence({ db })
    p.recordTurn({
      turnId: 't-empty',
      occurredAt: 1000,
      gateScope: 'observe',
      blocked: false,
      regenerations: 0,
      degradedPass: false,
      degraded: false,
      checkedSegments: 0,
      gateMs: 0,
      providerFirstDeltaMs: null,
      gateHoldMs: null
    })
    const row = db
      .prepare(
        `SELECT provider_first_delta_ms, gate_hold_ms FROM compliance_turns WHERE turn_id = 't-empty'`
      )
      .get() as Record<string, unknown>
    expect(row['provider_first_delta_ms']).toBeNull()
    expect(row['gate_hold_ms']).toBeNull()
  })

  it('retryTurn 复用 turnId -> INSERT OR REPLACE（同轮只留最新终局）', () => {
    const db = makeDb()
    const p = createCompliancePersistence({ db })
    p.recordTurn({
      turnId: 't-1',
      occurredAt: 1000,
      gateScope: 'observe',
      blocked: false,
      regenerations: 0,
      degradedPass: false,
      degraded: false,
      checkedSegments: 1,
      gateMs: 0.5,
      providerFirstDeltaMs: null,
      gateHoldMs: null
    })
    p.recordTurn({
      turnId: 't-1',
      occurredAt: 2000,
      gateScope: 'observe',
      blocked: false,
      regenerations: 0,
      degradedPass: false,
      degraded: false,
      checkedSegments: 4,
      gateMs: 2,
      providerFirstDeltaMs: 100,
      gateHoldMs: 0
    })
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM compliance_turns`).get() as { n: number })
      .n
    expect(count).toBe(1)
    const row = db
      .prepare(`SELECT occurred_at, checked_segments FROM compliance_turns WHERE turn_id = 't-1'`)
      .get() as Record<string, unknown>
    expect(row['occurred_at']).toBe(2000)
    expect(row['checked_segments']).toBe(4)
  })

  it('关闭并重开文件数据库后 samples 计数仍存在（C1 验收⑤：跨重启不归零）', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacime-compliance-restart-'))
    tempRoots.push(root)
    const filePath = join(root, 'compliance.db')
    const first = new Database(filePath)
    m009.up({ db: first, dataDir: root, log: noopLogger(), dryRun: false })
    const p1 = createCompliancePersistence({ db: first })
    p1.recordTurn({
      turnId: 't-restart',
      occurredAt: 1000,
      gateScope: 'observe',
      blocked: false,
      regenerations: 0,
      degradedPass: false,
      degraded: false,
      checkedSegments: 1,
      gateMs: 0,
      providerFirstDeltaMs: 1,
      gateHoldMs: 0
    })
    p1.recordSamples([
      sampleRowFromRecord(record({ turnId: 't-restart' }), 'meta-reference', 'critical', 1000)
    ])
    first.close()

    // 模拟应用重启：新进程重新打开同一个 SQLite 文件。
    const restarted = new Database(filePath)
    dbs.push(restarted)
    const count = (
      restarted
        .prepare(`SELECT COUNT(*) AS n FROM compliance_samples WHERE turn_id = 't-restart'`)
        .get() as {
        n: number
      }
    ).n
    expect(count).toBe(1)
  })
})

// === recordSamples（hook 第一步批写；反事实八列全落） ===

describe('P3C1-08 persistence：recordSamples', () => {
  it('sampleRowFromRecord 映射全 20 列（含裁定 1.5 反事实八列）', () => {
    const row = sampleRowFromRecord(record(), 'meta-reference', 'critical', 7777)
    expect(row.turnId).toBe('t-1')
    expect(row.occurredAt).toBe(7777)
    expect(row.type).toBe('meta-reference')
    expect(row.severity).toBe('critical')
    expect(row.detectionMethod).toBe('regex')
    expect(row.ruleId).toBe('R-MR-01')
    expect(row.confidence).toBe(0.97)
    expect(row.declaredAction).toBe('flag')
    expect(row.effectiveAction).toBe('flag')
    expect(row.spanStart).toBe(12)
    expect(row.spanLength).toBe(7)
    expect(row.attemptIndex).toBe(0)
    expect(row.segmentIndex).toBe(1)
    expect(row.candidateId).toBe('cand-1')
    expect(row.counterfactualAction).toBe('block')
    expect(row.wouldBlockFirstSegment).toBe(1)
    expect(row.blockIneligibleReason).toBeNull()
    expect(row.releasedCharsBefore).toBe(5)
    expect(row.shadowPolicyVersion).toBe('shadow-v1')
  })

  it('wouldBlock=false 时 block_ineligible_reason 落枚举值', () => {
    const row = sampleRowFromRecord(
      record({
        wouldBlockUnderFirstSegmentPolicy: false,
        blockIneligibleReason: 'after-first-segment'
      }),
      'meta-reference',
      'critical',
      7777
    )
    expect(row.wouldBlockFirstSegment).toBe(0)
    expect(row.blockIneligibleReason).toBe('after-first-segment')
  })

  it('批写多行进库；空数组 no-op', () => {
    const db = makeDb()
    const p = createCompliancePersistence({ db })
    p.recordTurn({
      turnId: 't-1',
      occurredAt: 1000,
      gateScope: 'observe',
      blocked: false,
      regenerations: 0,
      degradedPass: false,
      degraded: false,
      checkedSegments: 1,
      gateMs: 0,
      providerFirstDeltaMs: null,
      gateHoldMs: null
    })
    const rows: ComplianceSampleRow[] = [
      sampleRowFromRecord(record(), 'meta-reference', 'critical', 1000),
      sampleRowFromRecord(
        record({ ruleId: 'R-AP-01', segmentIndex: 2 }),
        'assistant-persona',
        'warning',
        1000
      )
    ]
    p.recordSamples(rows)
    p.recordSamples([]) // no-op
    const count = (
      db.prepare(`SELECT COUNT(*) AS n FROM compliance_samples`).get() as { n: number }
    ).n
    expect(count).toBe(2)
    const ruleIds = (
      db.prepare(`SELECT rule_id FROM compliance_samples ORDER BY id`) as unknown as {
        all: () => { rule_id: string }[]
      }
    )
      .all()
      .map((r) => r.rule_id)
    expect(ruleIds).toEqual(['R-MR-01', 'R-AP-01'])
  })

  it('表无 content 列（红线守卫，迁回 009 validate）', () => {
    const db = makeDb()
    const cols = (
      db.prepare(`PRAGMA table_info(compliance_samples)`).all() as { name: string }[]
    ).map((c) => c.name)
    expect(cols).not.toContain('content')
    expect(cols).toHaveLength(20)
  })
})

it('regex samples 缺 parent turns 行 -> 返回 false，整批 zero-write（不造孤儿）', () => {
  const db = makeDb()
  const p = createCompliancePersistence({ db })
  const result = p.recordSamples([
    sampleRowFromRecord(record({ turnId: 't-missing' }), 'meta-reference', 'critical', 1000)
  ])
  expect(result).toBe(false)
  const count = (db.prepare(`SELECT COUNT(*) AS n FROM compliance_samples`).get() as { n: number })
    .n
  expect(count).toBe(0)
})

// === recordAuditResult（异步回填 + llm 样本行） ===

describe('P3C1-08 persistence：recordAuditResult', () => {
  function makeTurnedDb(): {
    db: Database.Database
    p: ReturnType<typeof createCompliancePersistence>
  } {
    const db = makeDb()
    const p = createCompliancePersistence({ db })
    p.recordTurn({
      turnId: 't-1',
      occurredAt: 1000,
      gateScope: 'observe',
      blocked: false,
      regenerations: 0,
      degradedPass: false,
      degraded: false,
      checkedSegments: 1,
      gateMs: 0,
      providerFirstDeltaMs: null,
      gateHoldMs: null
    })
    return { db, p }
  }

  it('完成审计回填四列（audited=1 / verdict / level / unavailable=0）', () => {
    const { db, p } = makeTurnedDb()
    p.recordAuditResult('t-1', BLOCK_AUDIT, 2000)
    const row = db
      .prepare(
        `SELECT audited, audit_verdict, audit_level, audit_unavailable FROM compliance_turns WHERE turn_id = 't-1'`
      )
      .get() as Record<string, unknown>
    expect(row['audited']).toBe(1)
    expect(row['audit_verdict']).toBe('block')
    expect(row['audit_level']).toBe('overt')
    expect(row['audit_unavailable']).toBe(0)
  })

  it('unavailable 空壳也入账（§3.11：audit_unavailable=1，verdict/level NULL）', () => {
    const { db, p } = makeTurnedDb()
    const unavailable: ComplianceAuditResult = {
      verdict: 'pass',
      level: 'none',
      violations: [],
      reviewedChars: 10,
      latencyMs: 20_000,
      unavailable: true
    }
    p.recordAuditResult('t-1', unavailable, 2000)
    const row = db
      .prepare(
        `SELECT audited, audit_verdict, audit_unavailable FROM compliance_turns WHERE turn_id = 't-1'`
      )
      .get() as Record<string, unknown>
    expect(row['audited']).toBe(1)
    expect(row['audit_verdict']).toBeNull()
    expect(row['audit_unavailable']).toBe(1)
  })

  it('llm 违规补写 samples 行：detection_method=llm / rule_id NULL / 反事实八列 NULL', () => {
    const { db, p } = makeTurnedDb()
    p.recordAuditResult('t-1', BLOCK_AUDIT, 2000)
    const row = db
      .prepare(`SELECT * FROM compliance_samples WHERE turn_id = 't-1'`)
      .get() as Record<string, unknown>
    expect(row['detection_method']).toBe('llm')
    expect(row['rule_id']).toBeNull()
    expect(row['type']).toBe('meta-reference')
    expect(row['severity']).toBe('critical')
    expect(row['confidence']).toBe(0.9)
    // llm 行无 regex 语义的动作列：两列占位 'flag'（C1 常量）
    expect(row['declared_action']).toBe('flag')
    expect(row['effective_action']).toBe('flag')
    expect(row['span_start']).toBeNull()
    expect(row['counterfactual_action']).toBeNull()
    expect(row['would_block_first_segment']).toBeNull()
    expect(row['shadow_policy_version']).toBeNull()
  })

  it('turns 行不存在（无门控轮/已清理）-> 返回 false，UPDATE 与 llm sample 均 zero-write', () => {
    const { db, p } = makeTurnedDb()
    expect(p.recordAuditResult('t-unknown', BLOCK_AUDIT, 2000)).toBe(false)
    const turns = (db.prepare(`SELECT COUNT(*) AS n FROM compliance_turns`).get() as { n: number })
      .n
    expect(turns).toBe(1) // 只有 t-1，没建新行
    const samples = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM compliance_samples WHERE turn_id = 't-unknown'`)
        .get() as {
        n: number
      }
    ).n
    expect(samples).toBe(0)
  })

  it('pass 无违规 -> 不写 llm 行', () => {
    const { db, p } = makeTurnedDb()
    p.recordAuditResult('t-1', PASS_AUDIT, 2000)
    const samples = (
      db.prepare(`SELECT COUNT(*) AS n FROM compliance_samples`).get() as { n: number }
    ).n
    expect(samples).toBe(0)
  })
})

// === purgeStale（§3.11 纪律 3：90 天滚动，turn_id 级联三表） ===

describe('P3C1-08 persistence：purgeStale', () => {
  it('超期 turns 级联清理 samples/feedback；期内全保留；孤儿行一并清', () => {
    const db = makeDb()
    const p = createCompliancePersistence({ db })
    const day = 24 * 3600 * 1000
    const now = 100 * day
    // 期内轮（保留）
    p.recordTurn({
      turnId: 't-fresh',
      occurredAt: now - 10 * day,
      gateScope: 'observe',
      blocked: false,
      regenerations: 0,
      degradedPass: false,
      degraded: false,
      checkedSegments: 1,
      gateMs: 0,
      providerFirstDeltaMs: null,
      gateHoldMs: null
    })
    // 超期轮（删除）
    p.recordTurn({
      turnId: 't-stale',
      occurredAt: now - 91 * day,
      gateScope: 'observe',
      blocked: false,
      regenerations: 0,
      degradedPass: false,
      degraded: false,
      checkedSegments: 1,
      gateMs: 0,
      providerFirstDeltaMs: null,
      gateHoldMs: null
    })
    p.recordSamples([
      sampleRowFromRecord(
        record({ turnId: 't-stale' }),
        'meta-reference',
        'critical',
        now - 91 * day
      )
    ])
    p.recordSamples([
      sampleRowFromRecord(
        record({ turnId: 't-fresh' }),
        'meta-reference',
        'critical',
        now - 10 * day
      )
    ])
    db.prepare(
      `INSERT INTO compliance_feedback (turn_id, message_id, kind, created_at) VALUES ('t-stale', 'm1', 'dislike', ?)`
    ).run(now - 91 * day)
    // 历史/异常留下的孤儿行：正常 persistence 已拒绝创建，这里用原始 SQL 模拟旧数据，
    // 验证启动 GC 仍能清扫它。
    db.prepare(
      `INSERT INTO compliance_samples
         (turn_id, occurred_at, type, severity, detection_method, confidence, declared_action, effective_action)
       VALUES ('t-orphan', ?, 'meta-reference', 'critical', 'regex', 0.97, 'flag', 'flag')`
    ).run(now)

    const result = p.purgeStale(now)
    expect(result.turns).toBe(1)
    expect(result.samples).toBe(2) // t-stale 的 1 行 + 孤儿 1 行
    expect(result.feedback).toBe(1)

    const turns = (db.prepare(`SELECT COUNT(*) AS n FROM compliance_turns`).get() as { n: number })
      .n
    const samples = (
      db.prepare(`SELECT COUNT(*) AS n FROM compliance_samples`).get() as { n: number }
    ).n
    const feedback = (
      db.prepare(`SELECT COUNT(*) AS n FROM compliance_feedback`).get() as { n: number }
    ).n
    expect(turns).toBe(1)
    expect(samples).toBe(1)
    expect(feedback).toBe(0)
    // 保留的是期内轮的数据
    const kept = db.prepare(`SELECT turn_id FROM compliance_samples`).get() as { turn_id: string }
    expect(kept.turn_id).toBe('t-fresh')
  })
})
