// src/main/compliance/feedback.ts
// 合规用户反馈持久化服务（F5-001 §3.7 + 开工裁定 1.7；P3C1-07 落地）。
//
// 语义（裁定 1.7 修正后的方向）：
//   1. 反馈只作**复核优先级**信号，不是合规违规的因果标签（§3.7 红线）：
//      - dislike：泛化负反馈。新插入时计一次 compliance.userDislike 指标 + 触发一次
//        补审回调（§3.6/§3.7「被 dislike 的轮强制补审」）。
//      - out-of-character：用户指出「这不像她」--**支持违规存在的证据（漏报线索）**，
//        方向与 dislike 相反。恒不计入 dislike 指标、恒不触发补审、恒不被当作规则反证
//        （裁定 1.7 #1/#2：dislikeOnHitTurns 统计必须排除本值；OOC 恒不阻止规则升级）。
//   2. 幂等（§3.7 + 迁移 009 UNIQUE(message_id, kind)）：同消息同 kind 重复上报只计一次；
//      同消息两种 kind 各占一行（单槽列废除的动机，裁定 1.7 #3）。
//   3. 写入纪律（裁定 1.7 #3 改写）：INSERT 前查 compliance_turns 行存在性，不存在静默忽略
//      --门控关闭/数据已清退的轮对 §4.1 统计无意义，不建行、不反馈差异给 renderer。
//   4. 关联校验（防过期/伪造 IPC 请求污染统计）：消息须存在于请求会话、role 为 assistant、
//      turnId 与请求一致；任一不满足静默忽略。feedback 行按 turn_id 进 dislikeOnHitTurns
//      统计，伪造的 (turnId, messageId) 组合会污染该 JOIN，故必须校验到消息级。
//
// 红线：日志只记元数据（kind / outcome / turnId），绝不记消息正文（§3.11）。
// 本服务不触碰规则权重/动作（§3.7：任何 action 变更必须过 §4 人工判据）。
// DB 层真实故障（磁盘满等）向上抛，由 handler 层转 IpcResult error；
// 语义性忽略与重复均对外等价成功（幂等语义不向 renderer 泄漏差异）。

import type { Database } from 'better-sqlite3'
import type { Logger, MetricsRegistry } from '@shared/observability/types'
import type { ChatFeedbackRequest, ComplianceFeedbackKind } from '@shared/compliance/types'
import type { SessionStore } from '../chat/session-store'

/** 语义性忽略原因（仅日志/测试观测用；不落库）。 */
export type ComplianceFeedbackIgnoreReason =
  /** compliance_turns 无该轮行（裁定 1.7 #3：静默忽略，不建行）。 */
  | 'turn-row-missing'
  /** 会话中无此消息（过期/伪造）。 */
  | 'message-not-found'
  /** 消息不是 assistant（feedback 只针对角色回复）。 */
  | 'message-not-assistant'
  /** 消息存在但不属于请求声称的轮（伪造/错位关联）。 */
  | 'turn-mismatch'

export type ComplianceFeedbackOutcome =
  | { readonly status: 'inserted'; readonly kind: ComplianceFeedbackKind }
  | { readonly status: 'duplicate' }
  | { readonly status: 'ignored'; readonly reason: ComplianceFeedbackIgnoreReason }

export interface ComplianceFeedbackDeps {
  /** sessionDb（迁移 009 三表所在库；与 SessionStore 同一连接）。 */
  readonly db: Database
  /** 关联校验用（只 getMessage 读元数据，不写消息表）。 */
  readonly sessionStore: SessionStore
  readonly logger?: Logger
  readonly metrics?: MetricsRegistry
  /**
   * 新插入 dislike 时的补审回调（§3.7 强制补审），每条新 dislike 至多一次；重复上报不触发。
   * P3C1-08 setupCompliance 接线到审计队列（reason='dislike'）；本服务不依赖审计模块。
   * 回调抛错只记元数据 warn，不撤销已落库反馈（反馈持久化优先于补审）。
   */
  readonly onDislike?: (turnId: string, sessionId: string, messageId: string) => void
  /** 测试/确定性时钟；默认 Date.now。 */
  readonly now?: () => number
}

