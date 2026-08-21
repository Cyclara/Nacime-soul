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
import { backfillPendingMemories } from './backfill'
import { purgeExpiredSoftDeleted } from './gc'
import {
  createOpenAIExtractionProvider,
  createFauxExtractionProvider,
  type ExtractionProvider
} from './extraction/provider'
import { createSyncTurnExtractor } from './extraction/sync-turn'
import { createMemoryJudge } from './extraction/judge'
import { createMemoryDispatcher } from './extraction/dispatch'
import { createExtractionHook } from './extraction/hook'
import {
  createAttributionGate,
  resolveAttributionGateTarget,
  type AttributionGate
} from './extraction/attribution-gate'
import { createConflictLogStore } from './conflict/log'
import {
  createConflictResolver,
  createConflictService,
  hasCorrectionIntent
} from './conflict/resolver'
import { createSecureFetch } from '../security/network-policy'
import { resolveCompat } from '../llm/compat/detect-compat'
import {
  createPromptContextAssembler,
  type PromptContextAssembler
} from '../prompts/context-assembler'
import { createDmaeStateStore } from './dmae/state-file'
import { createDmaeEngineService, type DmaeEngineService } from './dmae/service'
import { createDmaeHook } from './dmae/hook'
import { createDmaeHistoryStore } from './dmae/history-store'
import { snapshotFromDmaeConfig } from './dmae/history-types'
import { createDmaeConfigObserver } from './dmae/config-observer'
import { DEFAULT_ANOMALY_MUTED } from '@shared/memory/dmae-config'
import { createDmaeDiagnosticsService, type DmaeDiagnosticsService } from './dmae/diagnostics'
import { createMemoryEventBroadcaster, type MemoryEventBroadcaster } from './event-broadcaster'
import { loadSeeds } from './seed/loader'
import { applySeeds } from './seed/apply'
import { createGrowthEventBus } from '../growth/event-bus'
import { createGrowthService, createGrowthStore } from '../growth/service'
import type { GrowthService } from '../growth/types'
import { L0_FIELD_WEIGHTS } from '../growth/types'
import { createGrowthBridgeHook } from '../growth/bridge'
import { createReferenceTrackerHook } from '../growth/reference-tracker'
import { wireGrowthEventSources, wireConflictEventSource } from '../growth/wire'

