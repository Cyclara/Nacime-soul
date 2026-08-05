// src/main/migrations/runner-c-alpha.test.ts
// C-α 修复的验收测试（2026-08-04）。
// 覆盖：JSON 版本写入对称、sentinel 校验与清除、registry 校验、fresh 重置、回滚删新文件。
import { describe, it, expect, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from '@shared/observability/types'
import type { Migration } from './types'
import { createMigrationRunner } from './runner'
import { MIGRATIONS } from './registry'
import { writeSentinel, clearSentinel, validateSentinel, sentinelPath } from './sentinel'
import { createBackup } from './backup'
import { atomicWriteJson } from './atomic-json'
import { migration as m001 } from './scripts/001_init'
import { migration as m002 } from './scripts/002_extraction_key'
import { migration as m004 } from './scripts/004_dmae_state_v2'

// 验收清单 α-1 必测项①需要让 run() 流程中的 clearSentinel 失败（restore 后/成功后两处）。
// 用 vi.mock 包装：默认调用真实实现（本文件其他测试不受影响），
// 具体测试里用 mockReturnValueOnce 注入一次性失败，用完即恢复真实行为。
vi.mock('./sentinel', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./sentinel')>()
  return { ...mod, clearSentinel: vi.fn(mod.clearSentinel) }
})

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
  const d = mkdtempSync(join(tmpdir(), 'nacime-calpha-'))
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

function paths(): { dir: string; dataDir: string; dbPath: string } {
  const dir = tmp()
  const dataDir = join(dir, 'data')
  const dbPath = join(dataDir, 'memory.db')
  return { dir, dataDir, dbPath }
}

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
    // 注册 dmae jsonStore（MIGRATIONS 含 m004，需要 setJsonVersion 写版本号）
    jsonStores: [{ kind: 'dmae', filePath: join(dataDir, 'dmae-state.json') }]
  })
}

function makeRunnerWithJson(
  dbPath: string,
  dataDir: string,
  migrations: Migration[],
  jsonStores: Array<{ kind: string; filePath: string }>,
  now: () => number = () => 1_000
): ReturnType<typeof createMigrationRunner> {
  return createMigrationRunner({
    dbPath,
    dataDir,
    migrations,
    logger: noop,
    appVersion: '1.0.0',
    now,
    jsonStores
  })
}

