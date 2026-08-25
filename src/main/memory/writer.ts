// src/main/memory/writer.ts
// 记忆写入事务：L2 元数据 + 向量同 db.transaction() 提交、revision++、emit l2.added + IPC memory-updated。
// 依据 S-020 §1.6（两条合法原子写路径）、S-022 §1.4（MemoryRevisionClock）。
//
// P2-12 有两条合法原子写路径，不能混为一条：
//   1. embedding 已成功取得：L2 metadata + vector 在同一个 db.transaction() 内写入，
//      commit 后才 revision++/emit；任一失败两表都不留行。
//   2. embedding 未配置（冻结边界）或被策略明确认定为可稍后补偿的暂时不可用：
//      单事务只写 L2 metadata，syncStatus='pending'、零 vector，
//      commit 后正常 revision++/emit；以后批量补嵌入。
//   不可把 pending 路径断言为"memory/vector 都必须 0 行"。
//   401、维度不匹配、模型混算等不可补偿错误按 P2-09 错误策略拒绝，不擅自降为 pending。
//
// 跨轮/重启幂等（S-020 §1.6）：
//   extractionKey = sha256(schemaVersion + targetLayer + sourceMessageId + fieldOrType + NFC(trim(content)))
//   L2 表建立 UNIQUE（002 迁移）。重复 key 返回 no-op，不增加 revision、不 emit。

import { createHash } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { Logger } from '@shared/observability/types'
import { AppError } from '@shared/errors'
import type { L2Store, MemoryType, MemorySource } from './l2-store'
import type { VectorStore } from './vector/types'
import type { EmbeddingClient } from './embedding'
import type { MemoryRevisionClock } from './revision-clock'
import type { MemoryEventBroadcaster } from './event-broadcaster'

export interface WriteL2Input {
  content: string
  confidence: number
  evidenceIds: string[]
  sourceMessageIds: string[]
  triggerText: string | null
  type: MemoryType
  importance: number
  /** P2-37: 记忆来源；默认 'user_explicit'（dispatch 按 attribution 映射） */
  source?: MemorySource
  /** 当前 turn 的 user message ID（extractionKey 输入） */
  sourceMessageId: string
  /** L2 的 memoryType；L0 降级时为原声明值。extractionKey 输入 */
  fieldOrType: string
}

export interface WriteL2Result {
  /** 新写入的 memoryId；null = extractionKey 重复（no-op） */
  memoryId: string | null
  /** 新 revision；0 = no-op */
  revision: number
  /** 是否为 pending 路径（无 vector） */
  pending: boolean
}

export interface MemoryWriterDeps {
  db: Database
  l2Store: L2Store
  vectorStore: VectorStore
  /**
   * embedding 客户端。
   * null = embedding 未配置（冻结边界）-> 走 pending 路径。
   * 生产环境在 wiring 时注入；未配置时为 null。
   */
  embedding: EmbeddingClient | null
  revisionClock: MemoryRevisionClock
  /** P2-29: 记忆事件广播器（L2 写入后 notify('l2')）。可选，测试可不传 */
  broadcaster?: MemoryEventBroadcaster | null
  logger: Logger
}

export interface MemoryWriter {
  /**
   * 写入一条 L2 记忆 + 向量（同事务）。
   * extractionKey 重复时 no-op（不增 revision、不 emit）。
   * embedding 不可用时走 pending 路径（只写 metadata，syncStatus='pending'）。
   */
  writeL2(input: WriteL2Input, ctx: { sessionId: string; turnId: string }): Promise<WriteL2Result>
}

/**
 * 计算 extractionKey。
 * sha256(schemaVersion + targetLayer + sourceMessageId + fieldOrType + NFC(trim(content)))
 * 依据 S-020 §1.6。
 */
