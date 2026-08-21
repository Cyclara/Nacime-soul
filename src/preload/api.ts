// src/preload/api.ts
// preload API：typed window.companion，invoke/subscribe 白名单，unsubscribe 清理
// 依据：S-001 P1-17、S-003 §3.7、S-002 §3.5
//
// 安全红线：
//   - 不暴露原始 ipcRenderer
//   - 不暴露 invoke(channel: string) 通用通道
//   - 每个 API 方法固定通道，renderer 不可任意 invoke
//   - 事件退订后不再触发

import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { CompanionApi } from '../shared/global'
import type {
  IpcInvokeMap,
  IpcEventMap,
  IpcResult,
  Unsubscribe,
  AppInfo
} from '../shared/ipc/contracts'
import type { IpcInvokeChannel, IpcEventChannel } from '../shared/ipc/channels'
import type {
  ChatSendRequest,
  ChatCancelRequest,
  ChatListRequest,
  ChatStreamEvent,
  ChatHistorySnapshot,
  ChatSendAck
} from '../shared/chat/types'
import type {
  ConfigUpdateRequest,
  ModelConnectionTestRequest,
  ConnectionTestResult,
  ConfigResetRequest,
  PublicConfigSnapshot
} from '../shared/config/types'
import type { PublicAppError } from '../shared/errors'
import type { DebugSnapshot } from '../shared/observability/types'
import type {
  DmaeHistoryRequest,
  DmaeHistoryResponse,
  DmaeSnapshotView,
  DmaeTrendRequest,
  DmaeExplainRequest,
  DmaeBenchmarkRequest,
  DmaeQualitativeRequest,
  DmaeMuteRequest,
  GrowthProfileView,
  GrowthTimelineEntryView,
  GrowthTimelineRequest,
  GrowthTrendPoint,
  GrowthTrendRequest,
  L0ProfileView,
  L2MemoryDetail,
  MemoryDeleteRequest,
  MemoryDetailRequest,
  MemoryListRequest,
  MemoryListResponse,
  MemoryOverview,
  MemoryPinRequest,
  MemoryRestoreRequest,
  MemorySetL0FieldRequest,
  MemoryUpdateContentRequest,
  MemoryUpdatedEvent
} from '../shared/memory/types'
import type {
  DmaeBenchmarkReport,
  DmaeDailyAggregate,
  DmaePanelSnapshot,
  DmaeTurnExplanation
} from '../shared/memory/dmae-types'
import { validateEventPayload } from '../shared/ipc/validators'

/**
 * 类型安全的 invoke 包装。
 * 不暴露通用 invoke(channel)，每个 API 方法在编译时锁定通道。
 */
function typedInvoke<K extends IpcInvokeChannel>(
  channel: K,
  payload: IpcInvokeMap[K]['req']
): Promise<IpcResult<IpcInvokeMap[K]['res']>> {
  return ipcRenderer.invoke(channel, payload) as Promise<IpcResult<IpcInvokeMap[K]['res']>>
}

/**
 * 类型安全的事件订阅包装。
 * 返回 unsubscribe 函数，调用后移除 listener。
 * 依据 S-003 §3.7 subscribe/unsubscribe 模式。
 */
function typedSubscribe<K extends IpcEventChannel>(
  channel: K,
  callback: (payload: IpcEventMap[K]) => void
): Unsubscribe {
  const wrapped = (_event: IpcRendererEvent, payload: unknown): void => {
    // S-003 §3.7：验证事件载荷，拒绝畸形数据（纵深防御）
    if (validateEventPayload(channel, payload)) {
      callback(payload)
    }
  }
  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.removeListener(channel, wrapped)
  }
}

/**
 * preload 暴露的 typed API。
 * 使用 Object.freeze 防止 renderer 修改 API 对象。
 * 依据 S-003 §3.7、S-002 §3.5。
 */