export interface MemoryServices {
  l0Store: import('./l0-store').L0Store
  l1Store: import('./l1-store').L1Store
  l2Store: import('./l2-store').L2Store
  dmaeService: DmaeEngineService | null
  /** P2-32：DMAE 诊断服务（dmae.enabled=false 时为 null） */
  dmaeDiagnostics: DmaeDiagnosticsService | null
  revisionClock: import('./revision-clock').MemoryRevisionClock
  broadcaster: MemoryEventBroadcaster
  conflictLogStore: import('./conflict/log').ConflictLogStore
  /** P2-40：成长服务（订阅记忆事件、写 growth_events 表；memory.enabled=false 时为 null） */
  growthService: GrowthService | null
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
  /** P2-36: seed 记忆文件目录（resources/seeds/） */
  seedsDir: string
  /** P2-41: 里程碑定义文件路径（resources/growth/milestones.json） */
  growthMilestonesPath: string
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
 *
 * P2-36/37 审计修复（2026-08-11）：改为 async——seed 条目需要同步嵌入才能进 Prompt，
 * 而 embedding 是异步网络调用，必须在 setup 内 await。
 */
export async function setupMemoryInfrastructure(
  deps: SetupMemoryDeps
): Promise<MemoryInfrastructure> {
  const {
    dbPath,
    dataDir,
    seedsDir,
    growthMilestonesPath,
    configStore,
    secretStore,
    sessionStore,
    logger,
    isDev,
    getWebContents
  } = deps
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
  const workerHandle = createWorkerKmeansBuilder(memLogger)
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

  // P2-40/41: 成长事件总线 + GrowthService（F5-006 §5：记忆模块 emit 事件 -> growth 订阅）。
  //   growth 是记忆的只读投影：记忆写路径 emit GrowthEvent -> GrowthService.ingest 同步写 growth_events 表。
  //   依赖方向（F5-006 §5）：growth 不 import memory 内部实现；本 composition root 负责转发事件。
  //   growth bridge hook（turn.end, priority 220）在下方注册，fan-out l2.referenced + session.daily_first。
  //
  //   两步创建：EventBus + GrowthStore 先建（L0/L1/L2 事件转发立即需要）；
  //   GrowthService 在 stores 创建后建（metricsProvider 依赖 L0/L1/L2/DMAE）。
  const growthEventBus = createGrowthEventBus()
  const growthStore = createGrowthStore({ db })
  let growthService: GrowthService | null = null // 下方 stores 创建后赋值

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

  // P2-40: 把 L0/L1/L2 事件转发到 GrowthEventBus（F5-006 §3 事件发射点接线）。
  //   必须在 seed 加载前注册：seed 的 l2.added 也应被 growth 记录（seed 是 L2 记忆）。
  //   l0.filled/l0.updated/l1.refreshed/l2.added -> growth_events 表
  //   返回 unsub，cleanup 时调用。
  const unsubGrowthEvents = wireGrowthEventSources({
    eventBus: growthEventBus,
    l0: l0Store,
    l1: l1Store,
    l2: l2Store
  })
  // conflict.resolved 事件转发（conflictService 创建后赋值；无 API key 时保持 null）
  let unsubConflictGrowth: (() => void) | null = null

  // P2-36/37: Seed 加载器--从 resources/seeds/ 读取 seed 记忆文件。
  // 只解析 frontmatter + body，不写 DB；实际创建 + 嵌入在 embedding client 就绪后（下方 step 4.5）。
  // 原因：seed 条目需有向量才能被检索进 Prompt（P2-36/37 审计 🔴 修复，2026-08-11）--
  //   此前 syncStatus='pending' 无向量，selectL2 只对向量检索命中排序，seed 条目永远进不了 Prompt。
  const seedEntries = loadSeeds(seedsDir, memLogger)

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

  // P2-36/37: Seed 创建 + 嵌入（在 embedding client 就绪后，applySeeds 逻辑见 seed/apply.ts）。
  //   embedding 可用 -> 同步嵌入 + upsert 向量（可检索进 Prompt）；否则 pending（冻结边界）。
  //   已有 pending seed 条目 -> 回填向量（首次无 key 后配 key 的重启场景）。
  //   幂等：extractionKey='seed:{filename}'；不经 writer（writer 耦合 extractionKey 公式，不适用 seed）。
  const { inserted: seedInserted, embedded: seedEmbedded } = await applySeeds(seedEntries, {
    l2Store,
    vectorStore,
    embedding: embeddingClient,
    revisionClock,
    broadcaster,
    logger: memLogger
  })
  if (seedInserted > 0 || seedEmbedded > 0) {
    memLogger.info('seed memories loaded', {
      scope: 'memory',
      metrics: { inserted: seedInserted, embedded: seedEmbedded, total: seedEntries.length }
    })
  }

  // S-05 修复：回填历史 pending 的 L2 记忆（非 seed）。
  //   writer.ts 在 embedding 暂时不可用（超时/限流/未配置）时写 syncStatus='pending' 且无向量；
  //   此前全仓无任何回填代码 -> 这类记忆永远进不了 prompt。现在在 embedding 恢复后（每次启动）
  //   扫描回填。仅 embedding 可用时执行（模型变更阻断时跳过，避免新旧模型混算）。
  //   上限控制启动期嵌入成本（每条一次网络调用），超出部分下次启动继续。
  if (embeddingClient) {
    await backfillPendingMemories({
      l2Store,
      vectorStore,
      embedding: embeddingClient,
      revisionClock,
      broadcaster,
      logger: memLogger
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
    // E2E 测试模式（COMPANION_TEST_MODE=faux）：提取 provider 换 Faux（脚本化响应），
    // 镜像 index.ts 的 chat faux 路径——避免 E2E 触发真实网络。响应由
    // COMPANION_FAUX_EXTRACTION 环境变量提供（候选 envelope JSON；未设置则空候选）。
    const fauxMode = process.env['COMPANION_TEST_MODE'] === 'faux'
    let extractionProvider: ExtractionProvider
    if (fauxMode) {
      // E2E：Faux provider 返回脚本化 envelope；evidence.messageId 用 "current-user" 占位，
      // 从 extraction user prompt（含真实 messageId 的 JSON 数据块）提取后替换——否则
      // Judge 的 EVIDENCE_NOT_CURRENT_TURN 会拒绝候选（镜像 tests/evals/harness 的做法）。
      const faux = createFauxExtractionProvider()
      const envelope = process.env['COMPANION_FAUX_EXTRACTION']
      if (envelope) faux.setResponses([envelope])
      extractionProvider = {
        async complete(request, signal) {
          const userMsg = request.messages.find((m) => m.role === 'user')
          const realId = /"messageId":"([^"]+)"/.exec(userMsg?.content ?? '')?.[1] ?? 'msg_user'
          const raw = await faux.complete(request, signal)
          return raw.replaceAll('"current-user"', JSON.stringify(realId))
        }
      }
    } else {
      extractionProvider = createOpenAIExtractionProvider(
        {
          provider: configStore.get().model.provider,
          model: configStore.get().model.model, // extraction 用 chat model（不是 embedding model）
          baseUrl: configStore.get().model.baseUrl, // 复用 model 域 baseUrl
          apiKey,
          // 与聊天同款 compat 解析：提取必须显式关思考（DeepSeek V4 默认 enabled，
          // 不发参数≠关闭，否则 reasoning 烧光 max_tokens，每轮静默 0 候选——2026-08-20 实测）
          thinkingFormat: resolveCompat(
            configStore.get().model.provider,
            configStore.get().model.baseUrl,
            configStore.get().model.compatOverrides
          ).thinkingFormat
        },
        { logger: memLogger, fetchFn: secureFetch }
      )
    }
    // P2-38: 提取 hook 用 sync_turn 便宜画像（低 maxOutputTokens），复用 P2-10 queue/schema。
    //   S-010 §1.5：P2-10 与 P2-38 不注册两个重复 extractor——能力由 P2-10 交付，
    //   生产 wiring 由 P2-38 切到每轮便宜模型。conflict resolver 仍直接用 extractionProvider。
    const extractionService = createSyncTurnExtractor({
      provider: extractionProvider,
      logger: memLogger
    })
    const judge = createMemoryJudge()

    // M-42: L0 归属语义门（双模型判定，drain 时一次批量调用）。
    //   faux 模式不创建——Faux 队列只承载提取 envelope 脚本，归因门共用会串吃响应；
    //   gate=null 时 drain 跳过语义判定，Judge step 6 回退正则表（fail-closed，M-42 验收路径）。
    //   配置面 memory.attributionGate 支持独立模型/供应商（默认全空 = 提取同款，
    //   同款时直接复用 extractionProvider 实例——OpenAIExtractionProvider 无状态，不串 FIFO）。
    let attributionGate: AttributionGate | null = null
    if (!fauxMode) {
      const gateTarget = resolveAttributionGateTarget(
        configStore.get().memory,
        configStore.get().model
      )
      const gateProvider = gateTarget.reuseExtraction
        ? extractionProvider
        : createOpenAIExtractionProvider(
            {
              provider: gateTarget.provider,
              model: gateTarget.model,
              baseUrl: gateTarget.baseUrl,
              apiKey,
              // 独立模型同样显式关思考（与提取同一 compat 解析入口；overrides 复用 model 域）
              thinkingFormat: resolveCompat(
                gateTarget.provider,
                gateTarget.baseUrl,
                configStore.get().model.compatOverrides
              ).thinkingFormat
            },
            { logger: memLogger, fetchFn: secureFetch }
          )
      attributionGate = createAttributionGate({ provider: gateProvider, logger: memLogger })
      if (!gateTarget.reuseExtraction) {
        memLogger.info('attribution gate uses independent model (M-42)', {
          scope: 'memory',
          tags: { provider: gateTarget.provider, model: gateTarget.model }
        })
      }
    }

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

    // P2-40: conflict.resolved 事件转发到 GrowthEventBus（F5-006 §3 conflict.resolved 发射点）
    unsubConflictGrowth = wireConflictEventSource({
      eventBus: growthEventBus,
      conflict: conflictService
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
      getMemoryConfig: () => configStore.get().memory,
      attributionGate
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
  let dmaeDiagnostics: DmaeDiagnosticsService | null = null
  let unsubDmaeConfig: (() => void) | null = null
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
    // P2-37: seed 条目（importance=10, source='creator'）设初始激活值 = maxScore（立即 Active）。
    // 因 importance≥10 -> Decay=0（formulas.ts IMPORTANCE_EXEMPT_THRESHOLD）-> 永不衰减，
    // seed 条目永远保留在 Active 集（除非 MAX_ACTIVE 裁剪，activation=100 会排在顶部）。
    const dmaeCfg = memoryConfig.dmae
    let seedActivated = 0
    for (const entry of seedEntries) {
      const mem = l2Store.getByExtractionKey(entry.id)
      if (mem && dmaeService.seedActivation(mem.id, dmaeCfg.maxScore)) {
        seedActivated++
      }
    }
    if (seedActivated > 0) {
      memLogger.info('seed entries activated in DMAE', {
        scope: 'memory',
        metrics: { activated: seedActivated }
      })
    }
    // P2-31.5F/G：创建 HistoryStore 并注入 DMAE hook（记录 dmae_turns + dmae_samples）
    const historyStore = createDmaeHistoryStore({ db, logger: memLogger })

    // P1（2026-08-10 审计）：调参生命周期——config 订阅在保存后写 annotation + 清静音。
    // 修复前 addAnnotation 无生产调用者、lastAnnotation 恒 null，R10 永不可达。
    // 实现抽出到 config-observer.ts（可单测）；守卫防清静音写回触发二次 annotation（死循环）。
    unsubDmaeConfig = createDmaeConfigObserver({
      getInitialParams: () => snapshotFromDmaeConfig(memoryConfig.dmae),
      getTurn: () => dmaeService!.turn,
      subscribe: configStore.subscribe.bind(configStore),
      addAnnotation: (a) => historyStore.addAnnotation(a),
      getMuted: () => configStore.get().memory.dmae.anomaly.muted,
      clearMuted: () => {
        configStore
          .update(
            { memory: { dmae: { anomaly: { muted: DEFAULT_ANOMALY_MUTED } } } },
            { immediate: true }
          )
          .catch(() => {
            /* 清静音失败不影响主流程 */
          })
      }
    })
    memLogger.info('dmae config observer registered (annotation + mute reset)', {
      scope: 'memory'
    })

    // P2-32：创建 DmaeDiagnosticsService（面板唯一数据来源）
    dmaeDiagnostics = createDmaeDiagnosticsService({
      logger: memLogger,
      dmaeService,
      historyStore,
      stateStore: dmaeStateStore,
      l2Store,
      getMemoryConfig: () => configStore.get().memory
    })
    // 注册 DMAE turn.end hook（extraction 之后，更新 activation）
    // C-γ-2：注入 revisionClock + broadcaster，updateTurn 产生 activation 变化时广播
    // P2-31.5G：注入 historyStore，每轮记录历史 + 跨零点日聚合
    const dmaeHook = createDmaeHook({
      logger: memLogger,
      dmaeService,
      historyStore,
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

  // P2-41: GrowthService 在 L0/L1/L2/DMAE 都创建后实例化（metricsProvider 依赖它们）。
  //   F5-006 §5 依赖方向：growth 不 import memory 内部实现；这里用闭包包装成 GrowthMetricsProvider。
  //   uniqueTopics：L2 无 tags 字段（F5-006 说 tags 去重），暂用 l2Total 近似（Phase 5 扩展 tags 后再改）。
  //   dmaeOldestActiveDays：从 dmaeService.states 读 active 条目最早 createdAt（id 含时间戳）；无则 0。
  const metricsProvider = {
    getL0Fill() {
      const profile = l0Store.get()
      const filled = Object.keys(profile.fields)
      const weights = L0_FIELD_WEIGHTS
      let weightedFilled = 0
      let weightedTotal = 0
      for (const key of Object.keys(weights)) {
        const w = weights[key]
        weightedTotal += w
        if (filled.includes(key)) weightedFilled += w
      }
      return {
        rate: weightedTotal > 0 ? weightedFilled / weightedTotal : 0,
        filledCount: filled.length
      }
    },
    getL1Freshness() {
      const state = l1Store.get()
      const all = [...state.recentGoals, ...state.recentPreferences]
      if (all.length === 0) return 0
      const sevenDays = 7 * 24 * 3600 * 1000
      const nowMs = Date.now()
      const fresh = all.filter((e) => nowMs - e.updatedAt <= sevenDays).length
      return fresh / all.length
    },
    getL2Stats() {
      const total = l2Store.count()
      const active = l2Store.count({ lifecycleState: 'active' })
      const dormant = l2Store.count({ lifecycleState: 'dormant' })
      const archived = l2Store.count({ lifecycleState: 'archived' })
      // uniqueTopics：L2 无 tags 字段（F5-006 说 tags 去重），暂用 l2Total 近似
      return {
        total,
        byState: { active, dormant, archived },
        uniqueTopics: total
      }
    },
    getDmaeAggregate() {
      if (!dmaeService) return null
      const states = dmaeService.states
      if (states.size === 0) {
        return { avgActivation: 0, oldestActiveDays: 0 }
      }
      let sum = 0
      let count = 0
      let oldestTs = 0
      for (const [id, entry] of states) {
        sum += entry.activation
        count++
        // "active" 近似：activation > promptThreshold 阈值。用条目最早 createdAt。
        // F5-006 §3 C 层最老活跃天数（F5-002 面板用）；严格态需 threshold 派生，此处近似用 activation>0。
        if (entry.activation > 0) {
          const ts = parseTsFromL2Id(id)
          if (ts > 0 && (oldestTs === 0 || ts < oldestTs)) oldestTs = ts
        }
      }
      const avg = count > 0 ? sum / count : 0
      const oldestActiveDays =
        oldestTs > 0 ? Math.floor((Date.now() - oldestTs) / (24 * 3600 * 1000)) : 0
      return { avgActivation: avg, oldestActiveDays }
    }
  }
  growthService = createGrowthService({
    db,
    eventBus: growthEventBus,
    logger: memLogger.child('growth'),
    metricsProvider,
    milestonesPath: growthMilestonesPath,
    getL0FilledFields: () => new Set(Object.keys(l0Store.get().fields)),
    revisionClock,
    broadcaster
  })
  memLogger.info('growth service initialized (P2-41: snapshot + U-value + milestones)', {
    scope: 'growth'
  })

  // P2-41: 注册 reference-tracker hook（chat.message, priority 150）。
  //   检测用户纠正意图，对上一轮 referencedMemoryIds 发射 l2.confirmed/corrected（F5-006 §3 B 层判定流）。
  const referenceTrackerHook = createReferenceTrackerHook({
    eventBus: growthEventBus,
    store: growthStore,
    logger: memLogger.child('growth'),
    // F5-006 §3：correctionIntent 复用冲突系统能力（单一 patterns 真源）
    correctionDetector: hasCorrectionIntent
  })
  registerHook(referenceTrackerHook)
  memLogger.info('growth reference-tracker hook registered (chat.message priority 150)', {
    scope: 'growth'
  })

  // P2-40: growth bridge hook（turn.end, priority 220, S-011 §1.6 位于 extraction 250 之前）。
  //   memoryEligible=true 时 fan-out referencedMemoryIds 为 l2.referenced 事件，
  //   当天首次对话发射 session.daily_first（同日幂等），实际发射事件时广播 growth hint。
  //   failOpen=true：hook 抛错不阻塞 turn.end 后续 hook（extraction/dmae）。
  const growthBridgeHook = createGrowthBridgeHook({
    eventBus: growthEventBus,
    store: growthStore,
    revisionClock,
    broadcaster,
    logger: memLogger,
    // P2-41: 当天首轮 turn.end 触发每日快照（落盘 + 里程碑检查）。growthService 已在上方创建。
    snapshotToday: () => growthService!.snapshotToday()
  })
  registerHook(growthBridgeHook)
  memLogger.info('growth bridge hook registered (turn.end priority 220)', { scope: 'growth' })

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
    // P2-41: growth 注入 relationship 层（GrowthProfile.promptFragments -> 9 层 Prompt relationship 层）
    // growthService.getProfile() 返回含 stage + promptFragments 的 GrowthProfile，符合 GrowthProfileLike
    growth: growthService
      ? {
          getProfile: () => {
            const p = growthService!.getProfile()
            return { stage: p.stage, promptFragments: p.promptFragments }
          }
        }
      : undefined,
    logger: memLogger
  })

  // S-06 修复：启动清扫超期 soft_deleted 记忆（物理删除 + 向量联动）。
  //   只处理"用户已显式软删且超过保留期（默认 90 天，F5-004 softDeleteToPurgeDays）"的行；
  //   dormant/archived 永不在此删除（DMAE floor revival 依赖其向量）。
  //   有界（maxPurgePerRun=500）败而不崩；冷存储找回（F5-004 完整 GC）属后续阶段。
  //   memory.enabled=false 或 services 为 null 时不会走到这里（setup 已提前返回）。
  purgeExpiredSoftDeleted({
    l2Store,
    vectorStore,
    revisionClock,
    broadcaster,
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
      dmaeDiagnostics,
      revisionClock,
      broadcaster,
      conflictLogStore,
      growthService
    },
    cleanup: () => {
      broadcaster.flush() // flush 待发事件
      broadcaster.dispose()
      unsubConflictGrowth?.()
      unsubGrowthEvents()
      growthEventBus.removeAllListeners()
      unsubDmaeConfig?.()
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

/** 从 L2 记忆 id（格式 l2_{createdAtMs}_{rand}）解析 createdAt epoch ms。非 l2_ 前缀返回 0。 */
function parseTsFromL2Id(id: string): number {
  const m = /^l2_(\d+)_/.exec(id)
  if (!m) return 0
  const v = parseInt(m[1], 10)
  return Number.isFinite(v) ? v : 0
}
