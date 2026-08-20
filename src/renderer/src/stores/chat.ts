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
  /** C-β：send 发出到 ACK 返回的同步锁，独立于 started 后的 activeTurn。 */
  isSending: boolean
}

export const useChatStore = defineStore('chat', () => {
  const state = reactive<ChatState>({
    sessionId: null,
    messages: [],
    draft: '',
    activeTurn: null,
    lastError: null,
    isHydrating: false,
    isSending: false
  })

  const canSend = computed(
    () =>
      state.draft.trim().length > 0 && !state.activeTurn && !state.isHydrating && !state.isSending
  )
  const isStreaming = computed(() => state.activeTurn !== null)
  // main 已排序，禁止组件再排序（S-002 §3.2）
  const orderedMessages = computed(() => state.messages)

  // === 会话管理 ===

  async function hydrate(sessionId?: string): Promise<void> {
    state.isHydrating = true
    try {
      if (!window.companion) return

      // C-β β-2 + P2-43：显式 sid > renderer 当前 sid > main 恢复最近会话 > 新建。
      let sid = sessionId ?? state.sessionId ?? undefined
      if (!sid) {
        // P2-43：SQLite SessionStore 恢复。空库（全新用户）返回 null，落到新建。
        const lastResult = await window.companion.chat.getLastSession()
        // 查询失败不等于空库：若继续 createSession 会把持久历史静默藏到新会话后面。
        if (!lastResult.ok) return
        if (lastResult.data.sessionId) {
          sid = lastResult.data.sessionId
        }
      }
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

  // M-18：清除发送/流式错误提示（错误条关闭按钮）
  function clearLastError(): void {
    state.lastError = null
  }

  // === 发送/停止/重试 ===

  async function send(): Promise<void> {
    if (!canSend.value || !state.sessionId || !window.companion) return

    // C-β：必须在第一个 await 前同步置位。activeTurn 要等 started 事件，不能覆盖 ACK 窗口。
    state.isSending = true
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

    try {
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
    } finally {
      // ACK 成功、业务失败或 Promise reject 都必须解锁；流式阶段由 activeTurn 接管。
      state.isSending = false
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
        // C-β：started 本身也要幂等。同 requestId 的重复投递不能再加占位气泡；
        // 不同 requestId 在当前轮结束前同样属于旧/冲突事件。
        if (state.activeTurn) return
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

  // C-β：store 实例内只允许一个 stream listener；旧 teardown 不得误拆新订阅。
  let currentSubscription: Unsubscribe | null = null

  function subscribe(): Unsubscribe {
    currentSubscription?.()
    if (!window.companion) {
      currentSubscription = null
      return () => {}
    }

    const unsubscribeStream = window.companion.chat.onStream((event) => {
      applyStream(event)
    })
    let disposed = false
    const teardown: Unsubscribe = () => {
      if (disposed) return
      disposed = true
      unsubscribeStream()
      if (currentSubscription === teardown) currentSubscription = null
    }
    currentSubscription = teardown
    return teardown
  }

  function reset(): void {
    state.sessionId = null
    state.messages = []
    state.draft = ''
    state.activeTurn = null
    state.lastError = null
    state.isHydrating = false
    state.isSending = false
  }

  return {
    state,
    canSend,
    isStreaming,
    orderedMessages,
    hydrate,
    setDraft,
    clearLastError,
    send,
    stop,
    retry,
    applyStream,
    subscribe,
    reset
  }
})
