// src/main/memory/seed/apply.ts
// P2-36/37: 把 SeedEntry 写入 L2 记忆（含可选嵌入）。
// 独立成模块：setup.ts 只做接线，本模块可被单测直接覆盖（P2-36/37 审计 🔴 修复，2026-08-11）。
//
// 背景（审计发现）：seed 条目必须有向量才能被检索进 Prompt。
//   context-assembler 的 L2 链严格走「向量检索 → 水合 → selectL2」，无向量（pending）条目
//   永远不会被检索到，activation=100 与 Decay 豁免形同虚设。
//
// 行为：
//   1. 新 seed 条目：embedding 可用 -> 同步嵌入 + upsert 向量（syncStatus='synced'）；
//      embedding 不可用或嵌入失败 -> 'pending'（冻结边界，败而不崩）
//   2. 已有 seed 条目：pending 且 embedding 现可用 -> 回填向量（重启后配置 key 的场景）
//   3. 幂等：extractionKey = 'seed:{filename}'；已 synced 的条目跳过
//   4. 有写入/回填 -> revisionClock.next() + broadcaster.notify('l2')
//
// 安全红线（F5-011）：日志只记 filename/计数，不记 body 内容。

import type { Logger } from '@shared/observability/types'
import type { L2Store, MemorySyncStatus } from '../l2-store'
import type { VectorStore } from '../vector/types'
import type { EmbeddingClient } from '../embedding'
import type { MemoryRevisionClock } from '../revision-clock'
import type { MemoryEventBroadcaster } from '../event-broadcaster'
import type { SeedEntry } from './loader'

/** 最小依赖（setup.ts 注入真实对象；测试注入 mock） */
export interface SeedApplyDeps {
  l2Store: Pick<L2Store, 'getByExtractionKey' | 'add' | 'update'>
  vectorStore: Pick<VectorStore, 'upsert'>
  /** null = embedding 未配置/被阻断（模型变更） -> 全部 pending */
  embedding: EmbeddingClient | null
  revisionClock: Pick<MemoryRevisionClock, 'next'>
  broadcaster: Pick<MemoryEventBroadcaster, 'notify'>
  logger: Logger
}

export interface SeedApplyResult {
  /** 新写入的 seed 条目数 */
  inserted: number
  /** 成功嵌入（含回填）的 seed 条目数 */
  embedded: number
}

/**
 * 把 SeedEntry[] 写入 L2 记忆。
 * 有写入/回填时触发 revision++ + notify('l2')；否则 no-op。
 */
export async function applySeeds(
  entries: readonly SeedEntry[],
  deps: SeedApplyDeps
): Promise<SeedApplyResult> {
  const { l2Store, vectorStore, embedding, revisionClock, broadcaster, logger } = deps

  let inserted = 0
  let embedded = 0

  for (const entry of entries) {
    const existing = l2Store.getByExtractionKey(entry.id)
    if (existing) {
      // 已存在：pending 且 embedding 现可用 -> 回填向量（首次无 key、后配 key 的场景）
      if (existing.syncStatus === 'pending' && embedding) {
        try {
          const vec = await embedding.embed(entry.body)
          vectorStore.upsert(existing.id, vec)
          l2Store.update(existing.id, { syncStatus: 'synced' })
          embedded++
        } catch (e) {
          // 嵌入失败 -> 保持 pending，下次重启回填（败而不崩 + 自愈）
          logger.warn('seed embedding backfill failed; keeping pending', {
            scope: 'memory',
            tags: { filename: entry.filename, reason: e instanceof Error ? e.message : String(e) }
          })
        }
      }
      continue
    }

    // 新 seed 条目：embedding 可用则同步嵌入
    let syncStatus: MemorySyncStatus = 'pending'
    let vec: Float32Array | null = null
    if (embedding) {
      try {
        vec = await embedding.embed(entry.body)
        syncStatus = 'synced'
      } catch (e) {
        logger.warn('seed embedding failed; writing as pending', {
          scope: 'memory',
          tags: { filename: entry.filename, reason: e instanceof Error ? e.message : String(e) }
        })
      }
    }
    const mem = l2Store.add({
      content: entry.body,
      confidence: entry.frontmatter.confidence,
      evidenceIds: [],
      sourceMessageIds: [],
      triggerText: null,
      syncStatus,
      lifecycleState: 'active',
      type: 'stable',
      importance: entry.frontmatter.importance,
      source: entry.frontmatter.source,
      extractionKey: entry.id
    })
    if (vec) {
      vectorStore.upsert(mem.id, vec)
      embedded++
    }
    inserted++
  }

  if (inserted > 0 || embedded > 0) {
    // seed 写入/回填触发 revision++ + 广播
    revisionClock.next()
    broadcaster.notify('l2')
    logger.info('seed memories applied', {
      scope: 'memory',
      metrics: { inserted, embedded, total: entries.length }
    })
  }

  return { inserted, embedded }
}
