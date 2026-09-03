// src/main/ipc/handlers/chat.ts
// P1-25: Chat IPC handlers - 接通 ChatService 到 IPC
// 依据：S-001 P1-25、S-003 §3.2/§3.8
//
// 通道：
//   companion:chat:list          -> service.list
//   companion:chat:create-session -> service.createSession
//   companion:chat:get-last-session -> service.getLastSessionId
//   companion:chat:send          -> service.send（事件通过 webContents.send 推送）
//   companion:chat:cancel        -> service.cancel
//   companion:chat:retry         -> service.retryTurn（按 turnId 精确重试，不增消息）
//   companion:chat:delete-turn   -> service.deleteTurn（验收反馈⑥ 按轮删除）
//   companion:chat:delete-message -> service.deleteMessage（验收反馈⑥c 单条删除）
//   companion:chat:delete-selected -> service.deleteSelected（验收反馈⑦ 批量按轮删除）
//   companion:chat:clear-session -> service.clearSession（验收反馈⑦ 清空会话）
//   companion:chat:search        -> deps.searchMessages（P2-44 FTS5 全文搜索）
//   companion:chat:feedback      -> deps.recordFeedback（P3C1-07 合规用户反馈，F5-001 §3.7）
//
// 安全红线：
//   - 聊天正文不写 IPC 日志（只记通道、长度、requestId、耗时）
//   - send 的 ACK 在 started 事件之前返回（S-003 §4）
//   - 事件通过 sendEvent 发送，已检查 webContents.isDestroyed()

import type { WebContents } from 'electron'
import type { Logger } from '@shared/observability/types'
import type { ChatSearchHit, ChatStreamEvent } from '@shared/chat/types'
import type { ChatFeedbackRequest } from '@shared/compliance/types'
import type { ComplianceFeedbackOutcome } from '../../compliance/feedback'
import type { ChatService } from '../../chat/service'
import type { ChatRenderAckTracker } from '../../voice/playback/ack-gate'
import { registerValidatedHandler, sendEvent } from '../register'

/** Chat handler 依赖 */
export interface ChatHandlerDeps {
  chatService: ChatService
  logger: Logger
  /**
   * P2-44：全文搜索（FTS5）。生产绑定 sessionDb 的 searchMessages；
   * 测试可注入桩。query/limit 已过 validator（query 1..128，limit 1..100）。
   */
  searchMessages: (query: string, limit?: number) => ChatSearchHit[]
  /**
   * P3C1-07：合规用户反馈（F5-001 §3.7）。生产绑定 compliance feedback service；
   * 测试可注入桩。幂等与关联校验语义在 service 内（重复/语义性忽略均返回非插入 outcome，
   * handler 对外恒 {ok:true}--不向 renderer 泄漏差异）。
   */
  recordFeedback: (request: ChatFeedbackRequest) => ComplianceFeedbackOutcome
  /**
   * P3B-15A（F5-007 §1.5）：chat paint ack 跟踪器。send/retry 发出 requestId 后登记；
   * `companion:chat:ack-rendered` 的回报经它校验（未知请求/逆序拒绝）后喂进 gate，
   * 供播放队列在发声前等待「对应文字已绘制」。播放侧消费在 P3B-18 组合根接线。
   */
  ackTracker: ChatRenderAckTracker
}

/**
 * 创建事件接收器：将 ChatStreamEvent 通过 webContents.send 推送给 renderer。
 * sendEvent 已检查 webContents.isDestroyed()。
 */
function createSink(webContents: WebContents, logger: Logger): (event: ChatStreamEvent) => void {
  return (event) => {
    // 只记元数据，不记正文（S-003 §4 "只记通道、长度、requestId、耗时"）
    logger.debug('chat stream event', {
      scope: 'chat',
      tags: {
        type: event.type,
        requestId: event.requestId,
        sequence: String(event.sequence)
      }
    })
    sendEvent(webContents, 'companion:event:chat-stream', event)
  }
}

/**
 * 注册所有 chat IPC handler。
 * 在 main/index.ts 中调用，需在 configureIpcGuard 之后。
 */