export interface ComplianceFeedbackService {
  /**
   * 记录一条用户反馈。幂等：重复/语义性忽略对外等价成功（handler 恒返回 {ok:true}）。
   * 返回内部 outcome 供日志与测试断言。
   */
  recordFeedback(request: ChatFeedbackRequest): ComplianceFeedbackOutcome
}

export function createComplianceFeedbackService(
  deps: ComplianceFeedbackDeps
): ComplianceFeedbackService {
  const now = deps.now ?? Date.now
  const stmts = {
    turnExists: deps.db.prepare(`SELECT 1 AS one FROM compliance_turns WHERE turn_id = ?`),
    insertFeedback: deps.db.prepare(
      `INSERT OR IGNORE INTO compliance_feedback (turn_id, message_id, kind, created_at)
       VALUES (?, ?, ?, ?)`
    )
  }

  function recordFeedback(request: ChatFeedbackRequest): ComplianceFeedbackOutcome {
    // 1. 裁定 1.7 #3：turns 行不存在 -> 静默忽略（不建行）
    if (stmts.turnExists.get(request.turnId) === undefined) {
      try {
        deps.logger?.debug('compliance feedback ignored: no compliance_turns row', {
          scope: 'compliance',
          turnId: request.turnId,
          tags: { reason: 'turn-row-missing' }
        })
      } catch {
        /* logger 抛错不影响反馈路径 */
      }
      return { status: 'ignored', reason: 'turn-row-missing' }
    }

    // 2. 关联校验：消息存在 + assistant + 轮归属一致（过期/伪造请求静默忽略）
    const message = deps.sessionStore.getMessage(request.sessionId, request.messageId)
    if (message === null) {
      return ignore('message-not-found', request.turnId)
    }
    if (message.role !== 'assistant') {
      return ignore('message-not-assistant', request.turnId)
    }
    if (message.turnId !== request.turnId) {
      return ignore('turn-mismatch', request.turnId)
    }

    // 3. 幂等写入（UNIQUE(message_id, kind) 承载 §3.7 幂等）
    const inserted =
      stmts.insertFeedback.run(request.turnId, request.messageId, request.kind, now())
        .changes === 1
    if (!inserted) {
      try {
        deps.logger?.debug('compliance feedback duplicate; not counted again', {
          scope: 'compliance',
          turnId: request.turnId,
          tags: { kind: request.kind }
        })
      } catch {
        /* logger 抛错不影响反馈路径 */
      }
      return { status: 'duplicate' }
    }

    // 4. 新插入 dislike：指标 +1（一次）+ 补审回调（一次）。
    //    out-of-character 只落库作漏报线索（裁定 1.7：恒不计 dislike 指标、恒不补审）。
    if (request.kind === 'dislike') {
      try {
        deps.metrics?.counter('compliance.userDislike').inc()
      } catch {
        /* metrics 抛错不影响落库 */
      }
      if (deps.onDislike) {
        try {
          deps.onDislike(request.turnId, request.sessionId, request.messageId)
        } catch (e) {
          try {
            deps.logger?.warn(
              'compliance feedback: dislike supplementary-audit callback failed (feedback already persisted)',
              {
                scope: 'compliance',
                turnId: request.turnId,
                tags: { reason: e instanceof Error ? e.name : 'unknown' }
              }
            )
          } catch {
            /* logger 抛错不影响反馈路径 */
          }
        }
      }
    }

    try {
      deps.logger?.debug('compliance feedback recorded', {
        scope: 'compliance',
        turnId: request.turnId,
        tags: { kind: request.kind }
      })
    } catch {
      /* logger 抛错不影响反馈路径 */
    }
    return { status: 'inserted', kind: request.kind }
  }

  function ignore(reason: ComplianceFeedbackIgnoreReason, turnId: string): ComplianceFeedbackOutcome {
    try {
      deps.logger?.debug('compliance feedback ignored: association check failed', {
        scope: 'compliance',
        turnId,
        tags: { reason }
      })
    } catch {
      /* logger 抛错不影响反馈路径 */
    }
    return { status: 'ignored', reason }
  }

  return { recordFeedback }
}
