// src/main/memory/extraction/dispatch.ts
// accepted/downgraded 分发，不直接藏 IO 在 Judge 内。依据 S-010 §1.6 分发映射。
//
// 分发映射：
//   L0 -> L0Store.set({field, value:content, certainty:'explicit', attribution:'user_explicit'})
//   L1 -> L1Store.record(content)；P2-05 的现有正则负责 goal/preference 子路由
//   L2 -> MemoryWriter.writeL2（extractionKey 幂等 + L2+vector 同事务）
//
// 跨轮/重启幂等（S-010 §1.6）：
//   - L2 由 extractionKey UNIQUE 承担（writer 层）
//   - L0 由 L0Store.set() 的"same value" no-op 承担
//   - L1 由 L1Store 的"same text"去重承担
//   重复 key 返回 no-op，不增加 revision、不 emit。
//
// 安全红线（F5-011 LogFields 白名单）：
//   - 日志只记 candidateCount、accepted/rejected/downgraded 数、reason code 计数
//   - 不得记 candidate content、quote

import type { Logger } from '@shared/observability/types'
import type { L0Store } from '../l0-store'
import type { L1Store } from '../l1-store'
import type { L2Store, MemorySource } from '../l2-store'
import type { MemoryCandidate, CandidateAttribution } from './candidate'
import { importanceToValue } from './candidate'
import type { JudgeDecision } from './judge'
import type { MemoryWriter, WriteL2Input } from '../writer'
import type { ConflictService } from '../conflict/resolver'

/**
 * P2-37: candidate.attribution -> L2 source 映射。
 *   user_explicit       -> 'user_explicit'（用户明确陈述）
 *   assistant_inferred  -> 'inferred'（模型推断）
 *   mixed               -> 'inferred'（混合来源按推断处理，保守降权）
 */
function attributionToSource(attr: CandidateAttribution): MemorySource {
  if (attr === 'user_explicit') return 'user_explicit'
  return 'inferred'
}

export interface DispatchContext {
  sessionId: string
  turnId: string
}

export interface DispatchResult {
  accepted: number
  downgraded: number
  rejected: number
  /** 逐 reason code 计数 */
  reasonCounts: Record<string, number>
  /** 实际写入的 L2 memoryId 列表（供 growth bridge 用） */
  writtenMemoryIds: readonly string[]
}

export interface MemoryDispatcherDeps {
  l0Store: L0Store
  l1Store: L1Store
  /** L2 存储（用于写入后回读触发冲突检测） */
  l2Store: L2Store
  writer: MemoryWriter
  logger: Logger
  /**
   * 冲突检测服务（可选）。
   * 注入后，每条 L2 写入成功后触发 checkAndResolve（P2-20/21）。
   * 未注入时跳过冲突检测（Phase 2 早期或 memory.enabled=false）。
   */
  conflictService?: ConflictService
}

export interface MemoryDispatcher {
  /**
   * 分发一批 JudgeDecision。只处理 accept/downgrade；reject 只记计数。
   * 每个写入成功后由 writer/store 各自 emit 事件。
   */
  dispatchBatch(decisions: readonly JudgeDecision[], ctx: DispatchContext): Promise<DispatchResult>
}

