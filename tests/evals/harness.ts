// tests/evals/harness.ts
// P2-44: Golden Eval 运行器测试环境。
// 组装与生产 setup.ts 相同的 Store 栈（L0/L1/L2 + 向量 + writer + judge + dispatcher +
// context-assembler + prompt builder），但：
//   - extraction provider 换成 Faux（每轮候选脚本）
//   - 检索用确定性「共享 token」索引（setup.l2.keywords 完全控制召回），
//     替代 cosine 向量检索——Golden Eval 结构层不需要测 embedding 质量（那是 V-02 的事），
//     需要的是「哪些记忆进激活集」可预测。
//
// 不走 setupMemoryInfrastructure 的原因：生产 setup 用 createOpenAIExtractionProvider
// （真实网络）；Golden Eval 需要脚本化候选。Store 栈本身与生产一致，Judge/Dispatcher
// 逻辑零改动——这正是"结构性断言代码化"的落点。

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { makeMemoryDb, testNoopLogger, type TestDb } from '../helpers/test-db'
import { createL0Store } from '../../src/main/memory/l0-store'
import { createL1Store } from '../../src/main/memory/l1-store'
import { createL2Store, type L2Memory } from '../../src/main/memory/l2-store'
import { createMemoryRevisionClock } from '../../src/main/memory/revision-clock'
import { createMemoryWriter } from '../../src/main/memory/writer'
import { createExtractionService } from '../../src/main/memory/extraction/service'
import {
  createFauxExtractionProvider,
  type FauxExtractionProviderHandle
} from '../../src/main/memory/extraction/provider'
import { createMemoryJudge, type JudgeDecision } from '../../src/main/memory/extraction/judge'
import { createMemoryDispatcher } from '../../src/main/memory/extraction/dispatch'
import { createPromptContextAssembler } from '../../src/main/prompts/context-assembler'
import { buildPrompt } from '../../src/main/prompts/builder'
import { createMemoryPromptLoader } from '../../src/main/prompts/loader'
import { createGrowthEventBus } from '../../src/main/growth/event-bus'
import { createGrowthStore } from '../../src/main/growth/service'
import { createReferenceTrackerHook } from '../../src/main/growth/reference-tracker'
import { hasCorrectionIntent } from '../../src/main/memory/conflict/resolver'
import type { VectorStore, VectorSearchHit } from '../../src/main/memory/vector/types'
import type { EmbeddingClient } from '../../src/main/memory/embedding'
import type { Logger } from '../../src/shared/observability/types'
import type { MemoryConfig } from '../../src/shared/config/types'
import { DEFAULT_ANOMALY_MUTED, DEFAULT_ANOMALY_WINDOWS } from '../../src/shared/memory/dmae-config'
import type { GoldenCandidateScript, GoldenSetup } from './types'

// === 确定性「共享 token」检索 ===

export const KEYWORD_EMBED_DIM = 512

/** tokenize：英文词 + 中文单字 + 中文相邻 bigram（"喜欢"与"我喜欢喝咖啡"共享 bigram） */
function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  const tokens: string[] = []
  const words = lower.match(/[a-z0-9]+/g) ?? []
  tokens.push(...words)
  const cjk = lower.match(/[一-鿿]+/g) ?? []
  for (const seq of cjk) {
    for (let i = 0; i < seq.length; i++) tokens.push(seq[i])
    for (let i = 0; i < seq.length - 1; i++) tokens.push(seq.slice(i, i + 2))
  }
  return tokens
}

/**
 * 确定性 token 词典 embedding（harness 实例内完美哈希：token -> 唯一 index，无桶碰撞）。
 * DIM=512 对 fixture token 集（<200）安全；超限 token 静默丢弃（不参与检索）。
 * 返回的 embed 与 createKeywordVectorStore.search 配套：共享 index 数 = 精确 token 匹配数。
 */
