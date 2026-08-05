// src/shared/global.d.ts
// window.companion 全局类型声明
// 依据：S-002 §3.5、S-003 §3.7

import type { AppInfo, IpcResult, Unsubscribe } from './ipc/contracts'
import type { PublicAppError } from './errors'
import type {
  ChatCancelRequest,
  ChatHistorySnapshot,
  ChatListRequest,
  ChatSendAck,
  ChatSendRequest,
  ChatStreamEvent
} from './chat/types'
import type {
  ConfigResetRequest,
  ConfigUpdateRequest,
  ConnectionTestResult,
  ModelConnectionTestRequest,
  PublicConfigSnapshot
} from './config/types'
import type { DebugSnapshot } from './observability/types'
import type {
  DmaeHistoryRequest,
  DmaeHistoryResponse,
  DmaeSnapshotView,
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
  MemoryUpdatedEvent
} from './memory/types'

/** preload 暴露的 typed API。依据 S-003 §3.7、S-003-补充 §3.6 */
export interface CompanionApi {
  app: {
    getInfo(): Promise<IpcResult<AppInfo>>
    openUserData(): Promise<IpcResult<void>>
    onError(cb: (e: PublicAppError) => void): Unsubscribe
  }
  window: {
    minimize(): Promise<IpcResult<void>>
    toggleMaximize(): Promise<IpcResult<{ maximized: boolean }>>
    close(): Promise<IpcResult<void>>
    getState(): Promise<IpcResult<{ maximized: boolean }>>
    onState(cb: (state: { maximized: boolean }) => void): Unsubscribe
  }
  config: {
    get(): Promise<IpcResult<PublicConfigSnapshot>>
    update(patch: ConfigUpdateRequest): Promise<IpcResult<PublicConfigSnapshot>>
    testModel(input: ModelConnectionTestRequest): Promise<IpcResult<ConnectionTestResult>>
    resetDomain(input: ConfigResetRequest): Promise<IpcResult<PublicConfigSnapshot>>
  }
  chat: {
    list(input: ChatListRequest): Promise<IpcResult<ChatHistorySnapshot>>
    createSession(): Promise<IpcResult<{ sessionId: string }>>
    getLastSession(): Promise<IpcResult<{ sessionId: string | null }>>
    send(input: ChatSendRequest): Promise<IpcResult<ChatSendAck>>
    cancel(input: ChatCancelRequest): Promise<IpcResult<void>>
    retry(input: {
      sessionId: string
      messageId: string
    }): Promise<IpcResult<{ requestId: string }>>
    onStream(cb: (event: ChatStreamEvent) => void): Unsubscribe
  }
  debug: {
    getSnapshot(): Promise<IpcResult<DebugSnapshot>>
    openLogFolder(): Promise<IpcResult<void>>
  }
  // Phase 2：memory（9 invoke + onUpdated）。依据 S-003-补充 §3.6
  memory: {
    getOverview(): Promise<IpcResult<MemoryOverview>>
    getL0(): Promise<IpcResult<L0ProfileView>>
    listL2(input: MemoryListRequest): Promise<IpcResult<MemoryListResponse>>
    getDetail(input: MemoryDetailRequest): Promise<IpcResult<L2MemoryDetail>>
    setPinned(input: MemoryPinRequest): Promise<IpcResult<void>>
    softDelete(input: MemoryDeleteRequest): Promise<IpcResult<void>>
    restore(input: MemoryRestoreRequest): Promise<IpcResult<void>>
    getDmaeSnapshot(): Promise<IpcResult<DmaeSnapshotView>>
    getDmaeHistory(input: DmaeHistoryRequest): Promise<IpcResult<DmaeHistoryResponse>>
    onUpdated(cb: (e: MemoryUpdatedEvent) => void): Unsubscribe
  }
  // Phase 2：growth（3 invoke；无独立订阅，复用 memory.onUpdated hint==='growth'）
  growth: {
    getProfile(): Promise<IpcResult<GrowthProfileView>>
    getTimeline(input: GrowthTimelineRequest): Promise<IpcResult<GrowthTimelineEntryView[]>>
    getTrend(input: GrowthTrendRequest): Promise<IpcResult<GrowthTrendPoint[]>>
  }
}

declare global {
  interface Window {
    companion: Readonly<CompanionApi>
  }
}
