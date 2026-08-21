// src/main/chat/service.ts
// P1-23: ChatService - 固定执行顺序编排一轮对话
// 依据：S-001 P1-23、S-004 #25-#27、S-003 §3.8（ChatStreamEvent）
//
// 固定执行顺序（S-001 P1-23 验收"事件顺序固定"）：
//   1. sanitize hook（chat.message）-> 清理用户输入
//   2. prompt + budget -> 构建 LlmRequest
//   3. chat.params hook -> 扩展点（Phase 1 无内置 hook）
//   4. provider stream -> 流式产出
//   5. turn.end hook -> 独立扩展点（Phase 2 记忆提取在此接入）
//
// 安全红线：
//   - 用户消息始终保持 user role（冻结合同 §1.0 注入边界）
//   - 单一 turnId 贯穿全轮（S-001 P1-23 验收）
//   - 失败只终止当前轮，不阻断后续（S-001 P1-23 验收）
//   - 同 session 有 active turn 时拒绝第二次 send（S-004 #27）
//   - 聊天正文不进日志（只记 turnId/长度/状态/错误码）
//
// 事件顺序（S-003 §3.8）：
//   started(seq=0) -> chunk(seq=1,2,...) -> completed/failed/cancelled(seq=N)
//   ACK 在 started 之前返回（S-003 §4 "send ACK 后 main 才发 started"）

import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { Logger } from '@shared/observability/types'
import { AppError, isAppError, type ErrorCode } from '@shared/errors'
import type {
  ChatMessage,
  ChatHistorySnapshot,
  SessionId,
  RequestId,
  MessageId,
  ChatStreamEvent
} from '@shared/chat/types'
import type { MemoryConfig } from '@shared/config/types'
import type { LLMProvider, LlmRequest, LlmMessage } from '../llm/types'
import type { PromptLoader } from '../prompts/loader'
import { buildPrompt } from '../prompts/builder'
import { applyBudget, type BudgetHistoryTurn } from '../prompts/budgeter'
import type { PromptContextAssembler } from '../prompts/context-assembler'
import { emitLifecycle, LifecycleEvent } from '../hooks/lifecycle'
import type { SessionStore } from './session-store'
import { formatTimePrefix } from './datetime-prefix'
import { hashIdempotencyText, type IdempotencyLedger } from './idempotency-ledger'
import { getTracer } from '../observability/tracer'
import { getMetrics } from '../observability/metrics'

// === 类型定义 ===

/** 模型能力（预算器需要） */
export interface ModelCapabilities {
  contextWindow: number
  maxOutputTokens: number
}

/** Provider 工厂结果 */
export interface ProviderFactoryResult {
  provider: LLMProvider
  capabilities: ModelCapabilities
}

/** 动态 Prompt 依赖（memory.enabled=true 时必需） */
export interface DynamicPromptDeps {
  contextAssembler: PromptContextAssembler
}

/** ChatService 依赖 */
export interface ChatServiceDeps {
  logger: Logger
  promptLoader: PromptLoader
  sessionStore: SessionStore
  /** Provider 工厂：每次 turn 调用，返回当前配置的 provider + 能力 */
  providerFactory: () => ProviderFactoryResult
  /** 只读配置获取器；返回当前 memory 配置。Phase 1 测试可省略（默认 memory.enabled=false） */
  getMemoryConfig?: () => Readonly<MemoryConfig>
  /** memory 关闭时可缺；开启时必须存在，否则抛 CFG_INVALID */
  dynamicPrompt?: DynamicPromptDeps
  /**
   * P2-43 跨重启幂等账本。可选：不注入时只有 C-β 进程内幂等。
   * 注入后：completed 终态跨重启重放原 ACK；failed 终态（含 cancelled/崩溃残留）
   * 走逃生门——删除记录按全新请求处理（防死轮次锁死重试）。
   */
  idempotencyLedger?: IdempotencyLedger
}

/** 事件接收器。ChatService 通过此回调发射 ChatStreamEvent */
export type ChatEventSink = (event: ChatStreamEvent) => void

/** 发送请求 */
export interface TurnRequest {
  sessionId: SessionId
  text: string
  clientRequestId: RequestId
}

/**
 * 重试请求（验收反馈④c）。
 * 与 send 的根本区别：重发的是**既有**用户消息——不写新 user 行、复用原 turnId，
 * 新 assistant 行落回原轮；到达终局后同轮旧 failed/cancelled assistant 行被删除。
 * 一轮在历史和界面上都只剩"user + 最新 assistant"，不再出现重复提问/重复回答。
 */
export interface RetryTurnRequest {
  sessionId: SessionId
  /** 被点击的失败/中断气泡 id（assistant 或 user 均可） */
  messageId: MessageId
  clientRequestId: RequestId
}

/** 发送确认（ACK） */
export interface TurnAck {
  requestId: RequestId
  userMessageId: MessageId
  assistantMessageId: MessageId
}