describe('C-α 约束 2：JSON 迁移版本写入对称', () => {
  it('JSON 迁移成功后版本号落盘（setJsonVersion）', async () => {
    const { dataDir, dbPath } = paths()
    await makeRunner(dbPath, dataDir, MIGRATIONS).run()

    const dmaeFile = join(dataDir, 'dmae-state.json')
    atomicWriteJson(dmaeFile, { schemaVersion: 1, entries: {} })

    const dmaeMig: Migration = {
      id: 5,
      store: 'dmae',
      title: 'test dmae upgrade',
      up({ dataDir: dd }) {
        const f = join(dd, 'dmae-state.json')
        const data = JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>
        data.migrated = true
        atomicWriteJson(f, data)
      },
      validate({ dataDir: dd }) {
        const f = join(dd, 'dmae-state.json')
        const data = JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>
        return data.migrated === true ? { ok: true } : { ok: false, detail: 'not migrated' }
      }
    }

    const runner = makeRunnerWithJson(
      dbPath,
      dataDir,
      [...MIGRATIONS, dmaeMig],
      [{ kind: 'dmae', filePath: dmaeFile }],
      () => 2_000
    )
    const report = await runner.run()
    expect(report.ok).toBe(true)
    expect(report.ran).toContain(5)

    const after = JSON.parse(readFileSync(dmaeFile, 'utf8')) as Record<string, unknown>
    // 关键断言：runner 在 JSON 迁移成功后写入版本号（= 迁移 id），与 db 分支 setDbVersion 对称
    expect(after.schemaVersion).toBe(5)
    expect(after.migrated).toBe(true)
  })

  it('C1 验收：v1 文件升 v4 后 activation 全部保留 + turn/everActivated 补入', async () => {
    const { dataDir, dbPath } = paths()
    // 先跑 db 迁移建表（不跑 m004，用 [m001, m002]）
    await makeRunner(dbPath, dataDir, [m001, m002]).run()

    const dmaeFile = join(dataDir, 'dmae-state.json')
    // 写一个 v1 格式的 dmae-state.json（有 activation 数据，无 turn/everActivated）
    const v1Data = {
      schemaVersion: 1,
      entries: {
        m1: { activation: 50, userSilence: 3, modelSilence: 2 },
        m2: { activation: 0, userSilence: 10, modelSilence: 10 },
        m3: { activation: 100, userSilence: 0, modelSilence: 0 }
      }
    }
    atomicWriteJson(dmaeFile, v1Data)

    // 跑 m004 迁移（v1 -> v4）
    const runner = makeRunnerWithJson(
      dbPath,
      dataDir,
      [m001, m002, m004],
      [{ kind: 'dmae', filePath: dmaeFile }],
      () => 2_000
    )
    const report = await runner.run()
    expect(report.ok).toBe(true)
    expect(report.ran).toContain(4)

    const after = JSON.parse(readFileSync(dmaeFile, 'utf8')) as {
      schemaVersion: number
      turn: number
      entries: Record<string, { activation: number; everActivated: boolean }>
    }
    // 约束 1：版本号 = 4（不是 2）
    expect(after.schemaVersion).toBe(4)
    // v4 新增：turn
    expect(after.turn).toBe(0)
    // v4 新增：everActivated（activation > 0 -> true，= 0 -> false）
    expect(after.entries.m1.activation).toBe(50) // activation 保留
    expect(after.entries.m1.everActivated).toBe(true)
    expect(after.entries.m2.activation).toBe(0) // activation 保留
    expect(after.entries.m2.everActivated).toBe(false)
    expect(after.entries.m3.activation).toBe(100) // activation 保留
    expect(after.entries.m3.everActivated).toBe(true)
  })

  it('JSON 存储损坏 -> run() 抛 MEM_DB_CORRUPT fatal（不静默清空）', async () => {
    const { dataDir, dbPath } = paths()
    await makeRunner(dbPath, dataDir, MIGRATIONS).run()

    const dmaeFile = join(dataDir, 'dmae-state.json')
    writeFileSync(dmaeFile, '{ not valid json')

    const runner = makeRunnerWithJson(dbPath, dataDir, MIGRATIONS, [
      { kind: 'dmae', filePath: dmaeFile }
    ])
    await expect(runner.run()).rejects.toMatchObject({
      code: 'MEM_DB_CORRUPT',
      severity: 'fatal'
    })
  })
})

