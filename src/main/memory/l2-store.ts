// src/main/memory/l2-store.ts
// L2 记忆存储：l2_memories 表的 CRUD（14 字段元数据）。
// 依据：S-Phase2 P2-07、F5-004（生命周期五态/类型三档）。
//
// id 格式：l2_{createdAtMs}_{random}——创建时间编码在 id 里（无独立 created_at 列）。
// 向量写入不在这里（P2-12 用 db.transaction 把 l2 行 + l2_vectors 一起提交）。

import { randomBytes } from 'node:crypto'
import type { Database } from 'better-sqlite3'

export type MemorySyncStatus = 'pending' | 'synced' | 'failed'
// M-20：MemoryLifecycleState/MemoryType 下沉到 @shared/memory/types（消除 shared→main 反向依赖）。
// import 供本文件使用；re-export 保持既有 `from '../l2-store'` 导入兼容。
import type { MemoryLifecycleState, MemoryType } from '@shared/memory/types'
export type { MemoryLifecycleState, MemoryType }

/**
 * P2-37: L2 记忆来源。
 *   - 'creator'      = seed 加载器创建（importance=10，DMAE Decay 豁免）
 *   - 'user_explicit' = MemoryJudge 终审通过的用户明确陈述
 *   - 'inferred'     = MemoryJudge 降级/推断
 */
export type MemorySource = 'creator' | 'user_explicit' | 'inferred'

/** L2 记忆完整模型（16 字段，002 迁移增加 extraction_key，006 迁移增加 source，007 迁移增加 importance_before_pin/edited_at） */
export interface L2Memory {
  id: string
  evidenceIds: string[]
  sourceMessageIds: string[]
  triggerText: string | null
  content: string
  confidence: number
  syncStatus: MemorySyncStatus
  lifecycleState: MemoryLifecycleState
  isPinned: boolean
  accessCount: number
  weight: number
  type: MemoryType
  importance: number
  archivedAt: number | null
  /** P3G：进入回收站的时间；与 archivedAt 分开，避免用户删除与归档年龄混算。 */
  softDeletedAt?: number | null
  /** P3G：最近一次检索命中时间；GC recent-access grace 的唯一时间真源。 */
  lastAccessedAt?: number | null
  /** 跨轮/重启幂等键（S-020 §1.6）。旧数据/未设置时为 null */
  extractionKey: string | null
  /** P2-37: 记忆来源（006 迁移增加；旧数据默认 'user_explicit'） */
  source: MemorySource
  /** M-48: pin 前的原始 importance（unpin 时恢复）；从未 pin 过为 null（007 迁移增加） */
  importanceBeforePin: number | null
  /** M-44: 用户最后一次手动编辑内容的时间（ms epoch）；从未编辑为 null（007 迁移增加） */
  editedAt: number | null
}

export interface L2CreateInput {
  content: string
  confidence: number
  evidenceIds?: string[]
  sourceMessageIds?: string[]
  triggerText?: string | null
  syncStatus?: MemorySyncStatus
  lifecycleState?: MemoryLifecycleState
  isPinned?: boolean
  weight?: number
  type?: MemoryType
  importance?: number
  /** 跨轮幂等键；缺失时为 null（旧数据兼容） */
  extractionKey?: string | null
  /** P2-37: 记忆来源；默认 'user_explicit'（006 迁移 DEFAULT 语义一致） */
  source?: MemorySource
}

export interface L2ListFilter {
  lifecycleState?: MemoryLifecycleState | MemoryLifecycleState[]
  syncStatus?: MemorySyncStatus
  type?: MemoryType
  limit?: number
  /** C-β：SQL OFFSET；与 limit 一起下推，禁止在 JS 层 slice。 */
  offset?: number
  /** C-β：content LIKE 子串匹配；%、_、反斜线按字面转义。 */
  search?: string
}

export type L2Event = 'l2.added'

export interface L2Store {
  /**
   * 生成 id、插入、emit l2.added，返回完整记忆。
   * @param emit 是否立即 emit（默认 true）。writer 的事务内写入传 false，
   *   由 commit 后统一调用 emitAdded——避免事务回滚时订阅者收到幽灵事件（S-020 §1.6"commit 后才 emit"）。
   */
  add(input: L2CreateInput, emit?: boolean): L2Memory
  /** 事务内插入指定记忆（不 emit；供 P2-12 组合写入用） */
  insert(mem: L2Memory): void
  get(id: string): L2Memory | null
  /** 按 extraction_key 查询（幂等检查；S-020 §1.6）。无则返回 null */
  getByExtractionKey(key: string): L2Memory | null
  update(id: string, patch: Partial<Omit<L2Memory, 'id'>>): void
  remove(id: string): void
  list(filter?: L2ListFilter): L2Memory[]
  count(filter?: Omit<L2ListFilter, 'limit' | 'offset'>): number
  /** access_count += 1（检索命中时调用） */
  touch(id: string): void
  on(event: L2Event, handler: (mem: L2Memory) => void): () => void
  /** 供 P2-12 在事务 commit 后手动广播 */
  emitAdded(mem: L2Memory): void
}

