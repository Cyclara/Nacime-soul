// src/shared/global.d.ts
// window.companion 全局类型声明
// 依据：S-002 §3.5、S-003 §3.7

import type { AppInfo, IpcResult, Unsubscribe } from './ipc/contracts'
import type { PublicAppError } from './errors'
import type {
  ChatCancelRequest,
  ChatHistorySnapshot,
  ChatListRequest,
  ChatRenderAckRequest,
  ChatSearchHit,
  ChatSendAck,
  ChatSendRequest,
  ChatStreamEvent
} from './chat/types'
import type {
  ChatFeedbackRequest,
  ChatFeedbackResponse,
  ComplianceSnapshot
} from './compliance/types'
import type {
  ConfigResetRequest,
  ConfigUpdateRequest,
  ConnectionTestResult,
  ModelConnectionTestRequest,
  PublicConfigSnapshot
} from './config/types'
import type { DebugSnapshot } from './observability/types'
import type {
  Live2dPublicSnapshot,
  Live2dImportResult,
  Live2dStateEvent,
  Live2dFramingPreviewRequest
} from './live2d/public-types'
import type { UpdateStatus } from './update/types'
import type {
  DmaeBenchmarkRequest,
  DmaePanelRequest,
  DmaeHistoryRequest,
  DmaeHistoryResponse,
  DmaeQualitativeRequest,
  DmaeMuteRequest,
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
} from './memory/types'
import type {
  AsrOverview,
  AsrEngineRequest,
  AsrSelectEngineRequest,
  AsrSetFallbackEngineRequest
} from './voice/asr-settings-types'
import type {
  AssetDownloadStatus,
  AssetRootChangeResult,
  AssetRootStatus
} from './voice/asset-root-types'
import type {
  GptRuntimeOverview,
  GptRuntimeSourceResult,
  GptRuntimeVariantRequest,
  GptVoiceDeleteRequest,
  GptVoiceDeleteResult,
  GptVoiceFilePickRequest,
  GptVoiceFilePickResult,
  GptVoiceImportRequest,
  GptVoiceImportResult
} from './voice/gpt-runtime-types'
import type { VoiceEvent, VoicePublicSnapshot, VoiceTestTtsRequest } from './voice/voice-events'
import type {
  DmaeBenchmarkReport,
  DmaeDailyAggregate,
  DmaePanelSnapshot,
  DmaeTurnExplanation
} from './memory/dmae-types'

