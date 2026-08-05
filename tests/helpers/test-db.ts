// tests/helpers/test-db.ts
// 记忆库测试助手：建一个跑完迁移的临时 memory.db，返回打开的连接 + 清理函数。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import type { Logger } from '@shared/observability/types'
import { createMigrationRunner } from '../../src/main/migrations/runner'
import { MIGRATIONS } from '../../src/main/migrations/registry'
import { openMemoryDb } from '../../src/main/memory/db'

export const testNoopLogger: Logger = {
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
    return testNoopLogger
  }
}

export interface TestDb {
  db: Database
  dbPath: string
  dataDir: string
  cleanup: () => void
}

/** 建一个跑完迁移（v1 schema）的临时 memory.db，返回打开的连接 + 清理 */
export async function makeMemoryDb(): Promise<TestDb> {
  const root = mkdtempSync(join(tmpdir(), 'nacime-db-'))
  const dataDir = join(root, 'data')
  const dbPath = join(dataDir, 'memory.db')
  await createMigrationRunner({
    dbPath,
    dataDir,
    migrations: MIGRATIONS,
    logger: testNoopLogger,
    appVersion: '1.0.0',
    // 注册 dmae jsonStore（m004 迁移需要 setJsonVersion 写版本号）
    jsonStores: [{ kind: 'dmae', filePath: join(dataDir, 'dmae-state.json') }]
  }).run()
  const db = openMemoryDb({ dbPath, logger: testNoopLogger })
  return {
    db,
    dbPath,
    dataDir,
    cleanup: () => {
      try {
        db.close()
      } catch {
        /* best-effort */
      }
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    }
  }
}
