// P3G-03..06：GC 只写保留权，先冷后删，稳定/pinned/anchor/recent-access 永不自动清理。

import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { Logger } from '@shared/observability/types'
import type { L2Memory, L2Store } from './l2-store'
import { createGcService } from './gc-service'
import { DEFAULT_GC_POLICY } from './gc-policy'
import { migration as gcLogMigration } from '../migrations/scripts/012_gc_log'
import type { MigrationContext } from '../migrations/types'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_000 * DAY
const logger: Logger = {
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
    return logger
  }
}

function memory(id: string, overrides: Partial<L2Memory> = {}): L2Memory {
  return {
    id,
    evidenceIds: [],
    sourceMessageIds: [],
    triggerText: null,
    content: `content-${id}`,
    confidence: 0.9,
    syncStatus: 'synced',
    lifecycleState: 'archived',
    isPinned: false,
    accessCount: 0,
    weight: 1,
    type: 'one_off',
    importance: 5,
    archivedAt: NOW - 40 * DAY,
    softDeletedAt: null,
    lastAccessedAt: null,
    extractionKey: null,
    source: 'user_explicit',
    importanceBeforePin: null,
    editedAt: null,
    ...overrides
  }
}

function fixture(
  rows: L2Memory[],
  coldAppend: (records: readonly unknown[]) => string | null = () => 'cold/1972.jsonl.gz',
  db?: Database
): {
  service: ReturnType<typeof createGcService>
  map: Map<string, L2Memory>
  removed: string[]
  vectors: string[]
  warnings: Array<{ msg: string; code?: string }>
} {
  const map = new Map(rows.map((row) => [row.id, row]))
  const removed: string[] = []
  const vectors: string[] = []
  const warnings: Array<{ msg: string; code?: string }> = []
  const l2Store: L2Store = {
    add() {
      throw new Error('not used')
    },
    insert() {
      /* noop */
    },
    get: (id) => map.get(id) ?? null,
    getByExtractionKey: () => null,
    update: (id, patch) => {
      const current = map.get(id)
      if (current) map.set(id, { ...current, ...patch })
    },
    remove: (id) => {
      map.delete(id)
      removed.push(id)
    },
    list: (filter) => {
      const matching = [...map.values()].filter((entry) => {
        const wanted = filter?.lifecycleState
        return (
          wanted === undefined ||
          (Array.isArray(wanted)
            ? wanted.includes(entry.lifecycleState)
            : entry.lifecycleState === wanted)
        )
      })
      const offset = filter?.offset ?? 0
      return filter?.limit === undefined
        ? matching.slice(offset)
        : matching.slice(offset, offset + filter.limit)
    },
    count: (filter) => l2Store.list(filter).length,
    touch() {
      /* noop */
    },
    on: () => () => {},
    emitAdded() {
      /* noop */
    }
  }
  const service = createGcService({
    l2Store,
    vectorStore: {
      remove: (id) => {
        vectors.push(id)
      }
    } as never,
    revisionClock: { next: vi.fn(() => 1), current: vi.fn(() => 1) },
    broadcaster: { notify: vi.fn(), flush: vi.fn(), dispose: vi.fn() },
    coldStore: { append: coldAppend as never, searchIndex: () => [], read: () => null },
    ...(db === undefined ? {} : { db }),
    getPolicy: () => DEFAULT_GC_POLICY,
    logger: {
      ...logger,
      warn: (msg, fields) => {
        warnings.push({ msg, code: fields.code })
      }
    },
    now: () => NOW
  })
  return { service, map, removed, vectors, warnings }
}

