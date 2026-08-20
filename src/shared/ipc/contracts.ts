// src/shared/ipc/contracts.ts
// IPC 统一类型：IpcResult、Contract Map、Validator、AppInfo
// 依据：S-003 §3.1、§3.4

import type { IpcError, PublicAppError } from '../errors'
import type { IpcEventChannel, IpcInvokeChannel } from './channels'
import type {
  ConfigResetRequest,
  ConfigUpdateRequest,
  ConnectionTestResult,
  ModelConnectionTestRequest,
  PublicConfigSnapshot
} from '../config/types'
import type {
  ChatCancelRequest,
  ChatHistorySnapshot,
  ChatListRequest,
  ChatRetryRequest,
  ChatSendAck,
  ChatSendRequest,
  ChatStreamEvent
} from '../chat/types'
import type { DebugSnapshot } from '../observability/types'
import type {
  DmaeBenchmarkReport,
  DmaeDailyAggregate,
  DmaePanelSnapshot,
  DmaeTurnExplanation
} from '../memory/dmae-types'
import type {
  DmaeBenchmarkRequest,
  DmaeHistoryRequest,
  DmaeHistoryResponse,
  DmaeMuteRequest,
  DmaeQualitativeRequest,
  DmaeSnapshotView,
  DmaeTrendRequest,
  DmaeExplainRequest,
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
} from '../memory/types'

// === 统一结果信封 ===

export type Unsubscribe = () => void

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError }

// === App info ===

export interface AppInfo {
  version: string
  platform: string
  arch: string
}

// === Contract Map。依据 S-003 §3.4 ===

export interface IpcInvokeMap {
  'companion:app:get-info': { req: undefined; res: AppInfo }
  'companion:app:open-user-data': { req: undefined; res: void }
  'companion:window:minimize': { req: undefined; res: void }
  'companion:window:toggle-maximize': { req: undefined; res: { maximized: boolean } }
  'companion:window:close': { req: undefined; res: void }
  'companion:window:get-state': { req: undefined; res: { maximized: boolean } }
  'companion:config:get': { req: undefined; res: PublicConfigSnapshot }
  'companion:config:update': { req: ConfigUpdateRequest; res: PublicConfigSnapshot }
  'companion:config:test-model': { req: ModelConnectionTestRequest; res: ConnectionTestResult }
  'companion:config:reset-domain': { req: ConfigResetRequest; res: PublicConfigSnapshot }
  'companion:chat:list': { req: ChatListRequest; res: ChatHistorySnapshot }
  'companion:chat:create-session': { req: undefined; res: { sessionId: string } }
  'companion:chat:get-last-session': { req: undefined; res: { sessionId: string | null } }
  'companion:chat:send': { req: ChatSendRequest; res: ChatSendAck }
  'companion:chat:cancel': { req: ChatCancelRequest; res: void }
  'companion:chat:retry': { req: ChatRetryRequest; res: { requestId: string } }
  'companion:debug:get-snapshot': { req: undefined; res: DebugSnapshot }
  'companion:debug:open-log-folder': { req: undefined; res: void }
  // ── Phase 2：memory（9 invoke，S-003-补充 §3.1）──
  'companion:memory:get-overview': { req: undefined; res: MemoryOverview }
  'companion:memory:get-l0': { req: undefined; res: L0ProfileView }
  'companion:memory:list-l2': { req: MemoryListRequest; res: MemoryListResponse }
  'companion:memory:get-detail': { req: MemoryDetailRequest; res: L2MemoryDetail }
  'companion:memory:set-pinned': { req: MemoryPinRequest; res: void }
  'companion:memory:soft-delete': { req: MemoryDeleteRequest; res: void }
  'companion:memory:restore': { req: MemoryRestoreRequest; res: void }
  'companion:memory:get-dmae-snapshot': { req: undefined; res: DmaeSnapshotView }
  'companion:memory:get-dmae-history': { req: DmaeHistoryRequest; res: DmaeHistoryResponse }
  // ── Phase 2：growth（3 invoke，S-003-补充 §3.1）──
  'companion:growth:get-profile': { req: undefined; res: GrowthProfileView }
  'companion:growth:get-timeline': { req: GrowthTimelineRequest; res: GrowthTimelineEntryView[] }
  'companion:growth:get-trend': { req: GrowthTrendRequest; res: GrowthTrendPoint[] }
  // ── Phase 2 P2-32：DMAE 面板（F5-002 §3.7）──
  'companion:dmae:get-panel': { req: undefined; res: DmaePanelSnapshot }
  'companion:dmae:get-trend': { req: DmaeTrendRequest; res: readonly DmaeDailyAggregate[] }
  'companion:dmae:explain': { req: DmaeExplainRequest; res: DmaeTurnExplanation | null }
  // ── Phase 2 P2-34：DMAE 基准体检（F5-002 §3.6）──
  'companion:dmae:run-benchmark': { req: DmaeBenchmarkRequest; res: DmaeBenchmarkReport }
  'companion:dmae:record-qualitative': { req: DmaeQualitativeRequest; res: void }
  // ── M-26：DMAE 异常静音（F5-002 §3.7 第 6 通道）──
  'companion:dmae:mute-anomaly': { req: DmaeMuteRequest; res: void }
}

export interface IpcEventMap {
  'companion:event:chat-stream': ChatStreamEvent
  'companion:event:app-error': PublicAppError
  'companion:event:window-state': { maximized: boolean }
  // ── Phase 2：记忆/成长跨进程同步（S-003-补充 §3.2）──
  'companion:event:memory-updated': MemoryUpdatedEvent
}

// re-export 通道类型，供外部使用
export type { IpcEventChannel, IpcInvokeChannel }

// === Validator ===

export type Validator<T> = (value: unknown) => value is T
