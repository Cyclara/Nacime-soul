// src/main/memory/gc.test.ts
// S-06 修复验证：物理删除联动向量 + 软删到期清扫。
// 关键断言：purgeMemory 同时清 L2 行与向量并推进 revision；幂等；
//           purgeExpiredSoftDeleted 只清超保留期软删记忆、受配额上限、null 时间戳保守保留。

import { describe, it, expect, vi } from 'vitest'
import type { Logger } from '@shared/observability/types'
import type { L2Memory, L2Store, MemoryLifecycleState } from './l2-store'
import type { VectorStore } from './vector/types'
import type { MemoryRevisionClock } from './revision-clock'
import type { MemoryEventBroadcaster } from './event-broadcaster'
import { purgeMemory, purgeExpiredSoftDeleted, SOFT_DELETE_TO_PURGE_DAYS } from './gc'

function noopLogger(): Logger {
  const log: Logger = {
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
      return log
    }
  }
  return log
}

function makeMemory(
  id: string,
  lifecycleState: MemoryLifecycleState,
  archivedAt: number | null
): L2Memory {
  return {
    id,
    evidenceIds: [],
    sourceMessageIds: [],
    triggerText: null,
    content: `内容-${id}`,
    confidence: 0.9,
    syncStatus: 'synced',
    lifecycleState,
    isPinned: false,
    accessCount: 0,
    weight: 1,
    type: 'stable',
    importance: 6,
    archivedAt,
    extractionKey: null,
    source: 'user_explicit',
    importanceBeforePin: null,
    editedAt: null
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- 测试辅助对象类型由推断承载
function makeGcDeps(rows: L2Memory[], now?: () => number) {
  const store = new Map(rows.map((r) => [r.id, r]))
  const removed: string[] = []
  const vectorRemoved: string[] = []
  let revisions = 0
  const notified: string[] = []

  const l2Store: Pick<L2Store, 'get' | 'remove' | 'list'> = {
    get: (id) => store.get(id) ?? null,
    remove: (id) => {
      store.delete(id)
      removed.push(id)
    },
    list: vi.fn((filter?: { lifecycleState?: MemoryLifecycleState }) => {
      const rowsAll = filter?.lifecycleState
        ? rows.filter((r) => r.lifecycleState === filter.lifecycleState)
        : rows
      return [...rowsAll]
    })
  }

  const vectorStore: Pick<VectorStore, 'remove'> = {
    remove: (id) => {
      vectorRemoved.push(id)
    }
  }

  const revisionClock: Pick<MemoryRevisionClock, 'next'> = {
    next: () => ++revisions
  }

  const broadcaster: Pick<MemoryEventBroadcaster, 'notify'> = {
    notify: (hint) => {
      notified.push(hint)
    }
  }

  return {
    deps: {
      l2Store,
      vectorStore,
      revisionClock,
      broadcaster,
      logger: noopLogger(),
      ...(now ? { now } : {})
    },
    removed,
    vectorRemoved,
    notified,
    getRevisions: () => revisions
  }
}

const DAY = 24 * 3600 * 1000
const NOW = 1_000_000 * DAY

describe('S-06: purgeMemory', () => {
  it('物理删除一条记忆：L2 行 + 向量 + revision + 广播全部同步', () => {
    const { deps, removed, vectorRemoved, notified, getRevisions } = makeGcDeps([
      makeMemory('m1', 'soft_deleted', NOW - 100 * DAY)
    ])

    const ok = purgeMemory(deps as never, 'm1', 'test')

    expect(ok).toBe(true)
    expect(removed).toEqual(['m1'])
    expect(vectorRemoved).toEqual(['m1'])
    expect(getRevisions()).toBe(1)
    expect(notified).toEqual(['l2'])
  })

  it('幂等：记忆不存在时为 no-op（不推进 revision）', () => {
    const { deps, removed, vectorRemoved, getRevisions } = makeGcDeps([])

    const ok = purgeMemory(deps as never, 'missing', 'test')

    expect(ok).toBe(false)
    expect(removed).toEqual([])
    expect(vectorRemoved).toEqual([])
    expect(getRevisions()).toBe(0)
  })
})

describe('S-06: purgeExpiredSoftDeleted', () => {
  it('只清超保留期的软删记忆，近期软删保留', () => {
    const oldOne = makeMemory('old', 'soft_deleted', NOW - (SOFT_DELETE_TO_PURGE_DAYS + 10) * DAY)
    const recentOne = makeMemory('recent', 'soft_deleted', NOW - 10 * DAY)
    const { deps, removed, vectorRemoved, getRevisions } = makeGcDeps(
      [oldOne, recentOne],
      () => NOW
    )

    const report = purgeExpiredSoftDeleted(deps as never)

    expect(report.purged).toBe(1)
    expect(report.scanned).toBe(2)
    expect(removed).toEqual(['old'])
    expect(vectorRemoved).toEqual(['old'])
    expect(getRevisions()).toBe(1)
  })

  it('null archivedAt 的软删记忆保守保留（不删）', () => {
    const noTs = makeMemory('m1', 'soft_deleted', null)
    const { deps, removed } = makeGcDeps([noTs], () => NOW)

    const report = purgeExpiredSoftDeleted(deps as never)

    expect(report.purged).toBe(0)
    expect(removed).toEqual([])
  })

  it('受 maxPurge 配额上限，超出的计入 deferred', () => {
    const rows = [
      makeMemory('a', 'soft_deleted', NOW - 100 * DAY),
      makeMemory('b', 'soft_deleted', NOW - 100 * DAY),
      makeMemory('c', 'soft_deleted', NOW - 100 * DAY)
    ]
    const { deps, removed } = makeGcDeps(rows, () => NOW)

    const report = purgeExpiredSoftDeleted(deps as never, { maxPurge: 2 })

    expect(report.purged).toBe(2)
    expect(report.deferred).toBe(1)
    expect(removed).toEqual(['a', 'b'])
  })

  it('非 soft_deleted 的记忆不被清扫', () => {
    const activeOne = makeMemory('act', 'active', null)
    const archivedOne = makeMemory('arc', 'archived', NOW - 500 * DAY)
    const { deps, removed } = makeGcDeps([activeOne, archivedOne], () => NOW)

    const report = purgeExpiredSoftDeleted(deps as never)

    expect(report.purged).toBe(0)
    expect(removed).toEqual([])
  })
})
