// src/renderer/src/stores/chat.ts
// P1-24: chat store - 当前会话、消息投影、流式状态机、发送/停止
// 依据：S-002 §3.2、S-001 P1-24、S-003 §3.8（ChatStreamEvent）
//
// 安全红线：
//   - Store 不直接调用其他 store 的 action（S-002 铁律 1）
//   - 组件不直接调 window.companion，统一由 store action 调用（S-002 铁律 3）
//   - 事件带 requestId/sequence；store 丢弃旧 request 或逆序 sequence（S-002 铁律 5）
//
// applyStream() 状态机（S-002 §3.2）：
//   started(seq=0)  -> activeTurn + assistant placeholder
//   chunk(seq=n)    -> requestId 匹配且 n>lastSequence 才 append
//   completed       -> status=complete，activeTurn=null
//   failed          -> status=failed，activeTurn=null，保存安全错误
//   cancelled       -> status=cancelled，activeTurn=null
//   旧 requestId / sequence<=lastSequence -> 丢弃并 debug 计数

import { reactive, computed } from 'vue'
import { defineStore } from 'pinia'
import type { ErrorCode, PublicAppError } from '@shared/errors'
import type { Unsubscribe } from '@shared/ipc/contracts'
import type { ChatMessageView, ChatStreamEvent, ChatHistorySnapshot } from '@shared/chat/types'

export type ChatRole = 'user' | 'assistant' | 'system'
export type MessageStatus = 'complete' | 'streaming' | 'failed' | 'cancelled'

export interface ActiveTurn {
  requestId: string
  assistantMessageId: string
  lastSequence: number
  startedAt: number
}

export interface ChatState {
  sessionId: string | null
  messages: ChatMessageView[]
  draft: string
  activeTurn: ActiveTurn | null
  lastError: PublicAppError | null
  isHydrating: boolean
}

