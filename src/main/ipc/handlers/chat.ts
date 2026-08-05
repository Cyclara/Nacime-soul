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
//   companion:chat:retry         -> 查找原用户消息 -> service.send
//
// 安全红线：
//   - 聊天正文不写 IPC 日志（只记通道、长度、requestId、耗时）
//   - send 的 ACK 在 started 事件之前返回（S-003 §4）
//   - 事件通过 sendEvent 发送，已检查 webContents.isDestroyed()

import type { WebContents } from 'electron'
import type { Logger } from '@shared/observability/types'
import type { ChatStreamEvent, ChatMessageView } from '@shared/chat/types'
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
  // Phase 1：查找原用户消息，重新发送
  registerValidatedHandler('companion:chat:retry', async (ctx, payload) => {
    const { sessionId, messageId } = payload

    // 获取会话消息，查找要重试的消息
    const history = chatService.list(sessionId, 500)
    const messages = history.messages
    const msgIdx = messages.findIndex((m) => m.id === messageId)

    if (msgIdx < 0) {
      chatLogger.warn('retry: message not found', {
        scope: 'chat',
        tags: { sessionId, messageId }
      })
      // 找不到消息：返回新的 requestId 但不发送（容错）
      return { requestId: '' }
    }

    // 找到用户消息：如果指定的是 assistant 消息，往前找最近的 user 消息
    let userMessage: ChatMessageView | null = null
    for (let i = msgIdx; i >= 0; i--) {
      if (messages[i].role === 'user') {
        userMessage = messages[i]
        break
      }
    }

    if (!userMessage) {
      chatLogger.warn('retry: no preceding user message', {
        scope: 'chat',
        tags: { sessionId, messageId }
      })
      return { requestId: '' }
    }

    const sink = createSink(ctx.sender, chatLogger)
    const ack = await chatService.send(
      {
        sessionId,
        text: userMessage.content,
        clientRequestId: `retry-${messageId}`
      },
      sink
    )

    chatLogger.info('chat retry ack', {
      scope: 'chat',
      tags: { requestId: ack.requestId, sessionId, originalMessageId: messageId }
    })

    return { requestId: ack.requestId }
  })

  chatLogger.debug('chat handlers registered', { scope: 'ipc' })
}
