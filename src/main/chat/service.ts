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
import type { ComplianceDecisionRecord } from '@shared/compliance/types'
import type { ComplianceGate, ComplianceGateOutcome } from '../compliance/gate'
import { capComplianceRecords } from '../compliance/gate'
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
import type { SpanHandle } from '../observability/tracer'
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

/**
 * P3C1-08: 合规观测集成（F5-001 §3.5/§3.11 + 开工裁定 1.1/1.2/1.4）。
 * 由 setupCompliance 构造注入；未注入（Phase 1 单测）时全旁路。
 * gate.enabled=false / scope='off' 时集成层返回 Null Object——ChatService
 * 不写 enabled/disabled 分支（F5-001 §5 边界条件：单一代码路径）。
 */
export interface ChatComplianceIntegration {
  /** 每轮创建一个 gate（含 live config 读取；C1 一轮一个 attempt 一个 gate，不复用）。 */
  createGate(turnId: string, candidateId: string): ComplianceGate
  /**
   * TURN_END 时点收尾：compliance_turns 行 INSERT（§3.11 纪律 1：先建行，
   * 审计/反馈是后来的 UPDATE）+ 跨轮熔断器 record + 时序遥测两列落库。
   * 内部 fail-open：DB 写失败只 warn，绝不影响聊天终局。
   */
  recordTurnEnd(input: {
    turnId: string
    outcome: ComplianceGateOutcome
    providerFirstDeltaMs: number | null
    gateHoldMs: number | null
  }): void
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
  /**
   * P3C1-08：合规观测集成。可选注入（生产由 setupCompliance 接线；测试可省略）。
   */
  compliance?: ChatComplianceIntegration
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
  /**
   * 按轮删除（验收反馈⑥ 用户自助删除）：messageId 定位一轮，删除该轮全部行
   * （user + assistant，任何状态）；遗产无 turnId 行只删自己。
   * 返回被删行 id 列表；目标不存在返回空数组（幂等容错）。
   * 有 active turn 时拒绝（CHAT_BUSY）——防删到在途轮的用户消息。
   */
  deleteTurn(sessionId: SessionId, messageId: MessageId): { deletedIds: string[] }
  /**
   * 单条删除（验收反馈⑥c 粒度控制）：只删被点的那一条，不动同轮兄弟行。
   * 与 deleteTurn 相同的 CHAT_BUSY 守卫与容错（目标不存在返回空数组）。
   * 连带语义见 ChatDeleteMessageRequest 注释（孤儿 user 会被 M-39 补占位；
   * 孤立 assistant 退出 prompt 装配）。
   */
  deleteMessage(sessionId: SessionId, messageId: MessageId): { deletedIds: string[] }
  /**
   * 批量按轮删除（验收反馈⑦ 选择模式）：把每个 messageId 解析到所在轮（turnId）
   * 去重后整轮删除——删除单位永远是轮，不会产生孤儿/孤立半轮；
   * 无 turnId 的遗产行按单条删；查无此行/查无此轮的 id 静默跳过（幂等容错）。
   * 返回被删行的 id 全集。有 active turn 时拒绝（CHAT_BUSY）。
   */
  deleteSelected(sessionId: SessionId, messageIds: MessageId[]): { deletedIds: string[] }
  /**
   * 清空会话全部消息（验收反馈⑦「删除所有对话」）。会话本身保留；
   * 记忆条目不受影响。有 active turn 时拒绝（CHAT_BUSY）。
   */
  clearSession(sessionId: SessionId): { removed: number }
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
   * 是否符合记忆提取条件。依据 S-020 §1.1：只有 provider 正常完成、assistant 非空、
   * 已持久化且未走 sanitize/params 短路路径时为 true。failed/cancelled/stopped 均 false。
   * 提取管线和引用追踪只认这个门。
   */
  memoryEligible: boolean
  /**
   * 最终预算保留且 provider 正常完成、非空并已持久化的 L2 memoryId 列表。
   * 依据 S-021 §1.6：只有 memoryEligible=true 时才传非空数组；
   * failed/cancelled/stopped/检索命中但被 budget 裁掉均传 []。
   */
  referencedMemoryIds: readonly string[]
  /**
   * PromptBudgeter 最终实际保留的 L2 memoryId；与 `referencedMemoryIds` 不同，失败/取消
   * 轮也保留该预算真值，供 DMAE 区分“被选择”与“真正注入 Prompt”。
   */
  promptIncludedMemoryIds?: readonly string[]
  /** PromptBudgeter 最终裁掉的 L2 memoryId；与 included 同源，供 DMAE 记录裁剪真值。 */
  promptTrimmedMemoryIds?: readonly string[]
  /**
   * 逐命中合规决策记录（开工裁定 1.4）：与 `complianceGate` outcome 聚合（随 P3C1-08
   * ChatService 集成落地）并列的新字段。只有 id/偏移/枚举/时序计数，**无正文**（§3.11 红线），
   * 过 hook 总线安全。单轮上限 `COMPLIANCE_RECORDS_MAX_PER_TURN`=64，超出截断并把
   * 截断条数写入 `complianceRecordsTruncated`。
   */
  /**
   * 本轮门控汇总结论（P3C1-08 落地；F5-001 集成点「门控结论 -> TurnEndData.complianceGate
   * -> 审计 hook」）。仅含聚合量（blocked/规则 ID/段数/耗时），**不含正文**（§3.11 红线）。
   */
  complianceGate?: ComplianceGateOutcome
  complianceRecords?: readonly ComplianceDecisionRecord[]
  /** `complianceRecords` 超单轮上限被截断的条数（裁定 1.4 #3：截断并计数）。 */
  complianceRecordsTruncated?: number
}

