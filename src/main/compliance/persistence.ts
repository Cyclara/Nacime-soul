// src/main/compliance/persistence.ts
// 合规观测数据落库 sink（F5-001 §3.11 + 开工裁定 1.4/1.5/1.7；P3C1-08 落地）。
//
// 三条写入纪律（§3.11，裁定 1.7 #3 改写后）：
//   1. compliance_turns 的行在 TURN_END 时 INSERT（ChatService finally 里经集成层调用），
//      审计结果与用户反馈都是后来的 UPDATE/独立表 INSERT。不等审计完成再插。
//   2. compliance_samples 由 350 审计 hook 第一步批写（裁定 1.4 #4「同 hook、先写行再
//      决定采样审计」）--records 来自 TurnEndData.complianceRecords（regex 来源）；
//      llm 来源的行由审计器完成时异步补写（detection_method='llm'、rule_id NULL）。
//   3. 90 天滚动删除按 turn_id 级联（启动时清一次），三表一起清，不留孤儿。
//
// 红线（§3.11 + 台账 §5）：compliance_samples 永远没有 content 列--本模块只写
// id/偏移/枚举/时序计数，**任何正文字段都不经过这里**。模型自由文本 rationale
// 只短暂存在于 auditor 结果对象，严禁经过本 persistence sink（不能相信模型不摘录正文）。
//
// 失败语义：DB 真实故障（磁盘满等）向上抛，由接线层（setup.ts）catch + warn
// --fail-open：合规写库失败绝不影响聊天终局（F5-001 §6.2 #3）。
// retryTurn 复用 turnId（验收反馈④c）：turns 行用 INSERT OR REPLACE，
// 重试轮的结论覆盖首次失败轮（同轮只留最新一次终局，与消息表行为一致）。

import type { Database } from 'better-sqlite3'
import type { Logger } from '@shared/observability/types'
import type { ComplianceDecisionRecord } from '@shared/compliance/types'
import type { ComplianceAuditResult } from './auditor'

/** regex 来源样本行（由 DecisionRecord + 规则元数据组装，见 setup.ts writeSamples）。 */
export interface ComplianceSampleRow {
  readonly turnId: string
  readonly occurredAt: number
  readonly type: string
  readonly severity: string
  readonly detectionMethod: 'regex' | 'llm'
  readonly ruleId: string | null
  readonly confidence: number
  readonly declaredAction: string
  readonly effectiveAction: string
  readonly spanStart: number | null
  readonly spanLength: number | null
  readonly attemptIndex: number
  readonly segmentIndex: number | null
  readonly candidateId: string | null
  readonly counterfactualAction: string | null
  readonly wouldBlockFirstSegment: number | null
  readonly blockIneligibleReason: string | null
  readonly releasedCharsBefore: number | null
  readonly shadowPolicyVersion: string | null
}

/** compliance_turns 行（§3.11 纪律 1：TURN_END 时点 INSERT）。 */
export interface ComplianceTurnRowInput {
  readonly turnId: string
  readonly occurredAt: number
  readonly gateScope: string
  readonly blocked: boolean
  readonly regenerations: 0 | 1
  readonly degradedPass: boolean
  readonly degraded: boolean
  readonly checkedSegments: number
  readonly gateMs: number
  readonly providerFirstDeltaMs: number | null
  readonly gateHoldMs: number | null
}

export interface CompliancePersistence {
  /** TURN_END 时点写 turns 行（裁定 1.2 时序遥测两列一并落库）。成功 true；真实 DB 故障抛出。 */
  recordTurn(row: ComplianceTurnRowInput): true
  /**
   * 批写 regex 来源 samples（hook 第一步；事务包裹）。仅在**所有** rows 的 parent turn 存在时写；
   * 缺任一 parent 返回 false，绝不产生孤儿 sample。空数组 true。
   */
  recordSamples(rows: readonly ComplianceSampleRow[]): boolean
  /**
   * 审计完成回填（异步、晚于行创建）：原子 UPDATE turns + 补写 llm 来源 sample 行。
   * parent turns 行不存在（门控关闭轮/清理竞态/前序 insert 失败）返回 false，**不得写 llm 孤儿行**。
   */
  recordAuditResult(turnId: string, result: ComplianceAuditResult, occurredAt: number): boolean
  /** 90 天滚动删除（turn_id 级联清三表 + 孤儿行）。返回各表删除行数。 */
  purgeStale(
    nowMs: number,
    retentionDays?: number
  ): { turns: number; samples: number; feedback: number }
}

/** 默认保留期（§3.11 纪律 3：90 天，与 F5-002 dmae_turns 一致）。 */
export const COMPLIANCE_RETENTION_DAYS = 90

/** llm 来源行的动作列常量（C1：审计无动作语义，两列都写 'flag' 占位；rule_id 恒 NULL）。 */
const LLM_ROW_ACTION = 'flag'