/** preload 暴露的 typed API。依据 S-003 §3.7、S-003-补充 §3.6 */
export interface CompanionApi {
  app: {
    getInfo(): Promise<IpcResult<AppInfo>>
    openUserData(): Promise<IpcResult<void>>
    // M-50：自动更新（checkForUpdates 手动触发；getUpdateStatus 启动补水；quitAndInstall 仅 downloaded 态有效）
    checkForUpdates(): Promise<IpcResult<void>>
    getUpdateStatus(): Promise<IpcResult<UpdateStatus>>
    quitAndInstall(): Promise<IpcResult<void>>
    onUpdateStatus(cb: (status: UpdateStatus) => void): Unsubscribe
    onError(cb: (e: PublicAppError) => void): Unsubscribe
  }
  // M-51：UI 缩放（webFrame 直连，窗口本地；持久化走 config.ui.fontScale）
  ui: {
    getZoomFactor(): number
    setZoomFactor(factor: number): void
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
    deleteTurn(input: {
      sessionId: string
      messageId: string
    }): Promise<IpcResult<{ deletedIds: string[] }>>
    deleteMessage(input: {
      sessionId: string
      messageId: string
    }): Promise<IpcResult<{ deletedIds: string[] }>>
    deleteSelected(input: {
      sessionId: string
      messageIds: string[]
    }): Promise<IpcResult<{ deletedIds: string[] }>>
    clearSession(input: { sessionId: string }): Promise<IpcResult<{ removed: number }>>
    search(input: { query: string; limit?: number }): Promise<IpcResult<ChatSearchHit[]>>
    // P3C1-07：合规用户反馈（F5-001 §3.7）。幂等--重复上报只计一次
    feedback(input: ChatFeedbackRequest): Promise<IpcResult<ChatFeedbackResponse>>
    // P3B-15A：paint ack（F5-007 §1.5）。applyStream 后等一次 rAF 回报最高已绘制
    // sequence；main 侧据此保证 TTS 音频不早于对应文字出现。
    ackRendered(input: ChatRenderAckRequest): Promise<IpcResult<void>>
    onStream(cb: (event: ChatStreamEvent) => void): Unsubscribe
  }
  // P3C1-08：compliance（1 invoke；仅调试面板，无 event 通道——审查不可见原则）
  compliance: {
    getSnapshot(): Promise<IpcResult<ComplianceSnapshot>>
  }
  live2d: {
    getState(): Promise<IpcResult<Live2dPublicSnapshot>>
    chooseImportSource(): Promise<IpcResult<Live2dImportResult>>
    selectModel(input: { modelId: string }): Promise<IpcResult<void>>
    setVisible(input: { visible: boolean }): Promise<IpcResult<void>>
    resetWindowPlacement(): Promise<IpcResult<void>>
    previewFraming(input: Live2dFramingPreviewRequest): Promise<IpcResult<void>>
    retryLoad(): Promise<IpcResult<void>>
    onState(cb: (event: Live2dStateEvent) => void): Unsubscribe
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
    listRecycleBin(input: RecycleBinListRequest): Promise<IpcResult<RecycleBinListResponse>>
    restoreFromRecycleBin(input: RecycleBinRestoreRequest): Promise<IpcResult<void>>
    emptyRecycleBin(input: RecycleBinEmptyRequest): Promise<IpcResult<{ purged: number }>>
    // M-44：编辑 L2 记忆内容 / 设定·清空 L0 画像字段
    updateContent(input: MemoryUpdateContentRequest): Promise<IpcResult<void>>
    setL0Field(input: MemorySetL0FieldRequest): Promise<IpcResult<void>>
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
  // Phase 2 P2-32/P2-34：DMAE 面板（F5-002 §3.7/§3.6）
  dmae: {
    getPanel(input?: DmaePanelRequest): Promise<IpcResult<DmaePanelSnapshot>>
    getTrend(input: DmaeTrendRequest): Promise<IpcResult<readonly DmaeDailyAggregate[]>>
    explain(input: DmaeExplainRequest): Promise<IpcResult<DmaeTurnExplanation | null>>
    runBenchmark(input: DmaeBenchmarkRequest): Promise<IpcResult<DmaeBenchmarkReport>>
    recordQualitative(input: DmaeQualitativeRequest): Promise<IpcResult<void>>
    // M-26：静音某条 DMAE 异常规则 N 天
    muteAnomaly(input: DmaeMuteRequest): Promise<IpcResult<void>>
  }
  // P3B-14：语音设置/语音输入（chat；台账已登记）
  voice: {
    getAsrOverview(): Promise<IpcResult<AsrOverview>>
    downloadAsrModel(input: AsrEngineRequest): Promise<IpcResult<{ ok: true }>>
    cancelAsrDownload(input: AsrEngineRequest): Promise<IpcResult<{ ok: true; cancelled: boolean }>>
    pauseAsrDownload(input: AsrEngineRequest): Promise<IpcResult<{ ok: true; paused: boolean }>>
    resumeAsrDownload(input: AsrEngineRequest): Promise<IpcResult<{ ok: true; resumed: boolean }>>
    deleteAsrModel(input: AsrEngineRequest): Promise<IpcResult<{ ok: true }>>
    selectAsrEngine(input: AsrSelectEngineRequest): Promise<IpcResult<{ ok: true }>>
    // P3V-09/10：备用引擎 + 大资源根目录（响应无路径）
    setAsrFallbackEngine(input: AsrSetFallbackEngineRequest): Promise<IpcResult<{ ok: true }>>
    getAssetRoot(): Promise<IpcResult<AssetRootStatus>>
    chooseAssetRoot(): Promise<IpcResult<AssetRootChangeResult>>
    resetAssetRoot(): Promise<IpcResult<AssetRootChangeResult>>
    // P3V-16：GPT-SoVITS 运行时一键安装（进度经 onAssetDownload）
    getGptRuntime(): Promise<IpcResult<GptRuntimeOverview>>
    installGptRuntime(input: GptRuntimeVariantRequest): Promise<IpcResult<{ ok: true }>>
    pauseGptRuntimeDownload(
      input: GptRuntimeVariantRequest
    ): Promise<IpcResult<{ ok: true; paused: boolean }>>
    resumeGptRuntimeDownload(
      input: GptRuntimeVariantRequest
    ): Promise<IpcResult<{ ok: true; resumed: boolean }>>
    cancelGptRuntimeDownload(
      input: GptRuntimeVariantRequest
    ): Promise<IpcResult<{ ok: true; cancelled: boolean }>>
    deleteGptRuntime(): Promise<IpcResult<{ ok: true }>>
    // P3V-17：选择/清除已有 GPT-SoVITS 目录（重启后生效）
    chooseGptRuntimeDir(): Promise<IpcResult<GptRuntimeSourceResult>>
    clearGptRuntimeDir(): Promise<IpcResult<GptRuntimeSourceResult>>
    // P3V-20：本地导入音色
    pickGptVoiceFile(input: GptVoiceFilePickRequest): Promise<IpcResult<GptVoiceFilePickResult>>
    importGptVoice(input: GptVoiceImportRequest): Promise<IpcResult<GptVoiceImportResult>>
    deleteGptVoice(input: GptVoiceDeleteRequest): Promise<IpcResult<GptVoiceDeleteResult>>
    startListening(): Promise<IpcResult<{ ok: true }>>
    stopListening(): Promise<IpcResult<{ ok: true }>>
    // P3B-18：TTS 编排（VoiceOrchestrator）
    getVoiceState(): Promise<IpcResult<VoicePublicSnapshot>>
    testTts(input: VoiceTestTtsRequest): Promise<IpcResult<void>>
    cancelSpeaking(): Promise<IpcResult<void>>
    onAsrOverview(cb: (overview: AsrOverview) => void): Unsubscribe
    onAssetDownload(cb: (status: AssetDownloadStatus) => void): Unsubscribe
    onVoiceState(cb: (event: VoiceEvent) => void): Unsubscribe
    openMicPort(): void
  }
}

declare global {
  interface Window {
    companion: Readonly<CompanionApi>
  }
}
