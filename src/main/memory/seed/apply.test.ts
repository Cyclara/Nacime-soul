// src/main/memory/seed/apply.test.ts
// P2-36/37 审计 🔴 修复验证：applySeeds 的嵌入路径。
// 关键断言：embedding 可用 -> seed 条目 syncStatus='synced' + 向量 upsert（可被检索进 Prompt）；
//           embedding 不可用/失败 -> pending（败而不崩）；重启回填场景。

import { describe, it, expect, vi } from 'vitest'
import type { Logger } from '@shared/observability/types'
import type { EmbeddingClient } from '../embedding'
import type { L2Memory, L2Store, MemorySyncStatus } from '../l2-store'
import { applySeeds, type SeedApplyDeps } from './apply'
import type { SeedEntry } from './loader'

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

/** 构造一条 SeedEntry */
function entry(id: string, body = `body-${id}`, importance = 10): SeedEntry {
  return {
    id,
    filename: `${id.replace('seed:', '')}.md`,
    frontmatter: {
      type: 'seed',
      importance,
      confidence: 1.0,
      source: 'creator',
      tags: ['test']
    },
    body
  }
}

/** 构造一个能记录调用的 mock L2Store */
function mockL2Store(existing: Map<string, L2Memory> = new Map()): {
  store: Pick<L2Store, 'getByExtractionKey' | 'add' | 'update'>
  added: L2Memory[]
  updated: Array<{ id: string; patch: Partial<Omit<L2Memory, 'id'>> }>
} {
  const added: L2Memory[] = []
  const updated: Array<{ id: string; patch: Partial<Omit<L2Memory, 'id'>> }> = []
  return {
    store: {
      getByExtractionKey: (key: string) => existing.get(key) ?? null,
      add: (input) => {
        const mem: L2Memory = {
          id: `l2_test_${added.length}`,
          evidenceIds: [],
          sourceMessageIds: [],
          triggerText: null,
          content: input.content,
          confidence: input.confidence,
          syncStatus: (input.syncStatus ?? 'pending') as MemorySyncStatus,
          lifecycleState: input.lifecycleState ?? 'active',
          isPinned: false,
          accessCount: 0,
          weight: 1,
          type: input.type ?? 'situational',
          importance: input.importance ?? 5,
          archivedAt: null,
          extractionKey: input.extractionKey ?? null,
          source: input.source ?? 'user_explicit'
        }
        existing.set(mem.id, mem)
        added.push(mem)
        return mem
      },
      update: (id, patch) => {
        updated.push({ id, patch })
        const cur = existing.get(id)
        if (cur) existing.set(id, { ...cur, ...patch, id })
      }
    },
    added,
    updated
  }
}

/** 构造能记录调用的 fake embedding client */
function fakeEmbedding(behavior: 'ok' | 'fail' | 'slow' = 'ok'): {
  client: EmbeddingClient
  embedCalls: string[]
} {
  const embedCalls: string[] = []
  return {
    client: {
      embed: async (text) => {
        embedCalls.push(text)
        if (behavior === 'fail') throw new Error('embed network error')
        // 返回固定 4 维向量（测试用）
        return new Float32Array([0.1, 0.2, 0.3, 0.4])
      },
      embedBatch: async () => []
    },
    embedCalls
  }
}

function makeDeps(overrides: Partial<SeedApplyDeps> = {}): SeedApplyDeps {
  return {
    l2Store: mockL2Store().store,
    vectorStore: { upsert: () => {} },
    embedding: null,
    revisionClock: { next: () => 1 },
    broadcaster: { notify: () => {} },
    logger: noopLogger(),
    ...overrides
  }
}

// === 测试 ===

