// src/main/memory/conflict/log.ts
// 冲突日志存储：conflict_log 表 CRUD + 审计查询。依据 S-Phase2 P2-21。
//
// conflict_log 记录每次冲突检测的双方 ID、分数、信号明细、解决结果。
// 表结构由 001_init 建立（P2-02），不得回改；新增字段走新迁移。
//
// IPC 查询接口（S-012 §3.1 裁定）：
//   conflict audit 查询不属于当前 12 通道。本文件只提供 store 级查询函数；
//   IPC 通道注册延后到 P2-29——若开发者使用并入 debug snapshot（P2-26~28），
//   若用户面板需要则新立经 validator/sender-trust 审查的新通道并更新计数。
//
// 安全红线（F5-011 LogFields 白名单）：
//   - signals 字段只存逐信号分数（数字），不含记忆正文/quote
//   - 查询结果不含记忆 content，只含 memoryId 引用

import { randomBytes } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { ConflictBand } from './score'

export type ConflictLogResolution = 'supersede' | 'coexist' | 'reject' | 'none'

export interface ConflictLogEntry {
  id: string
  ts: number
  newMemoryId: string | null
  existingMemoryId: string | null
  score: number
  band: ConflictBand
  /** 逐信号贡献（scoreConflict().breakdown），只含数字 */
  signals: Record<string, number>
  resolution: ConflictLogResolution
  resolvedAt: number | null
}

/** 新建条目（id/ts 由 store 自动生成，也可覆盖） */
export type NewConflictLogEntry = Omit<ConflictLogEntry, 'id' | 'ts'> &
  Partial<Pick<ConflictLogEntry, 'id' | 'ts'>>

export interface ConflictLogFilter {
  band?: ConflictBand | ConflictBand[]
  resolution?: ConflictLogResolution | ConflictLogResolution[]
  /** 匹配 new_memory_id 或 existing_memory_id */
  memoryId?: string
  limit?: number
  offset?: number
}

export interface ConflictLogStore {
  /** 插入一条冲突日志，返回完整条目（含生成的 id/ts） */
  append(entry: NewConflictLogEntry): ConflictLogEntry
  /** 列表查询（按 ts 倒序） */
  list(filter?: ConflictLogFilter): ConflictLogEntry[]
  /** 按 id 查单条 */
  get(id: string): ConflictLogEntry | null
  /** 计数（不含 limit/offset） */
  count(filter?: Omit<ConflictLogFilter, 'limit' | 'offset'>): number
  /** 查询涉及某记忆的冲突（作为 new 或 existing），按 ts 倒序 */
  listByMemory(memoryId: string, limit?: number): ConflictLogEntry[]
  /** 查询同一对记忆的冲突（用于 recentlyResolved 信号判断） */
  listByPair(newMemoryId: string, existingMemoryId: string, sinceTs?: number): ConflictLogEntry[]
}

interface Row {
  id: string
  ts: number
  new_memory_id: string | null
  existing_memory_id: string | null
  score: number
  band: ConflictBand
  signals: string
  resolution: ConflictLogResolution
  resolved_at: number | null
}

export interface ConflictLogStoreOptions {
  db: Database
  now?: () => number
  /** id 随机后缀生成（测试可注入） */
  randomSuffix?: () => string
}

function rowToEntry(r: Row): ConflictLogEntry {
  let signals: Record<string, number> = {}
  try {
    const v = JSON.parse(r.signals)
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      signals = v as Record<string, number>
    }
  } catch {
    /* 损坏 signals 视为空对象，不阻塞查询 */
  }
  return {
    id: r.id,
    ts: r.ts,
    newMemoryId: r.new_memory_id,
    existingMemoryId: r.existing_memory_id,
    score: r.score,
    band: r.band,
    signals,
    resolution: r.resolution,
    resolvedAt: r.resolved_at
  }
}

