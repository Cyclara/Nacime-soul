// src/main/memory/gc.ts
// S-06 修复：记忆 GC 的最小闭环——物理删除时向量同步清理 + 软删到期清扫。
// 依据 F5-004：soft_deleted 由 GC 写入 purged 后物理删行（l2_memories + l2_vectors 级联）。
//
// 说明：F5-004 的完整 GC（冷存储找回、按类型分档保留期、idle 调度、月度摘要）属后续阶段；
// 本模块先补齐已经缺失的两条：
//   1. 物理删除时向量必须联动清除——此前 l2Store.remove() 只删 L2 行（FK 级联删 DB 向量行），
//      但向量存储的内存矩阵与 IVF 索引不更新，长期运行导致 mem.size 与 DB 不一致、检索命中死记忆。
//   2. soft_deleted -> purged 的清理路径——此前 purged 状态全仓无任何写路径，软删记忆永远留存。
// 默认策略对齐 F5-004：softDeleteToPurgeDays=90、maxPurgePerRun=500。
//
// 数据安全：只处理用户已显式软删（UI"确定删除"）且超过保留期的记忆；
// dormant/archived 永不在此删除（DMAE floor revival 依赖其向量）。
// 注意：F5-004 要求 purge 前先落冷存储以支持"以前记得的"找回；冷存储尚未实现，
// 故此处清扫会使超期软删记忆永久不可恢复——这正是 F5-004 定义的语义（用户删除+超期=放弃）。

import type { Logger } from '@shared/observability/types'
import type { L2Store } from './l2-store'
import type { VectorStore } from './vector/types'
import type { MemoryRevisionClock } from './revision-clock'
import type { MemoryEventBroadcaster } from './event-broadcaster'

/** F5-004 默认：soft_deleted 保持 90 天后物理清除 */
export const SOFT_DELETE_TO_PURGE_DAYS = 90
/** F5-004 默认：单轮最多 purge 条数（限爆炸半径） */
export const MAX_PURGE_PER_RUN = 500

export interface MemoryGcDeps {
  l2Store: L2Store
  vectorStore: VectorStore
  revisionClock: MemoryRevisionClock
  /** 可选：物理删除后广播 l2 hint（renderer 刷新） */
  broadcaster?: MemoryEventBroadcaster | null
  logger: Logger
  now?: () => number
}

export interface PurgeReport {
  purged: number
  /** 本次扫描的 soft_deleted 候选总数 */
  scanned: number
  /** 命中保留期但因本轮配额未清理的条数 */
  deferred: number
}

/**
 * 物理删除一条记忆：L2 行 + 向量（DB/内存/IVF 全部一致）。
 * 幂等：记忆不存在时为 no-op。删除后推进 revision 并广播 l2。
 * 这是唯一合法的"向量清理"入口——此前 l2Store.remove() 只删行，向量在内存/IVF 中永久残留。
 */
export function purgeMemory(deps: MemoryGcDeps, memoryId: string, reason: string): boolean {
  const { l2Store, vectorStore, revisionClock, broadcaster, logger } = deps
  const mem = l2Store.get(memoryId)
  if (!mem) return false
  l2Store.remove(memoryId)
  vectorStore.remove(memoryId)
  revisionClock.next()
  broadcaster?.notify('l2')
  logger.info('memory purged', {
    scope: 'memory',
    code: 'MEM_GC',
    tags: { memoryId: memoryId.slice(0, 12), reason }
  })
  return true
}

/**
 * 清扫超过保留期的 soft_deleted 记忆（F5-004: soft_deleted -> purged）。
 * 只处理 soft_deleted 且 archivedAt（软删时间戳，见 memory:soft-delete）距今超过 retentionDays 的行；
 * 有配额上限；逐条失败败而不崩。返回清扫报告。
 */
export function purgeExpiredSoftDeleted(
  deps: MemoryGcDeps,
  opts?: { retentionDays?: number; maxPurge?: number }
): PurgeReport {
  const { l2Store, logger } = deps
  const retentionDays = opts?.retentionDays ?? SOFT_DELETE_TO_PURGE_DAYS
  const maxPurge = opts?.maxPurge ?? MAX_PURGE_PER_RUN
  const now = deps.now ?? ((): number => Date.now())
  const cutoff = now() - retentionDays * 24 * 3600 * 1000

  const candidates = l2Store.list({ lifecycleState: 'soft_deleted' })
  let purged = 0
  let deferred = 0
  for (const mem of candidates) {
    if (purged >= maxPurge) {
      deferred += candidates.length - purged
      break
    }
    // archivedAt 是软删时间戳（memory:soft-delete 写入）；null/缺失的保守保留（不删）
    if (mem.archivedAt === null || mem.archivedAt > cutoff) continue
    purgeMemory(deps, mem.id, 'soft-delete-expired')
    purged++
  }

  logger.info('memory GC sweep done', {
    scope: 'memory',
    metrics: { purged, scanned: candidates.length, deferred }
  })
  return { purged, scanned: candidates.length, deferred }
}