describe('C-α-1：sentinel 校验与清除', () => {
  it('clearSentinel 返回 true（文件不存在或删除成功）', () => {
    const dataDir = tmp()
    expect(clearSentinel(dataDir)).toBe(true) // 文件不存在
    writeSentinel(dataDir, { startedAt: 1, from: {}, to: {}, backupPath: dataDir })
    expect(clearSentinel(dataDir)).toBe(true) // 删除成功
    expect(existsSync(sentinelPath(dataDir))).toBe(false)
  })

  it('clearSentinel 返回 false（删除失败：sentinel 是目录，rmSync 无 recursive 抛错）', () => {
    const dataDir = tmp()
    mkdirSync(sentinelPath(dataDir), { recursive: true })
    expect(clearSentinel(dataDir)).toBe(false)
    rmSync(sentinelPath(dataDir), { recursive: true, force: true })
  })

  it('validateSentinel：备份目录不存在 -> 返回错误', () => {
    const sentinel = {
      startedAt: 1,
      from: {},
      to: {},
      backupPath: join(tmp(), 'nonexistent-backup')
    }
    expect(validateSentinel(sentinel)).toMatch(/does not exist/)
  })

  it('validateSentinel：备份目录存在 -> 返回 null', () => {
    const backupDir = tmp()
    const sentinel = { startedAt: 1, from: {}, to: {}, backupPath: backupDir }
    expect(validateSentinel(sentinel)).toBeNull()
  })

  it('run()：哨兵存在但备份目录缺失 -> 抛 MEM_DB_CORRUPT fatal（不半恢复）', async () => {
    const { dataDir, dbPath } = paths()
    await makeRunner(dbPath, dataDir, MIGRATIONS).run()

    writeSentinel(dataDir, {
      startedAt: 1,
      from: { db: 2 },
      to: { db: 2 },
      backupPath: join(dataDir, 'nonexistent-backup')
    })

    await expect(makeRunner(dbPath, dataDir, MIGRATIONS).run()).rejects.toMatchObject({
      code: 'MEM_DB_CORRUPT',
      severity: 'fatal'
    })
  })

  it('run()：迁移成功但清哨兵失败 -> 抛 MEM_MIGRATE_FAIL fatal（验收清单 α-1 必测项①：提交确认）', async () => {
    const { dataDir, dbPath } = paths()
    // 成功路径（runner :484）清哨兵 = 提交确认。清不掉必须 fatal，
    // 否则下次启动看到残留哨兵会把已迁移好的数据整体滚回旧版本。
    vi.mocked(clearSentinel).mockReturnValueOnce(false)

    await expect(makeRunner(dbPath, dataDir, MIGRATIONS).run()).rejects.toMatchObject({
      code: 'MEM_MIGRATE_FAIL',
      severity: 'fatal'
    })

    // 一次性 mock 已消耗，此后恢复真实实现（不污染本文件后续测试）
    expect(clearSentinel(dataDir)).toBe(true)
  })

  it('run()：恢复完成但清哨兵失败 -> 抛 MEM_MIGRATE_FAIL fatal（防无限回滚循环）', async () => {
    const { dir, dataDir, dbPath } = paths()
    // 先正常迁移一轮，产出真实数据
    await makeRunner(dbPath, dataDir, MIGRATIONS).run()

    // 手工制造"上次迁移崩溃"现场：真实备份 + 哨兵（恢复路径 :315 的 clearSentinel）
    const db = new Database(dbPath)
    const backupPath = createBackup({
      db,
      dbFileName: 'memory.db',
      jsonStores: [{ kind: 'dmae', filePath: join(dataDir, 'dmae-state.json') }],
      backupsRoot: join(dir, 'data-backups'),
      maxId: 4,
      now: 9_999
    })
    db.close()
    writeSentinel(dataDir, {
      startedAt: 1,
      from: { db: 2, dmae: 4 },
      to: { db: 2, dmae: 4 },
      backupPath
    })

    vi.mocked(clearSentinel).mockReturnValueOnce(false)
    await expect(makeRunner(dbPath, dataDir, MIGRATIONS).run()).rejects.toMatchObject({
      code: 'MEM_MIGRATE_FAIL',
      severity: 'fatal'
    })

    // 一次性 mock 已消耗，恢复真实实现
    expect(clearSentinel(dataDir)).toBe(true)
  })

  it('正常迁移（清哨兵成功）-> 下次启动不触发 restore（回归）', async () => {
    const { dataDir, dbPath } = paths()
    const report = await makeRunner(dbPath, dataDir, MIGRATIONS).run()
    expect(report.ok).toBe(true)
    expect(existsSync(sentinelPath(dataDir))).toBe(false)

    const report2 = await makeRunner(dbPath, dataDir, MIGRATIONS).run()
    expect(report2.ok).toBe(true)
    expect(report2.ran).toEqual([])
  })
})

