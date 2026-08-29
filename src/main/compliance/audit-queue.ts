// src/main/compliance/audit-queue.ts
// 合规审计有界队列（F5-001 §3.6；P3C1-06 落地）。
//
// 「复用 extraction 的形状，不复用它的实例」（§3.6）：有界单消费者、同 turnId 幂等、
// 满则丢最旧。形状与 memory/extraction/queue.ts 对齐，语义差异：
//   1. 容量 16（§3.6；extraction 是 24）。
//   2. 满溢出除 droppedOverflow 计数外另发 compliance.audit.dropped 指标（§3.6 失败表命名）。
//   3. dequeue 即从去重集摘除——已完成/进行中的 turn 允许再次入队：
//      dislike 补审（§3.6/§3.7，P3C1-07 落地）需要在首轮审计完成后再次送审同一 turn；
//      「重复入队幂等」只约束**仍在队列里**的重复（§3.6 失败表）。
//   4. 任务携带完整 ComplianceAuditInput（hook 在 turn.end 时点已从 SessionStore 装配好文本），
//      消费者不回调 SessionStore——用户删轮不影响已入队任务（与 extraction 任务携带
//      userContent 同一取舍）。
//
// ⚠️ 这不是裁定 1.6 的 BlockedCandidateReview 队列——那是 C3 被拦候选（attempt 0 文本）
//    的仅内存队列，C1/C2 明确不建。本队列是常规后台审计任务的缓冲，两边文本都来自
//    正常 SessionStore。

import type { Logger, MetricsRegistry } from '@shared/observability/types'
import type { ComplianceAuditInput } from './auditor'

/** 入队原因（观测/调试用；不落库）。dislike 补审由 P3C1-07 feedback 通路直接入队。 */
export type ComplianceAuditEnqueueReason = 'sampled' | 'would-block' | 'dislike'

export interface ComplianceAuditTask {
  readonly turnId: string
  readonly sessionId: string
  /** hook 时点装配好的完整审计输入（文本来自正常 SessionStore）。 */
  readonly input: ComplianceAuditInput
  readonly reason: ComplianceAuditEnqueueReason
  readonly enqueueSequence: number
}

export interface ComplianceAuditQueueOptions {
  /** 最大待处理任务数。默认 16（§3.6）。 */
  readonly maxPending?: number
  readonly logger?: Logger
  readonly metrics?: MetricsRegistry
}

export interface ComplianceAuditQueue {
  /** 入队一个任务。仍在队列中的同 turnId 幂等去重；满时丢最旧。返回是否成功入队。 */
  enqueue(task: Omit<ComplianceAuditTask, 'enqueueSequence'>): boolean
  /** 取下一个任务（FIFO）。取出的 turnId 离开去重集（允许完成后补审再入队）。 */
  dequeue(): ComplianceAuditTask | null
  /** 当前待处理任务数 */
  pending(): number
  /**
   * 丢弃当前待处理任务但保持队列可用（动态撤销/kill switch 用）。
   * 返回丢弃数；与 close 不同，之后重新启用采集可以继续 enqueue。
   */
  clearPending(): number
  /** 标记关闭：不再接受新任务 */
  close(): void
  /** 是否已关闭 */
  isClosed(): boolean
  /** 因队列满被丢弃的任务计数（仅记计数，不记内容） */
  droppedOverflow(): number
}

/**
 * 创建合规审计有界队列。
 * 满时丢最旧未开始任务：droppedOverflow 计数 + compliance.audit.dropped 指标 + warn（无正文）。
 */
export function createComplianceAuditQueue(opts: ComplianceAuditQueueOptions = {}): ComplianceAuditQueue {
  const maxPending = opts.maxPending ?? 16
  const logger = opts.logger
  const metrics = opts.metrics
  let tasks: ComplianceAuditTask[] = []
  let sequence = 0
  let closed = false
  let droppedOverflow = 0
  const seenTurnIds = new Set<string>()

  return {
    enqueue(task) {
      if (closed) return false
      // 仍在队列中的同 turnId 幂等去重
      if (seenTurnIds.has(task.turnId)) return false
      // 满时丢最旧
      if (tasks.length >= maxPending) {
        const oldest = tasks.shift()
        if (oldest) {
          seenTurnIds.delete(oldest.turnId)
          droppedOverflow++
          try {
            metrics?.counter('compliance.audit.dropped').inc()
          } catch {
            /* metrics 抛错不影响队列行为 */
          }
          try {
            logger?.warn('compliance audit queue overflow; dropped oldest task', {
              scope: 'compliance',
              turnId: oldest.turnId,
              metrics: { droppedOverflow, pending: tasks.length }
            })
          } catch {
            /* logger 抛错不影响队列行为 */
          }
        }
      }
      const full: ComplianceAuditTask = { ...task, enqueueSequence: sequence++ }
      tasks.push(full)
      seenTurnIds.add(task.turnId)
      return true
    },

    dequeue() {
      const next = tasks.shift()
      if (next) {
        seenTurnIds.delete(next.turnId)
      }
      return next ?? null
    },

    pending() {
      return tasks.length
    },

    clearPending() {
      const dropped = tasks.length
      tasks = []
      seenTurnIds.clear()
      return dropped
    },

    close() {
      closed = true
      tasks = []
      seenTurnIds.clear()
    },

    isClosed() {
      return closed
    },

    droppedOverflow() {
      return droppedOverflow
    }
  }
}
