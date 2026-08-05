// src/main/chat/idempotency-ledger.ts
// P2-43: clientRequestId 幂等账本（跨重启持久化 + 有界保留）。
// 依据：S-002-补充-P2-43-SQLiteSessionStore与跨重启幂等 §4。
//
// 定性（§4.1）：这是**可再生缓存**，不是用户数据——
//   - missing/corrupt -> 空表继续，不抛 MEM_DB_CORRUPT、不进迁移备份。
//     最坏后果 = 一次重复发送；用 fatal 拦启动是本末倒置。
//   - 只存终态（completed/failed）。pending 仅存内存（ackPromise 无法序列化），
//     崩溃时进程内 pending 随进程消失 -> 重启后查无此记录 -> 按全新请求处理，
//     恰好是死轮次的正确语义（逃生门，§4.3）。
//   - LRU 上限 256 条（Map 插入序淘汰最老）；每次写操作即落盘（人速发送，无需防抖）。

import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import type { Logger } from '@shared/observability/types'
import type { RequestId, SessionId } from '@shared/chat/types'
import type { TurnAck } from './service'
import { atomicWriteJson } from '../migrations/atomic-json'

export const IDEMPOTENCY_LEDGER_MAX_ENTRIES = 256
const LEDGER_SCHEMA_VERSION = 1

export interface PersistedIdempotencyRecord {
  sessionId: SessionId
  /** 原始聊天正文不重复写入 JSON；只存 SHA-256 用于 key+payload 一致性校验 */
  textHash: string
  ack: TurnAck
  state: 'completed' | 'failed'
  createdAt: number
}

/** 只用于等值校验，不记录聊天正文。 */
export function hashIdempotencyText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function isPersistedRecord(value: unknown): value is PersistedIdempotencyRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  const ack = v['ack']
  if (!ack || typeof ack !== 'object' || Array.isArray(ack)) return false
  const a = ack as Record<string, unknown>
  return (
    typeof v['sessionId'] === 'string' &&
    typeof v['textHash'] === 'string' &&
    /^[a-f0-9]{64}$/.test(v['textHash']) &&
    (v['state'] === 'completed' || v['state'] === 'failed') &&
    typeof v['createdAt'] === 'number' &&
    Number.isFinite(v['createdAt']) &&
    typeof a['requestId'] === 'string' &&
    typeof a['userMessageId'] === 'string' &&
    typeof a['assistantMessageId'] === 'string'
  )
}

export interface IdempotencyLedger {
  get(clientRequestId: RequestId): PersistedIdempotencyRecord | null
  put(clientRequestId: RequestId, record: PersistedIdempotencyRecord): void
  remove(clientRequestId: RequestId): void
  /** 当前记录数（诊断/测试用） */
  readonly size: number
}

export interface IdempotencyLedgerDeps {
  filePath: string
  logger?: Logger
  maxEntries?: number
}

export function createIdempotencyLedger(deps: IdempotencyLedgerDeps): IdempotencyLedger {
  const { filePath, logger } = deps
  const maxEntries = deps.maxEntries ?? IDEMPOTENCY_LEDGER_MAX_ENTRIES
  const records = new Map<RequestId, PersistedIdempotencyRecord>()

  // === 加载（缓存语义：missing/corrupt 都按空表继续）===
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw) as {
      schemaVersion?: number
      records?: Array<[RequestId, PersistedIdempotencyRecord]>
    }
    if (parsed.schemaVersion === LEDGER_SCHEMA_VERSION && Array.isArray(parsed.records)) {
      for (const entry of parsed.records) {
        if (
          Array.isArray(entry) &&
          entry.length === 2 &&
          typeof entry[0] === 'string' &&
          isPersistedRecord(entry[1])
        ) {
          records.set(entry[0], entry[1])
        }
      }
      // 超上限的历史文件：启动时即收敛
      while (records.size > maxEntries) {
        const oldest = records.keys().next().value
        if (oldest === undefined) break
        records.delete(oldest)
      }
    } else {
      logger?.warn('idempotency ledger shape unrecognized; starting empty', {
        scope: 'chat',
        tags: { file: path.basename(filePath) }
      })
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger?.warn('idempotency ledger unreadable; starting empty (cache, not user data)', {
        scope: 'chat',
        tags: { file: path.basename(filePath) },
        detail: e instanceof Error ? e.message : String(e)
      })
    }
  }

  function persist(): void {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      atomicWriteJson(filePath, {
        schemaVersion: LEDGER_SCHEMA_VERSION,
        records: [...records.entries()]
      })
    } catch (e) {
      // 缓存写不进去不阻断聊天；下次状态变更再试
      logger?.warn('idempotency ledger persist failed (non-fatal)', {
        scope: 'chat',
        detail: e instanceof Error ? e.message : String(e)
      })
    }
  }

  return {
    get size(): number {
      return records.size
    },

    get(clientRequestId: RequestId): PersistedIdempotencyRecord | null {
      const record = records.get(clientRequestId)
      if (!record) return null
      // Map 插入序作为进程内 LRU：命中即刷新热度（无需为一次 get 额外写盘）。
      records.delete(clientRequestId)
      records.set(clientRequestId, record)
      return record
    },

    put(clientRequestId: RequestId, record: PersistedIdempotencyRecord): void {
      // 插入序 = LRU 次序：重复 put 先删再插刷新热度
      records.delete(clientRequestId)
      records.set(clientRequestId, record)
      while (records.size > maxEntries) {
        const oldest = records.keys().next().value
        if (oldest === undefined) break
        records.delete(oldest)
      }
      persist()
    },

    remove(clientRequestId: RequestId): void {
      if (records.delete(clientRequestId)) persist()
    }
  }
}
