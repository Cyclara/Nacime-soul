// src/main/migrations/runner.ts
// MigrationRunner：启动链上第一个数据触碰者，唯一允许改 schema 的地方。依据 F5-013 §3。
//
// 启动序列（run）：
//   1. 检测哨兵 → 存在则先从备份恢复（上次迁移中断）
//   2. 打开 db（损坏→MEM_DB_CORRUPT），读各存储版本
//   3. 降级保护：任一存储版本 > EXPECTED → 拒绝启动（throw fatal）
//   4. plan() 为空 → 直接返回（无备份）
//   5. fresh（无既有数据）→ 直接跑，无备份；否则备份 + 写哨兵 + dry-run（副本上跑全链）
//   6. 真跑：会话级 FK off，每个 db 迁移一个事务，跑完即提升版本
//   7. 失败 → 恢复备份；成功 → 写 migrations_log + 删哨兵

import * as fs from 'node:fs'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import { AppError } from '@shared/errors'
import type { Logger } from '@shared/observability/types'
import {
  EXPECTED_VERSIONS,
  getDbVersion,
  setDbVersion,
  type Migration,
  type MigrationContext,
  type MigrationReport,
  type MigrationRunner,
  type PendingMigration,
  type StoreKind
} from './types'
import { readJsonVersion, setJsonVersion, getJsonVersion } from './atomic-json'
import { createBackup, restoreBackup, type JsonStoreFile } from './backup'
import { clearSentinel, readSentinel, writeSentinel, validateSentinel } from './sentinel'

export interface MigrationRunnerDeps {
  /** data/memory.db 绝对路径（不硬编码，由调用方从配置注入） */
  dbPath: string
  /** data/ 目录（哨兵、JSON 存储所在） */
  dataDir: string
  /** 注入的迁移链（生产 = registry.MIGRATIONS） */
  migrations: Migration[]
  /** 参与版本检查/备份的 JSON 存储（l0/l1/dmae…）。默认 [] */
  jsonStores?: JsonStoreFile[]
  logger: Logger
  /** 写 migrations_log 用 */
  appVersion: string
  /** 备份根目录，默认 data/ 的同级 data-backups/ */
  backupsRoot?: string
  /** 注入时钟（测试确定性）。默认 Date.now */
  now?: () => number
  /** 注入 db 工厂（测试）。默认 better-sqlite3 */
  openDatabase?: (dbPath: string) => Database.Database
}

function isStoreKind(k: string): k is StoreKind {
  return k === 'db' || k === 'l0' || k === 'l1' || k === 'config' || k === 'dmae'
}

/**
 * 启动期校验迁移注册表：id 必须全局唯一且单调递增，store 必须合法。
 * 依据 C-α-3：registry 无校验 -> 重复 id 会互相覆盖、乱序会导致 pending 计算错。
 */
function validateRegistry(migrations: Migration[]): void {
  let prevId = 0
  const seen = new Set<number>()
  for (const m of migrations) {
    if (!isStoreKind(m.store)) {
      throw new AppError({
        code: 'MEM_MIGRATE_FAIL',
        userMessage: `迁移注册表损坏：迁移 ${m.id} 的 store='${m.store}' 不合法`,
        severity: 'fatal',
        retryable: false
      })
    }
    if (seen.has(m.id)) {
      throw new AppError({
        code: 'MEM_MIGRATE_FAIL',
        userMessage: `迁移注册表损坏：重复 id=${m.id}`,
        severity: 'fatal',
        retryable: false
      })
    }
    seen.add(m.id)
    if (m.id <= prevId) {
      throw new AppError({
        code: 'MEM_MIGRATE_FAIL',
        userMessage: `迁移注册表损坏：id 非单调递增（${prevId} 之后出现 ${m.id}）`,
        severity: 'fatal',
        retryable: false
      })
    }
    prevId = m.id
  }
}

