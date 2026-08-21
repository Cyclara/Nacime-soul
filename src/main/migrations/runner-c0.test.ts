// src/main/migrations/runner-c0.test.ts
// P2-31.5C0：JSON 迁移路径的框架级测试（F5-013 勘误 §3 + S-Phase2 C0 实施清单）。
//
// 背景：runOne 的 db 分支在 validate 通过后调 setDbVersion，而非 db 分支（JSON）
// 以前对版本号零写入、零校验。004 是第一条走 JSON 路径的迁移。
// C0 先补路径测试，再走路径（C1 写业务迁移）。
//
// 六条清单：
//   C0-1: runner.ts runOne 非 db 分支有后置断言 getJsonVersion === m.id（代码已在 runner.ts 实现）
//   C0-2: 迁移 up() 产生的问题文件 -> 在 dry-run 阶段中止，真实文件字节不变
//   C0-3: 目标 JSON 文件原本不存在 -> 迁移跑完后文件存在且 schemaVersion === m.id
//   C0-4: JSON 迁移中途抛异常 -> 备份恢复后文件字节级一致、哨兵已清除
//   C0-5: backup.ts 对 jsonStores 的备份与 restoreBackup 各有至少一条覆盖
//   C0-6: 回归：db 分支原有用例仍全绿

import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from '@shared/observability/types'
import type { Migration } from './types'
import { createMigrationRunner } from './runner'
import { createBackup, restoreBackup, type JsonStoreFile } from './backup'
import { MIGRATIONS } from './registry'

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
  const d = mkdtempSync(join(tmpdir(), 'nacime-c0-'))
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

function paths(): { dir: string; dataDir: string; dbPath: string; dmaePath: string } {
  const dir = tmp()
  const dataDir = join(dir, 'data')
  const dbPath = join(dataDir, 'memory.db')
  const dmaePath = join(dataDir, 'dmae-state.json')
  return { dir, dataDir, dbPath, dmaePath }
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
    jsonStores: [{ kind: 'dmae', filePath: join(dataDir, 'dmae-state.json') }]
  })
}

// === C0-2: 迁移 up() 产生的问题文件 -> dry-run 中止，真实文件不变 ===
describe('P2-31.5C0-2: JSON 迁移 dry-run 失败中止', () => {
  it('up() 抛异常 -> dry-run 失败，真实文件字节不变', async () => {
    const { dataDir, dbPath, dmaePath } = paths()
    // 先跑合法迁移建库 + dmae-state.json
    await makeRunner(dbPath, dataDir, MIGRATIONS).run()
    const originalContent = readFileSync(dmaePath, 'utf8')

    // 造一条会在 dry-run 阶段抛错的 JSON 迁移（id=7，在 006 之后）
    const failing: Migration = {
      id: 8,
      store: 'dmae',
      title: 'throws during up()',
      up() {
        throw new Error('boom in json migration up()')
      },
      validate() {
        return { ok: true }
      }
    }

    const report = await makeRunner(dbPath, dataDir, [...MIGRATIONS, failing], () => 2_000).run()
    expect(report.ok).toBe(false)
    expect(report.failedAt).toBe(8)
    // 真实文件字节不变
    expect(readFileSync(dmaePath, 'utf8')).toBe(originalContent)
  })

  it('up() 产出无效 JSON -> setJsonVersion 抛错 -> dry-run 失败', async () => {
    const { dataDir, dbPath, dmaePath } = paths()
    await makeRunner(dbPath, dataDir, MIGRATIONS).run()
    const originalContent = readFileSync(dmaePath, 'utf8')

    // up() 写入无效 JSON（不是合法 JSON 对象）
    const badJson: Migration = {
      id: 8,
      store: 'dmae',
      title: 'writes invalid json',
      up({ dataDir: dd }) {
        writeFileSync(join(dd, 'dmae-state.json'), 'not valid json {{{')
      },
      validate() {
        return { ok: true }
      }
    }

    const report = await makeRunner(dbPath, dataDir, [...MIGRATIONS, badJson], () => 2_000).run()
    expect(report.ok).toBe(false)
    expect(report.failedAt).toBe(8)
    // 真实文件字节不变（dry-run 在副本上跑，真身未动）
    expect(readFileSync(dmaePath, 'utf8')).toBe(originalContent)
  })
})

