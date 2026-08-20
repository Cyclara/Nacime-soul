// src/main/migrations/runner.test.ts
// P2-01 迁移框架 + P2-02 001_init + 002_extraction_key。M-01~06（S-004-补充）：均用临时文件 DB。
import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from '@shared/observability/types'
import type { Migration } from './types'
import { createMigrationRunner } from './runner'
import { MIGRATIONS } from './registry'
import { writeSentinel, sentinelPath } from './sentinel'

const noop: Logger = {
  fatal() {
    /* noop */
  },
  error() {
    /* noop */
  },
  warn() {
    /* noop */
  },
  info() {
    /* noop */
  },
  debug() {
    /* noop */
  },
  child() {
    return noop
  }
}

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'nacime-mig-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

function makeRunner(
  dbPath: string,
  dataDir: string,
  migrations: Migration[],
  now: () => number = () => 1_000
): ReturnType<typeof createMigrationRunner> {
  return createMigrationRunner({
    dbPath,
    dataDir,
    migrations,
    logger: noop,
    appVersion: '1.0.0',
    now,
    // 注册 dmae jsonStore（m004 迁移需要 setJsonVersion 写版本号）
    jsonStores: [{ kind: 'dmae', filePath: join(dataDir, 'dmae-state.json') }]
  })
}

function paths(): { dir: string; dataDir: string; dbPath: string } {
  const dir = tmp()
  const dataDir = join(dir, 'data')
  const dbPath = join(dataDir, 'memory.db')
  return { dir, dataDir, dbPath }
}

describe('P2-02 001+002+003+004+005 fresh path', () => {
  it('M-01: empty dir first start -> all tables, user_version=6, no backup', async () => {
    const { dataDir, dbPath } = paths()
    const report = await makeRunner(dbPath, dataDir, MIGRATIONS).run()

    expect(report.ok).toBe(true)
    expect(report.ran).toEqual([1, 2, 3, 4, 5, 6])
    expect(report.backupPath).toBeNull() // 全新用户不产生备份

    const db = new Database(dbPath)
    expect(db.pragma('user_version', { simple: true })).toBe(6)
    const tables = new Set(
      (
        db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{
          name: string
        }>
      ).map((r) => r.name)
    )
    for (const t of [
      'l2_memories',
      'l2_vectors',
      'vec_meta',
      'conflict_log',
      'growth_events',
      'growth_snapshots',
      'growth_milestones',
      'migrations_log',
      'sessions',
      'messages',
      'app_meta'
    ]) {
      expect(tables.has(t), `table ${t}`).toBe(true)
    }
    // 002：extraction_key 列存在
    const cols = db.prepare(`PRAGMA table_info(l2_memories)`).all() as Array<{ name: string }>
    expect(cols.some((c) => c.name === 'extraction_key')).toBe(true)
    // 002：app_meta.memory_revision 初始化为 0
    expect(db.prepare(`SELECT value FROM app_meta WHERE key='memory_revision'`).get()).toEqual({
      value: '0'
    })
    // 003：DMAE 历史四表存在
    for (const t of ['dmae_samples', 'dmae_turns', 'dmae_daily', 'dmae_annotations']) {
      expect(tables.has(t), `table ${t}`).toBe(true)
    }
    // migrations_log 有六行审计记录（001 + 002 + 003 + 004 + 005 + 006）
    expect(db.prepare(`SELECT COUNT(*) c FROM migrations_log`).get()).toEqual({ c: 6 })
    db.close()
  })

  it('M-02: repeat start is idempotent (no pending, version stays 6)', async () => {
    const { dataDir, dbPath } = paths()
    await makeRunner(dbPath, dataDir, MIGRATIONS).run()
    const report2 = await makeRunner(dbPath, dataDir, MIGRATIONS).run()
    expect(report2.ok).toBe(true)
    expect(report2.ran).toEqual([])
    expect(report2.backupPath).toBeNull()

    const db = new Database(dbPath)
    expect(db.pragma('user_version', { simple: true })).toBe(6)
    db.close()
  })

  it('plan() returns [1,2,3,4,5,6] on fresh, [] after applied', async () => {
    const { dataDir, dbPath } = paths()
    const runner = makeRunner(dbPath, dataDir, MIGRATIONS)
    expect(runner.plan().map((p) => p.id)).toEqual([1, 2, 3, 4, 5, 6])
    await runner.run()
    expect(makeRunner(dbPath, dataDir, MIGRATIONS).plan()).toEqual([])
  })
})