export function createMemoryDispatcher(deps: MemoryDispatcherDeps): MemoryDispatcher {
  const { l0Store, l1Store, l2Store, writer, logger, conflictService } = deps

  async function dispatchBatch(
    decisions: readonly JudgeDecision[],
    ctx: DispatchContext
  ): Promise<DispatchResult> {
    let accepted = 0
    let downgraded = 0
    let rejected = 0
    const reasonCounts: Record<string, number> = {}
    const writtenMemoryIds: string[] = []

    for (const decision of decisions) {
      reasonCounts[decision.reason] = (reasonCounts[decision.reason] ?? 0) + 1

      if (decision.action === 'reject') {
        rejected++
        continue
      }

      const candidate = decision.accepted

      if (decision.action === 'downgrade') {
        downgraded++
      } else {
        accepted++
      }

      try {
        const memoryId = await dispatchSingle(candidate, ctx)
        if (memoryId) {
          writtenMemoryIds.push(memoryId)
          // L2 写入成功后触发冲突检测（P2-20/21）
          //
          // fire-and-forget：不 await，冲突检测在后台异步进行。
          // 原因：resolver 的 LLM 调用可能耗时数秒到 30s，await 会阻塞
          // extraction 单消费者队列，导致后续轮次的记忆提取延迟。
          // 冲突检测是后置 best-effort（fail-open），不影响已写入的记忆，
          // 也不影响当前轮次的聊天响应--只是延迟旧记忆的归档/软删。
          // 并发风险：多个 checkAndResolve 可能并行运行，但 l2Store.update
          // 是同步的（SQLite 单写者），不会产生数据竞态；最多重复调一次
          // resolver LLM（high band 冲突很少，可接受）。
          if (conflictService) {
            const mem = l2Store.get(memoryId)
            if (mem) {
              void conflictService.checkAndResolve(mem, ctx).catch((e) => {
                logger.warn('conflict check failed for new L2', {
                  scope: 'memory',
                  turnId: ctx.turnId,
                  tags: { reason: e instanceof Error ? e.name : 'unknown' }
                })
              })
            }
          }
        }
      } catch (e) {
        // 单条失败不影响其他；只记元数据
        logger.warn('dispatch single candidate failed', {
          scope: 'memory',
          turnId: ctx.turnId,
          tags: {
            targetLayer: candidate.targetLayer,
            reason: e instanceof Error ? e.name : 'unknown'
          }
        })
      }
    }

    logger.info('extraction dispatch batch', {
      scope: 'memory',
      turnId: ctx.turnId,
      metrics: {
        accepted,
        downgraded,
        rejected,
        written: writtenMemoryIds.length,
        // F5-011 白名单允许 reason code 计数；metrics 值只允许 number/boolean，
        // 故展平为 reason_<CODE> 前缀键。2026-08-20 事件：FORBIDDEN_OVERCLAIM
        // 三连拒在日志里只有 rejected=3，不带 reason 时无法与「模型零候选」区分
        ...Object.fromEntries(
          Object.entries(reasonCounts).map(([code, n]) => [`reason_${code}`, n])
        )
      }
    })

    return { accepted, downgraded, rejected, reasonCounts, writtenMemoryIds }
  }

  /**
   * 分发单个候选到对应 Store。返回写入的 L2 memoryId（L0/L1 返回 null）。
   */
  async function dispatchSingle(
    candidate: MemoryCandidate,
    ctx: DispatchContext
  ): Promise<string | null> {
    if (candidate.targetLayer === 'l0' && candidate.field) {
      // L0 -> L0Store.set
      l0Store.set({
        field: candidate.field,
        value: candidate.content,
        certainty: 'explicit',
        attribution: 'user_explicit'
      })
      return null
    }

    if (candidate.targetLayer === 'l1') {
      // L1 -> L1Store.record
      l1Store.record(candidate.content)
      return null
    }

    // L2 -> MemoryWriter.writeL2
    const input: WriteL2Input = {
      content: candidate.content,
      confidence: candidate.confidence,
      evidenceIds: dedupe(candidate.evidence.map((e) => e.messageId)),
      sourceMessageIds: dedupe(candidate.evidence.map((e) => e.messageId)),
      triggerText: candidate.evidence[0]?.quote ?? null,
      type: candidate.memoryType ?? 'situational',
      importance: importanceToValue(candidate.importance),
      // P2-37: attribution -> source 映射（user_explicit / inferred）
      source: attributionToSource(candidate.attribution),
      // extractionKey 由 writer 内部计算（需要 sourceMessageId + fieldOrType + content）
      sourceMessageId: candidate.evidence[0]?.messageId ?? '',
      fieldOrType: candidate.memoryType ?? 'situational'
    }
    const result = await writer.writeL2(input, ctx)
    return result.memoryId
  }

  return { dispatchBatch }
}

function dedupe(arr: readonly string[]): string[] {
  return [...new Set(arr)]
}
