// src/main/chat/sqlite-session-store.ts
// P2-43: SQLite 会话存储（生产实现，接替内存 SessionStore）。
// 依据：S-Phase2 P2-43 任务卡、S-002-补充-P2-43-SQLiteSessionStore与跨重启幂等 §2。
//
// 设计要点：
//   1. 复用 001_init 已建的 sessions/messages 表，零迁移（不加列：db 版本=max 迁移 id，
//      003 已预留 dmae_history，取 id≥5 会静默废掉 003）。
//   2. 语义与内存实现逐条等价（自动建会话、最近 limit 条升序、getTurnMessages 只认 complete）。
//   3. 启动中断修复：进程死则流式轮次必死，残留 streaming 一律修复为 failed，
//      让 UI 出"重试"而不是永远"正在输入"（§2.3）；M-39 补充第二类——
//      "用户消息已落库、assistant 未落库"的孤儿轮次补 failed 占位（CHAT_INTERRUPTED）。
//   4. 全部参数化绑定；单写者（main 进程），事务包住"建会话+算 seq+插消息+刷热度"。

import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { Logger } from '@shared/observability/types'
import type { ChatMessage, ChatMessageView, SessionId, MessageId } from '@shared/chat/types'
import type { MessageStatus } from '@shared/chat/types'
import type { ErrorCode } from '@shared/errors'
import { chatMessageToView, type SessionStore, type TurnMessagePair } from './session-store'

export interface SQLiteSessionStoreDeps {
  db: Database
  logger?: Logger
  /** 测试/确定性时钟；默认 Date.now */
  now?: () => number
}

interface MessageRow {
  id: string
  session_id: string
  seq: number
  role: 'user' | 'assistant' | 'system'
  content: string
  reasoning: string | null
  status: MessageStatus
  error_code: string | null
  turn_id: string | null
  created_at: number
}

function rowToMessage(row: MessageRow): ChatMessage {
  const message: ChatMessage = {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    status: row.status
  }
  if (row.reasoning !== null) message.reasoning = row.reasoning
  if (row.error_code !== null) message.errorCode = row.error_code as ErrorCode
  if (row.turn_id !== null) message.turnId = row.turn_id
  return message
}

/** updateMessage 允许回写的列（白名单，防任意列注入） */
const PATCH_COLUMNS: ReadonlyArray<readonly [keyof ChatMessage, string]> = [
  ['content', 'content'],
  ['reasoning', 'reasoning'],
  ['status', 'status'],
  ['errorCode', 'error_code'],
  ['turnId', 'turn_id']
]

/**
 * 创建 SQLite 会话存储。
 * 构造时同步执行中断修复（streaming -> failed），返回前完成——
 * ChatService 接受请求前不可能再看到尸体轮次。
 */
