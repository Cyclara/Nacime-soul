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

import { reactive, computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { ErrorCode, PublicAppError } from '@shared/errors'
import type { Unsubscribe, IpcResult } from '@shared/ipc/contracts'
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
      } else {
        // M-49：乐观气泡的 id 从 clientRequestId 回填为 main 落库的真实 userMessageId。
        // 不回填的话，针对刚发出的 user 气泡的删除/单删会拿临时 id 查库，
        // main 查不到 -> 返回空 deletedIds -> 静默删不掉（2026-08-21 验收红圈 bug）。
        // 气泡行无入场动画，key 变化引起的重挂载不可见。
        const idx = state.messages.findIndex((m) => m.id === clientRequestId)
        if (idx >= 0) state.messages[idx].id = result.data.userMessageId
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
    // 验收反馈④c：main 重试到终局后会删掉同轮旧失败行；renderer 在对应终局事件里
    // 同步摘除旧气泡（consumeRetryTarget），界面上一轮只留"user + 最新 assistant"。
    retryTargetId = messageId
    const result = await window.companion.chat.retry({ sessionId: state.sessionId, messageId })
    // 发送失败或目标已不存在（requestId=''）：不会有流事件到来，撤销标记防误摘
    if (!result.ok || !result.data.requestId) retryTargetId = null
  }

  // 验收反馈⑥：按轮删除（右键气泡 → 删除这轮对话）。
  // main 返回实际被删的行 id（整轮 user+assistant 或单条遗产行），renderer 据此同步摘除气泡。
  // 删除后该轮退出 prompt 历史——她会忘记这一轮；已沉淀的记忆条目不受影响。
  async function deleteTurn(messageId: string): Promise<void> {
    if (!state.sessionId || !window.companion || state.activeTurn) return
    const result = await window.companion.chat.deleteTurn({
      sessionId: state.sessionId,
      messageId
    })
    applyDeletedIds(result)
  }

  // 验收反馈⑥c：单条删除（右键气泡 → 删除这条消息）。
  // 只删被点的那一条，同轮兄弟气泡保留（孤儿/孤立语义见 ChatDeleteMessageRequest 注释）。
  async function deleteMessage(messageId: string): Promise<void> {
    if (!state.sessionId || !window.companion || state.activeTurn) return
    const result = await window.companion.chat.deleteMessage({
      sessionId: state.sessionId,
      messageId
    })
    applyDeletedIds(result)
  }

  function applyDeletedIds(result: IpcResult<{ deletedIds: string[] }>): void {
    if (!result.ok) {
      // M-49：删除失败不再静默（如竞态 CHAT_BUSY）——走现有错误条给用户一个说法
      state.lastError = {
        code: result.error.code as ErrorCode,
        message: result.error.message,
        severity: 'error',
        retryable: result.error.retryable
      }
      return
    }
    const deleted = new Set(result.data.deletedIds)
    if (deleted.size === 0) return
    state.messages = state.messages.filter((m) => !deleted.has(m.id))
  }

  // === 验收反馈⑦：选择模式（批量按轮删除 + 清空会话） ===
  //
  // 粒度裁定（2026-08-21 用户拍板）：删除单位永远是"轮"，不留孤儿/孤立半轮。
  // ChatMessageView 按 S-002 §3.6 剥离 turnId（冻结合约不改），renderer 用相邻配对
  // 规则做勾选联动（user 配紧随的 assistant；assistant 配紧邻的前置 user），
  // 让"所见即所删"成立；真正的删除解析在 main 侧按 turnId 去重，联动配错也不产生半轮。
  const selectionMode = ref(false)
  const selectedIds = reactive(new Set<string>())

  /** 相邻配对：返回 messageId 所在轮的视图 id 组（孤儿/孤立行只含自己） */
  function turnGroupOf(messageId: string): string[] {
    const msgs = orderedMessages.value
    const i = msgs.findIndex((m) => m.id === messageId)
    if (i < 0) return [messageId]
    const m = msgs[i]
    if (m.role === 'user') {
      const next = msgs[i + 1]
      return next && next.role === 'assistant' ? [m.id, next.id] : [m.id]
    }
    if (m.role === 'assistant') {
      const prev = msgs[i - 1]
      return prev && prev.role === 'user' ? [prev.id, m.id] : [m.id]
    }
    return [m.id]
  }

  /** 进入选择模式；带 messageId 时预勾它所在的整轮 */
  function enterSelection(messageId?: string): void {
    selectionMode.value = true
    if (messageId) {
      for (const id of turnGroupOf(messageId)) selectedIds.add(id)
    }
  }

  function exitSelection(): void {
    selectionMode.value = false
    selectedIds.clear()
  }

  /** 勾选/取消勾选：整轮联动（组内全选 -> 全消；否则全选） */
  function toggleSelect(messageId: string): void {
    const group = turnGroupOf(messageId)
    const allIn = group.every((id) => selectedIds.has(id))
    for (const id of group) {
      if (allIn) selectedIds.delete(id)
      else selectedIds.add(id)
    }
  }

  const selectedCount = computed(() => selectedIds.size)
  const allSelected = computed(
    () => orderedMessages.value.length > 0 && selectedIds.size >= orderedMessages.value.length
  )

  function toggleSelectAll(): void {
    if (allSelected.value) selectedIds.clear()
    else for (const m of orderedMessages.value) selectedIds.add(m.id)
  }

  /** 删除所选（按轮）：main 侧 id->turnId 去重整轮删；成功后退出选择模式 */
  async function deleteSelected(): Promise<void> {
    if (!state.sessionId || !window.companion || state.activeTurn || selectedIds.size === 0) {
      return
    }
    const result = await window.companion.chat.deleteSelected({
      sessionId: state.sessionId,
      messageIds: [...selectedIds]
    })
    applyDeletedIds(result)
    if (result.ok) exitSelection()
  }

  /** 删除所有对话：清空当前会话消息（会话保留；记忆条目不受影响） */
  async function clearSession(): Promise<void> {
    if (!state.sessionId || !window.companion || state.activeTurn) return
    const result = await window.companion.chat.clearSession({ sessionId: state.sessionId })
    if (!result.ok) {
      state.lastError = {
        code: result.error.code as ErrorCode,
        message: result.error.message,
        severity: 'error',
        retryable: result.error.retryable
      }
      return
    }
    state.messages = []
    exitSelection()
  }

  // 流式开始（send/retry）自动退出选择模式——删除项/选择模式都以非流式为前提
  watch(
    () => state.activeTurn,
    (turn) => {
      if (turn) exitSelection()
    }
  )


  // 验收反馈④c：重试终局（completed/failed/cancelled）时摘除被取代的旧气泡。
  let retryTargetId: string | null = null
  function consumeRetryTarget(): void {
    if (retryTargetId === null) return
    const idx = state.messages.findIndex((m) => m.id === retryTargetId)
    // 只摘非 complete 的旧气泡；若它已被别的路径更新/删除则不动
    if (idx >= 0 && state.messages[idx].status !== 'complete') state.messages.splice(idx, 1)
    retryTargetId = null
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
        consumeRetryTarget()
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
        consumeRetryTarget()
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
        consumeRetryTarget()
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
    exitSelection()
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
    deleteTurn,
    deleteMessage,
    deleteSelected,
    clearSession,
    selectionMode,
    selectedIds,
    selectedCount,
    allSelected,
    enterSelection,
    exitSelection,
    toggleSelect,
    toggleSelectAll,
    applyStream,
    subscribe,
    reset
  }
})
