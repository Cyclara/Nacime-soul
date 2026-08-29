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
  ChatDeleteTurnRequest,
  ChatDeleteMessageRequest,
  ChatDeleteSelectedRequest,
  ChatClearSessionRequest,
  ChatHistorySnapshot,
  ChatListRequest,
  ChatRetryRequest,
  ChatSearchHit,
  ChatSearchRequest,
  ChatSendAck,
  ChatSendRequest,
  ChatStreamEvent
} from '../chat/types'
import type { DebugSnapshot } from '../observability/types'
import type { UpdateStatus } from '../update/types'
import type {
  ChatFeedbackRequest,
  ChatFeedbackResponse,
  ComplianceSnapshot
} from '../compliance/types'
import type {
  Live2dStageBootstrap,
  Live2dStageReadyRequest,
  Live2dStageReport,
  Live2dStageCommand
} from '../live2d/stage-types'
import type {
  Live2dPublicSnapshot,
  Live2dImportResult,
  Live2dStateEvent,
  Live2dFramingPreviewRequest
} from '../live2d/public-types'
import type {
  DmaeBenchmarkReport,
  DmaeDailyAggregate,
  DmaePanelSnapshot,
  DmaeTurnExplanation
} from '../memory/dmae-types'
import type {
  DmaeBenchmarkRequest,
  DmaePanelRequest,
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
  RecycleBinEmptyRequest,
  RecycleBinListRequest,
  RecycleBinListResponse,
  RecycleBinRestoreRequest,
  MemorySetL0FieldRequest,
  MemoryUpdateContentRequest,
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
  'companion:chat:delete-turn': { req: ChatDeleteTurnRequest; res: { deletedIds: string[] } }
  'companion:chat:delete-message': {
    req: ChatDeleteMessageRequest
    res: { deletedIds: string[] }
  }
  'companion:chat:delete-selected': {
    req: ChatDeleteSelectedRequest
    res: { deletedIds: string[] }
  }
  'companion:chat:clear-session': { req: ChatClearSessionRequest; res: { removed: number } }
  // P2-44：聊天记录全文搜索（FTS5；scope=全部会话的消息正文）
  'companion:chat:search': { req: ChatSearchRequest; res: ChatSearchHit[] }
  // P3C1-07：合规用户反馈（F5-001 §3.7；UNIQUE(message_id,kind) 幂等，只作复核优先级）
  'companion:chat:feedback': { req: ChatFeedbackRequest; res: ChatFeedbackResponse }
  // P3C1-08：合规调试快照（F5-001 §3.10；仅调试面板，聚合量无正文；无 event 通道）
  'companion:compliance:get-snapshot': { req: undefined; res: ComplianceSnapshot }
  // P3A-05：仅 stage preload 可见；capability guard 会拒绝 chat sender。
  'companion:stage:ready': { req: Live2dStageReadyRequest; res: Live2dStageBootstrap }
  'companion:stage:report-state': { req: Live2dStageReport; res: void }
  // P3A-23：chat renderer Live2D 管理面；所有文件选择由 main dialog 完成。
  'companion:live2d:get-state': { req: undefined; res: Live2dPublicSnapshot }
  'companion:live2d:choose-import-source': { req: undefined; res: Live2dImportResult }
  'companion:live2d:select-model': { req: { modelId: string }; res: void }
  'companion:live2d:set-visible': { req: { visible: boolean }; res: void }
  'companion:live2d:reset-window-placement': { req: undefined; res: void }
  /** framing=null 结束预览，main 把 stage 归位到已保存的 config 构图。 */
  'companion:live2d:preview-framing': { req: Live2dFramingPreviewRequest; res: void }
  'companion:live2d:retry-load': { req: undefined; res: void }
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
  'companion:memory:list-recycle-bin': { req: RecycleBinListRequest; res: RecycleBinListResponse }
  'companion:memory:restore-from-recycle-bin': { req: RecycleBinRestoreRequest; res: void }
  'companion:memory:empty-recycle-bin': { req: RecycleBinEmptyRequest; res: { purged: number } }
  // ── M-44：记忆编辑（L2 内容 + L0 字段）──
  'companion:memory:update-content': { req: MemoryUpdateContentRequest; res: void }
  'companion:memory:set-l0-field': { req: MemorySetL0FieldRequest; res: void }
  'companion:memory:get-dmae-snapshot': { req: undefined; res: DmaeSnapshotView }
  'companion:memory:get-dmae-history': { req: DmaeHistoryRequest; res: DmaeHistoryResponse }
  // ── Phase 2：growth（3 invoke，S-003-补充 §3.1）──
  'companion:growth:get-profile': { req: undefined; res: GrowthProfileView }
  'companion:growth:get-timeline': { req: GrowthTimelineRequest; res: GrowthTimelineEntryView[] }
  'companion:growth:get-trend': { req: GrowthTrendRequest; res: GrowthTrendPoint[] }
  // ── Phase 2 P2-32：DMAE 面板（F5-002 §3.7）──
  'companion:dmae:get-panel': { req: DmaePanelRequest | undefined; res: DmaePanelSnapshot }
  'companion:dmae:get-trend': { req: DmaeTrendRequest; res: readonly DmaeDailyAggregate[] }
  'companion:dmae:explain': { req: DmaeExplainRequest; res: DmaeTurnExplanation | null }
  // ── Phase 2 P2-34：DMAE 基准体检（F5-002 §3.6）──
  'companion:dmae:run-benchmark': { req: DmaeBenchmarkRequest; res: DmaeBenchmarkReport }
  'companion:dmae:record-qualitative': { req: DmaeQualitativeRequest; res: void }
  // ── M-26：DMAE 异常静音（F5-002 §3.7 第 6 通道）──
  'companion:dmae:mute-anomaly': { req: DmaeMuteRequest; res: void }
  // ── M-50：自动更新（2026-08-24 用户需求）──
  'companion:app:check-for-updates': { req: undefined; res: void }
  'companion:app:get-update-status': { req: undefined; res: UpdateStatus }
  'companion:app:quit-and-install': { req: undefined; res: void }
}

export interface IpcEventMap {
  'companion:event:chat-stream': ChatStreamEvent
  'companion:event:app-error': PublicAppError
  'companion:event:window-state': { maximized: boolean }
  // ── Phase 2：记忆/成长跨进程同步（S-003-补充 §3.2）──
  'companion:event:memory-updated': MemoryUpdatedEvent
  // ── M-50：更新状态推送 ──
  'companion:event:update-status': UpdateStatus
  // ── P3A-05/06：main → Live2D stage 独占命令 ──
  'companion:event:stage-command': Live2dStageCommand
  'companion:event:live2d-state': Live2dStateEvent
}

// re-export 通道类型，供外部使用
export type { IpcEventChannel, IpcInvokeChannel }

// === Validator ===

export type Validator<T> = (value: unknown) => value is T