export function registerChatHandlers(deps: ChatHandlerDeps): void {
  const { chatService, logger } = deps
  const chatLogger = logger.child('chat')

  // === companion:chat:list ===
  registerValidatedHandler('companion:chat:list', async (_ctx, payload) => {
    return chatService.list(payload.sessionId ?? '', payload.limit)
  })

  // === companion:chat:create-session ===
  registerValidatedHandler('companion:chat:create-session', async () => {
    const sessionId = chatService.createSession()
    chatLogger.info('session created', {
      scope: 'chat',
      tags: { sessionId }
    })
    return { sessionId }
  })

  // === companion:chat:get-last-session ===
  // P2-43：启动恢复。返回最近活跃会话；空库（全新用户）返回 null，renderer 落到 createSession。
  registerValidatedHandler('companion:chat:get-last-session', async () => {
    return { sessionId: chatService.getLastSessionId() }
  })

  // === companion:chat:send ===
  // ACK 在 started 事件之前返回（S-003 §4）
  registerValidatedHandler('companion:chat:send', async (ctx, payload) => {
    const sink = createSink(ctx.sender, chatLogger)

    const ack = await chatService.send(
      {
        sessionId: payload.sessionId,
        text: payload.text,
        clientRequestId: payload.clientRequestId
      },
      sink
    )

    // P3B-15A：renderer 随后会为这个 requestId 回报 paint ack；先登记进 LRU。
    deps.ackTracker.noteRequestIssued(ack.requestId)

    chatLogger.info('chat send ack', {
      scope: 'chat',
      tags: { requestId: ack.requestId, sessionId: payload.sessionId },
      metrics: { textLen: payload.text.length }
    })

    return ack
  })

  // === companion:chat:cancel ===
  registerValidatedHandler('companion:chat:cancel', async (_ctx, payload) => {
    const cancelled = chatService.cancel(payload.requestId)
    chatLogger.info('chat cancel', {
      scope: 'chat',
      tags: { requestId: payload.requestId, cancelled: String(cancelled) }
    })
  })

  // === companion:chat:retry ===
  // 验收反馈④c：重试不增消息。定位与轮次复用全在 service.retryTurn——
  // 按被点气泡的 turnId 精确重试原轮，不写新 user 行，终局删除同轮旧失败行。
  registerValidatedHandler('companion:chat:retry', async (ctx, payload) => {
    const { sessionId, messageId } = payload
    const sink = createSink(ctx.sender, chatLogger)

    const ack = await chatService.retryTurn(
      { sessionId, messageId, clientRequestId: `retry-${messageId}` },
      sink
    )

    if (!ack) {
      // 目标已不存在（旧投影/已清理）：容错静默，renderer 不做事
      chatLogger.warn('retry: target message gone', {
        scope: 'chat',
        tags: { sessionId, messageId }
      })
      return { requestId: '' }
    }

    // P3B-15A：retry 轮同样登记（renderer 对 retry 的流事件回报同一 requestId）。
    deps.ackTracker.noteRequestIssued(ack.requestId)

    chatLogger.info('chat retry ack', {
      scope: 'chat',
      tags: { requestId: ack.requestId, sessionId, originalMessageId: messageId }
    })

    return { requestId: ack.requestId }
  })

  // === companion:chat:delete-turn ===
  // 验收反馈⑥：按轮删除（用户自助清理残留/发错的对话）。删除即退出 prompt 历史。
  // 日志只由 service.deleteTurn 记一条（turnId + 删除数）——electron-log 是同步写盘，
  // handler 再记一条等于链路上双倍磁盘延迟（验收反馈⑥b"删除延迟大"优化）。
  registerValidatedHandler('companion:chat:delete-turn', async (_ctx, payload) => {
    return chatService.deleteTurn(payload.sessionId, payload.messageId)
  })

  // === companion:chat:delete-message ===
  // 验收反馈⑥c：单条删除（粒度控制）。日志同样只由 service 记一条。
  registerValidatedHandler('companion:chat:delete-message', async (_ctx, payload) => {
    return chatService.deleteMessage(payload.sessionId, payload.messageId)
  })

  // === companion:chat:delete-selected ===
  // 验收反馈⑦：选择模式批量按轮删除（main 侧 id->turnId 解析去重）。
  registerValidatedHandler('companion:chat:delete-selected', async (_ctx, payload) => {
    return chatService.deleteSelected(payload.sessionId, payload.messageIds)
  })

  // === companion:chat:clear-session ===
  // 验收反馈⑦：清空会话全部消息（「删除所有对话」）。会话保留；记忆条目不受影响。
  registerValidatedHandler('companion:chat:clear-session', async (_ctx, payload) => {
    return chatService.clearSession(payload.sessionId)
  })

  // === companion:chat:search ===
  // P2-44：全文搜索（FTS5）。只读查询、无轮次/流式状态，不走 chatService，
  // 直接调注入的 searchMessages（绑定 sessionDb）。日志不记查询正文（与聊天正文同规）。
  registerValidatedHandler('companion:chat:search', async (_ctx, payload) => {
    const hits = deps.searchMessages(payload.query, payload.limit)
    chatLogger.debug('chat search', {
      scope: 'chat',
      metrics: { queryLen: payload.query.length, hits: hits.length }
    })
    return hits
  })

  // === companion:chat:feedback ===
  // P3C1-07：合规用户反馈（F5-001 §3.7）。幂等：重复上报/语义性忽略（无 turns 行、
  // 消息关联不匹配）对外一律 {ok:true}--方向语义（dislike/OOC）与计数在 service 内。
  // 红线：日志只记元数据（kind/outcome/turnId），不记消息正文。
  registerValidatedHandler('companion:chat:feedback', async (_ctx, payload) => {
    const outcome = deps.recordFeedback(payload)
    chatLogger.debug('chat feedback', {
      scope: 'compliance',
      turnId: payload.turnId,
      tags: { kind: payload.kind, status: outcome.status }
    })
    return { ok: true }
  })

  // === companion:chat:ack-rendered ===
  // P3B-15A（F5-007 §1.5）：renderer applyStream + rAF 后回报最高已绘制 sequence。
  // capability=chat 由 guard 保证（stage 无权调用）；未知 requestId / 逆序 sequence 由
  // tracker 拒绝（不喂 gate）。拒绝只记 debug——renderer 端口的迟到 ack 属协议噪声，
  // 不构成用户可见错误；后果只是播放侧等不到该 ack（超时→本轮 text-only）。
  registerValidatedHandler('companion:chat:ack-rendered', async (_ctx, payload) => {
    const ack = deps.ackTracker.acceptAck(payload.requestId, payload.sequence)
    if (ack === null) {
      chatLogger.debug('chat render ack rejected (unknown/stale request or bad sequence)', {
        scope: 'chat',
        tags: { requestId: payload.requestId, sequence: String(payload.sequence) }
      })
    }
  })

  chatLogger.debug('chat handlers registered', { scope: 'ipc' })
}