export const companionApi: CompanionApi = Object.freeze({
  app: {
    getInfo(): Promise<IpcResult<AppInfo>> {
      return typedInvoke('companion:app:get-info', undefined)
    },
    openUserData(): Promise<IpcResult<void>> {
      return typedInvoke('companion:app:open-user-data', undefined)
    },
    onError(cb: (e: PublicAppError) => void): Unsubscribe {
      return typedSubscribe('companion:event:app-error', cb)
    }
  },

  window: {
    minimize(): Promise<IpcResult<void>> {
      return typedInvoke('companion:window:minimize', undefined)
    },
    toggleMaximize(): Promise<IpcResult<{ maximized: boolean }>> {
      return typedInvoke('companion:window:toggle-maximize', undefined)
    },
    close(): Promise<IpcResult<void>> {
      return typedInvoke('companion:window:close', undefined)
    },
    getState(): Promise<IpcResult<{ maximized: boolean }>> {
      return typedInvoke('companion:window:get-state', undefined)
    },
    onState(cb: (state: { maximized: boolean }) => void): Unsubscribe {
      return typedSubscribe('companion:event:window-state', cb)
    }
  },

  config: {
    get(): Promise<IpcResult<PublicConfigSnapshot>> {
      return typedInvoke('companion:config:get', undefined)
    },
    update(patch: ConfigUpdateRequest): Promise<IpcResult<PublicConfigSnapshot>> {
      return typedInvoke('companion:config:update', patch)
    },
    testModel(input: ModelConnectionTestRequest): Promise<IpcResult<ConnectionTestResult>> {
      return typedInvoke('companion:config:test-model', input)
    },
    resetDomain(input: ConfigResetRequest): Promise<IpcResult<PublicConfigSnapshot>> {
      return typedInvoke('companion:config:reset-domain', input)
    }
  },

  chat: {
    list(input: ChatListRequest): Promise<IpcResult<ChatHistorySnapshot>> {
      return typedInvoke('companion:chat:list', input)
    },
    createSession(): Promise<IpcResult<{ sessionId: string }>> {
      return typedInvoke('companion:chat:create-session', undefined)
    },
    getLastSession(): Promise<IpcResult<{ sessionId: string | null }>> {
      return typedInvoke('companion:chat:get-last-session', undefined)
    },
    send(input: ChatSendRequest): Promise<IpcResult<ChatSendAck>> {
      return typedInvoke('companion:chat:send', input)
    },
    cancel(input: ChatCancelRequest): Promise<IpcResult<void>> {
      return typedInvoke('companion:chat:cancel', input)
    },
    retry(input: {
      sessionId: string
      messageId: string
    }): Promise<IpcResult<{ requestId: string }>> {
      return typedInvoke(
        'companion:chat:retry',
        input as unknown as IpcInvokeMap['companion:chat:retry']['req']
      )
    },
    // 验收反馈⑥：按轮删除对话（删除即退出她的上下文；记忆条目不受影响）
    deleteTurn(input: {
      sessionId: string
      messageId: string
    }): Promise<IpcResult<{ deletedIds: string[] }>> {
      return typedInvoke(
        'companion:chat:delete-turn',
        input as unknown as IpcInvokeMap['companion:chat:delete-turn']['req']
      )
    },
    // 验收反馈⑥c：单条删除（粒度控制——只删被点的那一条，不动同轮兄弟）
    deleteMessage(input: {
      sessionId: string
      messageId: string
    }): Promise<IpcResult<{ deletedIds: string[] }>> {
      return typedInvoke(
        'companion:chat:delete-message',
        input as unknown as IpcInvokeMap['companion:chat:delete-message']['req']
      )
    },
    // 验收反馈⑦：选择模式批量按轮删除（勾选 id 解析到轮去重后整轮删，不留半轮）
    deleteSelected(input: {
      sessionId: string
      messageIds: string[]
    }): Promise<IpcResult<{ deletedIds: string[] }>> {
      return typedInvoke(
        'companion:chat:delete-selected',
        input as unknown as IpcInvokeMap['companion:chat:delete-selected']['req']
      )
    },
    // 验收反馈⑦：清空会话全部消息（「删除所有对话」；会话保留，记忆条目不受影响）
    clearSession(input: { sessionId: string }): Promise<IpcResult<{ removed: number }>> {
      return typedInvoke(
        'companion:chat:clear-session',
        input as unknown as IpcInvokeMap['companion:chat:clear-session']['req']
      )
    },
    onStream(cb: (event: ChatStreamEvent) => void): Unsubscribe {
      return typedSubscribe('companion:event:chat-stream', cb)
    }
  },

  debug: {
    getSnapshot(): Promise<IpcResult<DebugSnapshot>> {
      return typedInvoke('companion:debug:get-snapshot', undefined)
    },
    openLogFolder(): Promise<IpcResult<void>> {
      return typedInvoke('companion:debug:open-log-folder', undefined)
    }
  },

  // ── Phase 2：memory（9 invoke + onUpdated，S-003-补充 §3.6）──
  memory: {
    getOverview(): Promise<IpcResult<MemoryOverview>> {
      return typedInvoke('companion:memory:get-overview', undefined)
    },
    getL0(): Promise<IpcResult<L0ProfileView>> {
      return typedInvoke('companion:memory:get-l0', undefined)
    },
    listL2(input: MemoryListRequest): Promise<IpcResult<MemoryListResponse>> {
      return typedInvoke('companion:memory:list-l2', input)
    },
    getDetail(input: MemoryDetailRequest): Promise<IpcResult<L2MemoryDetail>> {
      return typedInvoke('companion:memory:get-detail', input)
    },
    setPinned(input: MemoryPinRequest): Promise<IpcResult<void>> {
      return typedInvoke('companion:memory:set-pinned', input)
    },
    softDelete(input: MemoryDeleteRequest): Promise<IpcResult<void>> {
      return typedInvoke('companion:memory:soft-delete', input)
    },
    restore(input: MemoryRestoreRequest): Promise<IpcResult<void>> {
      return typedInvoke('companion:memory:restore', input)
    },
    // M-44：编辑 L2 记忆内容（走 store action → IPC → main；不乐观更新）
    updateContent(input: MemoryUpdateContentRequest): Promise<IpcResult<void>> {
      return typedInvoke('companion:memory:update-content', input)
    },
    // M-44：设定/清空 L0 画像字段（空串 value = 清空）
    setL0Field(input: MemorySetL0FieldRequest): Promise<IpcResult<void>> {
      return typedInvoke('companion:memory:set-l0-field', input)
    },
    getDmaeSnapshot(): Promise<IpcResult<DmaeSnapshotView>> {
      return typedInvoke('companion:memory:get-dmae-snapshot', undefined)
    },
    getDmaeHistory(input: DmaeHistoryRequest): Promise<IpcResult<DmaeHistoryResponse>> {
      return typedInvoke('companion:memory:get-dmae-history', input)
    },
    onUpdated(cb: (e: MemoryUpdatedEvent) => void): Unsubscribe {
      return typedSubscribe('companion:event:memory-updated', cb)
    }
  },

  // ── Phase 2：growth（3 invoke，S-003-补充 §3.6）──
  // growth 不提供订阅方法：growth store 复用 memory.onUpdated 的 hint==='growth'（S-002-补充 §3.2）
  growth: {
    getProfile(): Promise<IpcResult<GrowthProfileView>> {
      return typedInvoke('companion:growth:get-profile', undefined)
    },
    getTimeline(input: GrowthTimelineRequest): Promise<IpcResult<GrowthTimelineEntryView[]>> {
      return typedInvoke('companion:growth:get-timeline', input)
    },
    getTrend(input: GrowthTrendRequest): Promise<IpcResult<GrowthTrendPoint[]>> {
      return typedInvoke('companion:growth:get-trend', input)
    }
  },

  // ── Phase 2 P2-32：DMAE 面板（3 invoke，F5-002 §3.7）──
  dmae: {
    getPanel(): Promise<IpcResult<DmaePanelSnapshot>> {
      return typedInvoke('companion:dmae:get-panel', undefined)
    },
    getTrend(input: DmaeTrendRequest): Promise<IpcResult<readonly DmaeDailyAggregate[]>> {
      return typedInvoke('companion:dmae:get-trend', input)
    },
    explain(input: DmaeExplainRequest): Promise<IpcResult<DmaeTurnExplanation | null>> {
      return typedInvoke('companion:dmae:explain', input)
    },
    runBenchmark(input: DmaeBenchmarkRequest): Promise<IpcResult<DmaeBenchmarkReport>> {
      return typedInvoke('companion:dmae:run-benchmark', input)
    },
    recordQualitative(input: DmaeQualitativeRequest): Promise<IpcResult<void>> {
      return typedInvoke('companion:dmae:record-qualitative', input)
    },
    // M-26：静音某条 DMAE 异常规则 N 天
    muteAnomaly(input: DmaeMuteRequest): Promise<IpcResult<void>> {
      return typedInvoke('companion:dmae:mute-anomaly', input)
    }
  }
})