describe('P2-01 downgrade protection', () => {
  it('M-03: rejects startup when db version > expected', async () => {
    const { dataDir, dbPath } = paths()
    mkdirSync(dataDir, { recursive: true })
    const db = new Database(dbPath)
    db.pragma('user_version = 7') // 高于 EXPECTED.db=6
    db.close()

    await expect(makeRunner(dbPath, dataDir, MIGRATIONS).run()).rejects.toMatchObject({
      code: 'MEM_MIGRATE_FAIL',
      severity: 'fatal'
    })
  })
})

describe('P2-01 backup / dry-run / restore', () => {
  it('M-04: real-run failure restores backup, data + version intact', async () => {
    const { dataDir, dbPath } = paths()
    await makeRunner(dbPath, dataDir, MIGRATIONS).run()

    // 插入已知行
    let db = new Database(dbPath)
    db.prepare(`INSERT INTO l2_memories (id, content, confidence) VALUES ('A','rowA',0.9)`).run()
    db.close()

    // 合成迁移：dry-run（第 1 次）通过，真跑（第 2 次）抛错。id=7（在 006 之后）
    let calls = 0
    const failing: Migration = {
      id: 7,
      store: 'db',
      title: 'passes dry-run, throws on real run',
      up() {
        calls++
        if (calls >= 2) throw new Error('boom on real run')
      },
      validate() {
        return { ok: true }
      }
    }

    const report = await makeRunner(dbPath, dataDir, [...MIGRATIONS, failing], () => 2_000).run()
    expect(report.ok).toBe(false)
    expect(report.failedAt).toBe(7)
    expect(report.restored).toBe(true)
    expect(report.backupPath).not.toBeNull()

    db = new Database(dbPath)
    expect(db.pragma('user_version', { simple: true })).toBe(6) // 版本回滚到 6（备份时已含 006）
    expect(db.prepare(`SELECT content FROM l2_memories WHERE id='A'`).get()).toEqual({
      content: 'rowA'
    })
    db.close()
  })

  it('M-05: dry-run failure aborts with real data untouched', async () => {
    const { dataDir, dbPath } = paths()
    await makeRunner(dbPath, dataDir, MIGRATIONS).run()
    let db = new Database(dbPath)
    db.prepare(`INSERT INTO l2_memories (id, content, confidence) VALUES ('A','rowA',0.9)`).run()
    db.close()

    const alwaysFails: Migration = {
      id: 7,
      store: 'db',
      title: 'always throws (dry-run fails)',
      up() {
        throw new Error('always fails')
      },
      validate() {
        return { ok: true }
      }
    }

    const report = await makeRunner(
      dbPath,
      dataDir,
      [...MIGRATIONS, alwaysFails],
      () => 2_000
    ).run()
    expect(report.ok).toBe(false)
    expect(report.failedAt).toBe(7)
    expect(report.ran).toEqual([]) // 真身未动
    expect(existsSync(sentinelPath(dataDir))).toBe(false) // 哨兵已清

    db = new Database(dbPath)
    expect(db.pragma('user_version', { simple: true })).toBe(6)
    expect(db.prepare(`SELECT content FROM l2_memories WHERE id='A'`).get()).toEqual({
      content: 'rowA'
    })
    db.close()
  })
})

describe('P2-01 sentinel crash recovery', () => {
  it('M-06: sentinel present -> restores backup and clears sentinel', async () => {
    const { dir, dataDir, dbPath } = paths()
    await makeRunner(dbPath, dataDir, MIGRATIONS).run()

    // 已知行 A，checkpoint 后做一份备份
    let db = new Database(dbPath)
    db.prepare(`INSERT INTO l2_memories (id, content, confidence) VALUES ('A','rowA',0.5)`).run()
    db.pragma('wal_checkpoint(TRUNCATE)')
    db.close()
    const backupDir = join(dir, 'backup1')
    mkdirSync(backupDir, { recursive: true })
    copyFileSync(dbPath, join(backupDir, 'memory.db'))

    // 模拟迁移中途：真库多写了 B，然后崩溃（留下哨兵）
    db = new Database(dbPath)
    db.prepare(`INSERT INTO l2_memories (id, content, confidence) VALUES ('B','rowB',0.5)`).run()
    db.close()
    writeSentinel(dataDir, { startedAt: 1, from: { db: 2 }, to: { db: 2 }, backupPath: backupDir })

    const report = await makeRunner(dbPath, dataDir, MIGRATIONS).run()
    expect(report.ok).toBe(true)

    db = new Database(dbPath)
    expect(db.prepare(`SELECT content FROM l2_memories WHERE id='A'`).get()).toEqual({
      content: 'rowA'
    })
    expect(db.prepare(`SELECT content FROM l2_memories WHERE id='B'`).get()).toBeUndefined()
    db.close()
    expect(existsSync(sentinelPath(dataDir))).toBe(false)
  })
})
