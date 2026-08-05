// src/main/memory/setup.ts
// Phase 2 记忆基础设施接线：创建全部 memory Store / Service / Hook 并注册到 hook 系统。
// 依据 S-010 §1.1 责任边界 + F5-003 §5 + F5-013 迁移先行。
//
// 接线顺序（F5-013：迁移必须已跑完，DB 文件已存在）：
//   1. openMemoryDb（WAL + foreign_keys + 损坏检测）
//   2. init VectorStore（加载持久化向量 + IVF 状态）
//   3. 创建 L0/L1/L2 Store
//   4. 创建 EmbeddingClient（若配置了 embedding model + apiKey）
//   5. 创建 MemoryRevisionClock + MemoryWriter
//   6. 创建 ExtractionProvider + ExtractionService + MemoryJudge + MemoryDispatcher
//   7. 创建 ExtractionHook 并注册到 hook registry
//
// 凭据来源（临时方案，正式方案待 S-005 扩展 MemoryConfig）：
//   - embedding/extraction 的 baseUrl/apiKey 复用 model 域（config.model.baseUrl + secretStore 'modelApiKey'）
//   - 大多数 OpenAI-compatible 提供商同时提供 chat 和 embedding API
//   - 若用户用不同提供商做 embedding，需等 S-005 扩展 embeddingBaseUrl/embeddingApiKey 字段
//
// 旁路逻辑（S-010 §1.1 硬门）：
//   - memory.enabled=false -> 不创建任何 Store/Service/Hook，聊天回 Phase 1 行为
//   - memory.enabled=true 但无 API Key -> embedding=null（走 pending 路径），extraction 不注册

import { join } from 'node:path'
import type { WebContents } from 'electron'
import type { Logger } from '@shared/observability/types'
import type { ConfigStore } from '@shared/config/types'
import type { SecretStore } from '../security/secret-store'
import type { SessionStore } from '../chat/session-store'
import type { HookRegistration } from '../hooks/types'
import { registerHook } from '../hooks/registry'
import { openMemoryDb } from './db'
import { createL0Store } from './l0-store'
import { createL1Store } from './l1-store'
import { createL2Store } from './l2-store'
import { createSQLiteVectorStore, createWorkerKmeansBuilder } from './vector/sqlite-vector-store'
import { createEmbeddingClient, verifyEmbeddingModel, type EmbeddingClient } from './embedding'
import { createMemoryRevisionClock } from './revision-clock'
import { createMemoryWriter } from './writer'
import { createOpenAIExtractionProvider } from './extraction/provider'
import { createExtractionService } from './extraction/service'
import { createMemoryJudge } from './extraction/judge'
import { createMemoryDispatcher } from './extraction/dispatch'
import { createExtractionHook } from './extraction/hook'
import { createConflictLogStore } from './conflict/log'
import { createConflictResolver, createConflictService } from './conflict/resolver'
import { createSecureFetch } from '../security/network-policy'
import {
  createPromptContextAssembler,
  type PromptContextAssembler
} from '../prompts/context-assembler'
import { createDmaeStateStore } from './dmae/state-file'
import { createDmaeEngineService, type DmaeEngineService } from './dmae/service'
import { createDmaeHook } from './dmae/hook'
import { createMemoryEventBroadcaster, type MemoryEventBroadcaster } from './event-broadcaster'

export interface MemoryServices {
  l0Store: import('./l0-store').L0Store
  l1Store: import('./l1-store').L1Store
  l2Store: import('./l2-store').L2Store
  dmaeService: DmaeEngineService | null
  revisionClock: import('./revision-clock').MemoryRevisionClock
  broadcaster: MemoryEventBroadcaster
  conflictLogStore: import('./conflict/log').ConflictLogStore
}

export interface MemoryInfrastructure {
  /** 记忆 hook 注册项（null = memory 未启用，无需注册） */
  hook: HookRegistration | null
  /** 动态 Prompt context assembler（memory.enabled=true 时存在；dmae 关闭时只读 L0/L1） */
  contextAssembler: PromptContextAssembler | null
  /** P2-29: IPC handler 依赖（memory.enabled=false 时 null） */
  services: MemoryServices | null
  /** 清理：关闭 DB、停止队列消费者、terminate worker、dispose broadcaster */
  cleanup: () => void
}