// === 内部状态 ===

interface ActiveTurnState {
  sessionId: SessionId
  assistantMessageId: MessageId
  controller: AbortController
  /** 轮次看门狗：true = 本轮因停滞被看门狗 abort（区别于用户主动 cancel） */
  stalled: boolean
  stallTimer?: ReturnType<typeof setTimeout>
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
  const compliance = deps.compliance
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

  // === 轮次看门狗（停滞自愈） ===
  // provider 层已有 idle timeout（无数据 timeoutMs 即断，思考模式首字节地板 120s），
  // 但它只覆盖 provider.stream 内部——prompt 装配/记忆检索/hook/未来新 provider
  // 不在其保护范围。看门狗站在轮次级：登记后任何阶段超过预算没有任何流事件 ->
  // 判停滞 -> abort，走 failed(NET_TIMEOUT) 终局释放轮次——应用不再只能靠重启解锁。
  // 预算 360s：必须超过 provider 合法静默上限（timeoutMs 最大 300s / 思考地板 120s），
  // 保证永不误杀。已知未覆盖的缝隙：streamTurn 启动前的 hook 挂起（abort 无法打断
  // 一个永不 settle 的 emitLifecycle）——当前 hook 全是本地同步逻辑，不构成现实风险。
  const TURN_STALL_TIMEOUT_MS = 360_000

  /** 布防/重置看门狗：每个流事件都是"还活着"的证据，重置计时 */
  function armStallWatchdog(state: ActiveTurnState, requestId: RequestId): void {
    clearTimeout(state.stallTimer)
    state.stallTimer = setTimeout(() => {
      state.stalled = true
      chatLogger.warn('turn stalled; watchdog aborting', {
        scope: 'chat',
        tags: { requestId, sessionId: state.sessionId },
        metrics: { stallMs: TURN_STALL_TIMEOUT_MS }
      })
      state.controller.abort()
    }, TURN_STALL_TIMEOUT_MS)
  }