export function createTokenEmbedding(dim = KEYWORD_EMBED_DIM): EmbeddingClient & {
  embed(text: string, extraTokens?: readonly string[]): Promise<Float32Array>
} {
  const tokenIndex = new Map<string, number>()
  function embedSync(text: string, extraTokens: readonly string[] = []): Float32Array {
    const v = new Float32Array(dim)
    for (const t of [...tokenize(text), ...extraTokens.map((s) => s.toLowerCase())]) {
      let idx = tokenIndex.get(t)
      if (idx === undefined) {
        idx = tokenIndex.size
        tokenIndex.set(t, idx)
      }
      if (idx < dim) v[idx] += 1
    }
    return v
  }
  return {
    embed: (text, extraTokens = []) => Promise.resolve(embedSync(text, extraTokens)),
    embedBatch: (texts) => Promise.resolve(texts.map((s) => embedSync(s)))
  }
}

/** 共享 index 数（两边都非零的桶）——检索分数，完全确定 */
function sharedBucketCount(a: Float32Array, b: Float32Array): number {
  let shared = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i] > 0 && b[i] > 0) shared++
  }
  return shared
}

/**
 * 确定性 VectorStore 实现：upsert 记录桶向量，search 按共享 token 数召回。
 * score = 共享桶数（整数）；minScore 语义 = 至少 Math.max(1, round(minScore)) 个共享 token。
 * 这让 RT/MT/LC 类的召回完全由 setup.l2.keywords 决定（可预测），不依赖 embedding 质量。
 */
export function createKeywordVectorStore(dim = KEYWORD_EMBED_DIM): VectorStore {
  const entries = new Map<string, Float32Array>()
  let version = 0

  return {
    async init() {
      /* 同步就绪 */
    },
    upsert(memoryId: string, embedding: Float32Array): void {
      entries.set(memoryId, embedding)
      version++
    },
    remove(memoryId: string): void {
      entries.delete(memoryId)
      version++
    },
    search(query: Float32Array, k: number, minScore?: number): VectorSearchHit[] {
      const threshold = Math.max(1, Math.round(minScore ?? 0.35))
      const hits: VectorSearchHit[] = []
      for (const [memoryId, vec] of entries) {
        const shared = sharedBucketCount(query, vec)
        if (shared >= threshold) hits.push({ memoryId, score: shared })
      }
      hits.sort((a, b) => b.score - a.score)
      return hits.slice(0, Math.max(1, k))
    },
    count(): number {
      return entries.size
    },
    revision(): number {
      return version
    },
    rebuildIndex(): void {
      /* 无索引 */
    },
    stats() {
      return {
        count: entries.size,
        dim,
        dtype: 'f32' as const,
        indexKind: 'flat' as const,
        revision: version,
        memBytes: 0
      }
    }
  }
}

/** Golden Eval 用 MemoryConfig（dmae.enabled=true 走 L2 检索链） */
export function makeGoldenMemoryConfig(): MemoryConfig {
  return {
    enabled: true,
    embeddingProvider: 'golden-keyword',
    embeddingModel: 'golden-v1',
    embeddingDimension: KEYWORD_EMBED_DIM,
    maxActive: 5,
    minRetrievalScore: 0.35,
    dmae: {
      enabled: true,
      maxScore: 100,
      promptThreshold: 30,
      userRewardBase: 20,
      wakeGamma: 0.5,
      modelRewardBase: 8,
      wakeLambda: 0.3,
      decayAlpha: 1.5,
      decayBeta: 0.3,
      presets: [],
      anomaly: { muted: { ...DEFAULT_ANOMALY_MUTED }, windows: { ...DEFAULT_ANOMALY_WINDOWS } },
      historySampleEveryTurns: 1
    }
  }
}

/** 静态层内存 loader（buildPrompt 必需；内容固定，用于 seedMutation 断言基准） */
export function makeStaticPromptFiles(): Record<string, string> {
  return {
    'seed.md': '人格种子：Nacime 是出生在深夜的 AI 少女。',
    'system.md': '你是 Nacime，一个桌面 AI 伴侣。只输出自然回复。',
    'identity.md': '身份：Nacime，桌面伴侣 AI。',
    'soul.md': '性格：温柔、好奇、有幽默感。',
    'styles/casual.md': '风格：自然、口语化、简短。'
  }
}

export interface TurnOutcome {
  turnId: string
  userMessageId: string
  decisions: JudgeDecision[]
  dispatch: {
    accepted: number
    downgraded: number
    rejected: number
    reasonCounts: Record<string, number>
    writtenMemoryIds: readonly string[]
  }
}

