// src/main/prompts/context-assembler.ts
// P2-16B: PromptContextAssembler - 组装 PromptBuildContext 的运行时编排层。
// 依据：S-021 §1.2-§1.6、F5-003（向量检索）、F5-006（relationship）
//
// 设计要点：
//   1. Builder 保持纯函数边界；Assembler 负责 L0/L1/L2-chain/growth 四源隔离的异步编排
//   2. L0/L1 各自独立 try/catch；L2 是链式 source（embed->search->hydrate->select）
//   3. growth 与 L2 完全独立并行；L2 失败不阻止 growth
//   4. memory.enabled=false -> 返回 { memoryEnabled:false }（四动态层 skipped）
//   5. memory.dmae.enabled=false -> 只读 L0/L1；不调 embedding/vector/growth（L2/relationship skipped）
//   6. P2-25 前 selectL2 缺失 -> 默认 retrieval score 排序，rankSource='retrieval'
//   7. P2-41 前 growth 缺失 -> relationship skipped（不是错误）
//
// 安全红线：
//   - sanitized query 只用于检索，绝不直接渲染进动态 system 层
//   - L2 content 只能来自 L2Store.get() 的已持久化行，且 lifecycleState=active/dormant
//   - 日志只记 layer/reason/计数，不记 query/content（F5-011 LogFields 白名单）

import type { Logger } from '@shared/observability/types'
import type { MemoryConfig } from '@shared/config/types'
import type { SessionId } from '@shared/chat/types'
import type { L0Store } from '../memory/l0-store'
import type { L1Store } from '../memory/l1-store'
import type { L2Store, L2Memory } from '../memory/l2-store'
import type { EmbeddingClient } from '../memory/embedding'
import type { VectorStore, VectorSearchHit } from '../memory/vector/types'
import { isInstructionLikeContent } from './injection-guard'
import type {
  HydratedHit,
  PromptBuildContext,
  PromptL2Item,
  PromptRelationshipInput
} from './builder'

// === 类型 ===

/** GrowthService 的最小依赖（P2-41 前不存在；此时 relationship skipped） */
export interface GrowthProfileLike {
  stage: PromptRelationshipInput['stage']
  promptFragments: readonly string[]
}

export interface PromptContextAssemblerDeps {
  l0: Pick<L0Store, 'get'>
  l1: Pick<L1Store, 'get'>
  embedding: EmbeddingClient
  vectors: Pick<VectorStore, 'search'>
  l2: Pick<L2Store, 'get'>
  /** P2-41 才有；此前 undefined = relationship skipped，不伪造 profile */
  growth?: { getProfile(): GrowthProfileLike }
  /** P2-25 才替换为 DMAE selector；此前默认用 retrieval score 排序 */
  selectL2?: (
    hits: readonly HydratedHit[],
    memory: Readonly<MemoryConfig>,
    sessionId: SessionId
  ) => readonly PromptL2Item[]
  logger: Logger
}

export interface AssembleInput {
  sessionId: SessionId
  /** 已 sanitize；只用于检索，绝不直接渲染进动态 system 层 */
  query: string
  memory: Readonly<MemoryConfig>
}

export interface PromptContextAssembler {
  assemble(input: AssembleInput): Promise<PromptBuildContext>
}

// === 默认 L2 selector（P2-25 前：retrieval score 排序） ===

/**
 * 默认 L2 selector。按 retrievalScore 降序取 top maxActive，过滤 minRetrievalScore。
 * rankSource='retrieval'，selectionRank=retrievalScore（trimRank 越小越先裁 = 低分先裁）。
 * 不需要 sessionId（C-γ-2 统一签名：TS 允许参数更少的函数赋给三参类型，第三参自然忽略）。
 */
function defaultSelectL2(
  hits: readonly HydratedHit[],
  memory: Readonly<MemoryConfig>
): readonly PromptL2Item[] {
  const filtered = hits.filter((h) => h.retrievalScore >= memory.minRetrievalScore)
  filtered.sort((a, b) => b.retrievalScore - a.retrievalScore)
  const top = filtered.slice(0, Math.max(1, memory.maxActive))
  return top.map((h) => ({
    id: `l2:${h.memory.id}`,
    provenance: 'judge-approved-l2',
    content: h.memory.content,
    selectionRank: h.retrievalScore,
    rankSource: 'retrieval' as const,
    retrievalScore: h.retrievalScore
  }))
}

// === Assembler 实现 ===