describe('P3G GC service', () => {
  it('40 天 archived one_off 入 soft-delete 候选，stable/pinned/anchor/recent-access 全跳过', () => {
    const { service } = fixture([
      memory('old'),
      memory('stable', { type: 'stable' }),
      memory('pinned', { isPinned: true }),
      memory('anchor', { importance: 8 }),
      memory('recent', { lastAccessedAt: NOW - 10 * DAY })
    ])
    const scan = service.scan()
    expect(scan.candidates).toEqual([
      expect.objectContaining({ memoryId: 'old', action: 'soft_delete' })
    ])
    expect(scan.skipped).toMatchObject({ typeStable: 1, pinned: 1, anchor: 1, recentAccess: 1 })
  })

  it('首轮 dry-run 只报告，不改 L2/向量', () => {
    const { service, map, removed, vectors } = fixture([memory('old')])
    const report = service.run({ dryRun: true })
    expect(report).toMatchObject({ dryRun: true, softDeleted: 0, purged: 0 })
    expect(map.get('old')?.lifecycleState).toBe('archived')
    expect(removed).toEqual([])
    expect(vectors).toEqual([])
  })

  // F5-004 Phase 3 完成定义第 8 条：「首轮 dry-run 报告可审」。写进 gc_log 才算可审——
  // 光在内存里返回一个对象，重启后就没人能复核这轮 GC 打算删什么。
  it('首轮 dry-run 报告落 gc_log 可复核：含扫描数与逐项跳过原因，且不含记忆正文', () => {
    const db = new Database(':memory:')
    try {
      const context = { db, dataDir: '', log: logger, dryRun: false } as MigrationContext
      gcLogMigration.up(context)
      expect(gcLogMigration.validate(context)).toEqual({ ok: true })

      const { service } = fixture(
        [memory('old'), memory('pinned', { isPinned: true }), memory('stable', { type: 'stable' })],
        undefined,
        db
      )
      const report = service.run({ dryRun: true })
      expect(report).toMatchObject({ dryRun: true, scanned: 3, softDeleted: 0, purged: 0 })

      const rows = db.prepare(`SELECT ran_at, report FROM gc_log`).all() as Array<{
        ran_at: number
        report: string
      }>
      expect(rows).toHaveLength(1)
      expect(rows[0]!.ran_at).toBe(NOW)
      const persisted = JSON.parse(rows[0]!.report) as typeof report
      expect(persisted).toMatchObject({
        dryRun: true,
        scanned: 3,
        softDeleted: 0,
        purged: 0,
        coldFile: null
      })
      expect(persisted.skipped).toMatchObject({ pinned: 1, typeStable: 1 })
      // 红线：审计表只存计数与原因，绝不留记忆正文。
      expect(rows[0]!.report).not.toContain('content-')
    } finally {
      db.close()
    }
  })

  it('实际运行只将 archive retention 到期条目软删，且不修改 activation（GC 不持有 DMAE 写权）', () => {
    const { service, map } = fixture([memory('old')])
    const report = service.run()
    expect(report.softDeleted).toBe(1)
    expect(map.get('old')).toMatchObject({ lifecycleState: 'soft_deleted', softDeletedAt: NOW })
  })

  it('purge 先成功写 cold store，才删除 L2 和向量；cold 写失败则保守不删', () => {
    const expired = memory('expired', {
      lifecycleState: 'soft_deleted',
      softDeletedAt: NOW - 100 * DAY
    })
    const good = fixture([expired])
    expect(good.service.run()).toMatchObject({ purged: 1, coldFile: 'cold/1972.jsonl.gz' })
    expect(good.removed).toEqual(['expired'])
    expect(good.vectors).toEqual(['expired'])

    const failed = fixture([expired], () => null)
    expect(failed.service.run()).toMatchObject({ purged: 0, coldFile: null })
    expect(failed.map.has('expired')).toBe(true)
  })

  it('P3G-08 时间回拨：archivedAt/softDeletedAt 落在未来时按 0 天算，GC 只会更保守', () => {
    const { service, map, removed } = fixture([
      memory('future-archived', { archivedAt: NOW + 400 * DAY }),
      memory('future-soft', { lifecycleState: 'soft_deleted', softDeletedAt: NOW + 400 * DAY })
    ])
    expect(service.scan().candidates).toEqual([])
    const report = service.run()
    expect(report).toMatchObject({ softDeleted: 0, purged: 0 })
    expect(map.get('future-archived')?.lifecycleState).toBe('archived')
    expect(map.get('future-soft')?.lifecycleState).toBe('soft_deleted')
    expect(removed).toEqual([])
  })

  it('P3G-08 磁盘满：冷写抛错时整段跳过 purge 并报 MEM_WRITE_FAIL，soft-delete 段仍然生效', () => {
    const { service, map, removed, vectors, warnings } = fixture(
      [
        memory('to-soft'),
        memory('expired', { lifecycleState: 'soft_deleted', softDeletedAt: NOW - 100 * DAY })
      ],
      () => {
        throw new Error('ENOSPC: no space left on device')
      }
    )
    const report = service.run()
    expect(report).toMatchObject({ softDeleted: 1, purged: 0, coldFile: null })
    expect(map.get('to-soft')?.lifecycleState).toBe('soft_deleted')
    expect(map.has('expired')).toBe(true)
    expect(removed).toEqual([])
    expect(vectors).toEqual([])
    expect(warnings).toEqual([expect.objectContaining({ code: 'MEM_WRITE_FAIL' })])
  })

  it('P3G-06 单轮 purge 配额封顶 maxPurgePerRun，超出部分记入 quotaExceeded 留到下轮', () => {
    const expired = Array.from({ length: 502 }, (_, index) =>
      memory(`expired-${index}`, { lifecycleState: 'soft_deleted', softDeletedAt: NOW - 100 * DAY })
    )
    const { service, removed, vectors } = fixture(expired)
    const report = service.run()
    expect(report.purged).toBe(500)
    expect(report.skipped.quotaExceeded).toBe(2)
    expect(removed).toHaveLength(500)
    expect(vectors).toHaveLength(500)
  })

  it('回收站分页和恢复只影响 soft_deleted 记忆', () => {
    const { service, map } = fixture([
      memory('a', { lifecycleState: 'soft_deleted', softDeletedAt: NOW - DAY }),
      memory('b', { lifecycleState: 'soft_deleted', softDeletedAt: NOW - DAY }),
      memory('c')
    ])
    expect(service.listRecycleBin(1, 0)).toMatchObject({
      total: 2,
      items: [expect.objectContaining({ id: 'a' })]
    })
    expect(service.restore('a')).toBe(true)
    expect(map.get('a')).toMatchObject({ lifecycleState: 'archived', softDeletedAt: null })
    expect(service.restore('c')).toBe(false)
  })
})