/** ChatService 接口 */
export interface ChatService {
  createSession(): SessionId
  /** 最近活跃会话（P2-43 启动恢复）；无会话返回 null */
  getLastSessionId(): SessionId | null
  list(sessionId: SessionId, limit: number): ChatHistorySnapshot
  send(request: TurnRequest, sink: ChatEventSink): Promise<TurnAck>
  /**
   * 重试既有用户消息所在轮（验收反馈④c）。返回 null 表示目标已不存在（容错：
   * 气泡是旧投影，主库已清理），调用方静默忽略即可。
   */
  retryTurn(request: RetryTurnRequest, sink: ChatEventSink): Promise<TurnAck | null>
  cancel(requestId: RequestId): boolean
  hasActiveTurn(sessionId: SessionId): boolean
}

/** turn.end hook 接收的数据 */
export interface TurnEndData {
  turnId: string
  sessionId: SessionId
  requestId: RequestId
  status: 'completed' | 'failed' | 'cancelled'
  inputLen: number
  outputLen: number
  errorCode?: ErrorCode
  /**
   * 是否符合记忆提取条件。依据 S-010 §1.1：只有 provider 正常完成、assistant 非空、
   * 已持久化且未走 sanitize/params 短路路径时为 true。failed/cancelled/stopped 均 false。
   * 提取管线和引用追踪只认这个门。
   */
  memoryEligible: boolean
  /**
   * 最终预算保留且 provider 正常完成、非空并已持久化的 L2 memoryId 列表。
   * 依据 S-011 §1.6：只有 memoryEligible=true 时才传非空数组；
   * failed/cancelled/stopped/检索命中但被 budget 裁掉均传 []。
   */
  referencedMemoryIds: readonly string[]
}

// === 内部状态 ===

interface ActiveTurnState {
  sessionId: SessionId
  assistantMessageId: MessageId
  controller: AbortController
}

interface ClientRequestRecord {
  sessionId: SessionId
  text: string
  ackPromise: Promise<TurnAck>
}

/** 只释放 requestId 自己持有的 session 登记；迟到的旧 finally 不得解锁新轮次。 */
export function releaseSessionTurnOwnership(
  sessionActiveTurn: Map<SessionId, RequestId>,
  sessionId: SessionId,
  requestId: RequestId
): void {
  if (sessionActiveTurn.get(sessionId) === requestId) {
    sessionActiveTurn.delete(sessionId)
  }
}

// === ChatService 实现 ===

/**
 * 创建 ChatService。
 *
 * send() 流程：
 *   1. clientRequestId 幂等命中 -> 返回同一 ACK Promise
 *   2. 检查 active turn -> 有则拒绝
 *   3. 生成 IDs 并同步占有 session（首个 await 前）
 *   4. 执行 sanitize hook，存储用户消息
 *   5. 返回 ACK（在事件之前）
 *   6. 后台启动 streamTurn（不阻塞 ACK）
 */