export function createMigrationRunner(deps: MigrationRunnerDeps): MigrationRunner {
  const {
    dbPath,
    dataDir,
    migrations,
    logger,
    appVersion,
    jsonStores = [],
    now = () => Date.now(),
    openDatabase = (p: string): Database.Database => new Database(p)
  } = deps
  // 启动期校验注册表（C-α-3）：重复 id / 非单调递增 / 非法 store -> 立即 fatal
  validateRegistry(migrations)
  const dbFileName = path.basename(dbPath)
  const backupsRoot = deps.backupsRoot ?? path.join(path.dirname(dataDir), 'data-backups')

  /** 打开 db，损坏映射为 MEM_DB_CORRUPT fatal（F5-013/F5-003 边界） */
  function openDb(): Database.Database {
    try {
      const db = openDatabase(dbPath)
      db.pragma('journal_mode = WAL')
      // 触发一次读，尽早暴露损坏
      getDbVersion(db)
      return db
    } catch (e) {
      throw new AppError({
        code: 'MEM_DB_CORRUPT',
        userMessage: '记忆数据库无法打开（可能已损坏），请从备份恢复',
        severity: 'fatal',
        retryable: false,
        cause: e
      })
    }
  }

  /** 读 JSON 版本，invalid -> 抛 MEM_DB_CORRUPT fatal（C-α-2：坏文件不许猜） */
  function readJsonVersionOrThrow(filePath: string): number {
    const r = readJsonVersion(filePath)
    if (r.kind === 'missing') return 0
    if (r.kind === 'ok') return r.version
    throw new AppError({
      code: 'MEM_DB_CORRUPT',
      userMessage: `存储文件损坏（${r.reason}），请从备份恢复：${path.basename(filePath)}`,
      severity: 'fatal',
      retryable: false,
      cause: { file: filePath, reason: r.reason }
    })
  }

  function readVersions(db: Database.Database): Partial<Record<StoreKind, number>> {
    const out: Partial<Record<StoreKind, number>> = { db: getDbVersion(db) }
    for (const js of jsonStores) {
      if (isStoreKind(js.kind)) out[js.kind] = readJsonVersionOrThrow(js.filePath)
    }
    return out
  }

  function computePending(versions: Partial<Record<StoreKind, number>>): Migration[] {
    return migrations.filter((m) => m.id > (versions[m.store] ?? 0)).sort((a, b) => a.id - b.id)
  }

  /** 单个迁移：db 迁移在同步事务内（up+validate+提升版本），JSON 迁移 await up 再 validate */
  async function runOne(
    db: Database.Database,
    m: Migration,
    ctxDataDir: string,
    dryRun: boolean
  ): Promise<void> {
    const ctx: MigrationContext = {
      db,
      dataDir: ctxDataDir,
      log: logger.child(`m${m.id}`),
      dryRun
    }
    if (m.store === 'db') {
      const txn = db.transaction(() => {
        const up = m.up(ctx)
        if (up instanceof Promise) {
          throw new Error(`db migration ${m.id} must be synchronous (no async up)`)
        }
        const vr = m.validate(ctx)
        if (vr instanceof Promise) {
          throw new Error(`db migration ${m.id} validate must be synchronous`)
        }
        if (!vr.ok) {
          throw new AppError({
            code: 'MEM_MIGRATE_FAIL',
            severity: 'error',
            retryable: false,
            cause: vr.detail
          })
        }
        setDbVersion(db, m.id)
      })
      txn()
    } else {
      await m.up(ctx)
      const vr = await m.validate(ctx)
      if (!vr.ok) {
        throw new AppError({
          code: 'MEM_MIGRATE_FAIL',
          severity: 'error',
          retryable: false,
          cause: vr.detail
        })
      }
      // 提升版本号（与 db 分支 setDbVersion 对称）。C-α 约束 2：JSON 分支必须写版本号，
      // 否则迁移"成功"但版本没落盘，下次启动重复迁移（T-01 根因）。
      const js = jsonStores.find((j) => j.kind === m.store)
      if (!js) {
        throw new AppError({
          code: 'MEM_MIGRATE_FAIL',
          userMessage: `迁移 ${m.id} 的 store='${m.store}' 未在 jsonStores 注册，无法提升版本`,
          severity: 'fatal',
          retryable: false
        })
      }
      // dry-run 时文件在 scratchDir 副本，真跑时在 jsonStore.filePath 原位
      const targetPath = dryRun ? path.join(ctxDataDir, path.basename(js.filePath)) : js.filePath
      setJsonVersion(targetPath, m.id)
      // C0-1（F5-013 勘误 3b）：后置断言--验证版本号确实落盘且等于 m.id。
      // setJsonVersion 成功时版本号必然为 m.id，此断言是 defense-in-depth：
      // 捕获 setJsonVersion 静默失败、文件系统竞态、或迁移 up() 事后回写错误版本等极端情况。
      // 在 dry-run 阶段触发 -> 真身未动 -> 干净中止（F5-013 勘误 §3 第 1 条）。
      const actualVersion = getJsonVersion(targetPath)
      if (actualVersion !== m.id) {
        throw new AppError({
          code: 'MEM_MIGRATE_FAIL',
          userMessage: `迁移 ${m.id} 完成后 ${path.basename(targetPath)} 版本号校验失败（期望 ${m.id}，实际 ${actualVersion}）`,
          severity: 'error',
          retryable: false,
          cause: { file: targetPath, expected: m.id, actual: actualVersion }
        })
      }
    }
  }

  /** dry-run：把备份复制到临时 scratch，跑全链（不动真身，也不动 pristine 备份） */
  async function dryRun(
    backupPath: string,
    pending: Migration[]
  ): Promise<{ ok: boolean; failedAt?: number }> {
    const scratchDir = path.join(backupPath, '.dryrun')
    fs.mkdirSync(scratchDir, { recursive: true })
    const scratchDb = path.join(scratchDir, dbFileName)
    fs.copyFileSync(path.join(backupPath, dbFileName), scratchDb)
    for (const js of jsonStores) {
      const b = path.join(backupPath, path.basename(js.filePath))
      if (fs.existsSync(b)) fs.copyFileSync(b, path.join(scratchDir, path.basename(js.filePath)))
    }
    const sdb = openDatabase(scratchDb)
    sdb.pragma('foreign_keys = OFF')
    let failedAt: number | undefined
    try {
      for (const m of pending) {
        failedAt = m.id
        await runOne(sdb, m, scratchDir, true)
      }
      failedAt = undefined
      return { ok: true }
    } catch (e) {
      logger.warn('migration dry-run failed', {
        scope: 'migrate',
        code: 'MEM_MIGRATE_FAIL',
        detail: e instanceof Error ? e.message : String(e)
      })
      return { ok: false, failedAt }
    } finally {
      if (sdb.open) sdb.close()
      fs.rmSync(scratchDir, { recursive: true, force: true })
    }
  }

  function writeMigrationsLog(
    db: Database.Database,
    entries: Array<{ id: number; durationMs: number }>,
    ranAt: number
  ): void {
    const exists = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='migrations_log'`)
      .get()
    if (!exists) return
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO migrations_log (id, app_version, ran_at, duration_ms) VALUES (?,?,?,?)`
    )
    for (const e of entries) stmt.run(e.id, appVersion, ranAt, e.durationMs)
  }

  function plan(): PendingMigration[] {
    if (!fs.existsSync(dbPath)) {
      // db 不存在 → 版本 0，只按注册迁移与 JSON 版本推 pending
      const versions: Partial<Record<StoreKind, number>> = { db: 0 }
      for (const js of jsonStores) {
        if (isStoreKind(js.kind)) versions[js.kind] = readJsonVersionOrThrow(js.filePath)
      }
      return computePending(versions).map((m) => ({ id: m.id, store: m.store, title: m.title }))
    }
    const db = openDb()
    try {
      return computePending(readVersions(db)).map((m) => ({
        id: m.id,
        store: m.store,
        title: m.title
      }))
    } finally {
      if (db.open) db.close()
    }
  }

  async function run(): Promise<MigrationReport> {
    const startedAt = now()
    fs.mkdirSync(dataDir, { recursive: true })
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })

    // 1. 哨兵 → 崩溃恢复
    const sentinel = readSentinel(dataDir)
    if (sentinel) {
      // C-α-1：恢复前校验哨兵完整性 + 备份目录存在。缺备份不许"尽力而为"半恢复。
      const sentinelErr = validateSentinel(sentinel)
      if (sentinelErr) {
        throw new AppError({
          code: 'MEM_DB_CORRUPT',
          userMessage: `迁移哨兵损坏或备份缺失，无法恢复：${sentinelErr}。请手动从备份恢复 data/ 目录`,
          severity: 'fatal',
          retryable: false,
          cause: sentinelErr
        })
      }
      logger.warn('found migration sentinel; recovering from backup', {
        scope: 'migrate',
        code: 'MEM_MIGRATE_FAIL',
        tags: { backup: path.basename(sentinel.backupPath) }
      })
      restoreBackup({ backupPath: sentinel.backupPath, dbFilePath: dbPath, dbFileName, jsonStores })
      // C-α-1：清哨兵失败 = fatal（否则下次启动又恢复一遍，无限循环）
      if (!clearSentinel(dataDir)) {
        throw new AppError({
          code: 'MEM_MIGRATE_FAIL',
          userMessage:
            '迁移恢复完成但无法清除哨兵文件（文件被占用？）。请手动删除 .migration-lock.json 后重启',
          severity: 'fatal',
          retryable: false
        })
      }
    }

    const dbPreexisted = fs.existsSync(dbPath)
    const db = openDb()

    try {
      // 3. 降级保护
      const versions = readVersions(db)
      for (const store of Object.keys(EXPECTED_VERSIONS) as StoreKind[]) {
        const actual = versions[store]
        if (actual !== undefined && actual > EXPECTED_VERSIONS[store]) {
          if (db.open) db.close()
          throw new AppError({
            code: 'MEM_MIGRATE_FAIL',
            userMessage: '数据版本高于当前应用版本，请升级应用或从备份恢复',
            severity: 'fatal',
            retryable: false
          })
        }
      }

      // 4. plan
      const pending = computePending(versions)
      if (pending.length === 0) {
        if (db.open) db.close()
        return { ok: true, ran: [], backupPath: null, durationMs: now() - startedAt }
      }
      const maxId = pending[pending.length - 1].id

      // 5. fresh vs backup
      const isFresh = !dbPreexisted && jsonStores.every((js) => !fs.existsSync(js.filePath))
      let backupPath: string | null = null
      if (!isFresh) {
        try {
          backupPath = createBackup({
            db,
            dbFileName,
            jsonStores,
            backupsRoot,
            maxId,
            now: now()
          })
        } catch (e) {
          if (db.open) db.close()
          throw new AppError({
            code: 'MEM_MIGRATE_FAIL',
            userMessage: '无法创建迁移备份（磁盘空间不足？），已中止升级',
            severity: 'fatal',
            retryable: false,
            cause: e
          })
        }
        writeSentinel(dataDir, {
          startedAt,
          backupPath,
          from: versions as Record<string, number>,
          to: targetVersions(pending, versions)
        })
        const dry = await dryRun(backupPath, pending)
        if (!dry.ok) {
          // 真身未动。清哨兵失败只 warn（数据无损，仅需手动清哨兵）。
          if (!clearSentinel(dataDir)) {
            logger.warn('failed to clear sentinel after dry-run failure (manual cleanup needed)', {
              scope: 'migrate',
              code: 'MEM_MIGRATE_FAIL'
            })
          }
          if (db.open) db.close()
          // `dry.failedAt ?? -1`：dry-run 在迁移循环前失败（scratch 打开失败）时 failedAt 为 undefined；
          // 属防御性 fallback，正常失败路径 failedAt 必已赋值
          logger.error('migration dry-run failed; aborting (real data untouched)', {
            scope: 'migrate',
            code: 'MEM_MIGRATE_FAIL',
            metrics: { failedAt: dry.failedAt ?? -1 }
          })
          return {
            ok: false,
            ran: [],
            backupPath,
            durationMs: now() - startedAt,
            failedAt: dry.failedAt
          }
        }
      }

      // 6. 真跑
      db.pragma('foreign_keys = OFF')
      const ran: number[] = []
      const logEntries: Array<{ id: number; durationMs: number }> = []
      for (const m of pending) {
        const t0 = now()
        try {
          await runOne(db, m, dataDir, false)
          ran.push(m.id)
          logEntries.push({ id: m.id, durationMs: now() - t0 })
        } catch (e) {
          if (db.open) db.close()
          let restored = false
          if (backupPath) {
            try {
              restoreBackup({ backupPath, dbFilePath: dbPath, dbFileName, jsonStores })
              restored = true
            } catch (re) {
              logger.error('backup restore failed after migration failure', {
                scope: 'migrate',
                code: 'MEM_MIGRATE_FAIL',
                detail: re instanceof Error ? re.message : String(re)
              })
            }
            // backupPath 为 null 时必然是 fresh 路径（非 fresh 必先建备份），isFresh=false 假分支不可达
          } else if (isFresh) {
            // C-α-3：fresh 路径无备份可恢复。删除本次运行创建的所有文件，回到 fresh 状态。
            // isFresh 保证这些文件迁移前不存在，删除安全。
            for (const suffix of ['', '-wal', '-shm']) {
              try {
                fs.rmSync(dbPath + suffix, { force: true })
              } catch {
                /* best-effort */
              }
            }
            for (const js of jsonStores) {
              try {
                fs.rmSync(js.filePath, { force: true })
              } catch {
                /* best-effort */
              }
            }
            restored = true
          }
          // 失败路径的 clearSentinel：清不掉只 warn（不 throw，避免遮蔽原始错误）。
          // fresh 路径无哨兵，clearSentinel 是 no-op。
          if (!clearSentinel(dataDir)) {
            logger.warn(
              'failed to clear sentinel after migration failure (manual cleanup needed)',
              {
                scope: 'migrate',
                code: 'MEM_MIGRATE_FAIL'
              }
            )
          }
          logger.error('migration failed', {
            scope: 'migrate',
            code: 'MEM_MIGRATE_FAIL',
            metrics: { failedAt: m.id, restored },
            detail: e instanceof Error ? e.message : String(e)
          })
          return {
            ok: false,
            ran,
            backupPath,
            durationMs: now() - startedAt,
            failedAt: m.id,
            restored
          }
        }
      }
      db.pragma('foreign_keys = ON')

      // 7. 成功
      writeMigrationsLog(db, logEntries, now())
      if (db.open) db.close()
      // C-α-1：成功路径清哨兵 = 提交确认。清不掉必须 fatal，
      // 否则下次启动看到哨兵会把已迁移好的数据整体滚回旧版本。
      if (!clearSentinel(dataDir)) {
        throw new AppError({
          code: 'MEM_MIGRATE_FAIL',
          userMessage:
            '迁移成功但无法清除哨兵文件（文件被占用？）。请手动删除 .migration-lock.json 后重启，否则下次启动会回滚本次迁移',
          severity: 'fatal',
          retryable: false
        })
      }
      logger.info('migrations applied', {
        scope: 'migrate',
        metrics: { count: ran.length, durationMs: now() - startedAt }
      })
      return { ok: true, ran, backupPath, durationMs: now() - startedAt }
    } catch (e) {
      if (db.open) db.close()
      throw e
    }
  }

  return { plan, run }
}

function targetVersions(
  pending: Migration[],
  versions: Partial<Record<StoreKind, number>>
): Record<string, number> {
  const to: Record<string, number> = {}
  // readVersions 保证每个 key 都有确定值（getDbVersion / readJsonVersionOrThrow 均返回 number），
  // 无 undefined 值，直接断言类型（消除恒真防御分支，P2-45 100% branch）。
  for (const [k, v] of Object.entries(versions)) to[k] = v as number
  for (const m of pending) to[m.store] = m.id
  return to
}