export function createPromptContextAssembler(
  deps: PromptContextAssemblerDeps
): PromptContextAssembler {
  const { l0, l1, embedding, vectors, l2, growth, logger } = deps
  const selectL2 = deps.selectL2 ?? defaultSelectL2

  async function assemble(input: AssembleInput): Promise<PromptBuildContext> {
    const { memory } = input

    // 硬门：memory.enabled=false -> 四动态层全 skipped
    if (!memory.enabled) {
      return { memoryEnabled: false }
    }

    // === L0/L1 独立读取（各自 try/catch）===
    let l0Profile: ReturnType<L0Store['get']> | undefined
    try {
      l0Profile = l0.get()
    } catch (e) {
      logger.warn('dynamic prompt layer unavailable', {
        scope: 'prompts',
        tags: { layer: 'l0', reason: 'store-read-failed' },
        detail: e instanceof Error ? e.message : String(e)
      })
    }

    let l1State: ReturnType<L1Store['get']> | undefined
    try {
      l1State = l1.get()
    } catch (e) {
      logger.warn('dynamic prompt layer unavailable', {
        scope: 'prompts',
        tags: { layer: 'l1', reason: 'store-read-failed' },
        detail: e instanceof Error ? e.message : String(e)
      })
    }

    // dmae.enabled=false -> 只渲染 L0/L1；不调 embedding/vector/growth
    if (!memory.dmae.enabled) {
      return {
        memoryEnabled: true,
        l0: l0Profile,
        l1: l1State
      }
    }

    // === L2 链式 source（embed->search->hydrate->select，独立 try/catch）===
    const l2Items = await retrieveL2(input).catch((e) => {
      logger.warn('dynamic prompt layer unavailable', {
        scope: 'prompts',
        tags: { layer: 'l2', reason: 'retrieve-failed' },
        detail: e instanceof Error ? e.message : String(e)
      })
      return undefined
    })

    // === growth source（与 L2 完全独立并行）===
    let relationship: PromptRelationshipInput | undefined
    if (growth) {
      try {
        const profile = growth.getProfile()
        relationship = {
          stage: profile.stage,
          promptFragments: profile.promptFragments
        }
      } catch (e) {
        logger.warn('dynamic prompt layer unavailable', {
          scope: 'prompts',
          tags: { layer: 'relationship', reason: 'growth-read-failed' },
          detail: e instanceof Error ? e.message : String(e)
        })
      }
    }

    return {
      memoryEnabled: true,
      l0: l0Profile,
      l1: l1State,
      l2: l2Items,
      relationship
    }
  }

  /** L2 检索链：embed query -> search -> hydrate -> filter -> select */
  async function retrieveL2(input: AssembleInput): Promise<readonly PromptL2Item[] | undefined> {
    const { query, memory } = input

    // 1. embed query
    const queryVec = await embedding.embed(query)

    // 2. search（top maxActive，minScore 由 selector 再过滤）
    const k = Math.max(1, memory.maxActive)
    const hits = vectors.search(queryVec, k, memory.minRetrievalScore)

    // 3. hydrate（逐 ID 查 L2 元数据；丢弃不存在/非活跃态/sync failed）
    //    S-021 §1.2：只允许 lifecycleState=active/dormant 进 prompt。
    //    archived（被 supersede）/soft_deleted/purged 都不得出现，否则给模型矛盾信息。
    //    M-06：丢弃命中指令注入模式的记忆（记忆投毒/间接注入防护），并记录计数。
    const hydrated: HydratedHit[] = []
    let injectionDropped = 0
    for (const hit of hits) {
      const mem = l2.get(hit.memoryId)
      if (!mem) continue
      if (mem.lifecycleState !== 'active' && mem.lifecycleState !== 'dormant') continue
      if (mem.syncStatus === 'failed') continue
      if (isInstructionLikeContent(mem.content)) {
        injectionDropped++
        continue
      }
      hydrated.push({ memory: mem, retrievalScore: hit.score })
    }
    if (injectionDropped > 0) {
      logger.warn('L2 injection-like memories dropped before prompt assembly', {
        scope: 'memory',
        code: 'UNKNOWN',
        metrics: { dropped: injectionDropped }
      })
    }

    // 4. select（默认 retrieval score 排序；P2-25 后 DMAE activation）
    //    C-γ-2：透传 sessionId，DMAE selector 据此分桶记录 userHitIds（消除跨会话串线）。
    return selectL2(hydrated, memory, input.sessionId)
  }

  return { assemble }
}

// === 辅助：从 VectorSearchHit 构造 HydratedHit（测试用） ===

export function hydrateHits(
  hits: readonly VectorSearchHit[],
  lookup: (id: string) => L2Memory | null
): HydratedHit[] {
  const result: HydratedHit[] = []
  for (const hit of hits) {
    const mem = lookup(hit.memoryId)
    if (!mem) continue
    // S-021 §1.2：只允许 active/dormant 进 prompt
    if (mem.lifecycleState !== 'active' && mem.lifecycleState !== 'dormant') continue
    if (mem.syncStatus === 'failed') continue
    result.push({ memory: mem, retrievalScore: hit.score })
  }
  return result
}