export function createChatService(deps: ChatServiceDeps): ChatService {
  const { logger, promptLoader, sessionStore, providerFactory, getMemoryConfig, dynamicPrompt } =
    deps
  const idempotencyLedger = deps.idempotencyLedger
  const chatLogger = logger.child('chat')

  // active turns: requestId -> state
  const activeTurns = new Map<RequestId, ActiveTurnState>()
  // session -> active requestId（用于 hasActiveTurn 检查）
  const sessionActiveTurn = new Map<SessionId, RequestId>()
  // C-β：renderer 生成的幂等键 -> 同一 pending/resolved ACK（ChatService 进程生命周期内保留）。
  const clientRequests = new Map<RequestId, ClientRequestRecord>()

  function hasActiveTurn(sessionId: SessionId): boolean {
    return sessionActiveTurn.has(sessionId)
  }

  function createSession(): SessionId {
    return sessionStore.createSession()
  }

  function getLastSessionId(): SessionId | null {
    return sessionStore.getLastSessionId()
  }

  function list(sessionId: SessionId, limit: number): ChatHistorySnapshot {
    const messages = sessionStore.getMessages(sessionId, limit)
    return {
      sessionId,
      messages: messages.map((m) => sessionStore.toView(m))
    }
  }

  function cancel(requestId: RequestId): boolean {
    const state = activeTurns.get(requestId)
    if (!state) return false
    state.controller.abort()
    return true
  }

  async function send(request: TurnRequest, sink: ChatEventSink): Promise<TurnAck> {
    const { sessionId, text, clientRequestId } = request

    // C-β：幂等检查必须先于 busy。相同请求的重投是同一次调用，不应被判为 CHAT_BUSY。
    const existing = clientRequests.get(clientRequestId)
    if (existing) {
      if (existing.sessionId !== sessionId || existing.text !== text) {
        throw new AppError({
          code: 'IPC_VALIDATION',
          userMessage: '同一请求标识不能用于不同的聊天请求',
          severity: 'error',
          retryable: false
        })
      }
      return existing.ackPromise
    }

    // P2-43：跨重启账本重放（进程内 miss 才查）。completed -> 原 ACK；
    // 已落盘的 failed/cancelled -> 逃生门：删记录按全新请求处理，防死轮次锁死重试。
    // 进程中途崩溃不会留下终态账本记录，同样按全新请求处理。
    const persisted = idempotencyLedger?.get(clientRequestId)
    if (persisted) {
      if (persisted.sessionId !== sessionId || persisted.textHash !== hashIdempotencyText(text)) {
        throw new AppError({
          code: 'IPC_VALIDATION',
          userMessage: '同一请求标识不能用于不同的聊天请求',
          severity: 'error',
          retryable: false
        })
      }
      if (persisted.state === 'completed') {
        return persisted.ack
      }
      idempotencyLedger?.remove(clientRequestId)
    }

    // 1. 检查 active turn（S-004 #27：同 session 有 active turn 时拒绝第二次 send）
    //    此检查与下方登记之间没有 await：同一事件循环内形成原子占位，关闭 TOCTOU。
    if (hasActiveTurn(sessionId)) {
      throw new AppError({
        code: 'CHAT_BUSY',
        userMessage: '当前对话正在进行中，请等待完成或停止后再发送',
        severity: 'error',
        retryable: false
      })
    }

    // 2. 生成 ID + 在第一个 await 前登记 active/session 所有权
    const turnId = randomUUID()
    const requestId = randomUUID()
    const userMessageId = randomUUID()
    const assistantMessageId = randomUUID()
    const controller = new AbortController()
    activeTurns.set(requestId, { sessionId, assistantMessageId, controller })
    sessionActiveTurn.set(sessionId, requestId)

    // 用 microtask 启动准备阶段，确保 clientRequests 记录先同步写入，再执行任何 await 路径。
    const ackPromise = Promise.resolve().then(async (): Promise<TurnAck> => {
      // 3. 执行 sanitize hook（chat.message 事件）
      //    sanitize-message hook priority=100，failOpen=true
      const sanitizeResult = await emitLifecycle(
        LifecycleEvent.CHAT_MESSAGE,
        { event: LifecycleEvent.CHAT_MESSAGE, turnId, sessionId },
        { text, sessionId }
      )
      const sanitizedText = (sanitizeResult.data as { text: string }).text

      // 4. 存储用户消息（始终 complete，role=user）
      //    冻结合同 §1.0：用户消息始终保持 user role
      const userMessage: ChatMessage = {
        id: userMessageId,
        sessionId,
        role: 'user',
        content: sanitizedText,
        createdAt: Date.now(),
        status: 'complete',
        turnId
      }
      sessionStore.appendMessage(sessionId, userMessage)

      chatLogger.info('turn started', {
        scope: 'chat',
        turnId,
        tags: { requestId, sessionId },
        metrics: { inputLen: sanitizedText.length }
      })

      // 5. 返回 ACK（在事件之前，S-003 §4）
      const ack: TurnAck = { requestId, userMessageId, assistantMessageId }

      // 6. 后台启动 streamTurn（不阻塞 ACK 返回）；沿用 send() 已登记的 controller。
      const wasStopped = sanitizeResult.stopped
      void streamTurn({
        ack,
        turnId,
        sessionId,
        sanitizedText,
        wasStopped,
        sink,
        controller,
        clientRequestId,
        text
      }).catch((err) => {
        // 这是 streamTurn 内部未捕获的错误（不应发生，所有路径都有 try/catch）
        chatLogger.error('turn streaming failed unexpectedly', {
          scope: 'chat',
          code: 'UNKNOWN',
          turnId,
          detail: err instanceof Error ? err.message : String(err)
        })
      })

      return ack
    })

    const record: ClientRequestRecord = { sessionId, text, ackPromise }
    clientRequests.set(clientRequestId, record)

    try {
      return await ackPromise
    } catch (err) {
      // ACK 前失败不应形成永久幂等记录；释放本请求仍持有的占位，允许真实重试。
      if (clientRequests.get(clientRequestId) === record) {
        clientRequests.delete(clientRequestId)
      }
      activeTurns.delete(requestId)
      releaseSessionTurnOwnership(sessionActiveTurn, sessionId, requestId)
      throw err
    }
  }

  /**
   * 重试既有用户消息所在轮（验收反馈④c）。
   *
   * 与 send 的差异：
   *   - 目标定位按 turnId 精确匹配（被点气泡带哪个 turnId 就重试哪一轮），
   *     不再"往前找最近 user"——旧 walk-back 在 M-47 现场会重试错的轮次
   *     （表尾占位气泡实际属于更早的孤儿轮，walk-back 却命中了它前面那条完整轮的 user）。
   *   - 不写新 user 行、不跑 sanitize（原文已清理并落库）；复用原 turnId。
   *   - streamTurn 终局删除同轮被取代的 assistant 行（supersedeTurnId）。
   * 幂等与 send 同一套两层账本（clientRequests + idempotencyLedger）。
   */
  async function retryTurn(request: RetryTurnRequest, sink: ChatEventSink): Promise<TurnAck | null> {
    const { sessionId, messageId, clientRequestId } = request

    // === 定位目标轮（先于幂等账本：目标不存在时不必占用账本记录）===
    const clicked = sessionStore.getMessage(sessionId, messageId)
    if (!clicked) return null

    let userMessage: ChatMessage | null = null
    if (clicked.role === 'user') {
      userMessage = clicked
    } else if (clicked.turnId) {
      // 精确按 turnId 定位该轮的 user 行
      userMessage =
        sessionStore
          .getMessages(sessionId, 1000)
          .find((m) => m.role === 'user' && m.turnId === clicked.turnId) ?? null
    }
    if (!userMessage) {
      // 兜底：无 turnId 的遗产数据走旧 walk-back（往前找最近 user）
      const history = sessionStore.getMessages(sessionId, 500)
      const idx = history.findIndex((m) => m.id === messageId)
      for (let i = idx; i >= 0; i--) {
        if (history[i].role === 'user') {
          userMessage = history[i]
          break
        }
      }
    }
    if (!userMessage) {
      chatLogger.warn('retry: no user message for target', {
        scope: 'chat',
        tags: { sessionId, messageId }
      })
      return null
    }
    const targetUser = userMessage
    const retryText = targetUser.content

    // === 幂等（与 send 相同的两层检查；text 用目标 user 原文）===
    const existing = clientRequests.get(clientRequestId)
    if (existing) {
      if (existing.sessionId !== sessionId || existing.text !== retryText) {
        throw new AppError({
          code: 'IPC_VALIDATION',
          userMessage: '同一请求标识不能用于不同的聊天请求',
          severity: 'error',
          retryable: false
        })
      }
      return existing.ackPromise
    }
    const persisted = idempotencyLedger?.get(clientRequestId)
    if (persisted) {
      if (persisted.sessionId !== sessionId || persisted.textHash !== hashIdempotencyText(retryText)) {
        throw new AppError({
          code: 'IPC_VALIDATION',
          userMessage: '同一请求标识不能用于不同的聊天请求',
          severity: 'error',
          retryable: false
        })
      }
      if (persisted.state === 'completed') {
        return persisted.ack
      }
      idempotencyLedger?.remove(clientRequestId)
    }

    // === active turn 检查 + 原子占位（与 send 同序：检查与登记之间无 await）===
    if (hasActiveTurn(sessionId)) {
      throw new AppError({
        code: 'CHAT_BUSY',
        userMessage: '当前对话正在进行中，请等待完成或停止后再发送',
        severity: 'error',
        retryable: false
      })
    }

    // turnId 复用：新 assistant 行归回原轮。遗产 user 行无 turnId 时补写，保证分组语义。
    let turnId = targetUser.turnId
    if (!turnId) {
      turnId = randomUUID()
      sessionStore.updateMessage(sessionId, targetUser.id, { turnId })
    }

    const requestId = randomUUID()
    const assistantMessageId = randomUUID()
    const controller = new AbortController()
    activeTurns.set(requestId, { sessionId, assistantMessageId, controller })
    sessionActiveTurn.set(sessionId, requestId)

    const ackPromise = Promise.resolve().then(async (): Promise<TurnAck> => {
      chatLogger.info('retry turn started', {
        scope: 'chat',
        turnId,
        tags: { requestId, sessionId },
        metrics: { inputLen: retryText.length }
      })

      const ack: TurnAck = { requestId, userMessageId: targetUser.id, assistantMessageId }

      void streamTurn({
        ack,
        turnId,
        sessionId,
        sanitizedText: retryText,
        wasStopped: false,
        sink,
        controller,
        clientRequestId,
        text: retryText,
        supersedeTurnId: turnId
      }).catch((err) => {
        chatLogger.error('retry turn streaming failed unexpectedly', {
          scope: 'chat',
          code: 'UNKNOWN',
          turnId,
          detail: err instanceof Error ? err.message : String(err)
        })
      })

      return ack
    })

    const record: ClientRequestRecord = { sessionId, text: retryText, ackPromise }
    clientRequests.set(clientRequestId, record)

    try {
      return await ackPromise
    } catch (err) {
      if (clientRequests.get(clientRequestId) === record) {
        clientRequests.delete(clientRequestId)
      }
      activeTurns.delete(requestId)
      releaseSessionTurnOwnership(sessionActiveTurn, sessionId, requestId)
      throw err
    }
  }

  /**
   * 后台流式执行一轮对话。
   * 不阻塞 send() 返回 ACK。
   *
   * 流程：build prompt -> budget -> chat.params hook -> provider stream -> turn.end
   */
  async function streamTurn(opts: {
    ack: TurnAck
    turnId: string
    sessionId: SessionId
    sanitizedText: string
    wasStopped: boolean
    sink: ChatEventSink
    controller: AbortController
    /** P2-43：幂等账本落盘所需的原始请求键与原文（非 sanitized） */
    clientRequestId: RequestId
    text: string
    /**
     * 验收反馈④c：重试轮标记。到达终局（completed/failed/cancelled）写入新 assistant 行后，
     * 删除同 turnId 被取代的旧 assistant 行（failed/cancelled/CHAT_INTERRUPTED 占位），
     * 保证一轮只剩最新 assistant——历史不堆重复回答，getTurnMessages 也不被旧失败行挡住。
     */
    supersedeTurnId?: string
  }): Promise<void> {
    const { ack, turnId, sessionId, sanitizedText, wasStopped, sink, controller } = opts
    const { clientRequestId, text, supersedeTurnId } = opts
    const { requestId, assistantMessageId } = ack

    // 终局清理：删除同轮被取代的 assistant 行。持久化尽力而为（V-03a 同则：
    // 写盘失败不得影响事件送达）。必须在 turn.end hook 之前完成（finally 里发射），
    // 否则 getTurnMessages 会先命中旧 failed 行，成功重试的记忆提取被静默跳过。
    function removeSupersededRows(): void {
      if (!supersedeTurnId) return
      try {
        const removed = sessionStore.deleteSupersededAssistantMessages(
          sessionId,
          supersedeTurnId,
          assistantMessageId
        )
        if (removed > 0) {
          chatLogger.info('superseded assistant rows removed', {
            scope: 'chat',
            turnId,
            metrics: { removed }
          })
        }
      } catch (err) {
        chatLogger.warn('superseded rows cleanup skipped', {
          scope: 'chat',
          turnId,
          detail: err instanceof Error ? err.message : String(err)
        })
      }
    }

    let sequence = 0
    let status: 'completed' | 'failed' | 'cancelled' = 'completed'
    let errorCode: ErrorCode | undefined
    let accumulated = ''
    let accumulatedReasoning = ''
    let inputTokens = 0
    let outputTokens = 0
    // memoryEligible：仅 provider 正常完成且 assistant 非空时为 true（S-010 §1.1）。
    // sanitize 短路、params 短路、failed、cancelled、空输出均保持 false。
    let memoryEligible = false
    // 最终预算保留的 L2 memoryId 列表（S-011 §1.6）。
    // 只在 memoryEligible=true 时才传非空给 turn.end；提前 return 路径保持 []。
    let includedMemoryIds: readonly string[] = []

    // P2-27: 开始一轮 trace（F5-011 §4 验收：连续 10 轮 -> 10 条完整 trace）
    const tracer = getTracer()
    tracer.beginTurn(turnId, sanitizedText.length)

    try {
      // 发射 started（seq=0）
      sink({
        type: 'started',
        requestId,
        sessionId,
        assistantMessageId,
        sequence: 0
      })
      sequence = 1

      // 如果 sanitize 短路或清理后文本为空，不调用 provider（S-004 #26）
      if (wasStopped || sanitizedText.trim().length === 0) {
        chatLogger.info('turn skipped: empty input after sanitize', {
          scope: 'chat',
          turnId,
          tags: { requestId, reason: wasStopped ? 'stopped' : 'empty' }
        })

        // 存储空 assistant 消息
        sessionStore.appendMessage(sessionId, {
          id: assistantMessageId,
          sessionId,
          role: 'assistant',
          content: '',
          createdAt: Date.now(),
          status: 'complete',
          turnId
        })

        sink({
          type: 'completed',
          requestId,
          sequence,
          usage: { inputTokens: 0, outputTokens: 0 }
        })
        return
      }

      // === 构建 prompt + budget ===
      // P2-27: prompt.build span（含 context assemble + buildPrompt + applyBudget）
      const promptSpan = tracer.startSpan('prompt.build', turnId)
      // S-011 §1.6：memory.enabled=true 但 dynamicPrompt 缺失 -> CFG_INVALID
      // memory.enabled=false（默认）-> Phase 1 五层静态路径
      const memoryConfig = getMemoryConfig ? getMemoryConfig() : undefined
      const memoryEnabled = memoryConfig?.enabled === true
      if (memoryEnabled && !dynamicPrompt) {
        throw new AppError({
          code: 'CFG_INVALID',
          userMessage: '记忆功能已启用但动态 Prompt 依赖未注入',
          severity: 'fatal',
          retryable: false
        })
      }

      // 组装动态上下文（memory.enabled=true 时）
      // 失败的动态层在 assembler 内部 fail-open，不影响其他层和聊天
      const context = memoryEnabled
        ? await dynamicPrompt!.contextAssembler.assemble({
            sessionId,
            query: sanitizedText,
            memory: memoryConfig!
          })
        : undefined

      const builtPrompt = buildPrompt({
        loader: promptLoader,
        logger: chatLogger,
        ...(context ? { context } : {})
      })

      // 从会话历史构建 BudgetHistoryTurn[]（按 turnId 分组，当前 turn 标 isCurrent）
      const allMessages = sessionStore.getMessages(sessionId, 10_000)
      const historyTurns = buildBudgetHistoryTurns(allMessages, turnId, assistantMessageId)

      // 应用预算（按 L2 -> 旧历史 -> L1 -> relationship fragments -> style 裁剪）
      const { provider, capabilities } = providerFactory()
      const budgetReport = applyBudget({
        layers: builtPrompt.layers,
        historyTurns,
        modelCapabilities: capabilities
      })

      // 记录最终保留的 L2 memoryId（供 turn.end 时 referencedMemoryIds 用）
      // 只在 memoryEligible=true 时才传非空；此处先暂存，最后按门决定
      includedMemoryIds = budgetReport.includedMemoryIds
      promptSpan.end(true)

      if (budgetReport.historyRemoved > 0 || budgetReport.styleRemoved) {
        chatLogger.debug('budget trimmed', {
          scope: 'chat',
          turnId,
          metrics: {
            historyRemoved: budgetReport.historyRemoved,
            styleRemoved: budgetReport.styleRemoved ? 1 : 0,
            totalTokens: budgetReport.totalTokens,
            budget: budgetReport.budget
          }
        })
      }

      // === chat.params hook（扩展点）===
      const llmRequest: LlmRequest = { messages: budgetReport.messages }
      const paramsResult = await emitLifecycle(
        LifecycleEvent.CHAT_PARAMS,
        { event: LifecycleEvent.CHAT_PARAMS, turnId, sessionId },
        llmRequest
      )
      const finalRequest = paramsResult.data as LlmRequest

      // 如果 params hook 短路，不调用 provider
      if (paramsResult.stopped) {
        sessionStore.appendMessage(sessionId, {
          id: assistantMessageId,
          sessionId,
          role: 'assistant',
          content: '',
          createdAt: Date.now(),
          status: 'complete',
          turnId
        })
        sink({
          type: 'completed',
          requestId,
          sequence,
          usage: { inputTokens: 0, outputTokens: 0 }
        })
        return
      }

      // 检查是否在 hook 执行期间被取消
      if (controller.signal.aborted) {
        status = 'cancelled'
        sessionStore.appendMessage(sessionId, {
          id: assistantMessageId,
          sessionId,
          role: 'assistant',
          content: '',
          createdAt: Date.now(),
          status: 'cancelled',
          turnId
        })
        sink({ type: 'cancelled', requestId, sequence })
        return
      }

      // === provider stream ===
      // P2-26/27: llm.call span + LLM 指标（calls/errors/latencyMs/tokens）
      const metrics = getMetrics()
      metrics.counter('llm.calls').inc()
      const llmSpan = tracer.startSpan('llm.call', turnId)
      const llmStartMs = performance.now()
      try {
        for await (const chunk of provider.stream(finalRequest, controller.signal)) {
          if (controller.signal.aborted) break

          if (chunk.type === 'delta') {
            accumulated += chunk.text
            sink({ type: 'chunk', requestId, sequence, delta: chunk.text })
            sequence++
          } else if (chunk.type === 'reasoning') {
            accumulatedReasoning += chunk.text
            sink({ type: 'reasoning', requestId, sequence, delta: chunk.text })
            sequence++
          } else if (chunk.type === 'usage') {
            inputTokens = chunk.inputTokens
            outputTokens = chunk.outputTokens
          }
        }
        // P2-26/27: llm.call span 成功结束 + latencyMs observe
        llmSpan.end(true)
        metrics.histogram('llm.latencyMs').observe(performance.now() - llmStartMs)
      } catch (err) {
        // P2-26/27: llm.call span 失败 + errors inc
        metrics.counter('llm.errors').inc()
        llmSpan.end(false, isAppError(err) ? err.code : undefined)
        // provider 错误：保留已接收文本，标 failed（S-004 #24）
        status = 'failed'
        errorCode = isAppError(err) ? err.code : 'UNKNOWN'

        // V-03a：failed 标记写盘失败（如窗口关闭竞态 DB 已 close）不得吞掉下面的 failed 事件——
        // 事件必须先到达 UI，持久化尽力而为
        try {
          sessionStore.appendMessage(sessionId, {
            id: assistantMessageId,
            sessionId,
            role: 'assistant',
            content: accumulated,
            createdAt: Date.now(),
            status: 'failed',
            errorCode,
            turnId
          })
        } catch (writeErr) {
          chatLogger.warn('failed-marker persist skipped', {
            scope: 'chat',
            turnId,
            tags: { requestId },
            detail: writeErr instanceof Error ? writeErr.message : String(writeErr)
          })
        }

        chatLogger.warn('turn failed', {
          scope: 'chat',
          turnId,
          code: errorCode,
          tags: { requestId },
          metrics: { outputLen: accumulated.length }
        })

        removeSupersededRows()

        sink({
          type: 'failed',
          requestId,
          sequence,
          error: {
            code: errorCode,
            message: isAppError(err) ? (err.userMessage ?? err.code) : '生成回复时出错',
            retryable: isAppError(err) ? err.retryable : false,
            requestId
          }
        })
        return
      }

      // 检查是否在流式期间被取消
      if (controller.signal.aborted) {
        status = 'cancelled'
        sessionStore.appendMessage(sessionId, {
          id: assistantMessageId,
          sessionId,
          role: 'assistant',
          content: accumulated,
          ...(accumulatedReasoning.length > 0 ? { reasoning: accumulatedReasoning } : {}),
          createdAt: Date.now(),
          status: 'cancelled',
          turnId
        })

        chatLogger.info('turn cancelled', {
          scope: 'chat',
          turnId,
          tags: { requestId },
          metrics: { outputLen: accumulated.length }
        })

        removeSupersededRows()

        sink({ type: 'cancelled', requestId, sequence })
        return
      }

      // === 成功完成 ===
      sessionStore.appendMessage(sessionId, {
        id: assistantMessageId,
        sessionId,
        role: 'assistant',
        content: accumulated,
        ...(accumulatedReasoning.length > 0 ? { reasoning: accumulatedReasoning } : {}),
        createdAt: Date.now(),
        status: 'complete',
        turnId
      })

      removeSupersededRows()

      // provider 正常完成且 assistant 非空 -> 符合记忆提取条件（S-010 §1.1）
      memoryEligible = accumulated.trim().length > 0

      // P2-26: LLM token 指标（累计输入/输出 token）
      metrics.counter('llm.tokens.in').inc(inputTokens)
      metrics.counter('llm.tokens.out').inc(outputTokens)

      chatLogger.info('turn completed', {
        scope: 'chat',
        turnId,
        tags: { requestId },
        metrics: {
          inputLen: sanitizedText.length,
          outputLen: accumulated.length,
          inputTokens,
          outputTokens
        }
      })

      sink({
        type: 'completed',
        requestId,
        sequence,
        usage: { inputTokens, outputTokens }
      })
    } catch (err) {
      // 外层 catch：捕获 buildPrompt/providerFactory/budget/chat.params 抛出的错误
      // 内层 catch（provider stream 错误）已有 return，不会到达这里
      status = 'failed'
      errorCode = isAppError(err) ? err.code : 'UNKNOWN'
      // V-03a：同内层 catch——写盘失败不得吞掉 failed 事件（窗口关闭竞态下 UI 必须收到终止事件）
      try {
        sessionStore.appendMessage(sessionId, {
          id: assistantMessageId,
          sessionId,
          role: 'assistant',
          content: accumulated,
          ...(accumulatedReasoning.length > 0 ? { reasoning: accumulatedReasoning } : {}),
          createdAt: Date.now(),
          status: 'failed',
          errorCode,
          turnId
        })
      } catch (writeErr) {
        chatLogger.warn('failed-marker persist skipped (outer catch)', {
          scope: 'chat',
          turnId,
          tags: { requestId },
          detail: writeErr instanceof Error ? writeErr.message : String(writeErr)
        })
      }
      chatLogger.error('turn failed (outer catch)', {
        scope: 'chat',
        turnId,
        code: errorCode,
        tags: { requestId },
        metrics: { outputLen: accumulated.length }
      })
      removeSupersededRows()
      sink({
        type: 'failed',
        requestId,
        sequence,
        error: {
          code: errorCode,
          message: isAppError(err) ? (err.userMessage ?? err.code) : '生成回复时出错',
          retryable: isAppError(err) ? err.retryable : false,
          requestId
        }
      })
    } finally {
      // 清理 active turn（在 turn.end hook 之前，确保 hasActiveTurn 在事件发射后立即返回 false）
      // turn.end 是独立扩展点，不应阻塞 active turn 的释放
      activeTurns.delete(requestId)
      releaseSessionTurnOwnership(sessionActiveTurn, sessionId, requestId)

      // P2-43：轮次终局落幂等账本（跨重启重放的依据）。
      // cancelled 并入 failed：用户取消后点重试应当真跑（逃生门语义）。
      // 崩溃时进程内 pending 随进程消失、此处不会执行 -> 账本查无此记录 ->
      // 重启后按全新请求处理，恰好是死轮次的正确语义。
      if (idempotencyLedger) {
        idempotencyLedger.put(clientRequestId, {
          sessionId,
          textHash: hashIdempotencyText(text),
          ack,
          state: status === 'completed' ? 'completed' : 'failed',
          createdAt: Date.now()
        })
        // 生产环境由有界账本接管终态后，释放进程内 pending/resolved Promise，避免双缓存无界增长。
        // 未注入账本的 Phase 1 单测仍保留 C-β 原进程生命周期语义。
        clientRequests.delete(clientRequestId)
      }

      // === turn.end hook（独立扩展点，始终执行）===
      // Phase 2 记忆提取（MemoryJudge）在此接入
      const turnEndData: TurnEndData = {
        turnId,
        sessionId,
        requestId,
        status,
        inputLen: sanitizedText.length,
        outputLen: accumulated.length,
        memoryEligible,
        // S-011 §1.6：只有 memoryEligible=true 才传非空 includedMemoryIds
        referencedMemoryIds: memoryEligible ? includedMemoryIds : [],
        ...(errorCode !== undefined ? { errorCode } : {})
      }

      try {
        await emitLifecycle(
          LifecycleEvent.TURN_END,
          { event: LifecycleEvent.TURN_END, turnId, sessionId, requestId },
          turnEndData
        )
      } catch (turnEndErr) {
        // turn.end hook 失败不影响主流程（独立扩展点）
        chatLogger.error('turn.end hook threw', {
          scope: 'chat',
          code: 'UNKNOWN',
          turnId,
          detail: turnEndErr instanceof Error ? turnEndErr.message : String(turnEndErr)
        })
      }

      // P2-27: 结束 trace（推入环形缓冲，供 debug:get-snapshot 拉取）
      // P2（2026-08-10 审计）：传 turnId，跨会话并发时各自收尾互不覆盖
      tracer.endTurn(accumulated.length, turnId)
    }
  }

  return {
    createSession,
    getLastSessionId,
    list,
    send,
    retryTurn,
    cancel,
    hasActiveTurn
  }
}

