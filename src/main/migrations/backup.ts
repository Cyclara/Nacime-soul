// src/main/migrations/backup.ts
// 迁移前备份 + 恢复。DB 用 VACUUM INTO（SQLite 官方在线一致性快照，含 WAL 内容），
// JSON 存储用文件复制。依据 F5-013 §2、§3。

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Database } from 'better-sqlite3'

/** 参与备份/版本检查的 JSON 存储描述 */
export interface JsonStoreFile {
  kind: string
  filePath: string
}

/** 备份目录名时间戳：yyyymmdd-HHmmss（本地时区）。now 注入以便测试确定性。 */
function stamp(now: number): string {
  const d = new Date(now)
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  )
}

export interface CreateBackupOptions {
  db: Database
  /** 主库文件名，如 'memory.db' */
  dbFileName: string
  jsonStores: JsonStoreFile[]
  /** data-backups/ 绝对路径 */
  backupsRoot: string
  /** 本次迁移链最大 id（用于目录名） */
  maxId: number
  now: number
}

/**
 * 创建迁移前备份，返回备份目录绝对路径。
 * 1. wal_checkpoint(TRUNCATE) 合并 WAL 到主库
 * 2. VACUUM INTO 产出一致性快照
 * 3. 复制注册的 JSON 存储文件
 */
export function createBackup(opts: CreateBackupOptions): string {
  const dirName = `pre-migration-${opts.maxId}-${stamp(opts.now)}`
  const backupPath = path.join(opts.backupsRoot, dirName)
  fs.mkdirSync(backupPath, { recursive: true })

  // DB：先 checkpoint 再 VACUUM INTO（目标文件必须不存在）
  opts.db.pragma('wal_checkpoint(TRUNCATE)')
  const dbBackupFile = path.join(backupPath, opts.dbFileName)
  // 单引号字符串字面量；路径里的单引号按 SQLite 规则双写转义
  opts.db.exec(`VACUUM INTO '${dbBackupFile.replace(/'/g, "''")}'`)

  // JSON：存在才复制
  for (const js of opts.jsonStores) {
    if (fs.existsSync(js.filePath)) {
      fs.copyFileSync(js.filePath, path.join(backupPath, path.basename(js.filePath)))
    }
  }
  return backupPath
}

export interface RestoreBackupOptions {
  backupPath: string
  /** data/memory.db 绝对路径 */
  dbFilePath: string
  dbFileName: string
  jsonStores: JsonStoreFile[]
}

/**
 * 从备份目录恢复整个 data/：把备份里的 db 与 json 文件复制回原位。
 * 恢复前删除现有 db 的 -wal/-shm 旁文件，避免残留 WAL 与恢复的主库不一致。
 * 调用方必须保证目标 db 连接已关闭（Windows 文件锁）。
 *
 * C-α-3 修复：备份里没有的 JSON 文件（迁移期间新建的）必须删除，
 * 否则回滚不彻底--迁移创建了新文件，恢复只覆盖旧文件，新文件残留。
 */
export function restoreBackup(opts: RestoreBackupOptions): void {
  const backupDb = path.join(opts.backupPath, opts.dbFileName)
  if (fs.existsSync(backupDb)) {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(opts.dbFilePath + suffix, { force: true })
      } catch {
        // best-effort
      }
    }
    fs.copyFileSync(backupDb, opts.dbFilePath)
  }
  for (const js of opts.jsonStores) {
    const backupJson = path.join(opts.backupPath, path.basename(js.filePath))
    if (fs.existsSync(backupJson)) {
      // 备份有此文件 -> 覆盖回原位
      fs.copyFileSync(backupJson, js.filePath)
    } else if (fs.existsSync(js.filePath)) {
      // 备份没有但当前有 -> 迁移期间新建的，回滚时必须删除
      try {
        fs.rmSync(js.filePath, { force: true })
      } catch {
        // best-effort：删不掉不阻断恢复（文件锁），下次启动迁移会重试
      }
    }
  }
}