export function createSQLiteSessionStore(deps: SQLiteSessionStoreDeps): SessionStore {
  const { db, logger } = deps
  const now = deps.now ?? Date.now

  // updated_at 是"活跃顺序"而不只是墙钟：同毫秒快速操作、甚至系统时钟回拨时也必须严格递增。
  // 从持久化最大值起步，跨重启也保持单调；getLastSessionId 不靠 rowid 猜平局。
  let lastTouchedAt = (
    db.prepare(`SELECT COALESCE(MAX(updated_at), 0) AS ts FROM sessions`).get() as { ts: number }
  ).ts
  function nextTouchedAt(): number {
    lastTouchedAt = Math.max(now(), lastTouchedAt + 1)
    return lastTouchedAt
  }

  // === 启动中断修复（§2.3）===
  const repaired = db
    .prepare(`UPDATE messages SET status = 'failed' WHERE status = 'streaming'`)
    .run().changes
  if (repaired > 0) {
    logger?.info('repaired interrupted streaming messages', {
      scope: 'chat',
      metrics: { repaired }
    })
  }

  const stmts = {
    insertSession: db.prepare(
      `INSERT OR IGNORE INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)`
    ),
    touchSession: db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`),
    existsSession: db.prepare(`SELECT 1 AS one FROM sessions WHERE id = ?`),
    lastSession: db.prepare(`SELECT id FROM sessions ORDER BY updated_at DESC LIMIT 1`),
    nextSeq: db.prepare(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE session_id = ?`
    ),
    insertMessage: db.prepare(
      `INSERT INTO messages (id, session_id, seq, role, content, reasoning, status, error_code, turn_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    recentMessages: db.prepare(
      `SELECT * FROM (SELECT * FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC`
    ),
    turnMessages: db.prepare(`SELECT * FROM messages WHERE session_id = ? AND turn_id = ?`),
    byId: db.prepare(`SELECT * FROM messages WHERE session_id = ? AND id = ?`),
    deleteSupersededAssistant: db.prepare(
      `DELETE FROM messages
       WHERE session_id = ? AND turn_id = ? AND role = 'assistant'
         AND id != ? AND status != 'complete'`
    ),
    deleteTurn: db.prepare(
      `DELETE FROM messages WHERE session_id = ? AND turn_id = ? RETURNING id`
    ),
    deleteById: db.prepare(`DELETE FROM messages WHERE session_id = ? AND id = ?`),
    orphanUserTurns: db.prepare(
      `SELECT m.session_id AS session_id, m.turn_id AS turn_id FROM messages m
       WHERE m.role = 'user' AND m.turn_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM messages a
           WHERE a.session_id = m.session_id AND a.turn_id = m.turn_id AND a.role = 'assistant'
         )`
    )
  }

  // === 孤儿轮次修复（M-39，§2.3 中断修复的第二类）===
  // 进程在"用户消息已落库、assistant 消息尚未落库"之间死亡时，历史里只剩用户气泡、
  // 无任何"未回复"标记（streaming->failed 修复管不到——assistant 行根本不存在）。
  // 孤儿只能出现在会话尾部（崩溃即终局，此后不可能再有新消息），补一条 failed 占位
  // assistant（CHAT_INTERRUPTED），让 UI 出"回复被中断"标记 + 重试入口。
  // 不 touch session.updated_at：占位是修复产物不是用户活动，不该改变会话活跃排序。
  const orphanRows = stmts.orphanUserTurns.all() as Array<{
    session_id: string
    turn_id: string
  }>
  if (orphanRows.length > 0) {
    const repairOrphans = db.transaction((rows: typeof orphanRows): void => {
      for (const row of rows) {
        const seq = (stmts.nextSeq.get(row.session_id) as { seq: number }).seq
        stmts.insertMessage.run(
          randomUUID(),
          row.session_id,
          seq,
          'assistant',
          '',
          null,
          'failed',
          'CHAT_INTERRUPTED',
          row.turn_id,
          now()
        )
      }
    })
    repairOrphans(orphanRows)
    logger?.info('repaired orphan user turns with interrupted placeholders', {
      scope: 'chat',
      metrics: { repaired: orphanRows.length }
    })
  }

  const appendTx = db.transaction((sessionId: SessionId, message: ChatMessage): void => {
    // Phase 1 宽松语义：会话不存在自动创建（FK 约束下必须建）
    const touchedAt = nextTouchedAt()
    stmts.insertSession.run(sessionId, touchedAt, touchedAt)
    const seq = (stmts.nextSeq.get(sessionId) as { seq: number }).seq
    stmts.insertMessage.run(
      message.id,
      sessionId,
      seq,
      message.role,
      message.content,
      message.reasoning ?? null,
      message.status,
      message.errorCode ?? null,
      message.turnId ?? null,
      message.createdAt
    )
    stmts.touchSession.run(touchedAt, sessionId)
  })

  return {
    createSession(): SessionId {
      const id = randomUUID()
      const touchedAt = nextTouchedAt()
      stmts.insertSession.run(id, touchedAt, touchedAt)
      return id
    },

    exists(sessionId: SessionId): boolean {
      return stmts.existsSession.get(sessionId) !== undefined
    },

    appendMessage(sessionId: SessionId, message: ChatMessage): void {
      appendTx(sessionId, message)
    },

    getMessages(sessionId: SessionId, limit: number): ChatMessage[] {
      const rows = stmts.recentMessages.all(
        sessionId,
        Math.max(0, Math.floor(limit))
      ) as MessageRow[]
      return rows.map(rowToMessage)
    },

    getTurnMessages(sessionId: SessionId, turnId: string): TurnMessagePair | null {
      const rows = stmts.turnMessages.all(sessionId, turnId) as MessageRow[]
      const msgs = rows.map(rowToMessage)
      const user = msgs.find((m) => m.role === 'user')
      const assistant = msgs.find((m) => m.role === 'assistant')
      if (!user || !assistant) return null
      if (assistant.status !== 'complete') return null
      return { user, assistant }
    },

    getMessage(sessionId: SessionId, messageId: MessageId): ChatMessage | null {
      const row = stmts.byId.get(sessionId, messageId) as MessageRow | undefined
      return row ? rowToMessage(row) : null
    },

    deleteSupersededAssistantMessages(
      sessionId: SessionId,
      turnId: string,
      keepMessageId: MessageId
    ): number {
      return stmts.deleteSupersededAssistant.run(sessionId, turnId, keepMessageId).changes
    },

    deleteTurnMessages(sessionId: SessionId, turnId: string): string[] {
      const rows = stmts.deleteTurn.all(sessionId, turnId) as Array<{ id: string }>
      return rows.map((r) => r.id)
    },

    deleteMessage(sessionId: SessionId, messageId: MessageId): boolean {
      return stmts.deleteById.run(sessionId, messageId).changes > 0
    },

    updateMessage(sessionId: SessionId, messageId: MessageId, patch: Partial<ChatMessage>): void {
      const sets: string[] = []
      const values: unknown[] = []
      for (const [key, column] of PATCH_COLUMNS) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) {
          sets.push(`${column} = ?`)
          values.push(patch[key] ?? null)
        }
      }
      if (sets.length === 0) return
      values.push(sessionId, messageId)
      db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE session_id = ? AND id = ?`).run(
        ...values
      )
    },

    getLastSessionId(): SessionId | null {
      const row = stmts.lastSession.get() as { id: string } | undefined
      return row?.id ?? null
    },

    toView(message: ChatMessage): ChatMessageView {
      return chatMessageToView(message)
    }
  }
}
