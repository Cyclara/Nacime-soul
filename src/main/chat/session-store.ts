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

/** turn 内的 user + assistant 消息对。依据 S-010 §1.1 getTurnMessages */
export interface TurnMessagePair {
  user: ChatMessage
  assistant: ChatMessage
}

/**
 * 将内部 ChatMessage 转为 renderer 安全的 ChatMessageView（剥离 sessionId/turnId）。
 * P2-43：抽为共享函数，内存/SQLite 两实现共用，防双份漂移（S-002-补充-P2-43 §2.2）。
 */
export function chatMessageToView(message: ChatMessage): ChatMessageView {
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

/** 会话存储接口。Phase 1 为纯内存实现，P2-43 起生产环境用 SQLite（sqlite-session-store.ts） */
export interface SessionStore {
  /** 创建新会话，返回 sessionId */
  createSession(): SessionId
  /** 会话是否存在 */
  exists(sessionId: SessionId): boolean
  /** 追加消息到会话末尾。会话不存在时自动创建（Phase 1 宽松策略） */
  appendMessage(sessionId: SessionId, message: ChatMessage): void
  /** 获取会话最近 limit 条消息（按时间升序） */
  getMessages(sessionId: SessionId, limit: number): ChatMessage[]
  /**
   * 按 turnId 查询该 turn 的 user + assistant 消息对。
   * 依据 S-010 §1.1：提取管线只用当前 turn 的 user 消息做 evidence，
   * 不做 getMessages(10_000) 全会话扫描。缺失/无配对/assistant 非完整返回 null。
   */
  getTurnMessages(sessionId: SessionId, turnId: string): TurnMessagePair | null
  /** 按 messageId 查找单条消息 */
  getMessage(sessionId: SessionId, messageId: MessageId): ChatMessage | null
  /**
   * 删除一轮中被取代的 assistant 行（验收反馈④c 重试不增消息）。
   * 重试到达终局后，同 turnId 的旧 failed/cancelled assistant 行（含 CHAT_INTERRUPTED
   * 占位）已被新行取代，删除以保持"一轮 = user + 最新 assistant"，
   * 同时保证 getTurnMessages 的 find(assistant) 命中的是最新行（记忆提取不被旧失败行挡掉）。
   * complete 行绝不删；keepMessageId（本次终局新写入的行）不在删除范围。
   * 返回删除条数。
   */
  deleteSupersededAssistantMessages(
    sessionId: SessionId,
    turnId: string,
    keepMessageId: MessageId
  ): number
  /**
   * 删除一整轮（验收反馈⑥ 用户自助删除）：user + assistant 全部行、任何状态。
   * 返回被删行的 id 列表（renderer 据此同步摘除气泡）。
   */
  deleteTurnMessages(sessionId: SessionId, turnId: string): string[]
  /** 删除单条消息（遗产无 turnId 行的回退路径）。返回是否删到。 */
  deleteMessage(sessionId: SessionId, messageId: MessageId): boolean
  /** 更新消息的部分字段（流式完成后回写 status/content/errorCode） */
  updateMessage(sessionId: SessionId, messageId: MessageId, patch: Partial<ChatMessage>): void
  /** 最近活跃会话（P2-43 启动恢复）。空库/无会话返回 null */
  getLastSessionId(): SessionId | null
  /** 将内部 ChatMessage 转为 renderer 安全的 ChatMessageView */
  toView(message: ChatMessage): ChatMessageView
}

/**
 * 创建内存会话存储。
 * P2-43 起仅用于单元测试（生产环境为 SQLite 实现）。
 */
export function createMemorySessionStore(): SessionStore {
  const sessions = new Map<SessionId, ChatMessage[]>()
  // P2-43：与 SQLite getLastSessionId 对齐（最近创建/追加的会话）
  let lastTouched: SessionId | null = null

  return {
    createSession(): SessionId {
      const id = randomUUID()
      sessions.set(id, [])
      lastTouched = id
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
      lastTouched = sessionId
    },

    getMessages(sessionId: SessionId, limit: number): ChatMessage[] {
      const msgs = sessions.get(sessionId)
      if (!msgs) return []
      if (limit >= msgs.length) return [...msgs]
      return msgs.slice(msgs.length - limit)
    },

    getTurnMessages(sessionId: SessionId, turnId: string): TurnMessagePair | null {
      const msgs = sessions.get(sessionId)
      if (!msgs) return null
      // 找出该 turnId 的所有消息。一轮恰好含一条 user + 一条 assistant。
      const turnMsgs = msgs.filter((m) => m.turnId === turnId)
      const user = turnMsgs.find((m) => m.role === 'user')
      const assistant = turnMsgs.find((m) => m.role === 'assistant')
      // 缺失或 assistant 未完成（streaming/failed/cancelled）均视为不可用
      if (!user || !assistant) return null
      if (assistant.status !== 'complete') return null
      return { user, assistant }
    },

    getMessage(sessionId: SessionId, messageId: MessageId): ChatMessage | null {
      const msgs = sessions.get(sessionId)
      if (!msgs) return null
      return msgs.find((m) => m.id === messageId) ?? null
    },

    deleteSupersededAssistantMessages(
      sessionId: SessionId,
      turnId: string,
      keepMessageId: MessageId
    ): number {
      const msgs = sessions.get(sessionId)
      if (!msgs) return 0
      const before = msgs.length
      const kept = msgs.filter(
        (m) =>
          !(
            m.role === 'assistant' &&
            m.turnId === turnId &&
            m.id !== keepMessageId &&
            m.status !== 'complete'
          )
      )
      if (kept.length === before) return 0
      sessions.set(sessionId, kept)
      return before - kept.length
    },

    deleteTurnMessages(sessionId: SessionId, turnId: string): string[] {
      const msgs = sessions.get(sessionId)
      if (!msgs) return []
      const removed = msgs.filter((m) => m.turnId === turnId).map((m) => m.id)
      if (removed.length === 0) return []
      sessions.set(
        sessionId,
        msgs.filter((m) => m.turnId !== turnId)
      )
      return removed
    },

    deleteMessage(sessionId: SessionId, messageId: MessageId): boolean {
      const msgs = sessions.get(sessionId)
      if (!msgs) return false
      const idx = msgs.findIndex((m) => m.id === messageId)
      if (idx < 0) return false
      msgs.splice(idx, 1)
      return true
    },

    updateMessage(sessionId: SessionId, messageId: MessageId, patch: Partial<ChatMessage>): void {
      const msgs = sessions.get(sessionId)
      if (!msgs) return
      const idx = msgs.findIndex((m) => m.id === messageId)
      if (idx < 0) return
      msgs[idx] = { ...msgs[idx], ...patch }
    },

    getLastSessionId(): SessionId | null {
      return lastTouched
    },

    toView: chatMessageToView
  }
}
