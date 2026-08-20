// src/main/memory/backfill.ts
// S-05 修复：embedding 暂时不可用时写入的 pending L2 记忆，在 embedding 恢复后回填向量。
//
// 背景：writer.ts 在 embedding 暂时不可用（网络超时/限流/未配置）时写 syncStatus='pending'、
// 零向量，并承诺"以后批量补嵌入"。全仓此前无任何对非 seed 的 pending 行做补嵌入的代码——
// pending 记忆无向量 -> context-assembler 的 L2 链只认向量命中 -> 这类记忆永远进不了 prompt
// （模型变更阻断时整个记忆退化为"只写不读"）。
//
// 本模块在 setup 创建 embeddingClient 后调用：扫描 pending 行 -> embed -> upsert 向量 ->
// 置 synced。幂等：已 synced 的行不在候选；嵌入失败保持 pending，下次启动重试。败而不崩。
//
// 安全红线（F5-011）：日志只记 memoryId 前缀/计数，不记 content。

import type { Logger } from '@shared/observability/types'
import type { L2Store } from './l2-store'
import type { VectorStore } from './vector/types'
import type { EmbeddingClient } from './embedding'
import type { MemoryRevisionClock } from './revision-clock'
import type { MemoryEventBroadcaster } from './event-broadcaster'

export interface BackfillDeps {
  l2Store: L2Store
  vectorStore: VectorStore
  embedding: EmbeddingClient
  revisionClock: MemoryRevisionClock
  /** 可选：有回填时广播 l2 hint（renderer 刷新） */
  broadcaster?: MemoryEventBroadcaster | null
  logger: Logger
  /**
   * 单次启动回填上限。上限控制启动期嵌入成本（每条是一次网络调用）；
   * 超过上限的部分下次启动继续。默认 50。
   */
  limit?: number
}

export interface BackfillResult {
  backfilled: number
  failed: number
  /** 本次因上限未处理的剩余 pending 数 */
  remaining: number
}

/**
 * 把 syncStatus='pending' 的非 seed L2 记忆回填向量。
 * - 调用方只在 embedding 可用时调用（模型变更阻断时跳过，不混算）。
 * - 每条：embed(content) -> vectorStore.upsert -> l2Store.update(syncStatus:'synced')。
 * - 有回填 -> revisionClock.next() + broadcaster.notify('l2')。
 * - 任一条失败只记日志、保持 pending，不中断其余条目、不抛错。
 */
export async function backfillPendingMemories(deps: BackfillDeps): Promise<BackfillResult> {
  const { l2Store, vectorStore, embedding, revisionClock, broadcaster, logger } = deps
  const limit = deps.limit ?? 50

  const pending = l2Store.list({ syncStatus: 'pending', limit })
  if (pending.length === 0) return { backfilled: 0, failed: 0, remaining: 0 }

  let backfilled = 0
  let failed = 0
  for (const mem of pending) {
    try {
      const vec = await embedding.embed(mem.content)
      vectorStore.upsert(mem.id, vec)
      l2Store.update(mem.id, { syncStatus: 'synced' })
      backfilled++
    } catch (e) {
      failed++
      logger.warn('pending memory backfill failed; keeping pending for next retry', {
        scope: 'memory',
        code: 'UNKNOWN',
        tags: { memoryId: mem.id.slice(0, 12) },
        detail: e instanceof Error ? e.message : String(e)
      })
    }
  }

  if (backfilled > 0) {
    revisionClock.next()
    broadcaster?.notify('l2')
  }

  const totalPending = l2Store.count({ syncStatus: 'pending' })
  logger.info('pending L2 memories backfilled', {
    scope: 'memory',
    metrics: { backfilled, failed, remaining: totalPending }
  })

  return { backfilled, failed, remaining: totalPending }
}