  /** 释放轮次：清看门狗 + 摘 active 登记 + 释放会话所有权（终局/ACK 失败共用） */
  function releaseTurn(requestId: RequestId, sessionId: SessionId): void {
    const state = activeTurns.get(requestId)
    if (state) clearTimeout(state.stallTimer)
    activeTurns.delete(requestId)
    releaseSessionTurnOwnership(sessionActiveTurn, sessionId, requestId)
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
    const turnState: ActiveTurnState = { sessionId, assistantMessageId, controller, stalled: false }
    activeTurns.set(requestId, turnState)
    sessionActiveTurn.set(sessionId, requestId)
    armStallWatchdog(turnState, requestId)

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
      releaseTurn(requestId, sessionId)
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
  async function retryTurn(
    request: RetryTurnRequest,
    sink: ChatEventSink
  ): Promise<TurnAck | null> {
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
      if (
        persisted.sessionId !== sessionId ||
        persisted.textHash !== hashIdempotencyText(retryText)
      ) {
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
    const retryTurnState: ActiveTurnState = {
      sessionId,
      assistantMessageId,
      controller,
      stalled: false
    }
    activeTurns.set(requestId, retryTurnState)
    sessionActiveTurn.set(sessionId, requestId)
    armStallWatchdog(retryTurnState, requestId)

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
      releaseTurn(requestId, sessionId)
      throw err
    }
  }

  /**
   * 按轮删除（验收反馈⑥）。
   * 一轮 = 同 turnId 的全部行（user + assistant，任何状态）——失败/中断占位随轮一起消失。
   * 删除即退出后续 prompt 历史（buildBudgetHistoryTurns 从库读），等于"让她忘记这一轮"；
   * 已提取的记忆条目不受影响（记忆面板另有管理入口）。
   */
  function deleteTurn(sessionId: SessionId, messageId: MessageId): { deletedIds: string[] } {
    if (hasActiveTurn(sessionId)) {
      throw new AppError({
        code: 'CHAT_BUSY',
        userMessage: '她还在回复中，等回复结束后再删除',
        severity: 'error',
        retryable: false
      })
    }

    const target = sessionStore.getMessage(sessionId, messageId)
    if (!target) return { deletedIds: [] }

    const deletedIds = target.turnId
      ? sessionStore.deleteTurnMessages(sessionId, target.turnId)
      : sessionStore.deleteMessage(sessionId, messageId)
        ? [messageId]
        : []

    if (deletedIds.length > 0) {
      chatLogger.info('turn deleted by user', {
        scope: 'chat',
        ...(target.turnId ? { turnId: target.turnId } : {}),
        tags: { sessionId },
        metrics: { removed: deletedIds.length }
      })
    }
    return { deletedIds }
  }

  /**
   * 单条删除（验收反馈⑥c）。只删被点的那一条——不查 turnId、不动兄弟行。
   * 同一套 CHAT_BUSY 守卫（防删到在途轮的 streaming 行）与幂等容错。
   */
  function deleteMessage(sessionId: SessionId, messageId: MessageId): { deletedIds: string[] } {
    if (hasActiveTurn(sessionId)) {
      throw new AppError({
        code: 'CHAT_BUSY',
        userMessage: '她还在回复中，等回复结束后再删除',
        severity: 'error',
        retryable: false
      })
    }

    const deleted = sessionStore.deleteMessage(sessionId, messageId)
    if (deleted) {
      chatLogger.info('message deleted by user', {
        scope: 'chat',
        tags: { sessionId },
        metrics: { removed: 1 }
      })
    }
    return { deletedIds: deleted ? [messageId] : [] }
  }

  /**
   * 批量按轮删除（验收反馈⑦）。id -> turnId 解析去重后整轮删；
   * 删除单位永远是轮（用户已裁定：不留孤儿/孤立半轮）。
   */
  function deleteSelected(sessionId: SessionId, messageIds: MessageId[]): { deletedIds: string[] } {
    if (hasActiveTurn(sessionId)) {
      throw new AppError({
        code: 'CHAT_BUSY',
        userMessage: '她还在回复中，等回复结束后再删除',
        severity: 'error',
        retryable: false
      })
    }

    const turnIds = new Set<string>()
    const legacyIds = new Set<MessageId>()
    for (const id of messageIds) {
      const target = sessionStore.getMessage(sessionId, id)
      if (!target) continue // 查无此行：幂等容错，静默跳过
      if (target.turnId) turnIds.add(target.turnId)
      else legacyIds.add(id)
    }

    const deletedIds: string[] = []
    for (const turnId of turnIds) {
      deletedIds.push(...sessionStore.deleteTurnMessages(sessionId, turnId))
    }
    for (const id of legacyIds) {
      if (sessionStore.deleteMessage(sessionId, id)) deletedIds.push(id)
    }

    if (deletedIds.length > 0) {
      chatLogger.info('selected turns deleted by user', {
        scope: 'chat',
        tags: { sessionId },
        metrics: { removed: deletedIds.length, turns: turnIds.size }
      })
    }
    return { deletedIds }
  }

  /** 清空会话全部消息（验收反馈⑦）。会话保留；记忆条目不受影响。 */
  function clearSession(sessionId: SessionId): { removed: number } {
    if (hasActiveTurn(sessionId)) {
      throw new AppError({
        code: 'CHAT_BUSY',
        userMessage: '她还在回复中，等回复结束后再清空',
        severity: 'error',
        retryable: false
      })
    }

    const removed = sessionStore.clearMessages(sessionId)
    if (removed > 0) {
      chatLogger.info('session cleared by user', {
        scope: 'chat',
        tags: { sessionId },
        metrics: { removed }
      })
    }
    return { removed }
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
    // 看门狗状态（登记时已布防）；每个流事件重置计时。捕获引用即可——
    // 终局时从 map 摘除不影响已捕获的对象。
    const turnState = activeTurns.get(requestId)

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
    // memoryEligible：仅 provider 正常完成且 assistant 非空时为 true（S-020 §1.1）。
    // sanitize 短路、params 短路、failed、cancelled、空输出均保持 false。
    let memoryEligible = false
    // 最终预算保留的 L2 memoryId 列表（S-021 §1.6）。
    // 只在 memoryEligible=true 时才传非空给 turn.end；提前 return 路径保持 []。
    let includedMemoryIds: readonly string[] = []
    let droppedMemoryIds: readonly string[] = []
    // P3C1-08: 时序遥测三分量数据源（裁定 1.2：providerTTFB / gateHold / userTTFB）。
    // providerFirstDeltaMs = 首个 delta 到达 - provider 调用起点；
    // gateHoldMs = 首次非空放行 - 首个 delta 到达（observe 构造上恒 0）。
    let providerFirstDeltaMs: number | null = null
    let gateHoldMs: number | null = null
    // P3C1-08: 门控与 span（try 内创建、finally 收尾——块作用域必须提到外层函数体）
    let gate: ComplianceGate | undefined
    let complianceSpan: SpanHandle | null = null
    let providerStartAt = 0
    let firstDeltaAt: number | null = null
    let firstReleaseAt: number | null = null

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
      // S-021 §1.6：memory.enabled=true 但 dynamicPrompt 缺失 -> CFG_INVALID
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
      droppedMemoryIds = budgetReport.droppedMemoryIds
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

      // === P3C1-08: 合规门控（每轮一个实例；C1 observe 直通）===
      // gate 由集成层构造：enabled=false / scope='off' 时是 Null Object 直通实现
      // （F5-001 §5：ChatService 不写 enabled/disabled 分支，单一代码路径）。
      // candidateId 一轮一次生成尝试一个（C1 无真 block 时与 turn 一一对应；C3 起每 attempt 新建）。
      gate = compliance?.createGate(turnId, randomUUID())
      // F5-001 §3.9：一轮恰好一个 compliance.review span（绝不能每 segment 一个）。
      complianceSpan = gate === undefined ? null : tracer.startSpan('compliance.review', turnId)
      providerStartAt = performance.now()

      // === provider stream ===
      // P2-26/27: llm.call span + LLM 指标（calls/errors/latencyMs/tokens）
      const metrics = getMetrics()
      metrics.counter('llm.calls').inc()
      const llmSpan = tracer.startSpan('llm.call', turnId)
      const llmStartMs = performance.now()
      try {
        for await (const chunk of provider.stream(finalRequest, controller.signal)) {
          if (controller.signal.aborted) break

          // 任何 chunk 都是"本轮还活着"的证据：重置看门狗
          if (turnState) armStallWatchdog(turnState, requestId)

          if (chunk.type === 'delta') {
            // gateHold 是「因门控持留而多等的时间」，不是同步正则计算 CPU 耗时。
            // 因此首个 delta 内已经放行时构造上为 0（C1 observe 必经此路径，裁定 1.1）；
            // 不能用 performance.now() 的微小调用间隔冒充用户可感知的 hold。
            // 空 delta 不代表 provider 给用户送达了首字；与 gate.ts 的 firstDeltaAt
            // 语义对齐：TTFB 与 gateHold 都从首个**非空** delta 计时。否则 provider
            // 在空 chunk 后的等待会被错误归因到 gate（C1 observe 实际没有持留）。
            const isFirstDelta = chunk.text.length > 0 && firstDeltaAt === null
            if (isFirstDelta) {
              firstDeltaAt = performance.now()
              providerFirstDeltaMs = Math.round(firstDeltaAt - providerStartAt)
            }
            // P3C1-08: 双缓冲门控（裁定 1.1）——releaseText 是唯一权威输出，调用方
            // 不得自行拼接原 delta。observe 下逐字直通；accumulated 只累计放行文本
            // （§5 边界：memoryEligible = accumulated.trim().length > 0 语义自动正确）。
            const emission = gate === undefined ? null : gate.push(chunk.text)
            // C1 observe 恒 false；C3 真阻断在此中止流（provider 清理靠 for-await break 语义）
            if (emission?.abort) break
            const releaseText = emission === null ? chunk.text : emission.releaseText
            // 空串跳过 sink（F5-001 §3.5 改动点 3）
            if (releaseText.length > 0) {
              accumulated += releaseText
              if (firstReleaseAt === null) {
                firstReleaseAt = performance.now()
                gateHoldMs = isFirstDelta
                  ? 0
                  : firstDeltaAt === null
                    ? null
                    : Math.round(firstReleaseAt - firstDeltaAt)
              }
              sink({ type: 'chunk', requestId, sequence, delta: releaseText })
              sequence++
            }
          } else if (chunk.type === 'reasoning') {
            accumulatedReasoning += chunk.text
            sink({ type: 'reasoning', requestId, sequence, delta: chunk.text })
            sequence++
          } else if (chunk.type === 'usage') {
            inputTokens = chunk.inputTokens
            outputTokens = chunk.outputTokens
          }
        }
        // P3C1-08: 流结束——flush 输出缓冲（EOF 段动作一律降级 flag，永不真 abort）。
        // observe 下 outputHeld 恒空（releaseText 为空串），flush 只做 EOF 段分析；
        // 首段门控（C2+）在此吐出持有文本。异常路径（catch 内 return）不 flush，
        // takeRecords 按 EOF 定格影子首段（gate 合同）。
        if (gate !== undefined) {
          const emission = gate.flush()
          if (emission.releaseText.length > 0) {
            accumulated += emission.releaseText
            if (firstReleaseAt === null) {
              firstReleaseAt = performance.now()
              gateHoldMs = firstDeltaAt === null ? null : Math.round(firstReleaseAt - firstDeltaAt)
            }
            sink({ type: 'chunk', requestId, sequence, delta: emission.releaseText })
            sequence++
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
        // 看门狗停滞 abort 也走这里（abort 触发的 provider 抛错）：
        // 统一收敛为 NET_TIMEOUT —— 用户视角 = 连接超时，可重试
        status = 'failed'
        errorCode = turnState?.stalled ? 'NET_TIMEOUT' : isAppError(err) ? err.code : 'UNKNOWN'

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
            message: turnState?.stalled
              ? '连接超时，请检查网络后重试'
              : isAppError(err)
                ? (err.userMessage ?? err.code)
                : '生成回复时出错',
            retryable: turnState?.stalled ? true : isAppError(err) ? err.retryable : false,
            requestId
          }
        })
        return
      }

      // 看门狗停滞：provider 安静结束（abort 未抛错）也会走到这里。
      // 抛给外层 catch 统一走 failed 终局（保留已收文本、可重试）——
      // 必须在 cancelled 判定之前：停滞 abort 的 signal 同样是 aborted=true。
      if (turnState?.stalled) {
        throw new AppError({
          code: 'NET_TIMEOUT',
          userMessage: '连接超时，请检查网络后重试',
          severity: 'error',
          retryable: true
        })
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

      // provider 正常完成且 assistant 非空 -> 符合记忆提取条件（S-020 §1.1）
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
      // releaseTurn 一并清看门狗计时器（防终局后迟到触发）
      releaseTurn(requestId, sessionId)

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
      // === P3C1-08: 合规收尾（turn.end hook 之前）===
      // 纪律（§3.11 + 裁定 1.4 #4）：turns 行此刻先 INSERT（集成层内部 fail-open）；
      // samples 由 350 审计 hook 第一步批写；审计结果与用户反馈是后来的 UPDATE。
      let complianceGateOutcome: ComplianceGateOutcome | undefined
      let complianceRecordsOut: readonly ComplianceDecisionRecord[] | undefined
      let complianceRecordsTrunc: number | undefined
      if (gate !== undefined && compliance !== undefined) {
        complianceGateOutcome = gate.outcome()
        const capped = capComplianceRecords(gate.takeRecords())
        if (capped.records.length > 0) complianceRecordsOut = capped.records
        if (capped.truncated > 0) complianceRecordsTrunc = capped.truncated
        compliance.recordTurnEnd({
          turnId,
          outcome: complianceGateOutcome,
          providerFirstDeltaMs,
          gateHoldMs
        })
      }
      complianceSpan?.end(true)

      const turnEndData: TurnEndData = {
        turnId,
        sessionId,
        requestId,
        status,
        inputLen: sanitizedText.length,
        outputLen: accumulated.length,
        memoryEligible,
        // S-021 §1.6：只有 memoryEligible=true 才传非空 referencedMemoryIds。
        // DMAE 同时接收不依赖终局状态的最终预算真值，不能用 selected 集合冒充它。
        referencedMemoryIds: memoryEligible ? includedMemoryIds : [],
        promptIncludedMemoryIds: includedMemoryIds,
        promptTrimmedMemoryIds: droppedMemoryIds,
        ...(errorCode !== undefined ? { errorCode } : {}),
        ...(complianceGateOutcome !== undefined ? { complianceGate: complianceGateOutcome } : {}),
        ...(complianceRecordsOut !== undefined ? { complianceRecords: complianceRecordsOut } : {}),
        ...(complianceRecordsTrunc !== undefined
          ? { complianceRecordsTruncated: complianceRecordsTrunc }
          : {})
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
    deleteTurn,
    deleteMessage,
    deleteSelected,
    clearSession,
    cancel,
    hasActiveTurn
  }
}

/**
 * 从会话历史构建 BudgetHistoryTurn[]。依据 S-021 §1.5。
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