// === C0-3: 文件不存在 -> 迁移后文件存在且 schemaVersion === m.id ===
describe('P2-31.5C0-3: 文件不存在时迁移创建文件', () => {
  it('dmae-state.json 不存在 -> 迁移后文件存在且 schemaVersion === 4', async () => {
    const { dataDir, dbPath, dmaePath } = paths()
    // fresh 路径：db 和 dmae-state.json 都不存在
    expect(existsSync(dbPath)).toBe(false)
    expect(existsSync(dmaePath)).toBe(false)

    const report = await makeRunner(dbPath, dataDir, MIGRATIONS).run()
    expect(report.ok).toBe(true)
    expect(report.ran).toContain(4)

    // 文件存在
    expect(existsSync(dmaePath)).toBe(true)
    // schemaVersion === 4
    const data = JSON.parse(readFileSync(dmaePath, 'utf8')) as { schemaVersion: number }
    expect(data.schemaVersion).toBe(4)
  })

  it('fresh 路径无备份（isFresh=true），文件由 up() 创建 + setJsonVersion 写版本', async () => {
    const { dataDir, dbPath } = paths()
    const report = await makeRunner(dbPath, dataDir, MIGRATIONS).run()
    expect(report.ok).toBe(true)
    expect(report.backupPath).toBeNull() // fresh 不备份
  })
})