/**
 * 从会话历史构建 BudgetHistoryTurn[]。依据 S-011 §1.5。
 *
 * 规则：
 *   - 按 turnId 分组；只含 complete 消息；排除当前 assistant 占位
 *   - 允许 [user] 或 [user,assistant]；不得 assistant 开头（孤立 assistant -> 跳过该 turn）
 *   - 当前 turnId 标 isCurrent=true（永不裁）
 *   - 按时间升序排列（最旧在前，最旧先裁）
 *   - M-03：合并跨轮的连续 user（孤立失败轮并入下一轮首条 user）
 */
export function buildBudgetHistoryTurns(
  messages: readonly ChatMessage[],
  currentTurnId: string,
  assistantPlaceholderId: MessageId
): BudgetHistoryTurn[] {
  const groups = new Map<string, LlmMessage[]>()
  const order: string[] = []

  for (const msg of messages) {
    if (msg.status !== 'complete') continue
    if (msg.id === assistantPlaceholderId) continue
    if (msg.role === 'system') continue
    const tid = msg.turnId
    if (!tid) continue
    if (!groups.has(tid)) {
      groups.set(tid, [])
      order.push(tid)
    }
    groups.get(tid)!.push({
      role: msg.role,
      // 时间锚（datetime-prefix）：仅 user 消息加 `[YYYY-MM-DD HH:MM] ` 前缀，
      // 历史轮/当前轮同形状（KV cache 友好）；assistant 不加（防模型模仿进回复）。
      content: msg.role === 'user' ? formatTimePrefix(msg.createdAt) + msg.content : msg.content
    })
  }

  const turns: BudgetHistoryTurn[] = []
  for (const tid of order) {
    const msgs = groups.get(tid)!
    // 孤立 assistant（assistant 开头）-> 跳过该 turn
    while (msgs.length > 0 && msgs[0].role === 'assistant') {
      msgs.shift()
    }
    if (msgs.length === 0) continue
    turns.push({
      turnId: tid,
      messages: msgs,
      isCurrent: tid === currentTurnId
    })
  }

  // M-03 修复：合并跨轮的连续 user 消息。
  // 失败/取消轮会留下"孤立 user 轮"（assistant 是 failed 被排除、无 complete 配对），
  // 用户点重试后历史里出现 [user(失败)] 紧邻 [user(重试), assistant]——发给 provider 就是
  // 连续两条 user 消息（部分严格端点 400、模型困惑）。
  // 当上一轮以 user 结尾（必然是孤立轮）且本轮以 user 开头时，把上一轮的 user 文本并入本轮
  // 首条 user（用换行连接），既保留全部文本又不出现连续 user。
  // 用可变中间结构操作（BudgetHistoryTurn.messages 是 readonly），最后转回。
  interface MutableTurn {
    turnId: string
    messages: LlmMessage[]
    isCurrent: boolean
  }
  const mutableTurns: MutableTurn[] = turns.map((t) => ({
    turnId: t.turnId,
    messages: [...t.messages],
    isCurrent: t.isCurrent
  }))
  const mergedTurns: MutableTurn[] = []
  for (const turn of mutableTurns) {
    const last = mergedTurns[mergedTurns.length - 1]
    const lastEndsWithUser =
      last && last.messages.length > 0 && last.messages[last.messages.length - 1].role === 'user'
    const curStartsWithUser = turn.messages.length > 0 && turn.messages[0].role === 'user'
    if (lastEndsWithUser && curStartsWithUser) {
      const lastUser = last.messages[last.messages.length - 1]
      turn.messages[0] = {
        role: 'user',
        content: `${lastUser.content}\n${turn.messages[0].content}`
      }
      if (last.messages.length === 1) {
        // 上一轮是纯孤立 user 轮 -> 整轮并入本轮，移除
        mergedTurns.pop()
      } else {
        // 防御分支：上一轮末尾是 user 但前面还有 assistant（正常不会发生）-> 只并入 user
        last.messages = last.messages.slice(0, -1)
      }
    }
    mergedTurns.push(turn)
  }

  return mergedTurns.map((t) => ({
    turnId: t.turnId,
    messages: t.messages as readonly LlmMessage[],
    isCurrent: t.isCurrent
  }))
}
