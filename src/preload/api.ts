// src/preload/api.ts
// preload API：typed window.companion，invoke/subscribe 白名单，unsubscribe 清理
// 依据：S-001 P1-17、S-003 §3.7、S-002 §3.5
//
// 安全红线：
//   - 不暴露原始 ipcRenderer
//   - 不暴露 invoke(channel: string) 通用通道
//   - 每个 API 方法固定通道，renderer 不可任意 invoke
//   - 事件退订后不再触发

import { ipcRenderer, webFrame, type IpcRendererEvent } from 'electron'
import type { CompanionApi } from '../shared/global'
import type {
  IpcInvokeMap,
  IpcEventMap,
  IpcResult,
  Unsubscribe,
  AppInfo
} from '../shared/ipc/contracts'
import type { IpcInvokeChannel, IpcEventChannel } from '../shared/ipc/channels'
import type { UpdateStatus } from '../shared/update/types'
import type {
  ChatSendRequest,
  ChatCancelRequest,
  ChatListRequest,
  ChatRenderAckRequest,
  ChatStreamEvent,
  ChatHistorySnapshot,
  ChatSearchHit,
  ChatSendAck
} from '../shared/chat/types'
import type {
  ChatFeedbackRequest,
  ChatFeedbackResponse,
  ComplianceSnapshot
} from '../shared/compliance/types'
import type {
  Live2dPublicSnapshot,
  Live2dImportResult,
  Live2dStateEvent,
  Live2dFramingPreviewRequest
} from '../shared/live2d/public-types'
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
  AsrOverview,
  AsrEngineRequest,
  AsrSelectEngineRequest,
  AsrSetFallbackEngineRequest
} from '../shared/voice/asr-settings-types'
import type {
  AssetDownloadStatus,
  AssetRootChangeResult,
  AssetRootStatus
} from '../shared/voice/asset-root-types'
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
} from '../shared/voice/gpt-runtime-types'
import type {
  VoiceEvent,
  VoicePublicSnapshot,
  VoiceTestTtsRequest
} from '../shared/voice/voice-events'
import type {
  DmaeHistoryRequest,
  DmaePanelRequest,
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
  RecycleBinEmptyRequest,
  RecycleBinListRequest,
  RecycleBinListResponse,
  RecycleBinRestoreRequest,
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
    // ── M-50：自动更新 ──
    checkForUpdates(): Promise<IpcResult<void>> {
      return typedInvoke('companion:app:check-for-updates', undefined)
    },
    getUpdateStatus(): Promise<IpcResult<UpdateStatus>> {
      return typedInvoke('companion:app:get-update-status', undefined)
    },
    quitAndInstall(): Promise<IpcResult<void>> {
      return typedInvoke('companion:app:quit-and-install', undefined)
    },
    onUpdateStatus(cb: (status: UpdateStatus) => void): Unsubscribe {
      return typedSubscribe('companion:event:update-status', cb)
    },
    onError(cb: (e: PublicAppError) => void): Unsubscribe {
      return typedSubscribe('companion:event:app-error', cb)
    }
  },

  // ── M-51：UI 缩放。zoom 是窗口本地行为，webFrame 直连不走 IPC 往返；
  // webFrame 在沙箱化 preload 中可用（Electron 官方支持），持久化走 config.ui.fontScale ──
  ui: {
    getZoomFactor(): number {
      return webFrame.getZoomFactor()
    },
    setZoomFactor(factor: number): void {
      webFrame.setZoomFactor(factor)
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
    // P2-44：聊天记录全文搜索（FTS5；scope=全部会话的消息正文，按时间倒序）
    search(input: { query: string; limit?: number }): Promise<IpcResult<ChatSearchHit[]>> {
      return typedInvoke(
        'companion:chat:search',
        input as unknown as IpcInvokeMap['companion:chat:search']['req']
      )
    },
    // P3C1-07：合规用户反馈（F5-001 §3.7）。幂等--重复上报只计一次；
    // service 侧静默忽略无效关联，renderer 无需关心差异
    feedback(input: ChatFeedbackRequest): Promise<IpcResult<ChatFeedbackResponse>> {
      return typedInvoke(
        'companion:chat:feedback',
        input as unknown as IpcInvokeMap['companion:chat:feedback']['req']
      )
    },
    // ── P3B-15A：paint ack（F5-007 §1.5）。applyStream 应用后等一次 rAF 回报最高
    // 已绘制 sequence；main 侧由此保证「声音绝不跑在对应文字前面」──
    ackRendered(input: ChatRenderAckRequest): Promise<IpcResult<void>> {
      return typedInvoke('companion:chat:ack-rendered', input)
    },
    onStream(cb: (event: ChatStreamEvent) => void): Unsubscribe {
      return typedSubscribe('companion:event:chat-stream', cb)
    }
  },

  // ── P3C1-08：compliance（1 invoke，F5-001 §3.10；仅调试面板，无 event 通道）──
  compliance: {
    getSnapshot(): Promise<IpcResult<ComplianceSnapshot>> {
      return typedInvoke('companion:compliance:get-snapshot', undefined)
    }
  },

  live2d: {
    getState(): Promise<IpcResult<Live2dPublicSnapshot>> {
      return typedInvoke('companion:live2d:get-state', undefined)
    },
    chooseImportSource(): Promise<IpcResult<Live2dImportResult>> {
      return typedInvoke('companion:live2d:choose-import-source', undefined)
    },
    selectModel(input: { modelId: string }): Promise<IpcResult<void>> {
      return typedInvoke('companion:live2d:select-model', input)
    },
    setVisible(input: { visible: boolean }): Promise<IpcResult<void>> {
      return typedInvoke('companion:live2d:set-visible', input)
    },
    resetWindowPlacement(): Promise<IpcResult<void>> {
      return typedInvoke('companion:live2d:reset-window-placement', undefined)
    },
    previewFraming(input: Live2dFramingPreviewRequest): Promise<IpcResult<void>> {
      return typedInvoke('companion:live2d:preview-framing', input)
    },
    retryLoad(): Promise<IpcResult<void>> {
      return typedInvoke('companion:live2d:retry-load', undefined)
    },
    onState(callback: (event: Live2dStateEvent) => void): Unsubscribe {
      return typedSubscribe('companion:event:live2d-state', callback)
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
    listRecycleBin(input: RecycleBinListRequest): Promise<IpcResult<RecycleBinListResponse>> {
      return typedInvoke('companion:memory:list-recycle-bin', input)
    },
    restoreFromRecycleBin(input: RecycleBinRestoreRequest): Promise<IpcResult<void>> {
      return typedInvoke('companion:memory:restore-from-recycle-bin', input)
    },
    emptyRecycleBin(input: RecycleBinEmptyRequest): Promise<IpcResult<{ purged: number }>> {
      return typedInvoke('companion:memory:empty-recycle-bin', input)
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
    getPanel(input?: DmaePanelRequest): Promise<IpcResult<DmaePanelSnapshot>> {
      return typedInvoke('companion:dmae:get-panel', input)
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
  },

  // ── P3B-14：语音设置/语音输入（chat；台账已登记）──
  voice: {
    getAsrOverview(): Promise<IpcResult<AsrOverview>> {
      return typedInvoke('companion:voice:get-asr-overview', undefined)
    },
    downloadAsrModel(input: AsrEngineRequest): Promise<IpcResult<{ ok: true }>> {
      return typedInvoke('companion:voice:asr-download-model', input)
    },
    cancelAsrDownload(
      input: AsrEngineRequest
    ): Promise<IpcResult<{ ok: true; cancelled: boolean }>> {
      return typedInvoke('companion:voice:asr-cancel-download', input)
    },
    pauseAsrDownload(input: AsrEngineRequest): Promise<IpcResult<{ ok: true; paused: boolean }>> {
      return typedInvoke('companion:voice:asr-pause-download', input)
    },
    resumeAsrDownload(input: AsrEngineRequest): Promise<IpcResult<{ ok: true; resumed: boolean }>> {
      return typedInvoke('companion:voice:asr-resume-download', input)
    },
    deleteAsrModel(input: AsrEngineRequest): Promise<IpcResult<{ ok: true }>> {
      return typedInvoke('companion:voice:asr-delete-model', input)
    },
    selectAsrEngine(input: AsrSelectEngineRequest): Promise<IpcResult<{ ok: true }>> {
      return typedInvoke('companion:voice:asr-select-engine', input)
    },
    // P3V-09：备用引擎（engineId=null 清除）
    setAsrFallbackEngine(input: AsrSetFallbackEngineRequest): Promise<IpcResult<{ ok: true }>> {
      return typedInvoke('companion:voice:asr-set-fallback-engine', input)
    },
    // P3V-10：大资源根目录（响应无路径）
    getAssetRoot(): Promise<IpcResult<AssetRootStatus>> {
      return typedInvoke('companion:voice:get-asset-root', undefined)
    },
    chooseAssetRoot(): Promise<IpcResult<AssetRootChangeResult>> {
      return typedInvoke('companion:voice:choose-asset-root', undefined)
    },
    resetAssetRoot(): Promise<IpcResult<AssetRootChangeResult>> {
      return typedInvoke('companion:voice:reset-asset-root', undefined)
    },
    // P3V-16：GPT-SoVITS 运行时一键安装（install 即发即回；进度走 onAssetDownload）
    getGptRuntime(): Promise<IpcResult<GptRuntimeOverview>> {
      return typedInvoke('companion:voice:get-gpt-runtime', undefined)
    },
    installGptRuntime(input: GptRuntimeVariantRequest): Promise<IpcResult<{ ok: true }>> {
      return typedInvoke('companion:voice:gpt-runtime-install', input)
    },
    pauseGptRuntimeDownload(
      input: GptRuntimeVariantRequest
    ): Promise<IpcResult<{ ok: true; paused: boolean }>> {
      return typedInvoke('companion:voice:gpt-runtime-pause-download', input)
    },
    resumeGptRuntimeDownload(
      input: GptRuntimeVariantRequest
    ): Promise<IpcResult<{ ok: true; resumed: boolean }>> {
      return typedInvoke('companion:voice:gpt-runtime-resume-download', input)
    },
    cancelGptRuntimeDownload(
      input: GptRuntimeVariantRequest
    ): Promise<IpcResult<{ ok: true; cancelled: boolean }>> {
      return typedInvoke('companion:voice:gpt-runtime-cancel-download', input)
    },
    deleteGptRuntime(): Promise<IpcResult<{ ok: true }>> {
      return typedInvoke('companion:voice:gpt-runtime-delete', undefined)
    },
    // P3V-17：选择/清除已有 GPT-SoVITS 目录（路径不入参也不回传）
    chooseGptRuntimeDir(): Promise<IpcResult<GptRuntimeSourceResult>> {
      return typedInvoke('companion:voice:choose-gpt-runtime-dir', undefined)
    },
    clearGptRuntimeDir(): Promise<IpcResult<GptRuntimeSourceResult>> {
      return typedInvoke('companion:voice:clear-gpt-runtime-dir', undefined)
    },
    // P3V-20：本地导入音色（挑文件只回文件名；元信息由用户逐项确认）
    pickGptVoiceFile(input: GptVoiceFilePickRequest): Promise<IpcResult<GptVoiceFilePickResult>> {
      return typedInvoke('companion:voice:pick-gpt-voice-file', input)
    },
    importGptVoice(input: GptVoiceImportRequest): Promise<IpcResult<GptVoiceImportResult>> {
      return typedInvoke('companion:voice:import-gpt-voice', input)
    },
    deleteGptVoice(input: GptVoiceDeleteRequest): Promise<IpcResult<GptVoiceDeleteResult>> {
      return typedInvoke('companion:voice:delete-gpt-voice', input)
    },
    startListening(): Promise<IpcResult<{ ok: true }>> {
      return typedInvoke('companion:voice:start-listening', undefined)
    },
    stopListening(): Promise<IpcResult<{ ok: true }>> {
      return typedInvoke('companion:voice:stop-listening', undefined)
    },
    // P3B-18：TTS 编排（VoiceOrchestrator）
    getVoiceState(): Promise<IpcResult<VoicePublicSnapshot>> {
      return typedInvoke('companion:voice:get-state', undefined)
    },
    testTts(input: VoiceTestTtsRequest): Promise<IpcResult<void>> {
      return typedInvoke('companion:voice:test-tts', input)
    },
    cancelSpeaking(): Promise<IpcResult<void>> {
      return typedInvoke('companion:voice:cancel-speaking', undefined)
    },
    onAsrOverview(cb: (overview: AsrOverview) => void): Unsubscribe {
      return typedSubscribe('companion:event:asr-model-state', cb)
    },
    // P3V-16：大资产下载进度（assetId 分流；GPT runtime 与后续音色包共用）
    onAssetDownload(cb: (status: AssetDownloadStatus) => void): Unsubscribe {
      return typedSubscribe('companion:event:asset-download', cb)
    },
    onVoiceState(cb: (event: VoiceEvent) => void): Unsubscribe {
      return typedSubscribe('companion:event:voice-state', cb)
    },
    /**
     * P3B-13：开启麦克风 PCM 数据面——preload 建 MessageChannel，port2 经
     * `voice:mic-port`（ipcRenderer.postMessage）转交 main，port1 经
     * `window.postMessage('voice:mic-port', ...)` 转交给页面（contextBridge
     * 不直接传 port；页面在 window 'message' 上收）。port 生命周期 = 采集
     * 会话生命周期（session.stop() 关闭 → main 收 close 收尾）。
     */
    openMicPort(): void {
      const channel = new MessageChannel()
      ipcRenderer.postMessage('voice:mic-port', null, [channel.port2])
      window.postMessage('voice:mic-port', '*', [channel.port1])
    }
  }
})
