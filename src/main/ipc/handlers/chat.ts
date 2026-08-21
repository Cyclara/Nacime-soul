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
//
// 安全红线：
//   - 聊天正文不写 IPC 日志（只记通道、长度、requestId、耗时）
//   - send 的 ACK 在 started 事件之前返回（S-003 §4）
//   - 事件通过 sendEvent 发送，已检查 webContents.isDestroyed()

import type { WebContents } from 'electron'
import type { Logger } from '@shared/observability/types'
import type { ChatStreamEvent } from '@shared/chat/types'
import type { ChatService } from '../../chat/service'
import { registerValidatedHandler, sendEvent } from '../register'

/** Chat handler 依赖 */
export interface ChatHandlerDeps {
  chatService: ChatService
  logger: Logger
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

  chatLogger.debug('chat handlers registered', { scope: 'ipc' })
}
