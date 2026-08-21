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

/**
 * 按轮删除（验收反馈⑥）：messageId 定位一轮（取其 turnId），
 * 删除该轮全部行（user + assistant，含 failed/cancelled/CHAT_INTERRUPTED 占位）。
 * 返回被删行的 id 列表（renderer 据此同步摘除气泡）。
 */
export interface ChatDeleteTurnRequest {
  sessionId: SessionId
  messageId: MessageId
}

/**
 * 单条删除（验收反馈⑥c 粒度控制）：只删被点的那一条，不动同轮兄弟行。
 * 连带语义：删 assistant 会留孤儿 user（下次启动 M-39 补 CHAT_INTERRUPTED 占位=重答入口）；
 * 删 user 会留孤立 assistant（prompt 装配跳过孤立 assistant 轮=她忘了这句回答）。
 */
export interface ChatDeleteMessageRequest {
  sessionId: SessionId
  messageId: MessageId
}

/**
 * 批量按轮删除（验收反馈⑦ 选择模式）：messageIds 为勾选的消息 id（可有同轮多个），
 * main 把每个 id 解析到所在轮（turnId）去重后整轮删除——删除单位永远是轮，
 * 不会产生孤儿/孤立半轮。无 turnId 的遗产行按单条删。
 * 返回被删行的 id 全集（renderer 据此同步摘除气泡）。
 */
export interface ChatDeleteSelectedRequest {
  sessionId: SessionId
  messageIds: MessageId[] // 1..500
}

/**
 * 清空会话全部消息（验收反馈⑦ 选择模式「删除所有对话」）。
 * 会话本身保留；记忆条目不受影响。返回删除条数。
 */
export interface ChatClearSessionRequest {
  sessionId: SessionId
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