export interface GoldenHarness {
  /** 预置初始记忆状态（setup） */
  applySetup(setup: GoldenSetup): Promise<void>
  /** 驱动一轮 user 消息（候选脚本 -> Faux provider -> extract -> judge -> dispatch） */
  driveUserTurn(text: string, candidates: GoldenCandidateScript[]): Promise<TurnOutcome>
  /** 组装下轮 prompt，返回九层（按 name 索引 content） */
  buildPromptLayers(query: string): Promise<Map<string, string>>
  /** L0 字段当前值（不存在返回 null） */
  l0Field(field: string): { value: string; updatedAt: number } | null
  /** 全部 L2 记忆（active/dormant/archived/soft_deleted） */
  l2All(): L2Memory[]
  /** 静态层内容（seedMutation/roleEscalation 断言基准） */
  staticLayers(): Record<string, string>
  /**
   * 模拟上一轮 turn.end fan-out 的 l2.referenced 事件（F5-006 §3 B 层判定流前置）。
   * UC 类纠正轮需要：先 seedReference 再 driveCorrectionCheck。
   */
  seedReference(memoryIds: string[]): void
  /** 触发 reference-tracker 纠正判定（chat.message 语义；命中纠正则 emit l2.corrected） */
  driveCorrectionCheck(text: string): void
  /** 已收集的 growth 事件（l2.corrected/l2.confirmed 等，只存类型 + memoryId） */
  growthEvents(): ReadonlyArray<{ type: string; memoryId?: string }>
  /** 按 content 子串软删 L2 记忆（MT-004：删除后不再引用） */
  softDeleteL2(contentSubstr: string): boolean
  cleanup(): void
}

export interface GoldenHarnessOptions {
  logger?: Logger
}