interface Row {
  id: string
  evidence_ids: string
  source_message_ids: string
  trigger_text: string | null
  content: string
  confidence: number
  sync_status: MemorySyncStatus
  lifecycle_state: MemoryLifecycleState
  is_pinned: number
  access_count: number
  weight: number
  type: MemoryType
  importance: number
  archived_at: number | null
  soft_deleted_at?: number | null
  last_accessed_at?: number | null
  extraction_key: string | null
  source: MemorySource
  importance_before_pin: number | null
  edited_at: number | null
}

function rowToMemory(r: Row): L2Memory {
  return {
    id: r.id,
    evidenceIds: safeParseArray(r.evidence_ids),
    sourceMessageIds: safeParseArray(r.source_message_ids),
    triggerText: r.trigger_text,
    content: r.content,
    confidence: r.confidence,
    syncStatus: r.sync_status,
    lifecycleState: r.lifecycle_state,
    isPinned: r.is_pinned === 1,
    accessCount: r.access_count,
    weight: r.weight,
    type: r.type,
    importance: r.importance,
    archivedAt: r.archived_at,
    softDeletedAt: r.soft_deleted_at ?? null,
    lastAccessedAt: r.last_accessed_at ?? null,
    extractionKey: r.extraction_key,
    source: r.source,
    importanceBeforePin: r.importance_before_pin,
    editedAt: r.edited_at
  }
}

