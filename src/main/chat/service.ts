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
import type { LLMProvider, LlmRequest, LlmMessage } from '../llm/types'
import type { PromptLoader } from '../prompts/loader'
import { buildPrompt } from '../prompts/builder'
import { applyBudget } from '../prompts/budgeter'
import { emitLifecycle, LifecycleEvent } from '../hooks/lifecycle'
import type { SessionStore } from './session-store'

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

/** ChatService 依赖 */
export interface ChatServiceDeps {
  logger: Logger
  promptLoader: PromptLoader
  sessionStore: SessionStore
  /** Provider 工厂：每次 turn 调用，返回当前配置的 provider + 能力 */
  providerFactory: () => ProviderFactoryResult
}

/** 事件接收器。ChatService 通过此回调发射 ChatStreamEvent */
export type ChatEventSink = (event: ChatStreamEvent) => void

/** 发送请求 */
export interface TurnRequest {
  sessionId: SessionId
  text: string
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
  list(sessionId: SessionId, limit: number): ChatHistorySnapshot
  send(request: TurnRequest, sink: ChatEventSink): Promise<TurnAck>
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
}

// === 内部状态 ===

interface ActiveTurnState {
  sessionId: SessionId
  assistantMessageId: MessageId
  controller: AbortController
}

// === ChatService 实现 ===

/**
 * 创建 ChatService。
 *
 * send() 流程：
 *   1. 检查 active turn -> 有则拒绝
 *   2. 生成 turnId / requestId / messageId
 *   3. 执行 sanitize hook（chat.message）
 *   4. 存储用户消息（status=complete，role=user）
 *   5. 返回 ACK（在事件之前）
 *   6. 后台启动 streamTurn（不阻塞 ACK）
 */
export function createChatService(deps: ChatServiceDeps): ChatService {
  const { logger, promptLoader, sessionStore, providerFactory } = deps
  const chatLogger = logger.child('chat')

  // active turns: requestId -> state
  const activeTurns = new Map<RequestId, ActiveTurnState>()
  // session -> active requestId（用于 hasActiveTurn 检查）
  const sessionActiveTurn = new Map<SessionId, RequestId>()

  function hasActiveTurn(sessionId: SessionId): boolean {
    return sessionActiveTurn.has(sessionId)
  }

  function createSession(): SessionId {
    return sessionStore.createSession()
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
    const { sessionId, text } = request

    // 1. 检查 active turn（S-004 #27：同 session 有 active turn 时拒绝第二次 send）
    //    用 CHAT_BUSY 而非 LLM_CIRCUIT_OPEN：这是业务规则冲突（有活跃轮次），
    //    不是断路器打开（LLM_CIRCUIT_OPEN 语义是 provider 连续失败熔断）。
    if (hasActiveTurn(sessionId)) {
      throw new AppError({
        code: 'CHAT_BUSY',
        userMessage: '当前对话正在进行中，请等待完成或停止后再发送',
        severity: 'error',
        retryable: false
      })
    }

    // 2. 生成 ID
    const turnId = randomUUID()
    const requestId = randomUUID()
    const userMessageId = randomUUID()
    const assistantMessageId = randomUUID()

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

    // 6. 后台启动 streamTurn（不阻塞 ACK 返回）
    const wasStopped = sanitizeResult.stopped
    void streamTurn({
      ack,
      turnId,
      sessionId,
      sanitizedText,
      wasStopped,
      sink
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
  }): Promise<void> {
    const { ack, turnId, sessionId, sanitizedText, wasStopped, sink } = opts
    const { requestId, assistantMessageId } = ack

    // 注册 active turn
    const controller = new AbortController()
    const turnState: ActiveTurnState = {
      sessionId,
      assistantMessageId,
      controller
    }
    activeTurns.set(requestId, turnState)
    sessionActiveTurn.set(sessionId, requestId)

    let sequence = 0
    let status: 'completed' | 'failed' | 'cancelled' = 'completed'
    let errorCode: ErrorCode | undefined
    let accumulated = ''
    let accumulatedReasoning = ''
    let inputTokens = 0
    let outputTokens = 0

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
      const builtPrompt = buildPrompt({
        loader: promptLoader,
        logger: chatLogger
      })

      // 从会话历史构建 LlmMessage[]（只含 complete 消息，排除当前 assistant 占位）
      const allMessages = sessionStore.getMessages(sessionId, 10_000)
      const history: LlmMessage[] = allMessages
        .filter((m) => m.status === 'complete' && m.id !== assistantMessageId)
        .map((m) => ({ role: m.role, content: m.content }))

      // 应用预算（按 L2 -> 旧历史 -> L1 -> style 裁剪）
      const { provider, capabilities } = providerFactory()
      const budgetReport = applyBudget({
        layers: builtPrompt.layers,
        history,
        modelCapabilities: capabilities
      })

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
      } catch (err) {
        // provider 错误：保留已接收文本，标 failed（S-004 #24）
        status = 'failed'
        errorCode = isAppError(err) ? err.code : 'UNKNOWN'

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

        chatLogger.warn('turn failed', {
          scope: 'chat',
          turnId,
          code: errorCode,
          tags: { requestId },
          metrics: { outputLen: accumulated.length }
        })

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
      chatLogger.error('turn failed (outer catch)', {
        scope: 'chat',
        turnId,
        code: errorCode,
        tags: { requestId },
        metrics: { outputLen: accumulated.length }
      })
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
      sessionActiveTurn.delete(sessionId)

      // === turn.end hook（独立扩展点，始终执行）===
      // Phase 2 记忆提取（MemoryJudge）在此接入
      const turnEndData: TurnEndData = {
        turnId,
        sessionId,
        requestId,
        status,
        inputLen: sanitizedText.length,
        outputLen: accumulated.length,
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
    }
  }

  return {
    createSession,
    list,
    send,
    cancel,
    hasActiveTurn
  }
}
