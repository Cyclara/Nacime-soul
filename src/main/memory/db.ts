// src/main/memory/db.ts
// 记忆库连接模块：打开 data/memory.db、WAL、外键、损坏检测。
// 依据：S-Phase2 P2-06、F5-003（single-writer，main 进程唯一写者）、F5-013（损坏→引导恢复）。
//
// 路径由调用方注入（不硬编码 app.getPath）。迁移必须已在本连接打开前跑完（F5-013）。

import Database from 'better-sqlite3'
import { AppError } from '@shared/errors'
import type { Logger } from '@shared/observability/types'

export interface OpenMemoryDbOptions {
  dbPath: string
  logger?: Logger
}

function toCorrupt(cause: unknown): AppError {
  return new AppError({
    code: 'MEM_DB_CORRUPT',
    userMessage: '记忆数据库无法打开（可能已损坏），请从备份恢复',
    severity: 'fatal',
    retryable: false,
    cause
  })
}

/**
 * 打开记忆库单例连接。WAL + foreign_keys=ON。
 * 打开或首次读取头部失败（SQLITE_CORRUPT / SQLITE_NOTADB 等）→ MEM_DB_CORRUPT fatal，不崩溃。
 */
export function openMemoryDb(opts: OpenMemoryDbOptions): Database.Database {
  let db: Database.Database
  try {
    db = new Database(opts.dbPath)
  } catch (e) {
    opts.logger?.error('open memory.db failed', {
      scope: 'memory',
      code: 'MEM_DB_CORRUPT',
      detail: e instanceof Error ? e.message : String(e)
    })
    throw toCorrupt(e)
  }
  try {
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    // 触发头部读取，尽早暴露损坏（对非法/损坏文件抛错）
    db.pragma('user_version')
    return db
  } catch (e) {
    try {
      db.close()
    } catch {
      /* best-effort */
    }
    opts.logger?.error('memory.db integrity read failed', {
      scope: 'memory',
      code: 'MEM_DB_CORRUPT',
      detail: e instanceof Error ? e.message : String(e)
    })
    throw toCorrupt(e)
  }
}