// === C0-4: JSON 迁移中途抛异常 -> 备份恢复后文件字节级一致 ===
describe('P2-31.5C0-4: JSON 迁移真跑失败 -> 备份恢复', () => {
  it('真跑阶段 JSON 迁移抛异常 -> 备份恢复，dmae-state.json 字节级一致', async () => {
    const { dataDir, dbPath, dmaePath } = paths()
    // 先跑合法迁移
    await makeRunner(dbPath, dataDir, MIGRATIONS).run()
    // 修改 dmae-state.json（有已知内容）
    const knownContent =
      JSON.stringify(
        {
          schemaVersion: 4,
          turn: 5,
          entries: { m1: { activation: 50, userSilence: 3, modelSilence: 2, everActivated: true } }
        },
        null,
        2
      ) + '\n'
    writeFileSync(dmaePath, knownContent)

    // 造一条 dry-run 通过、真跑抛错的 JSON 迁移
    let calls = 0
    const failing: Migration = {
      id: 8,
      store: 'dmae',
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
    expect(report.failedAt).toBe(8)
    expect(report.restored).toBe(true)
    // 备份恢复后文件字节级一致
    expect(readFileSync(dmaePath, 'utf8')).toBe(knownContent)
  })
})

// === C0-5: backup.ts 对 jsonStores 的备份与 restoreBackup 覆盖 ===
describe('P2-31.5C0-5: backup.ts JSON 备份/恢复', () => {
  it('createBackup 复制存在的 JSON 文件到备份目录', () => {
    const { dir, dataDir, dbPath, dmaePath } = paths()
    mkdirSync(dataDir, { recursive: true })
    // 建 db + dmae-state.json
    const db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.close()
    const dmaeContent = JSON.stringify({ schemaVersion: 4, turn: 3, entries: {} }, null, 2)
    writeFileSync(dmaePath, dmaeContent)

    const jsonStores: JsonStoreFile[] = [{ kind: 'dmae', filePath: dmaePath }]
    const db2 = new Database(dbPath)
    const backupPath = createBackup({
      db: db2,
      dbFileName: 'memory.db',
      jsonStores,
      backupsRoot: join(dir, 'backups'),
      maxId: 5,
      now: 1_000
    })
    db2.close()

    // 备份目录有 dmae-state.json
    const backedUp = readFileSync(join(backupPath, 'dmae-state.json'), 'utf8')
    expect(backedUp).toBe(dmaeContent)
  })

  it('createBackup 跳过不存在的 JSON 文件（不抛错）', () => {
    const { dir, dataDir, dbPath, dmaePath } = paths()
    mkdirSync(dataDir, { recursive: true })
    const db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.close()
    // dmae-state.json 不存在
    expect(existsSync(dmaePath)).toBe(false)

    const jsonStores: JsonStoreFile[] = [{ kind: 'dmae', filePath: dmaePath }]
    const db2 = new Database(dbPath)
    const backupPath = createBackup({
      db: db2,
      dbFileName: 'memory.db',
      jsonStores,
      backupsRoot: join(dir, 'backups'),
      maxId: 5,
      now: 1_000
    })
    db2.close()
    // 备份目录没有 dmae-state.json（不报错）
    expect(existsSync(join(backupPath, 'dmae-state.json'))).toBe(false)
  })

  it('restoreBackup 覆盖 JSON 文件回原位', () => {
    const { dir, dataDir, dbPath, dmaePath } = paths()
    mkdirSync(dataDir, { recursive: true })
    // 建备份目录 + 备份文件
    const backupDir = join(dir, 'backup1')
    mkdirSync(backupDir, { recursive: true })
    const originalContent = JSON.stringify({ schemaVersion: 4, turn: 1, entries: {} }, null, 2)
    writeFileSync(join(backupDir, 'dmae-state.json'), originalContent)

    // 当前 dmae-state.json 被破坏
    writeFileSync(dmaePath, JSON.stringify({ schemaVersion: 99, entries: {} }))

    const jsonStores: JsonStoreFile[] = [{ kind: 'dmae', filePath: dmaePath }]
    restoreBackup({
      backupPath: backupDir,
      dbFilePath: dbPath,
      dbFileName: 'memory.db',
      jsonStores
    })
    // 恢复后内容 == 备份内容
    expect(readFileSync(dmaePath, 'utf8')).toBe(originalContent)
  })

  it('restoreBackup 删除备份中不存在的 JSON 文件（迁移期间新建的）', () => {
    const { dir, dataDir, dbPath, dmaePath } = paths()
    mkdirSync(dataDir, { recursive: true })
    // 备份目录没有 dmae-state.json
    const backupDir = join(dir, 'backup1')
    mkdirSync(backupDir, { recursive: true })
    // 但当前有 dmae-state.json（迁移期间新建的）
    writeFileSync(dmaePath, JSON.stringify({ schemaVersion: 4, entries: {} }))
    expect(existsSync(dmaePath)).toBe(true)

    const jsonStores: JsonStoreFile[] = [{ kind: 'dmae', filePath: dmaePath }]
    restoreBackup({
      backupPath: backupDir,
      dbFilePath: dbPath,
      dbFileName: 'memory.db',
      jsonStores
    })
    // 回滚时删除迁移期间新建的文件
    expect(existsSync(dmaePath)).toBe(false)
  })
})

// === C0-6: 回归：db 分支原有用例仍全绿 ===
describe('P2-31.5C0-6: 回归 - db 分支仍正常', () => {
  it('db 迁移 fresh 路径正常（001+002+003+004+005+006+007）', async () => {
    const { dataDir, dbPath } = paths()
    const report = await makeRunner(dbPath, dataDir, MIGRATIONS).run()
    expect(report.ok).toBe(true)
    expect(report.ran).toEqual([1, 2, 3, 4, 5, 6, 7])

    const db = new Database(dbPath)
    expect(db.pragma('user_version', { simple: true })).toBe(7)
    db.close()
  })

  it('db 迁移幂等（重复启动不重跑）', async () => {
    const { dataDir, dbPath } = paths()
    await makeRunner(dbPath, dataDir, MIGRATIONS).run()
    const report2 = await makeRunner(dbPath, dataDir, MIGRATIONS).run()
    expect(report2.ok).toBe(true)
    expect(report2.ran).toEqual([])
  })
})