describe('applySeeds', () => {
  it('embedding 可用 -> 新 seed 条目 syncStatus=synced + 向量 upsert（可检索进 Prompt）', async () => {
    const { store: l2, added } = mockL2Store()
    const upserts: string[] = []
    const { client: embedding, embedCalls } = fakeEmbedding()
    const result = await applySeeds([entry('seed:a'), entry('seed:b')], {
      l2Store: l2,
      vectorStore: { upsert: (id) => upserts.push(id) },
      embedding,
      revisionClock: { next: () => 1 },
      broadcaster: { notify: () => {} },
      logger: noopLogger()
    })

    expect(result.inserted).toBe(2)
    expect(result.embedded).toBe(2)
    expect(added.map((m) => m.syncStatus)).toEqual(['synced', 'synced'])
    // 向量 upsert 了每个 seed 条目
    expect(upserts).toHaveLength(2)
    expect(embedCalls).toHaveLength(2)
    // 元数据正确
    expect(added[0].importance).toBe(10)
    expect(added[0].source).toBe('creator')
    expect(added[0].extractionKey).toBe('seed:a')
  })

  it('embedding 不可用（null）-> 全部 pending（冻结边界，无向量）', async () => {
    const { store: l2, added } = mockL2Store()
    const result = await applySeeds([entry('seed:x')], makeDeps({ l2Store: l2 }))
    expect(result.inserted).toBe(1)
    expect(result.embedded).toBe(0)
    expect(added[0].syncStatus).toBe('pending')
  })

  it('embedding 失败 -> 写为 pending（败而不崩，不 throw）', async () => {
    const { store: l2, added } = mockL2Store()
    const { client: embedding } = fakeEmbedding('fail')
    const result = await applySeeds([entry('seed:y')], {
      ...makeDeps({ l2Store: l2 }),
      embedding
    })
    expect(result.inserted).toBe(1)
    expect(result.embedded).toBe(0)
    expect(added[0].syncStatus).toBe('pending')
  })

  it('已有 pending seed + embedding 现可用 -> 回填向量并更新为 synced（重启后配 key）', async () => {
    const existing = new Map<string, L2Memory>([
      [
        'seed:old',
        {
          id: 'l2_old',
          evidenceIds: [],
          sourceMessageIds: [],
          triggerText: null,
          content: '旧内容',
          confidence: 1.0,
          syncStatus: 'pending',
          lifecycleState: 'active',
          isPinned: false,
          accessCount: 0,
          weight: 1,
          type: 'stable',
          importance: 10,
          archivedAt: null,
          extractionKey: 'seed:old',
          source: 'creator'
        }
      ]
    ])
    const { store: l2, updated } = mockL2Store(existing)
    const upserts: string[] = []
    const { client: embedding } = fakeEmbedding()

    const result = await applySeeds([entry('seed:old')], {
      l2Store: l2,
      vectorStore: { upsert: (id) => upserts.push(id) },
      embedding,
      revisionClock: { next: () => 1 },
      broadcaster: { notify: () => {} },
      logger: noopLogger()
    })

    expect(result.inserted).toBe(0) // 已存在，不重复插入
    expect(result.embedded).toBe(1) // 回填成功
    expect(upserts).toEqual(['l2_old'])
    expect(updated).toEqual([{ id: 'l2_old', patch: { syncStatus: 'synced' } }])
  })

  it('已有 synced seed -> 跳过（不重复嵌入）', async () => {
    const existing = new Map<string, L2Memory>([
      [
        'seed:done',
        {
          id: 'l2_done',
          evidenceIds: [],
          sourceMessageIds: [],
          triggerText: null,
          content: '已嵌入',
          confidence: 1.0,
          syncStatus: 'synced',
          lifecycleState: 'active',
          isPinned: false,
          accessCount: 0,
          weight: 1,
          type: 'stable',
          importance: 10,
          archivedAt: null,
          extractionKey: 'seed:done',
          source: 'creator'
        }
      ]
    ])
    const { store: l2 } = mockL2Store(existing)
    const upserts: string[] = []
    const { client: embedding, embedCalls } = fakeEmbedding()

    const result = await applySeeds([entry('seed:done')], {
      l2Store: l2,
      vectorStore: { upsert: (id) => upserts.push(id) },
      embedding,
      revisionClock: { next: () => 1 },
      broadcaster: { notify: () => {} },
      logger: noopLogger()
    })

    expect(result.inserted).toBe(0)
    expect(result.embedded).toBe(0)
    expect(upserts).toEqual([])
    expect(embedCalls).toEqual([])
  })

  it('有写入时触发 revisionClock.next() + notify(l2)；无写入不触发', async () => {
    // 有写入
    const revNext = vi.fn()
    const notify = vi.fn()
    await applySeeds([entry('seed:new')], {
      ...makeDeps(),
      revisionClock: { next: revNext },
      broadcaster: { notify }
    })
    expect(revNext).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith('l2')

    // 无写入（空数组）-> 不触发
    const revNext2 = vi.fn()
    const notify2 = vi.fn()
    await applySeeds([], {
      ...makeDeps(),
      revisionClock: { next: revNext2 },
      broadcaster: { notify: notify2 }
    })
    expect(revNext2).not.toHaveBeenCalled()
    expect(notify2).not.toHaveBeenCalled()
  })
})
