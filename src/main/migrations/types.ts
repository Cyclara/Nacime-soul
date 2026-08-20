// src/main/migrations/types.ts
// 迁移框架的类型契约。照抄 F5-013 §3，不得改动字段语义。

import type { Database } from 'better-sqlite3'
import type { Logger } from '@shared/observability/types'

/** 受版本管理的存储。growth/vector 表在 db 内，共用 db 版本号（F5-013 §3）。 */
export type StoreKind = 'db' | 'l0' | 'l1' | 'config' | 'dmae'

/**
 * 当前代码期望的各存储版本。新迁移脚本合入时同步 +1。
 * db=6（001_init + 002_extraction_key + 003_dmae_history + 005_dmae_turn_stats + 006_l2_source）；
 * dmae=4（004 迁移：加 turn + everActivated）；
 * l0/l1/config 仍为 1。
 */
export const EXPECTED_VERSIONS: Record<StoreKind, number> = {
  db: 6,
  l0: 1,
  l1: 1,
  config: 1,
  dmae: 4
}

export interface MigrationContext {
  /** 仅 store==='db' 的迁移可用；已在事务内。JSON 迁移不应触碰它。 */
  db: Database
  /** data/ 绝对路径（JSON 迁移用它定位文件；写回必须走 atomicWriteJson） */
  dataDir: string
  /** F5-011 logger，scope='migrate' */
  log: Logger
  /** true = 跑在备份副本/临时副本上（dry-run） */
  dryRun: boolean
}

export interface ValidationResult {
  ok: boolean
  detail?: string
}

export interface Migration {
  /** 全局唯一递增编号，与文件名前缀一致：001, 002, … */
  id: number
  store: StoreKind
  /** 如 'add lifecycle_state to l2_memories' */
  title: string
  /**
   * 执行迁移。db 迁移必须同步（在 better-sqlite3 事务内，不允许 async）；
   * JSON 迁移可 async（自身用 atomicWriteJson 保证原子）。禁止依赖外部网络。
   */
  up(ctx: MigrationContext): void | Promise<void>
  /** 迁移后立即校验（行数守恒、非空抽查等）。失败 = 整体失败 → 恢复备份 */
  validate(ctx: MigrationContext): ValidationResult | Promise<ValidationResult>
}

export interface PendingMigration {
  id: number
  store: StoreKind
  title: string
}

export interface MigrationReport {
  ok: boolean
  ran: number[]
  /** null = 无 pending 或 fresh 路径，未产生备份 */
  backupPath: string | null
  durationMs: number
  /** 失败的迁移 id */
  failedAt?: number
  /** 失败后是否成功恢复备份 */
  restored?: boolean
}

export interface MigrationRunner {
  /** 读取各存储实际版本，对比 EXPECTED_VERSIONS，返回待跑链（按 id 升序） */
  plan(): PendingMigration[]
  /** 完整启动序列（在任何 Store 打开前调用）。见 runner.ts 实现说明。 */
  run(): Promise<MigrationReport>
}

/** 读 SQLite 的 user_version（4 字节头字段，零建表） */
export function getDbVersion(db: Database): number {
  const v = db.pragma('user_version', { simple: true })
  return typeof v === 'number' ? v : Number(v)
}

/** 写 SQLite 的 user_version。仅在迁移事务内调用；v 为受控整数（非用户输入） */
export function setDbVersion(db: Database, v: number): void {
  if (!Number.isInteger(v) || v < 0) {
    throw new Error(`setDbVersion: invalid version ${v}`)
  }
  db.pragma(`user_version = ${v}`)
}