export interface SetupMemoryDeps {
  dbPath: string
  dataDir: string
  configStore: ConfigStore
  secretStore: SecretStore
  sessionStore: SessionStore
  logger: Logger
  isDev: boolean
  /** P2-29: 获取主窗口 webContents（广播 memory-updated 事件用；可能被 CrashGuard 重建） */
  getWebContents: () => WebContents | null
}

/**
 * 创建并接线全部 Phase 2 记忆基础设施。
 * 返回 hook（供调用方 registerHook）+ cleanup（供 app quit 时调用）。
 */
export function setupMemoryInfrastructure(deps: SetupMemoryDeps): MemoryInfrastructure {
  const { dbPath, dataDir, configStore, secretStore, sessionStore, logger, isDev, getWebContents } =
    deps
  const memLogger = logger.child('memory')

  const memoryConfig = configStore.get().memory

  // 硬门 1：memory.enabled=false -> 全旁路
  if (!memoryConfig.enabled) {
    memLogger.info('memory disabled; skipping infrastructure setup', { scope: 'memory' })
    return { hook: null, contextAssembler: null, services: null, cleanup: () => {} }
  }

  // 1. 打开记忆库（迁移已跑完，DB 文件已存在）
  const db = openMemoryDb({ dbPath, logger: memLogger })

  // 2. VectorStore（加载持久化向量 + IVF 状态）
  // 显式创建 worker handle 以便 cleanup 时 terminate（F5-003 §5：worker 必须可清理）
  //
  // init() 是 async，此处 fire-and-forget：init 期间 search 走 flat 降级（mem 为空）。
  // 可接受：init 在启动时跑（<500ms），此期间无 turn.end 触发 upsert/search。
  // 若未来需 init 完成后再启动，可改为 await（但 setup 需改为 async）。
  const workerHandle = createWorkerKmeansBuilder()
  const vectorStore = createSQLiteVectorStore({
    db,
    dim: memoryConfig.embeddingDimension,
    logger: memLogger,
    kmeansBuilder: workerHandle.builder
  })
  // init 是 async，但在 setup 中我们不能 await（setup 是同步的）
  // 改为 fire-and-forget：init 在后台完成，期间 search 走 flat 降级
  void vectorStore.init().then(() => {
    memLogger.info('vector store initialized', {
      scope: 'memory',
      metrics: { count: vectorStore.count(), dim: vectorStore.stats().dim }
    })
  })

  // 3. L0/L1/L2 Store（注入 revisionClock + broadcaster，P2-29 事件广播）
  //    broadcaster 在 revisionClock 之后创建，此处先占位，下面创建后回填
  const revisionClock = createMemoryRevisionClock(db)
  const broadcaster = createMemoryEventBroadcaster({
    revisionClock,
    getWebContents,
    logger: memLogger
  })

  const l0Store = createL0Store({
    filePath: join(dataDir, 'l0-profile.json'),
    logger: memLogger,
    revisionClock,
    broadcaster
  })
  const l1Store = createL1Store({
    filePath: join(dataDir, 'l1-state.json'),
    logger: memLogger,
    revisionClock,
    broadcaster
  })
  const l2Store = createL2Store({ db })

  // 4. EmbeddingClient（若配置了 embedding model + apiKey）
  //    先做模型变更检测（F5-003 红线：禁止新旧混算）。
  //    若模型/dim 与持久化记录不一致 -> 告警 + embeddingClient=null（阻止新写入检索 +
  //    旧向量检索，后台重嵌入是 Phase 4）。
  const apiKey = secretStore.get('modelApiKey')
  const secureFetch = createSecureFetch(
    { isDev, allowHttpLocalhostInDev: configStore.get().security.allowHttpLocalhostInDev },
    memLogger
  )
  let embeddingClient: EmbeddingClient | null = null
  if (memoryConfig.embeddingModel && apiKey) {
    // 4a. 模型变更检测（F5-003 §5：模型变更=数据迁移，禁止新旧混算）
    const modelStatus = verifyEmbeddingModel(
      db,
      memoryConfig.embeddingModel,
      memoryConfig.embeddingDimension,
      memLogger
    )
    if (modelStatus.status === 'changed') {
      // 阻断 embedding：新写入走 pending 路径，检索因 embeddingClient=null 被跳过
      // （context-assembler 和 conflict service 都检查 embedding 可用性）
      memLogger.warn(
        'embedding model changed; blocking embedding until re-embed (Phase 4). L2 writes use pending path, retrieval disabled.',
        {
          scope: 'memory',
          code: 'MEM_EMBED_FAIL',
          tags: {
            storedModel: modelStatus.storedModel,
            newModel: memoryConfig.embeddingModel
          },
          metrics: {
            storedDim: modelStatus.storedDim,
            newDim: memoryConfig.embeddingDimension
          }
        }
      )
    } else {
      try {
        embeddingClient = createEmbeddingClient(
          {
            provider: memoryConfig.embeddingProvider,
            model: memoryConfig.embeddingModel,
            baseUrl: configStore.get().model.baseUrl, // 复用 model 域 baseUrl（临时方案）
            apiKey,
            dimension: memoryConfig.embeddingDimension
          },
          { logger: memLogger, fetchFn: secureFetch }
        )
        memLogger.info('embedding client configured', {
          scope: 'memory',
          tags: {
            model: memoryConfig.embeddingModel,
            provider: memoryConfig.embeddingProvider,
            modelStatus: modelStatus.status
          }
        })
      } catch (e) {
        memLogger.warn('embedding client setup failed; L2 will use pending path', {
          scope: 'memory',
          detail: e instanceof Error ? e.message : String(e)
        })
      }
    }
  } else {
    memLogger.info('embedding not configured; L2 writes will use pending path', {
      scope: 'memory',
      metrics: { hasModel: memoryConfig.embeddingModel ? 1 : 0, hasApiKey: apiKey ? 1 : 0 }
    })
  }

  // 5. MemoryWriter（revisionClock 已在 §3 创建，broadcaster 注入写路径）
  const writer = createMemoryWriter({
    db,
    l2Store,
    vectorStore,
    embedding: embeddingClient,
    revisionClock,
    broadcaster,
    logger: memLogger
  })

  // 6. ExtractionProvider + Service + Judge + Dispatcher
  //    conflictLogStore 只需 db，在 apiKey 检查外创建（无 API key 时仍可用于未来审计查询）
  const conflictLogStore = createConflictLogStore({ db })
  let extractionHook: ReturnType<typeof createExtractionHook> | null = null
  if (apiKey) {
    const extractionProvider = createOpenAIExtractionProvider(
      {
        provider: configStore.get().model.provider,
        model: configStore.get().model.model, // extraction 用 chat model（不是 embedding model）
        baseUrl: configStore.get().model.baseUrl, // 复用 model 域 baseUrl
        apiKey
      },
      { logger: memLogger, fetchFn: secureFetch }
    )
    const extractionService = createExtractionService({
      provider: extractionProvider,
      logger: memLogger
    })
    const judge = createMemoryJudge()

    // 冲突检测基础设施（P2-20/21）
    // resolver 复用 extraction provider（同为 temperature=0 的独立 LLM 调用；
    // OpenAIExtractionProvider 无状态，不会串吃 FIFO）
    const conflictResolver = createConflictResolver({
      provider: extractionProvider,
      logger: memLogger
    })
    const conflictService = createConflictService({
      l2Store,
      vectorStore,
      embedding: embeddingClient,
      resolver: conflictResolver,
      logStore: conflictLogStore,
      revisionClock,
      broadcaster,
      logger: memLogger,
      getMemoryConfig: () => configStore.get().memory
    })

    const dispatcher = createMemoryDispatcher({
      l0Store,
      l1Store,
      l2Store,
      writer,
      logger: memLogger,
      conflictService
    })
    extractionHook = createExtractionHook({
      logger: memLogger,
      sessionStore,
      extractionService,
      judge,
      dispatcher,
      getMemoryConfig: () => configStore.get().memory
    })
    // 注册 hook（hook 系统会在 turn.end 时调用）
    registerHook(extractionHook.hook)
    extractionHook.startConsumer()
    memLogger.info('extraction hook registered', { scope: 'memory' })
  } else {
    memLogger.warn('no API key; extraction hook not registered (memory writes disabled)', {
      scope: 'memory',
      code: 'LLM_AUTH'
    })
  }

  // 7. DMAE 引擎（P2-22~25；dmae.enabled=true 时创建）
  //    - DmaeStateStore：dmae-state.json 持久化（activation/US/MS）
  //    - DmaeEngineService：selectL2（activation 排序）+ updateTurn（turn.end 更新）
  //    - DmaeHook：turn.end（priority 300，extraction 250 之后）更新全部 L2 activation
  //    dmae.enabled=false 时 context-assembler 只读 L0/L1（assembler 内部检查），不创建 DMAE 基础设施
  let dmaeService: DmaeEngineService | null = null
  if (memoryConfig.dmae.enabled) {
    const dmaeStateStore = createDmaeStateStore({
      filePath: join(dataDir, 'dmae-state.json'),
      logger: memLogger
    })
    dmaeService = createDmaeEngineService({
      stateStore: dmaeStateStore,
      l2Store,
      getMemoryConfig: () => configStore.get().memory,
      logger: memLogger
    })
    dmaeService.initialize()
    // 注册 DMAE turn.end hook（extraction 之后，更新 activation）
    // C-γ-2：注入 revisionClock + broadcaster，updateTurn 产生 activation 变化时广播
    const dmaeHook = createDmaeHook({
      logger: memLogger,
      dmaeService,
      getMemoryConfig: () => configStore.get().memory,
      revisionClock,
      broadcaster
    })
    registerHook(dmaeHook.hook)
    memLogger.info('dmae engine initialized and hook registered', {
      scope: 'memory',
      metrics: { entries: dmaeService.states.size }
    })
  } else {
    memLogger.info('dmae disabled; using L0/L1-only static mode', { scope: 'memory' })
  }

  // 8. PromptContextAssembler（P2-16B：动态层组装器）
  // memory.enabled=true 时创建；dmae.enabled=false 时只读 L0/L1（assembler 内部检查）
  // embedding 为 null 时（无 API key）L2 链会 fail-open -> L2 skipped
  // P2-25：dmae.enabled=true 时注入 dmaeService.selectL2（activation 排序，rankSource='dmae-activation'）；
  //        dmae.enabled=false 时用默认 retrieval score 排序（assembler 内部不调 selectL2）
  const contextAssembler = createPromptContextAssembler({
    l0: l0Store,
    l1: l1Store,
    embedding: embeddingClient ?? {
      // 兜底：embedding 未配置时 embed 抛错，assembler 会 fail-open -> L2 skipped
      embed: async () => {
        throw new Error('embedding not configured')
      },
      embedBatch: async () => {
        throw new Error('embedding not configured')
      }
    },
    vectors: vectorStore,
    l2: l2Store,
    // P2-25：DMAE activation selector（dmae.enabled=true 时替换默认 retrieval 排序）
    // C-γ-2：透传 sessionId，DMAE service 据此分桶记录 userHitIds
    selectL2: dmaeService
      ? (hits, mem, sessionId) => dmaeService!.selectL2(hits, mem, sessionId)
      : undefined,
    // growth 未实现（P2-41 前）-> relationship skipped
    logger: memLogger
  })

  return {
    hook: extractionHook?.hook ?? null,
    contextAssembler,
    services: {
      l0Store,
      l1Store,
      l2Store,
      dmaeService,
      revisionClock,
      broadcaster,
      conflictLogStore
    },
    cleanup: () => {
      broadcaster.flush() // flush 待发事件
      broadcaster.dispose()
      extractionHook?.stopConsumer()
      workerHandle.terminate() // 必须 terminate，否则 worker 线程保活导致进程不退出
      try {
        db.close()
      } catch {
        /* best-effort */
      }
    }
  }
}