function safeParseArray(json: string): string[] {
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export interface L2StoreOptions {
  db: Database
  now?: () => number
  /** id 随机后缀生成（测试可注入） */
  randomSuffix?: () => string
}

/** SQLite LIKE 字面量转义：先转义 escape 字符本身，再处理两个通配符。 */
function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

export function createL2Store(opts: L2StoreOptions): L2Store {
  const { db } = opts
  const now = opts.now ?? ((): number => Date.now())
  const randomSuffix = opts.randomSuffix ?? ((): string => randomBytes(5).toString('hex'))
  const listeners = new Set<(mem: L2Memory) => void>()

  const insertStmt = db.prepare(
    `INSERT INTO l2_memories
       (id, evidence_ids, source_message_ids, trigger_text, content, confidence,
        sync_status, lifecycle_state, is_pinned, access_count, weight, type, importance, archived_at, soft_deleted_at, last_accessed_at, extraction_key, source,
        importance_before_pin, edited_at)
     VALUES
       (@id, @evidence_ids, @source_message_ids, @trigger_text, @content, @confidence,
        @sync_status, @lifecycle_state, @is_pinned, @access_count, @weight, @type, @importance, @archived_at, @soft_deleted_at, @last_accessed_at, @extraction_key, @source,
        @importance_before_pin, @edited_at)`
  )
  const getStmt = db.prepare(`SELECT * FROM l2_memories WHERE id = ?`)

  function toRow(m: L2Memory): Row {
    return {
      id: m.id,
      evidence_ids: JSON.stringify(m.evidenceIds),
      source_message_ids: JSON.stringify(m.sourceMessageIds),
      trigger_text: m.triggerText,
      content: m.content,
      confidence: m.confidence,
      sync_status: m.syncStatus,
      lifecycle_state: m.lifecycleState,
      is_pinned: m.isPinned ? 1 : 0,
      access_count: m.accessCount,
      weight: m.weight,
      type: m.type,
      importance: m.importance,
      archived_at: m.archivedAt,
      soft_deleted_at: m.softDeletedAt ?? null,
      last_accessed_at: m.lastAccessedAt ?? null,
      extraction_key: m.extractionKey,
      source: m.source,
      importance_before_pin: m.importanceBeforePin,
      edited_at: m.editedAt
    }
  }

  function emit(mem: L2Memory): void {
    for (const h of listeners) {
      try {
        h(mem)
      } catch {
        /* 订阅者异常不影响写入 */
      }
    }
  }

  function insert(mem: L2Memory): void {
    insertStmt.run(toRow(mem))
  }

  function buildWhere(filter?: L2ListFilter): { clause: string; params: unknown[] } {
    const conds: string[] = []
    const params: unknown[] = []
    if (filter?.lifecycleState) {
      const states = Array.isArray(filter.lifecycleState)
        ? filter.lifecycleState
        : [filter.lifecycleState]
      conds.push(`lifecycle_state IN (${states.map(() => '?').join(',')})`)
      params.push(...states)
    }
    if (filter?.syncStatus) {
      conds.push('sync_status = ?')
      params.push(filter.syncStatus)
    }
    if (filter?.type) {
      conds.push('type = ?')
      params.push(filter.type)
    }
    if (filter?.search) {
      conds.push("content LIKE ? ESCAPE '\\'")
      params.push(`%${escapeLikePattern(filter.search)}%`)
    }
    return { clause: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params }
  }

  return {
    add(input, shouldEmit = true) {
      const mem: L2Memory = {
        id: `l2_${now()}_${randomSuffix()}`,
        evidenceIds: input.evidenceIds ?? [],
        sourceMessageIds: input.sourceMessageIds ?? [],
        triggerText: input.triggerText ?? null,
        content: input.content,
        confidence: input.confidence,
        syncStatus: input.syncStatus ?? 'pending',
        lifecycleState: input.lifecycleState ?? 'active',
        isPinned: input.isPinned ?? false,
        accessCount: 0,
        weight: input.weight ?? 1,
        type: input.type ?? 'situational',
        importance: input.importance ?? 5,
        archivedAt: null,
        softDeletedAt: null,
        lastAccessedAt: null,
        extractionKey: input.extractionKey ?? null,
        source: input.source ?? 'user_explicit',
        importanceBeforePin: null,
        editedAt: null
      }
      insert(mem)
      // shouldEmit=false 时由调用方（writer 事务）commit 后统一 emitAdded，
      // 避免事务回滚时订阅者已收到指向不存在行的幽灵事件。
      if (shouldEmit) emit(mem)
      return mem
    },

    insert,

    get(id) {
      const row = getStmt.get(id) as Row | undefined
      return row ? rowToMemory(row) : null
    },

    getByExtractionKey(key) {
      const row = db
        .prepare(`SELECT * FROM l2_memories WHERE extraction_key = ? LIMIT 1`)
        .get(key) as Row | undefined
      return row ? rowToMemory(row) : null
    },

    update(id, patch) {
      const current = getStmt.get(id) as Row | undefined
      if (!current) return
      const merged: L2Memory = { ...rowToMemory(current), ...patch, id }
      const r = toRow(merged)
      db.prepare(
        `UPDATE l2_memories SET
           evidence_ids=@evidence_ids, source_message_ids=@source_message_ids, trigger_text=@trigger_text,
           content=@content, confidence=@confidence, sync_status=@sync_status, lifecycle_state=@lifecycle_state,
           is_pinned=@is_pinned, access_count=@access_count, weight=@weight, type=@type,
           importance=@importance, archived_at=@archived_at, soft_deleted_at=@soft_deleted_at, last_accessed_at=@last_accessed_at, extraction_key=@extraction_key, source=@source,
           importance_before_pin=@importance_before_pin, edited_at=@edited_at
         WHERE id=@id`
      ).run(r)
    },

    remove(id) {
      db.prepare(`DELETE FROM l2_memories WHERE id = ?`).run(id)
    },

    list(filter) {
      const { clause, params } = buildWhere(filter)
      const queryParams = [...params]
      let pagination = ''
      if (filter?.limit !== undefined) {
        pagination += ' LIMIT ?'
        queryParams.push(Math.max(0, Math.floor(filter.limit)))
      } else if (filter?.offset !== undefined) {
        // SQLite 的 OFFSET 必须配 LIMIT；-1 表示不限制行数。
        pagination += ' LIMIT -1'
      }
      if (filter?.offset !== undefined) {
        pagination += ' OFFSET ?'
        queryParams.push(Math.max(0, Math.floor(filter.offset)))
      }
      const rows = db
        .prepare(`SELECT * FROM l2_memories ${clause} ORDER BY id DESC${pagination}`)
        .all(...queryParams) as Row[]
      return rows.map(rowToMemory)
    },

    count(filter) {
      const { clause, params } = buildWhere(filter)
      const row = db.prepare(`SELECT COUNT(*) c FROM l2_memories ${clause}`).get(...params) as {
        c: number
      }
      return row.c
    },

    touch(id) {
      db.prepare(`UPDATE l2_memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`).run(now(), id)
    },

    on(_event, handler) {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },

    emitAdded(mem) {
      emit(mem)
    }
  }
}
