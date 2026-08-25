// src/main/migrations/fixtures.test.ts
// P2-03：迁移测试夹具体系。v1 夹具跑全链 -> 002 迁移成功、validate 全过、数据完好。
import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from '@shared/observability/types'
import { createMigrationRunner } from './runner'
import { migration as m001 } from './scripts/001_init'
import { migration as m002 } from './scripts/002_extraction_key'

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

const SEED_SQL = join(process.cwd(), 'tests/fixtures/migrations/v1/seed.sql')

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

describe('P2-03 v1 migration fixture', () => {
  it('v1 seed survives 002 migration: data intact, extraction_key column added, app_meta initialized', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nacime-fx-'))
    dirs.push(dir)
    const dataDir = join(dir, 'data')
    const dbPath = join(dataDir, 'memory.db')

    // 1. 建 v1 schema（只跑 001，不带 002）
    await createMigrationRunner({
      dbPath,
      dataDir,
      migrations: [m001],
      logger: noop,
      appVersion: '1.0.0'
    }).run()

    // 2. 载入 v1 夹具数据（此时无 extraction_key 列、无 app_meta 表）
    const seed = new Database(dbPath)
    seed.exec(readFileSync(SEED_SQL, 'utf8'))
    seed.close()

    // 3. 跑全链 [001, 002]：001 已应用（idempotent），002 pending
    //    用 [m001, m002] 而非 MIGRATIONS（含 m004 dmae 迁移）--本测试聚焦 002 对 v1 数据的处理
    const report = await createMigrationRunner({
      dbPath,
      dataDir,
      migrations: [m001, m002],
      logger: noop,
      appVersion: '1.0.0'
    }).run()
    expect(report.ok).toBe(true)
    expect(report.ran).toEqual([2]) // 只有 002 是 pending

    // 4. 验证 v2 schema + 数据完好
    const db = new Database(dbPath)
    expect(db.pragma('user_version', { simple: true })).toBe(2)
    // extraction_key 列存在（旧数据为 NULL）
    const cols = db.prepare(`PRAGMA table_info(l2_memories)`).all() as Array<{ name: string }>
    expect(cols.some((c) => c.name === 'extraction_key')).toBe(true)
    // app_meta 表存在且 memory_revision 初始化
    expect(db.prepare(`SELECT value FROM app_meta WHERE key='memory_revision'`).get()).toEqual({
      value: '0'
    })
    // 旧数据完好
    expect(
      db.prepare(`SELECT content FROM l2_memories WHERE id='l2_1710000002000_a1'`).get()
    ).toEqual({ content: '用户的名字是小明' })
    // 旧行的 extraction_key 为 NULL（迁移未回填）
    expect(
      db.prepare(`SELECT extraction_key FROM l2_memories WHERE id='l2_1710000002000_a1'`).get()
    ).toEqual({ extraction_key: null })
    expect(db.prepare(`SELECT COUNT(*) c FROM messages`).get()).toEqual({ c: 2 })
    expect(db.prepare(`SELECT COUNT(*) c FROM growth_events`).get()).toEqual({ c: 1 })
    db.close()
  })
})
