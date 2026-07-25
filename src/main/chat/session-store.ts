// src/main/chat/session-store.ts
// P1-23: 内存会话存储（Phase 1）。SQLite 持久化在 Phase 2 实现。
// 依据：S-001 P1-23、S-002 §3.6（消息/会话真源在 main SessionStore）
//
// 设计要点：
//   1. Phase 1 纯内存：刷新窗口后通过 hydrate 重建（Phase 1 刷新 = 丢失会话，Phase 2 才持久化）
//   2. 每个 session 持有有序消息列表，追加式写入
//   3. updateMessage 支持流式完成后回写 status/content
//   4. toView 将内部 ChatMessage 转为 renderer 安全的 ChatMessageView（剥离 sessionId/turnId）

import { randomUUID } from 'node:crypto'
import type { ChatMessage, ChatMessageView, SessionId, MessageId } from '@shared/chat/types'

/** 会话存储接口。Phase 1 为纯内存实现，Phase 2 替换为 SQLite */
export interface SessionStore {
  /** 创建新会话，返回 sessionId */
  createSession(): SessionId
  /** 会话是否存在 */
  exists(sessionId: SessionId): boolean
  /** 追加消息到会话末尾。会话不存在时自动创建（Phase 1 宽松策略） */
  appendMessage(sessionId: SessionId, message: ChatMessage): void
  /** 获取会话最近 limit 条消息（按时间升序） */
  getMessages(sessionId: SessionId, limit: number): ChatMessage[]
  /** 按 messageId 查找单条消息 */
  getMessage(sessionId: SessionId, messageId: MessageId): ChatMessage | null
  /** 更新消息的部分字段（流式完成后回写 status/content/errorCode） */
  updateMessage(sessionId: SessionId, messageId: MessageId, patch: Partial<ChatMessage>): void
  /** 将内部 ChatMessage 转为 renderer 安全的 ChatMessageView */
  toView(message: ChatMessage): ChatMessageView
}

/**
 * 创建内存会话存储。
 * Phase 1 唯一实现；Phase 2 用 SQLite SessionStore 替换。
 */
export function createMemorySessionStore(): SessionStore {
  const sessions = new Map<SessionId, ChatMessage[]>()

  return {
    createSession(): SessionId {
      const id = randomUUID()
      sessions.set(id, [])
      return id
    },

    exists(sessionId: SessionId): boolean {
      return sessions.has(sessionId)
    },

    appendMessage(sessionId: SessionId, message: ChatMessage): void {
      let msgs = sessions.get(sessionId)
      if (!msgs) {
        msgs = []
        sessions.set(sessionId, msgs)
      }
      msgs.push(message)
    },

    getMessages(sessionId: SessionId, limit: number): ChatMessage[] {
      const msgs = sessions.get(sessionId)
      if (!msgs) return []
      if (limit >= msgs.length) return [...msgs]
      return msgs.slice(msgs.length - limit)
    },

    getMessage(sessionId: SessionId, messageId: MessageId): ChatMessage | null {
      const msgs = sessions.get(sessionId)
      if (!msgs) return null
      return msgs.find((m) => m.id === messageId) ?? null
    },

    updateMessage(sessionId: SessionId, messageId: MessageId, patch: Partial<ChatMessage>): void {
      const msgs = sessions.get(sessionId)
      if (!msgs) return
      const idx = msgs.findIndex((m) => m.id === messageId)
      if (idx < 0) return
      msgs[idx] = { ...msgs[idx], ...patch }
    },

    toView(message: ChatMessage): ChatMessageView {
      const view: ChatMessageView = {
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        status: message.status
      }
      if (message.reasoning !== undefined) {
        view.reasoning = message.reasoning
      }
      if (message.errorCode !== undefined) {
        view.errorCode = message.errorCode
      }
      return view
    }
  }
}
