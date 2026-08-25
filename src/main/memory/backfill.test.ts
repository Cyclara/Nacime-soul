// src/main/memory/backfill.test.ts
// S-05 修复验证：pending L2 记忆在 embedding 恢复后回填向量。
// 关键断言：pending -> 每条 embed + upsert + 置 synced；有回填才推进 revision + 广播；
//           embedding 失败保持 pending 不中断其余条目；无 pending 为 no-op。

import { describe, it, expect, vi } from 'vitest'
import type { Logger } from '@shared/observability/types'
import type { EmbeddingClient } from './embedding'
import type { L2Memory, L2Store, MemorySyncStatus } from './l2-store'
import type { VectorStore } from './vector/types'
import type { MemoryRevisionClock } from './revision-clock'
import type { MemoryEventBroadcaster } from './event-broadcaster'
import { backfillPendingMemories } from './backfill'

// === 测试辅助 ===

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

function makeMemory(id: string, content: string, syncStatus: MemorySyncStatus): L2Memory {
  return {
    id,
    evidenceIds: [],
    sourceMessageIds: [],
    triggerText: null,
    content,
    confidence: 0.9,
    syncStatus,
    lifecycleState: 'active',
    isPinned: false,
    accessCount: 0,
    weight: 1,
    type: 'stable',
    importance: 6,
    archivedAt: null,
    extractionKey: `key-${id}`,
    source: 'user_explicit',
    importanceBeforePin: null,
    editedAt: null
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- 测试辅助对象类型由推断承载
function makeDeps(overrides?: {
  pendingRows?: L2Memory[]
  totalPending?: number
  embedError?: boolean
}) {
  const pendingRows = overrides?.pendingRows ?? [
    makeMemory('l2_1', '记忆甲', 'pending'),
    makeMemory('l2_2', '记忆乙', 'pending')
  ]
  const updated: Array<{ id: string; patch: Partial<Omit<L2Memory, 'id'>> }> = []
  const upserted: string[] = []
  let revisions = 0
  const notified: string[] = []

  const l2Store: Pick<L2Store, 'list' | 'count' | 'update'> = {
    list: vi.fn((filter?: { syncStatus?: MemorySyncStatus; limit?: number }) => {
      expect(filter?.syncStatus).toBe('pending')
      return pendingRows.slice(0, filter?.limit)
    }),
    count: vi.fn(() => overrides?.totalPending ?? pendingRows.length),
    update: (id, patch) => {
      updated.push({ id, patch })
    }
  }

  const vectorStore: Pick<VectorStore, 'upsert'> = {
    upsert: (id) => {
      upserted.push(id)
    }
  }

  const embedding: Pick<EmbeddingClient, 'embed'> = {
    embed: vi.fn(async (content: string) => {
      if (overrides?.embedError) throw new Error('embedding down')
      return new Float32Array([content.length])
    })
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
    deps: { l2Store, vectorStore, embedding, revisionClock, broadcaster, logger: noopLogger() },
    updated,
    upserted,
    notified,
    getRevisions: () => revisions
  }
}

describe('S-05: backfillPendingMemories', () => {
  it('pending 行逐条 embed + upsert + 置 synced，推进一次 revision 并广播', async () => {
    const { deps, updated, upserted, notified, getRevisions } = makeDeps()

    const result = await backfillPendingMemories(deps as never)

    expect(result).toEqual({ backfilled: 2, failed: 0, remaining: 2 })
    // 两条都 upsert 到向量库
    expect(upserted.sort()).toEqual(['l2_1', 'l2_2'])
    // 两条都标记 synced
    expect(updated).toEqual([
      { id: 'l2_1', patch: { syncStatus: 'synced' } },
      { id: 'l2_2', patch: { syncStatus: 'synced' } }
    ])
    // 有回填 -> 一次 revision + 一次 l2 广播
    expect(getRevisions()).toBe(1)
    expect(notified).toEqual(['l2'])
  })

  it('embedding 失败的行保持 pending、不中断其余条目、不抛错', async () => {
    const { deps, updated, upserted, getRevisions } = makeDeps({ embedError: true })

    const result = await backfillPendingMemories(deps as never)

    expect(result.failed).toBe(2)
    expect(result.backfilled).toBe(0)
    expect(upserted).toEqual([])
    expect(updated).toEqual([]) // 无一条被标记 synced
    expect(getRevisions()).toBe(0) // 无成功回填 -> 不推进 revision
  })

  it('部分失败：成功的条目照常 synced，失败的保持 pending', async () => {
    const { deps, updated, upserted, getRevisions } = makeDeps({
      pendingRows: [makeMemory('l2_ok', '好的', 'pending'), makeMemory('l2_bad', '坏的', 'pending')]
    })
    // 让第二条嵌入失败
    const embedding = deps.embedding as { embed: (c: string) => Promise<Float32Array> }
    const orig = embedding.embed
    deps.embedding.embed = async (c: string) => {
      if (c === '坏的') throw new Error('embedding down')
      return orig(c)
    }

    const result = await backfillPendingMemories(deps as never)

    expect(result.backfilled).toBe(1)
    expect(result.failed).toBe(1)
    expect(upserted).toEqual(['l2_ok'])
    expect(updated).toEqual([{ id: 'l2_ok', patch: { syncStatus: 'synced' } }])
    expect(getRevisions()).toBe(1)
  })

  it('无 pending 时为 no-op（不推进 revision、不广播）', async () => {
    const { deps, updated, upserted, notified, getRevisions } = makeDeps({ pendingRows: [] })

    const result = await backfillPendingMemories(deps as never)

    expect(result).toEqual({ backfilled: 0, failed: 0, remaining: 0 })
    expect(updated).toEqual([])
    expect(upserted).toEqual([])
    expect(notified).toEqual([])
    expect(getRevisions()).toBe(0)
  })
})