export function computeExtractionKey(
  schemaVersion: number,
  targetLayer: string,
  sourceMessageId: string,
  fieldOrType: string,
  content: string
): string {
  const normalized = content.trim().normalize('NFC')
  const raw = `${schemaVersion}|${targetLayer}|${sourceMessageId}|${fieldOrType}|${normalized}`
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

export function createMemoryWriter(deps: MemoryWriterDeps): MemoryWriter {
  const { db, l2Store, vectorStore, embedding, revisionClock, broadcaster, logger } = deps

  async function writeL2(
    input: WriteL2Input,
    ctx: { sessionId: string; turnId: string }
  ): Promise<WriteL2Result> {
    // 计算 extractionKey
    const extractionKey = computeExtractionKey(
      1, // schemaVersion=1（当前 envelope 版本）
      'l2',
      input.sourceMessageId,
      input.fieldOrType,
      input.content
    )

    // 幂等检查：extractionKey 已存在 -> no-op
    const existing = l2Store.getByExtractionKey(extractionKey)
    if (existing) {
      logger.debug('l2 write skipped: duplicate extractionKey', {
        scope: 'memory',
        turnId: ctx.turnId,
        tags: { extractionKey: extractionKey.slice(0, 12) }
      })
      return { memoryId: null, revision: 0, pending: false }
    }

    // 尝试获取 embedding
    let embeddingVec: Float32Array | null = null
    let pending = false

    if (embedding) {
      try {
        embeddingVec = await embedding.embed(input.content)
      } catch (e) {
        // 判断是否为"可补偿的暂时不可用"还是"不可补偿错误"
        const code = e instanceof AppError ? e.code : 'UNKNOWN'
        const retryable = e instanceof AppError ? e.retryable : false
        if (
          code === 'NET_TIMEOUT' ||
          code === 'NET_OFFLINE' ||
          code === 'LLM_RATE_LIMIT' ||
          retryable
        ) {
          // 可补偿：走 pending 路径
          pending = true
          logger.warn('embedding temporarily unavailable; writing as pending', {
            scope: 'memory',
            turnId: ctx.turnId,
            code,
            metrics: { pending: 1 }
          })
        } else {
          // 不可补偿：抛错，不擅自降为 pending
          throw e
        }
      }
    } else {
      // embedding 未配置 -> pending 路径（冻结边界）
      pending = true
    }

    // 事务内写入 L2 metadata + vector
    const txn = db.transaction(() => {
      const mem = l2Store.add(
        {
          content: input.content,
          confidence: input.confidence,
          evidenceIds: input.evidenceIds,
          sourceMessageIds: input.sourceMessageIds,
          triggerText: input.triggerText,
          syncStatus: pending ? 'pending' : 'synced',
          type: input.type,
          importance: input.importance,
          source: input.source ?? 'user_explicit',
          extractionKey
        },
        // emit=false：add() 不在事务内 emit（S-020 §1.6"commit 后才 emit"）；
        // 若事务回滚，订阅者不应收到指向不存在行的幽灵事件。commit 后由下方 emitAdded 统一发射。
        false
      )
      if (embeddingVec && !pending) {
        vectorStore.upsert(mem.id, embeddingVec)
      }
      return mem
    })

    let mem
    try {
      mem = txn()
    } catch (e) {
      // UNIQUE 约束冲突（并发写入同 extractionKey）-> no-op
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('UNIQUE') || msg.includes('extraction_key')) {
        logger.debug('l2 write skipped: concurrent extractionKey conflict', {
          scope: 'memory',
          turnId: ctx.turnId
        })
        return { memoryId: null, revision: 0, pending: false }
      }
      throw e
    }

    // commit 成功 -> revision++ + emit
    const revision = revisionClock.next()
    l2Store.emitAdded(mem)
    // P2-29: 广播 memory-updated hint='l2'（broadcaster 250ms 节流合并）
    broadcaster?.notify('l2')

    logger.info('l2 memory written', {
      scope: 'memory',
      turnId: ctx.turnId,
      metrics: { revision, pending: pending ? 1 : 0, hasVector: embeddingVec ? 1 : 0 }
    })

    return { memoryId: mem.id, revision, pending }
  }

  return { writeL2 }
}
