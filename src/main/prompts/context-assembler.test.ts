// src/main/prompts/context-assembler.test.ts
// P2-16B 测试：PromptContextAssembler
// 依据：S-011 §1.2-§1.4、§3.2 测试矩阵（旁路/单层失败/空态/L2 链）

import { describe, it, expect, vi } from 'vitest'
import { createPromptContextAssembler } from './context-assembler'
import type { PromptContextAssemblerDeps } from './context-assembler'
import type { MemoryConfig } from '@shared/config/types'
import type { L0Profile } from '../memory/l0-store'
import type { L1State } from '../memory/l1-store'
import type { L2Memory } from '../memory/l2-store'
import type { VectorSearchHit } from '../memory/vector/types'
import type { Logger } from '@shared/observability/types'
import type { SessionId } from '@shared/chat/types'

function noopLogger(): Logger {
  const l: Logger = {
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
      return l
    }
  }
  return l
}

const DEFAULT_MEMORY: MemoryConfig = {
  enabled: true,
  embeddingProvider: 'test',
  embeddingModel: 'test-embed',
  embeddingDimension: 4,
  maxActive: 5,
  minRetrievalScore: 0.3,
  dmae: {
    enabled: true,
    maxScore: 100,
    promptThreshold: 30,
    userRewardBase: 100,
    wakeGamma: 8,
    modelRewardBase: 30,
    wakeLambda: 0.3,
    decayAlpha: 1.5,
    decayBeta: 0.3,
    presets: [],
    anomaly: {
      muted: {
        R01: 0,
        R02: 0,
        R03: 0,
        R04: 0,
        R05: 0,
        R06: 0,
        R07: 0,
        R08: 0,
        R09: 0,
        R10: 0,
        R11: 0,
        R12: 0,
        R13: 0
      },
      windows: {
        R01: { days: 3 },
        R02: { days: 7 },
        R03: { days: 3 },
        R04: { turns: 50 },
        R05: { turns: 100 },
        R06: {},
        R07: { turns: 50 },
        R08: { turns: 200 },
        R09: { days: 3 },
        R10: { days: 3, turns: 100 },
        R11: { days: 7 },
        R12: {},
        R13: {}
      }
    },
    historySampleEveryTurns: 1
  }
}

function makeL0(): L0Profile {
  return {
    schemaVersion: 1,
    fields: {
      preferredName: { value: '小明', isPinned: false, updatedAt: 1, source: 'user_explicit' }
    }
  }
}

function makeL1(): L1State {
  return {
    schemaVersion: 1,
    recentGoals: [{ text: '想学钢琴', updatedAt: 2 }],
    recentPreferences: []
  }
}

function makeL2(id: string): L2Memory {
  return {
    id,
    evidenceIds: [],
    sourceMessageIds: [],
    triggerText: null,
    content: `记忆内容-${id}`,
    confidence: 0.8,
    syncStatus: 'synced',
    lifecycleState: 'active',
    isPinned: false,
    accessCount: 0,
    weight: 1,
    type: 'situational',
    importance: 5,
    archivedAt: null,
    extractionKey: null,
    source: 'user_explicit'
  }
}

function makeDeps(opts: Partial<PromptContextAssemblerDeps> = {}): PromptContextAssemblerDeps {
  return {
    l0: { get: () => makeL0() },
    l1: { get: () => makeL1() },
    embedding: { embed: async () => new Float32Array([1, 0, 0, 0]), embedBatch: async () => [] },
    vectors: {
      search: () => [
        { memoryId: 'm1', score: 0.9 },
        { memoryId: 'm2', score: 0.7 }
      ]
    },
    l2: { get: (id: string) => makeL2(id) },
    logger: noopLogger(),
    ...opts
  }
}