export function createCompliancePersistence(deps: {
  db: Database
  logger?: Logger
}): CompliancePersistence {
  const stmts = {
    insertTurn: deps.db.prepare(
      `INSERT OR REPLACE INTO compliance_turns
         (turn_id, occurred_at, gate_scope, gate_blocked, regenerations,
          degraded_pass, degraded, checked_segments, gate_ms,
          provider_first_delta_ms, gate_hold_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    turnExists: deps.db.prepare(`SELECT 1 AS one FROM compliance_turns WHERE turn_id = ?`),
    insertSample: deps.db.prepare(
      `INSERT INTO compliance_samples
         (turn_id, occurred_at, type, severity, detection_method, rule_id, confidence,
          declared_action, effective_action, span_start, span_length,
          attempt_index, segment_index, candidate_id, counterfactual_action,
          would_block_first_segment, block_ineligible_reason, released_chars_before,
          shadow_policy_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    updateAudit: deps.db.prepare(
      `UPDATE compliance_turns
         SET audited = 1, audit_verdict = ?, audit_level = ?, audit_unavailable = ?
       WHERE turn_id = ?`
    ),
    purgeTurns: deps.db.prepare(`DELETE FROM compliance_turns WHERE occurred_at < ?`),
    purgeOrphanSamples: deps.db.prepare(
      `DELETE FROM compliance_samples
         WHERE turn_id NOT IN (SELECT turn_id FROM compliance_turns)`
    ),
    purgeOrphanFeedback: deps.db.prepare(
      `DELETE FROM compliance_feedback
         WHERE turn_id NOT IN (SELECT turn_id FROM compliance_turns)`
    )
  }
  const insertSamplesTx = deps.db.transaction((rows: readonly ComplianceSampleRow[]): boolean => {
    // 写入纪律：parent turn 必须已经由 ChatService TURN_END INSERT 成功创建。
    // 事务内先完整检查，任一缺失时整个 batch zero-write，避免半批孤儿。
    for (const r of rows) {
      if (stmts.turnExists.get(r.turnId) === undefined) return false
    }
    for (const r of rows) {
      stmts.insertSample.run(
        r.turnId,
        r.occurredAt,
        r.type,
        r.severity,
        r.detectionMethod,
        r.ruleId,
        r.confidence,
        r.declaredAction,
        r.effectiveAction,
        r.spanStart,
        r.spanLength,
        r.attemptIndex,
        r.segmentIndex,
        r.candidateId,
        r.counterfactualAction,
        r.wouldBlockFirstSegment,
        r.blockIneligibleReason,
        r.releasedCharsBefore,
        r.shadowPolicyVersion
      )
    }
    return true
  })
  const recordAuditResultTx = deps.db.transaction(
    (turnId: string, result: ComplianceAuditResult, occurredAt: number): boolean => {
      // Parent check and UPDATE reside in the same SQLite transaction as child inserts:
      // any child write failure rolls the UPDATE back, preserving evidence consistency.
      if (stmts.turnExists.get(turnId) === undefined) return false
      const update = stmts.updateAudit.run(
        result.unavailable ? null : result.verdict,
        result.unavailable ? null : result.level,
        result.unavailable ? 1 : 0,
        turnId
      )
      if (update.changes !== 1) return false
      for (const v of result.violations) {
        stmts.insertSample.run(
          turnId,
          occurredAt,
          v.type,
          v.severity,
          'llm',
          null,
          v.confidence,
          LLM_ROW_ACTION,
          LLM_ROW_ACTION,
          null,
          null,
          0,
          null,
          null,
          null,
          null,
          null,
          null,
          null
        )
      }
      return true
    }
  )

  function recordTurn(row: ComplianceTurnRowInput): true {
    stmts.insertTurn.run(
      row.turnId,
      row.occurredAt,
      row.gateScope,
      row.blocked ? 1 : 0,
      row.regenerations,
      row.degradedPass ? 1 : 0,
      row.degraded ? 1 : 0,
      row.checkedSegments,
      row.gateMs,
      row.providerFirstDeltaMs,
      row.gateHoldMs
    )
    return true
  }

  function recordSamples(rows: readonly ComplianceSampleRow[]): boolean {
    if (rows.length === 0) return true
    return insertSamplesTx(rows)
  }

  function recordAuditResult(
    turnId: string,
    result: ComplianceAuditResult,
    occurredAt: number
  ): boolean {
    // Parent turns row is a hard prerequisite; transaction prevents partial UPDATE/sample results.
    return recordAuditResultTx(turnId, result, occurredAt)
  }

  function purgeStale(
    nowMs: number,
    retentionDays: number = COMPLIANCE_RETENTION_DAYS
  ): { turns: number; samples: number; feedback: number } {
    const cutoff = nowMs - retentionDays * 24 * 3600 * 1000
    const turns = stmts.purgeTurns.run(cutoff).changes
    // turn_id 级联（§3.11 纪律 3）：turns 删除后，samples/feedback 里 turn_id 无主的行一并清
    const samples = stmts.purgeOrphanSamples.run().changes
    const feedback = stmts.purgeOrphanFeedback.run().changes
    if (turns + samples + feedback > 0) {
      try {
        deps.logger?.info('compliance history purged (90d rolling)', {
          scope: 'compliance',
          metrics: { turns, samples, feedback }
        })
      } catch {
        /* logger 抛错不影响清理 */
      }
    }
    return { turns, samples, feedback }
  }

  return { recordTurn, recordSamples, recordAuditResult, purgeStale }
}

/** DecisionRecord + 规则元数据（type/severity 来自规则表）-> 样本行。由接线层调用。 */
export function sampleRowFromRecord(
  record: ComplianceDecisionRecord,
  type: string,
  severity: string,
  occurredAt: number
): ComplianceSampleRow {
  return {
    turnId: record.turnId,
    occurredAt,
    type,
    severity,
    detectionMethod: 'regex',
    ruleId: record.ruleId,
    confidence: record.confidence,
    declaredAction: record.declaredAction,
    effectiveAction: record.effectiveAction,
    spanStart: record.span.start,
    spanLength: record.span.length,
    attemptIndex: record.attemptIndex,
    segmentIndex: record.segmentIndex,
    candidateId: record.candidateId,
    counterfactualAction: record.counterfactualAction,
    wouldBlockFirstSegment: record.wouldBlockUnderFirstSegmentPolicy ? 1 : 0,
    blockIneligibleReason: record.blockIneligibleReason ?? null,
    releasedCharsBefore: record.releasedCharsBefore,
    shadowPolicyVersion: record.shadowPolicyVersion
  }
}
