// src/shared/chat/types.ts
// Chat 类型契约
// 依据：S-002 §3.2、S-003 §3.5/§3.8

import type { ErrorCode, IpcError } from '../errors'

export type ChatRole = 'user' | 'assistant' | 'system'
export type MessageStatus = 'complete' | 'streaming' | 'failed' | 'cancelled'

export type SessionId = string
export type RequestId = string
export type MessageId = string

/** main 进程的完整消息模型 */
export interface ChatMessage {
  id: MessageId
  sessionId: SessionId
  role: ChatRole
  content: string
  /** 思考过程（reasoning_content）。仅 assistant 消息在思考模式开启时可能非空 */
  reasoning?: string
  createdAt: number
  status: MessageStatus
  errorCode?: ErrorCode
  turnId?: string
}

/** renderer 的消息视图。依据 S-002 §3.2 */
export interface ChatMessageView {
  id: string
  role: ChatRole
  content: string
  /** 思考过程（reasoning_content）。仅 assistant 消息在思考模式开启时可能非空 */
  reasoning?: string
  /** 思考过程在 UI 上是否折叠（本地状态，不入 config.json） */
  reasoningCollapsed?: boolean
  createdAt: number
  status: MessageStatus
  errorCode?: ErrorCode
}

/** 活动轮次。依据 S-002 §3.2 */
export interface ActiveTurn {
  requestId: string
  assistantMessageId: string
  lastSequence: number
  startedAt: number
}

// === IPC 请求/响应 ===

export interface ChatListRequest {
  sessionId?: SessionId
  limit: number // 1..500
}

export interface ChatHistorySnapshot {
  sessionId: SessionId
  messages: ChatMessageView[]
}

export interface ChatSendRequest {
  sessionId: SessionId // 1..200，^[A-Za-z0-9._:-]+$
  text: string // trim 后 1..20_000 字符
  clientRequestId: RequestId // renderer 生成，幂等键
}

export interface ChatSendAck {
  requestId: RequestId
  userMessageId: MessageId
}

export interface ChatCancelRequest {
  requestId: RequestId
}

export interface ChatRetryRequest {
  sessionId: SessionId
  messageId: MessageId
}

// === ChatStreamEvent。依据 S-003 §3.8 ===
export type ChatStreamEvent =
  | {
      type: 'started'
      requestId: RequestId
      sessionId: SessionId
      assistantMessageId: MessageId
      sequence: 0
    }
  | { type: 'chunk'; requestId: RequestId; sequence: number; delta: string }
  | { type: 'reasoning'; requestId: RequestId; sequence: number; delta: string }
  | {
      type: 'completed'
      requestId: RequestId
      sequence: number
      usage?: { inputTokens: number; outputTokens: number }
    }
  | { type: 'failed'; requestId: RequestId; sequence: number; error: IpcError }
  | { type: 'cancelled'; requestId: RequestId; sequence: number }