describe('P2-16B PromptContextAssembler', () => {
  it('memory.enabled=false -> 四动态层全 skipped', async () => {
    const deps = makeDeps()
    const asm = createPromptContextAssembler(deps)
    const result = await asm.assemble({
      sessionId: 's1' as SessionId,
      query: 'hello',
      memory: { ...DEFAULT_MEMORY, enabled: false }
    })

    expect(result.memoryEnabled).toBe(false)
    expect(result.l0).toBeUndefined()
    expect(result.l1).toBeUndefined()
    expect(result.l2).toBeUndefined()
    expect(result.relationship).toBeUndefined()
  })

  it('dmae.enabled=false -> 只读 L0/L1；L2/relationship skipped', async () => {
    const embedSpy = vi.fn(async () => new Float32Array([1, 0, 0, 0]))
    const deps = makeDeps({
      embedding: { embed: embedSpy, embedBatch: async () => [] }
    })
    const asm = createPromptContextAssembler(deps)
    const result = await asm.assemble({
      sessionId: 's1' as SessionId,
      query: 'hello',
      memory: { ...DEFAULT_MEMORY, dmae: { ...DEFAULT_MEMORY.dmae, enabled: false } }
    })

    expect(result.memoryEnabled).toBe(true)
    expect(result.l0).toBeDefined()
    expect(result.l1).toBeDefined()
    expect(result.l2).toBeUndefined()
    expect(result.relationship).toBeUndefined()
    // 不调 embedding/vector/growth
    expect(embedSpy).not.toHaveBeenCalled()
  })

  it('memory.enabled=true + dmae=true -> L0/L1/L2 全读取', async () => {
    const deps = makeDeps()
    const asm = createPromptContextAssembler(deps)
    const result = await asm.assemble({
      sessionId: 's1' as SessionId,
      query: 'hello',
      memory: DEFAULT_MEMORY
    })

    expect(result.memoryEnabled).toBe(true)
    expect(result.l0).toBeDefined()
    expect(result.l1).toBeDefined()
    expect(result.l2).toBeDefined()
    expect(result.l2!.length).toBeGreaterThan(0)
    // L2 items 有正确的 provenance 和 rankSource
    for (const item of result.l2!) {
      expect(item.provenance).toBe('judge-approved-l2')
      expect(item.rankSource).toBe('retrieval')
      expect(item.id).toMatch(/^l2:/)
    }
  })

  it('L2 source 失败 -> L2 undefined，其他层仍在', async () => {
    const deps = makeDeps({
      embedding: {
        embed: async () => {
          throw new Error('embed failed')
        },
        embedBatch: async () => []
      }
    })
    const asm = createPromptContextAssembler(deps)
    const result = await asm.assemble({
      sessionId: 's1' as SessionId,
      query: 'hello',
      memory: DEFAULT_MEMORY
    })

    // L2 失败 -> undefined
    expect(result.l2).toBeUndefined()
    // L0/L1 仍在
    expect(result.l0).toBeDefined()
    expect(result.l1).toBeDefined()
  })

  it('L0 source 失败 -> L0 undefined，其他层仍在', async () => {
    const deps = makeDeps({
      l0: {
        get: () => {
          throw new Error('l0 read failed')
        }
      }
    })
    const asm = createPromptContextAssembler(deps)
    const result = await asm.assemble({
      sessionId: 's1' as SessionId,
      query: 'hello',
      memory: DEFAULT_MEMORY
    })

    expect(result.l0).toBeUndefined()
    expect(result.l1).toBeDefined()
    expect(result.l2).toBeDefined()
  })

  it('L1 source 失败 -> L1 undefined，其他层仍在', async () => {
    const deps = makeDeps({
      l1: {
        get: () => {
          throw new Error('l1 read failed')
        }
      }
    })
    const asm = createPromptContextAssembler(deps)
    const result = await asm.assemble({
      sessionId: 's1' as SessionId,
      query: 'hello',
      memory: DEFAULT_MEMORY
    })

    expect(result.l0).toBeDefined()
    expect(result.l1).toBeUndefined()
    expect(result.l2).toBeDefined()
  })

  it('growth undefined（P2-41 前）-> relationship skipped', async () => {
    const deps = makeDeps() // no growth
    const asm = createPromptContextAssembler(deps)
    const result = await asm.assemble({
      sessionId: 's1' as SessionId,
      query: 'hello',
      memory: DEFAULT_MEMORY
    })

    expect(result.relationship).toBeUndefined()
  })

  it('growth 存在 -> relationship 从 profile 派生', async () => {
    const deps = makeDeps({
      growth: {
        getProfile: () => ({
          stage: 'familiar' as const,
          promptFragments: ['里程碑1', '里程碑2']
        })
      }
    })
    const asm = createPromptContextAssembler(deps)
    const result = await asm.assemble({
      sessionId: 's1' as SessionId,
      query: 'hello',
      memory: DEFAULT_MEMORY
    })

    expect(result.relationship).toBeDefined()
    expect(result.relationship!.stage).toBe('familiar')
    expect(result.relationship!.promptFragments).toEqual(['里程碑1', '里程碑2'])
  })

  it('growth source 失败 -> relationship undefined，L2 仍在', async () => {
    const deps = makeDeps({
      growth: {
        getProfile: () => {
          throw new Error('growth failed')
        }
      }
    })
    const asm = createPromptContextAssembler(deps)
    const result = await asm.assemble({
      sessionId: 's1' as SessionId,
      query: 'hello',
      memory: DEFAULT_MEMORY
    })

    expect(result.relationship).toBeUndefined()
    expect(result.l2).toBeDefined() // L2 与 growth 独立
  })

  it('L2 hydrate 丢弃软删/purged/archived/sync failed 的条目', async () => {
    const deps = makeDeps({
      l2: {
        get: (id: string) => {
          if (id === 'm1') {
            const mem = makeL2(id)
            mem.lifecycleState = 'soft_deleted'
            return mem
          }
          if (id === 'm2') {
            const mem = makeL2(id)
            mem.syncStatus = 'failed'
            return mem
          }
          if (id === 'm3') {
            const mem = makeL2(id)
            mem.lifecycleState = 'archived' // 被 supersede 的旧记忆
            return mem
          }
          if (id === 'm4') {
            const mem = makeL2(id)
            mem.lifecycleState = 'purged'
            return mem
          }
          return null
        }
      }
    })
    const asm = createPromptContextAssembler(deps)
    const result = await asm.assemble({
      sessionId: 's1' as SessionId,
      query: 'hello',
      memory: DEFAULT_MEMORY
    })

    // m1 (soft_deleted) / m2 (sync failed) / m3 (archived) / m4 (purged) 都被丢弃
    // S-011 §1.2：只允许 active/dormant 进 prompt
    expect(result.l2).toBeDefined()
    expect(result.l2!.length).toBe(0)
  })

  it('L2 hydrate 保留 active 和 dormant 条目', async () => {
    const deps = makeDeps({
      l2: {
        get: (id: string) => {
          const mem = makeL2(id)
          if (id === 'm2') mem.lifecycleState = 'dormant'
          return mem
        }
      }
    })
    const asm = createPromptContextAssembler(deps)
    const result = await asm.assemble({
      sessionId: 's1' as SessionId,
      query: 'hello',
      memory: DEFAULT_MEMORY
    })

    expect(result.l2).toBeDefined()
    expect(result.l2!.length).toBe(2) // m1 (active) + m2 (dormant)
  })

  it('default selectL2 按 retrievalScore 降序取 top maxActive', async () => {
    const hits: VectorSearchHit[] = [
      { memoryId: 'm1', score: 0.5 },
      { memoryId: 'm2', score: 0.9 },
      { memoryId: 'm3', score: 0.7 }
    ]
    const deps = makeDeps({
      vectors: { search: () => hits }
    })
    const asm = createPromptContextAssembler(deps)
    const result = await asm.assemble({
      sessionId: 's1' as SessionId,
      query: 'hello',
      memory: { ...DEFAULT_MEMORY, maxActive: 2, minRetrievalScore: 0.3 }
    })

    expect(result.l2).toBeDefined()
    expect(result.l2!.length).toBe(2)
    // 降序：m2(0.9) 在前，m3(0.7) 在后
    expect(result.l2![0]!.id).toBe('l2:m2')
    expect(result.l2![1]!.id).toBe('l2:m3')
    // selectionRank = retrievalScore
    expect(result.l2![0]!.selectionRank).toBe(0.9)
    expect(result.l2![0]!.rankSource).toBe('retrieval')
  })

  it('minRetrievalScore 过滤低分命中', async () => {
    const hits: VectorSearchHit[] = [
      { memoryId: 'm1', score: 0.2 }, // 低于阈值
      { memoryId: 'm2', score: 0.8 }
    ]
    const deps = makeDeps({
      vectors: { search: () => hits }
    })
    const asm = createPromptContextAssembler(deps)
    const result = await asm.assemble({
      sessionId: 's1' as SessionId,
      query: 'hello',
      memory: { ...DEFAULT_MEMORY, minRetrievalScore: 0.5 }
    })

    expect(result.l2).toBeDefined()
    expect(result.l2!.length).toBe(1)
    expect(result.l2![0]!.id).toBe('l2:m2')
  })

  it('注入自定义 selectL2（P2-25 DMAE selector 模拟）', async () => {
    const deps = makeDeps({
      selectL2: (hits) =>
        hits.map((h) => ({
          id: `l2:${h.memory.id}`,
          provenance: 'judge-approved-l2' as const,
          content: h.memory.content,
          selectionRank: 0.99, // 模拟 activation
          rankSource: 'dmae-activation' as const,
          retrievalScore: h.retrievalScore
        }))
    })
    const asm = createPromptContextAssembler(deps)
    const result = await asm.assemble({
      sessionId: 's1' as SessionId,
      query: 'hello',
      memory: DEFAULT_MEMORY
    })

    expect(result.l2).toBeDefined()
    for (const item of result.l2!) {
      expect(item.rankSource).toBe('dmae-activation')
      expect(item.selectionRank).toBe(0.99)
    }
  })
})