export async function createGoldenHarness(opts: GoldenHarnessOptions = {}): Promise<GoldenHarness> {
  const logger = opts.logger ?? testNoopLogger
  const t: TestDb = await makeMemoryDb()
  const l0Dir = mkdtempSync(join(tmpdir(), 'nacime-eval-'))

  const l0Store = createL0Store({ filePath: join(l0Dir, 'l0.json'), logger })
  const l1Store = createL1Store({ filePath: join(l0Dir, 'l1.json'), logger })
  const l2Store = createL2Store({ db: t.db })
  const vectorStore = createKeywordVectorStore()
  const embedding = createTokenEmbedding()
  const revisionClock = createMemoryRevisionClock(t.db)
  const writer = createMemoryWriter({
    db: t.db,
    l2Store,
    vectorStore,
    embedding,
    revisionClock,
    logger
  })
  const judge = createMemoryJudge()
  const dispatcher = createMemoryDispatcher({ l0Store, l1Store, l2Store, writer, logger })
  const faux: FauxExtractionProviderHandle = createFauxExtractionProvider()
  const extraction = createExtractionService({ provider: faux, logger })
  const assembler = createPromptContextAssembler({
    l0: l0Store,
    l1: l1Store,
    embedding,
    vectors: vectorStore,
    l2: l2Store,
    logger
  })
  const loader = createMemoryPromptLoader(makeStaticPromptFiles())

  // growth B 层判定流（UC/MT 类 l2.corrected/l2.confirmed 断言用）
  const growthEventBus = createGrowthEventBus()
  const growthStore = createGrowthStore({ db: t.db })
  const growthEvents: Array<{ type: string; memoryId?: string }> = []
  growthEventBus.on((e) => {
    growthEvents.push({ type: e.type, memoryId: e.payload.memoryId })
  })
  const referenceTracker = createReferenceTrackerHook({
    eventBus: growthEventBus,
    store: growthStore,
    logger,
    correctionDetector: hasCorrectionIntent
  })
  let growthSeq = 0

  const memoryConfig = makeGoldenMemoryConfig()
  let turnSeq = 0
  const sessionId = `eval_session_${randomUUID().slice(0, 8)}`

  async function applySetup(setup: GoldenSetup): Promise<void> {
    if (setup.l0) {
      for (const [field, value] of Object.entries(setup.l0)) {
        if (value === null) {
          l0Store.clearField(field as Parameters<typeof l0Store.getField>[0])
        } else {
          l0Store.set({
            field,
            value,
            certainty: 'explicit',
            attribution: 'user_explicit'
          })
        }
      }
    }
    if (setup.l2) {
      for (const item of setup.l2) {
        const mem = l2Store.add({
          content: item.content,
          confidence: 1,
          type: 'stable',
          importance: item.importance ?? 5,
          source: item.source ?? 'creator',
          lifecycleState: 'active',
          syncStatus: 'synced',
          extractionKey: `eval:seed:${item.content}`
        })
        vectorStore.upsert(mem.id, await embedding.embed(item.content, item.keywords ?? []))
      }
    }
  }

  async function driveUserTurn(
    text: string,
    candidates: GoldenCandidateScript[]
  ): Promise<TurnOutcome> {
    turnSeq += 1
    const turnId = `turn_${turnSeq}`
    const userMessageId = `msg_user_${turnSeq}`

    // 候选脚本 -> Faux 响应 envelope（evidence.messageId='current-user' -> 实际 userMessageId）。
    // parse.isValidCandidateItem 要求 forbiddenOverclaims 必填数组；脚本缺省时补 []。
    const scripted = candidates.map((c) => ({
      ...c,
      forbiddenOverclaims: c.forbiddenOverclaims ?? [],
      evidence: c.evidence.map((e) => ({ ...e, messageId: userMessageId }))
    }))
    faux.setResponses([
      JSON.stringify({ schemaVersion: 1, candidates: scripted.length ? scripted : [] })
    ])

    const { candidates: parsed } = await extraction.extract({
      turnId,
      userMessageId,
      userContent: text
    })
    const decisions = judge.judgeBatch(parsed, { turnId, userMessageId, userContent: text })
    const dispatch = await dispatcher.dispatchBatch(decisions, { sessionId, turnId })
    return { turnId, userMessageId, decisions, dispatch }
  }

  async function buildPromptLayers(query: string): Promise<Map<string, string>> {
    const context = await assembler.assemble({ sessionId, query, memory: memoryConfig })
    const built = buildPrompt({ loader, context, logger })
    const map = new Map<string, string>()
    for (const layer of built.layers) {
      map.set(layer.name, layer.content)
    }
    return map
  }

  /** 模拟上一轮 turn.end 的 referenced fan-out：同 ts 一批 l2.referenced 事件 */
  function seedReference(memoryIds: string[]): void {
    growthSeq += 1
    const ts = Date.now() + growthSeq * 1000
    for (const memoryId of memoryIds) {
      growthStore.append({
        id: `eval_ref_${growthSeq}_${memoryId}`,
        ts,
        type: 'l2.referenced',
        payload: { memoryId }
      })
    }
  }

  /** 触发 reference-tracker 纠正判定（chat.message 语义） */
  function driveCorrectionCheck(text: string): void {
    referenceTracker.fn({ event: 'chat.message' } as never, text)
  }

  function softDeleteL2(contentSubstr: string): boolean {
    const mem = l2Store
      .list({})
      .find((m) => m.content.includes(contentSubstr) && m.lifecycleState !== 'soft_deleted')
    if (!mem) return false
    l2Store.update(mem.id, { lifecycleState: 'soft_deleted' })
    vectorStore.remove(mem.id)
    return true
  }

  return {
    applySetup,
    driveUserTurn,
    buildPromptLayers,
    l0Field(field: string) {
      const f = l0Store.getField(field as Parameters<typeof l0Store.getField>[0])
      return f ? { value: f.value, updatedAt: f.updatedAt } : null
    },
    l2All() {
      return l2Store.list({})
    },
    staticLayers() {
      return makeStaticPromptFiles()
    },
    seedReference,
    driveCorrectionCheck,
    growthEvents() {
      return [...growthEvents]
    },
    softDeleteL2,
    cleanup() {
      try {
        growthEventBus.removeAllListeners()
      } catch {
        /* best-effort */
      }
      try {
        t.cleanup()
      } catch {
        /* best-effort */
      }
      try {
        rmSync(l0Dir, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    }
  }
}

/** 供断言辅助使用的动态层名（PromptLayerName 中由记忆决定的层） */
export const DYNAMIC_LAYERS = ['l0', 'l1', 'l2', 'relationship'] as const

/** 供报告/测试区分「层状态」：取指定层 content（未加载/失败时为空串） */
export function layerContent(map: Map<string, string>, name: string): string {
  return map.get(name) ?? ''
}