export const useChatStore = defineStore('chat', () => {
  const state = reactive<ChatState>({
    sessionId: null,
    messages: [],
    draft: '',
    activeTurn: null,
    lastError: null,
    isHydrating: false
  })

  const canSend = computed(
    () => state.draft.trim().length > 0 && !state.activeTurn && !state.isHydrating
  )
  const isStreaming = computed(() => state.activeTurn !== null)
  // main 已排序，禁止组件再排序（S-002 §3.2）
  const orderedMessages = computed(() => state.messages)

  // === 会话管理 ===

  async function hydrate(sessionId?: string): Promise<void> {
    state.isHydrating = true
    try {
      if (!window.companion) return

      let sid = sessionId
      if (!sid) {
        const createResult = await window.companion.chat.createSession()
        if (!createResult.ok) return
        sid = createResult.data.sessionId
      }

      state.sessionId = sid

      const listResult = await window.companion.chat.list({ sessionId: sid, limit: 500 })
      if (listResult.ok) {
        const snapshot = listResult.data as ChatHistorySnapshot
        state.messages = snapshot.messages.map((m) => ({ ...m }))
      }
    } finally {
      state.isHydrating = false
    }
  }

  // === 草稿 ===

  function setDraft(value: string): void {
    state.draft = value
  }

  // === 发送/停止/重试 ===

  async function send(): Promise<void> {
    if (!canSend.value || !state.sessionId || !window.companion) return

    const text = state.draft
    const clientRequestId = crypto.randomUUID()
    state.draft = ''

    // 乐观添加用户消息
    const userMessage: ChatMessageView = {
      id: clientRequestId,
      role: 'user',
      content: text,
      createdAt: Date.now(),
      status: 'complete'
    }
    state.messages.push(userMessage)

    const result = await window.companion.chat.send({
      sessionId: state.sessionId,
      text,
      clientRequestId
    })

    if (!result.ok) {
      // 发送失败：移除乐观消息，恢复草稿（S-001 P1-24A "出错后回到正确步骤且草稿保留"）
      const idx = state.messages.findIndex((m) => m.id === clientRequestId)
      if (idx >= 0) state.messages.splice(idx, 1)
      state.draft = text
      state.lastError = {
        code: result.error.code as ErrorCode,
        message: result.error.message,
        severity: 'error',
        retryable: result.error.retryable
      }
    }
  }

  async function stop(): Promise<void> {
    if (!state.activeTurn || !window.companion) return
    await window.companion.chat.cancel({ requestId: state.activeTurn.requestId })
  }

  async function retry(messageId: string): Promise<void> {
    if (!state.sessionId || !window.companion || state.activeTurn) return
    await window.companion.chat.retry({ sessionId: state.sessionId, messageId })
  }

  // === 流式状态机（S-002 §3.2）===

  function applyStream(event: ChatStreamEvent): void {
    switch (event.type) {
      case 'started': {
        // 丢弃旧 requestId 事件
        if (state.activeTurn && state.activeTurn.requestId !== event.requestId) {
          return
        }
        state.activeTurn = {
          requestId: event.requestId,
          assistantMessageId: event.assistantMessageId,
          lastSequence: 0,
          startedAt: Date.now()
        }
        // 添加 assistant 占位消息
        state.messages.push({
          id: event.assistantMessageId,
          role: 'assistant',
          content: '',
          createdAt: Date.now(),
          status: 'streaming'
        })
        break
      }

      case 'chunk':
      case 'reasoning': {
        // requestId 必须匹配当前 activeTurn
        const turn = state.activeTurn
        if (!turn || turn.requestId !== event.requestId) return
        // sequence 必须大于 lastSequence（丢弃重复/逆序）
        if (event.sequence <= turn.lastSequence) return

        turn.lastSequence = event.sequence
        // 追加 delta 到 assistant 消息（正文或思考过程）
        const msg = state.messages.find((m) => m.id === turn.assistantMessageId)
        if (msg) {
          if (event.type === 'chunk') {
            msg.content += event.delta
          } else {
            msg.reasoning = (msg.reasoning ?? '') + event.delta
          }
        }
        break
      }

      case 'completed': {
        const turn = state.activeTurn
        if (!turn || turn.requestId !== event.requestId) return
        if (event.sequence <= turn.lastSequence) return

        const msg = state.messages.find((m) => m.id === turn.assistantMessageId)
        if (msg) {
          msg.status = 'complete'
        }
        state.activeTurn = null
        break
      }

      case 'failed': {
        const turn = state.activeTurn
        if (!turn || turn.requestId !== event.requestId) return
        if (event.sequence <= turn.lastSequence) return

        const msg = state.messages.find((m) => m.id === turn.assistantMessageId)
        if (msg) {
          msg.status = 'failed'
          msg.errorCode = event.error.code as ErrorCode
        }
        // 保存安全错误
        state.lastError = {
          code: event.error.code as ErrorCode,
          message: event.error.message,
          severity: 'error',
          retryable: event.error.retryable
        }
        state.activeTurn = null
        break
      }

      case 'cancelled': {
        const turn = state.activeTurn
        if (!turn || turn.requestId !== event.requestId) return
        if (event.sequence <= turn.lastSequence) return

        const msg = state.messages.find((m) => m.id === turn.assistantMessageId)
        if (msg) {
          msg.status = 'cancelled'
        }
        state.activeTurn = null
        break
      }
    }
  }

  // === 事件订阅 ===

  function subscribe(): Unsubscribe {
    if (!window.companion) return () => {}
    return window.companion.chat.onStream((event) => {
      applyStream(event)
    })
  }

  function reset(): void {
    state.sessionId = null
    state.messages = []
    state.draft = ''
    state.activeTurn = null
    state.lastError = null
    state.isHydrating = false
  }

  return {
    state,
    canSend,
    isStreaming,
    orderedMessages,
    hydrate,
    setDraft,
    send,
    stop,
    retry,
    applyStream,
    subscribe,
    reset
  }
})