function buildWhere(filter?: ConflictLogFilter): { clause: string; params: unknown[] } {
  const conds: string[] = []
  const params: unknown[] = []
  if (filter?.band) {
    const bands = Array.isArray(filter.band) ? filter.band : [filter.band]
    if (bands.length > 0) {
      conds.push(`band IN (${bands.map(() => '?').join(',')})`)
      params.push(...bands)
    }
  }
  if (filter?.resolution) {
    const resolutions = Array.isArray(filter.resolution) ? filter.resolution : [filter.resolution]
    if (resolutions.length > 0) {
      conds.push(`resolution IN (${resolutions.map(() => '?').join(',')})`)
      params.push(...resolutions)
    }
  }
  if (filter?.memoryId) {
    conds.push('(new_memory_id = ? OR existing_memory_id = ?)')
    params.push(filter.memoryId, filter.memoryId)
  }
  return { clause: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params }
}

export function createConflictLogStore(opts: ConflictLogStoreOptions): ConflictLogStore {
  const { db } = opts
  const now = opts.now ?? ((): number => Date.now())
  const randomSuffix = opts.randomSuffix ?? ((): string => randomBytes(5).toString('hex'))

  const insertStmt = db.prepare(
    `INSERT INTO conflict_log
       (id, ts, new_memory_id, existing_memory_id, score, band, signals, resolution, resolved_at)
     VALUES
       (@id, @ts, @new_memory_id, @existing_memory_id, @score, @band, @signals, @resolution, @resolved_at)`
  )
  const getStmt = db.prepare(`SELECT * FROM conflict_log WHERE id = ?`)

  function append(entry: NewConflictLogEntry): ConflictLogEntry {
    const id = entry.id || `cf_${now()}_${randomSuffix()}`
    const ts = entry.ts || now()
    insertStmt.run({
      id,
      ts,
      new_memory_id: entry.newMemoryId,
      existing_memory_id: entry.existingMemoryId,
      score: entry.score,
      band: entry.band,
      signals: JSON.stringify(entry.signals),
      resolution: entry.resolution,
      resolved_at: entry.resolvedAt
    })
    return {
      id,
      ts,
      newMemoryId: entry.newMemoryId,
      existingMemoryId: entry.existingMemoryId,
      score: entry.score,
      band: entry.band,
      signals: entry.signals,
      resolution: entry.resolution,
      resolvedAt: entry.resolvedAt
    }
  }

  function list(filter?: ConflictLogFilter): ConflictLogEntry[] {
    const { clause, params } = buildWhere(filter)
    const limit = filter?.limit ? Math.max(0, Math.floor(filter.limit)) : 0
    const offset = filter?.offset ? Math.max(0, Math.floor(filter.offset)) : 0
    let sql = `SELECT * FROM conflict_log ${clause} ORDER BY ts DESC`
    if (limit > 0) sql += ` LIMIT ${limit}`
    if (offset > 0) sql += ` OFFSET ${offset}`
    const rows = db.prepare(sql).all(...params) as Row[]
    return rows.map(rowToEntry)
  }

  function get(id: string): ConflictLogEntry | null {
    const row = getStmt.get(id) as Row | undefined
    return row ? rowToEntry(row) : null
  }

  function count(filter?: Omit<ConflictLogFilter, 'limit' | 'offset'>): number {
    const { clause, params } = buildWhere(filter)
    const row = db.prepare(`SELECT COUNT(*) c FROM conflict_log ${clause}`).get(...params) as {
      c: number
    }
    return row.c
  }

  function listByMemory(memoryId: string, limit?: number): ConflictLogEntry[] {
    const sql =
      `SELECT * FROM conflict_log WHERE new_memory_id = ? OR existing_memory_id = ? ORDER BY ts DESC` +
      (limit && limit > 0 ? ` LIMIT ${Math.max(0, Math.floor(limit))}` : '')
    const rows = db.prepare(sql).all(memoryId, memoryId) as Row[]
    return rows.map(rowToEntry)
  }

  function listByPair(
    newMemoryId: string,
    existingMemoryId: string,
    sinceTs?: number
  ): ConflictLogEntry[] {
    const conds = ['new_memory_id = ?', 'existing_memory_id = ?']
    const params: unknown[] = [newMemoryId, existingMemoryId]
    if (sinceTs !== undefined) {
      conds.push('ts >= ?')
      params.push(sinceTs)
    }
    const rows = db
      .prepare(`SELECT * FROM conflict_log WHERE ${conds.join(' AND ')} ORDER BY ts DESC`)
      .all(...params) as Row[]
    return rows.map(rowToEntry)
  }

  return { append, list, get, count, listByMemory, listByPair }
}