describe('C-α-3：registry 校验 + fresh 重置 + 回滚删新文件', () => {
  it('registry 重复 id -> 抛 fatal', () => {
    const { dataDir, dbPath } = paths()
    const dup: Migration[] = [
      {
        id: 1,
        store: 'db',
        title: 'a',
        up() {
          void 0
        },
        validate() {
          return { ok: true }
        }
      },
      {
        id: 1,
        store: 'db',
        title: 'b',
        up() {
          void 0
        },
        validate() {
          return { ok: true }
        }
      }
    ]
    expect(() => makeRunner(dbPath, dataDir, dup)).toThrow(/重复 id/)
  })

  it('registry 非单调递增 -> 抛 fatal', () => {
    const { dataDir, dbPath } = paths()
    const unordered: Migration[] = [
      {
        id: 2,
        store: 'db',
        title: 'b',
        up() {
          void 0
        },
        validate() {
          return { ok: true }
        }
      },
      {
        id: 1,
        store: 'db',
        title: 'a',
        up() {
          void 0
        },
        validate() {
          return { ok: true }
        }
      }
    ]
    expect(() => makeRunner(dbPath, dataDir, unordered)).toThrow(/非单调递增/)
  })

  it('fresh 路径迁移失败 -> 删除本次创建的文件，回到 fresh 状态', async () => {
    const { dataDir, dbPath } = paths()
    const dmaeFile = join(dataDir, 'dmae-state.json')

    const failing: Migration = {
      id: 5,
      store: 'db',
      title: 'fails on real run',
      up() {
        throw new Error('boom')
      },
      validate() {
        return { ok: true }
      }
    }

    const runner = makeRunnerWithJson(
      dbPath,
      dataDir,
      [...MIGRATIONS, failing],
      [{ kind: 'dmae', filePath: dmaeFile }],
      () => 2_000
    )
    const report = await runner.run()
    expect(report.ok).toBe(false)
    expect(report.failedAt).toBe(5)
    expect(report.restored).toBe(true)
    // fresh 重置：db 和 JSON 文件都应被删除
    expect(existsSync(dbPath)).toBe(false)
    expect(existsSync(dmaeFile)).toBe(false)
  })

  it('回滚删除迁移期间新建的 JSON 文件（备份里没有的）', async () => {
    const { dataDir, dbPath } = paths()
    // 用 [m001, m002] 而非 MIGRATIONS（含 m004）--m004 会创建 dmaeFile，
    // 导致备份里有 dmaeFile，无法测试"回滚删除迁移新建文件"的场景
    await makeRunner(dbPath, dataDir, [m001, m002]).run()

    let db = new Database(dbPath)
    db.prepare(`INSERT INTO l2_memories (id, content, confidence) VALUES ('A','rowA',0.5)`).run()
    db.close()

    const dmaeFile = join(dataDir, 'dmae-state.json')
    // dmaeFile 迁移前不存在 -> 备份里不会有

    let calls = 0
    const mig: Migration = {
      id: 5,
      store: 'db',
      title: 'creates dmae file then fails',
      up({ dataDir: dd }) {
        calls++
        if (calls === 1) return // dry-run 通过
        // 真跑：创建 dmaeFile，然后失败
        atomicWriteJson(join(dd, 'dmae-state.json'), { schemaVersion: 1, entries: {} })
        throw new Error('boom after creating file')
      },
      validate() {
        return { ok: true }
      }
    }

    const runner = makeRunnerWithJson(
      dbPath,
      dataDir,
      [m001, m002, mig],
      [{ kind: 'dmae', filePath: dmaeFile }],
      () => 2_000
    )
    const report = await runner.run()
    expect(report.ok).toBe(false)
    expect(report.restored).toBe(true)
    // 回滚后：迁移创建的 dmaeFile 应被删除（备份里没有）
    expect(existsSync(dmaeFile)).toBe(false)
    // 原有数据保留
    db = new Database(dbPath)
    expect(db.prepare(`SELECT content FROM l2_memories WHERE id='A'`).get()).toEqual({
      content: 'rowA'
    })
    db.close()
  })
})
