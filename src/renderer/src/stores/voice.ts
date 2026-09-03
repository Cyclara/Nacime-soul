// src/renderer/src/stores/voice.ts
// P3B-14：语音设置/测试录音 store（S-006-补充 §1.4 voice store 的设置侧子集；
// P3B-18 orchestrator 再扩 speaking/early-playback 等 TTS 侧状态——additive）。
//
// 职责：ASR 引擎 overview 投影、模型下载进度、测试录音状态、麦克风权限/设备/
// 电平。**不持浏览器/原生对象**（AudioContext/MediaStream/port/文件句柄）；
// 采集会话由 orchestrator 持有，store 只收事件与状态。
//
// 纪律：
//   - store 只调 window.companion.voice（typed preload），组件不拼 IPC；
//   - 事件用 eventSequence 单调递增，逆序/重复丢弃；
//   - 语音永远本地（localOnly 由共享类型冻结）；UI 不出现云识别选项。

import { defineStore } from 'pinia'
import { computed, reactive } from 'vue'
import type { AsrEngineId, AsrOverview } from '@shared/voice/asr-settings-types'
import type {
  AssetDownloadStatus,
  AssetRootChangeResult,
  AssetRootStatus
} from '@shared/voice/asset-root-types'
import type {
  GptRuntimeOverview,
  GptRuntimeSourceResult,
  GptRuntimeVariantId,
  GptVoiceFileKind,
  GptVoiceImportRequest
} from '@shared/voice/gpt-runtime-types'
import type { VoiceEvent, VoicePublicSnapshot } from '@shared/voice/voice-events'

export type MicPermissionState = 'unknown' | 'granted' | 'denied' | 'device-lost'

export interface MicDeviceInfo {
  readonly id: string
  readonly label: string
}

interface VoiceStoreState {
  asrOverview: AsrOverview | null
  overviewError: string | null
  listening: boolean
  vadActive: boolean
  /** P3B-18：stage 已确认在播（speaking-started → speaking-ended）。 */
  speaking: boolean
  speakingRequestId: string | null
  /** P3B-18：`voice:get-state` 投影（TTS 开关/provider/音色/宿主/最近降级原因）。 */
  tts: VoicePublicSnapshot | null
  /** 试听中（test-tts 已发出，等 speaking-ended）。 */
  testingTts: boolean
  ttsError: string | null
  micPermission: MicPermissionState
  micDevices: MicDeviceInfo[]
  inputDeviceId: string | null
  micLevel: number
  /** 流式 ASR 半成品：只供灰色预览，不触发 voice-chat 发送。 */
  partialTranscript: string
  lastTranscript: string
  testError: { code: string; message: string } | null
  /** P3V-10：大资源根目录状态（无路径——只有默认/自定义 + 空间数字 + 三态）。 */
  assetRoot: AssetRootStatus | null
  /** 换根提示（「重启后生效」等一句人话；null=无待处理提示）。 */
  assetRootNotice: string | null
  /** 当前 renderer 会话中是否仍有待重启生效的换根操作。 */
  assetRootRestartRequired: boolean
  /** P3V-15：同一 renderer 会话内的顺序下载队列（当前项在索引 0）。 */
  asrDownloadQueue: AsrEngineId[]
  /** 队列停在失败项时的人话错误；重试/新队列时清除。 */
  asrQueueError: string | null
  /** P3V-16/17/18：GPT-SoVITS 运行时与音色投影（无路径）。 */
  gptRuntime: GptRuntimeOverview | null
  /** GPT 运行时相关的人话提示/错误（安装被拒、目录不对等）；null=无。 */
  gptRuntimeNotice: string | null
  /** P3V-20：导入音色时已选文件的**文件名**（路径在 main）；null=还没选。 */
  gptVoiceStagedFiles: Record<GptVoiceFileKind, string | null>
}

export const useVoiceStore = defineStore('voice', () => {
  let queueDispatchedId: AsrEngineId | null = null
  let queueCancelPendingId: AsrEngineId | null = null
  let subscriptionUsers = 0
  let sharedSubscription: (() => void) | null = null

  const state = reactive<VoiceStoreState>({
    asrOverview: null,
    overviewError: null,
    listening: false,
    vadActive: false,
    speaking: false,
    speakingRequestId: null,
    tts: null,
    testingTts: false,
    ttsError: null,
    micPermission: 'unknown',
    micDevices: [],
    inputDeviceId: null,
    micLevel: 0,
    partialTranscript: '',
    lastTranscript: '',
    testError: null,
    assetRoot: null,
    assetRootNotice: null,
    assetRootRestartRequired: false,
    asrDownloadQueue: [],
    asrQueueError: null,
    gptRuntime: null,
    gptRuntimeNotice: null,
    gptVoiceStagedFiles: { 'gpt-weights': null, 'sovits-weights': null, 'ref-audio': null }
  })

  const engineList = computed(() => state.asrOverview?.engines ?? [])
  const selectedEngineId = computed(() => state.asrOverview?.selectedEngineId ?? null)
  /** P3V-09：当前备用引擎（null = 未设备用）。 */
  const fallbackEngineId = computed(() => state.asrOverview?.fallbackEngineId ?? null)
  const canListen = computed(
    () => state.asrOverview?.engines.some((e) => e.selected && e.modelState === 'ready') ?? false
  )

  function applyEvent(event: VoiceEvent): void {
    switch (event.type) {
      case 'listening-started':
        state.listening = true
        state.partialTranscript = ''
        state.testError = null
        break
      case 'listening-stopped':
        state.listening = false
        state.vadActive = false
        state.micLevel = 0
        state.partialTranscript = ''
        if (event.reason === 'error') {
          state.testError = { code: event.errorCode ?? 'UNKNOWN', message: '语音会话异常结束' }
        }
        break
      case 'vad-state':
        state.vadActive = event.state === 'active'
        break
      case 'transcript':
        state.partialTranscript = ''
        state.lastTranscript = event.text
        break
      case 'transcript-partial':
        state.partialTranscript = event.text
        break
      case 'asr-error':
        state.testError = { code: event.code, message: '语音识别失败，请重试' }
        break
      // ── P3B-18：TTS 侧 speaking 状态（additive）──
      case 'speaking-started':
        state.speaking = true
        state.speakingRequestId = event.requestId
        break
      case 'speaking-ended':
        state.speaking = false
        state.speakingRequestId = null
        if (event.requestId.startsWith('tts-test-')) {
          state.testingTts = false
          if (event.reason === 'degraded') {
            state.ttsError = '这次没能发出声音，已按纯文字处理'
          }
        }
        break
    }
  }

  /** `voice:get-state` 快照（TTS 侧）；设置页与 Composer 都靠它显示 provider/音色状态。 */
  async function hydrateTts(): Promise<void> {
    const result = await window.companion.voice.getVoiceState()
    if (result.ok) {
      state.tts = result.data
      state.ttsError = null
    } else {
      state.ttsError = result.error?.message ?? '无法读取语音朗读状态'
    }
  }

  /**
   * 试听当前音色（S-006-补充 §1.2.1 VoiceTestPanel「测试文本→发声」）。
   * 即发即回；结束由 speaking-ended(requestId=tts-test-*) 事件收口。
   */
  async function testTts(text: string): Promise<boolean> {
    const trimmed = text.trim()
    if (trimmed.length === 0) return false
    state.ttsError = null
    state.testingTts = true
    const result = await window.companion.voice.testTts({ text: trimmed })
    if (!result.ok) {
      state.testingTts = false
      state.ttsError = result.error?.message ?? '试听失败'
      return false
    }
    return true
  }

  function applyOverview(overview: AsrOverview): void {
    state.asrOverview = overview
    state.overviewError = null
    advanceDownloadQueue(overview)
  }

  /**
   * 下载完成事件推进下一项；失败停住给用户重试，绝不静默跳过。
   * `void downloadModel` 仅发起 main 长任务，真实完成仍以 overview event 为准。
   */
  function advanceDownloadQueue(overview: AsrOverview): void {
    while (state.asrDownloadQueue.length > 0) {
      const currentId = state.asrDownloadQueue[0]
      if (overview.vadModel.state === 'error') {
        queueDispatchedId = null
        state.asrQueueError = 'Silero VAD（说话检测）下载失败，请重试后继续队列'
        return
      }
      const current = overview.engines.find((engine) => engine.engineId === currentId)
      if (current === undefined) {
        state.asrDownloadQueue.shift()
        queueDispatchedId = null
        continue
      }
      if (queueCancelPendingId === currentId) {
        // cancel invoke 只表示 AbortController 已触发；等 main 的非-downloading overview 才能安全推进。
        if (current.modelState === 'downloading') return
        queueCancelPendingId = null
        queueDispatchedId = null
        state.asrDownloadQueue.shift()
        continue
      }
      if (current.modelState === 'ready') {
        state.asrDownloadQueue.shift()
        queueDispatchedId = null
        continue
      }
      if (current.modelState === 'error') {
        queueDispatchedId = null
        state.asrQueueError = `${current.label} 下载失败，请重试后继续队列`
        return
      }
      if (current.modelState === 'downloading') {
        queueDispatchedId = currentId
        return
      }
      if (queueDispatchedId === currentId) return
      queueDispatchedId = currentId
      void downloadModel(currentId)
      return
    }
    queueDispatchedId = null
    queueCancelPendingId = null
    state.asrQueueError = null
  }

  function queueModelDownloads(engineIds: readonly AsrEngineId[]): void {
    const unique = [...new Set(engineIds)]
    const current = state.asrDownloadQueue[0]
    const pending = unique.filter(
      (engineId) =>
        state.asrOverview?.engines.find((engine) => engine.engineId === engineId)?.modelState !==
        'ready'
    )
    // 重应用预设时不抛掉仍在 main 下载的当前项；否则下载中心会失去所有权。
    state.asrDownloadQueue =
      current !== undefined &&
      state.asrOverview?.engines.find((engine) => engine.engineId === current)?.modelState ===
        'downloading'
        ? [current, ...pending.filter((engineId) => engineId !== current)]
        : pending
    if (state.asrDownloadQueue[0] !== current) {
      queueDispatchedId = null
      queueCancelPendingId = null
    }
    state.asrQueueError = null
    if (state.asrOverview !== null) advanceDownloadQueue(state.asrOverview)
  }

  function enqueueModelDownload(engineId: AsrEngineId): void {
    queueModelDownloads([...state.asrDownloadQueue, engineId])
  }

  function retryDownloadQueue(): void {
    const currentId = state.asrDownloadQueue[0]
    if (currentId === undefined) return
    state.asrQueueError = null
    queueDispatchedId = currentId
    // 用户点击发生在错误事件送达之后；main 下载器的 finally 已释放 controller。
    // 不能再走 advance(error overview)，否则会立刻停回错误分支而永远不发 IPC。
    void downloadModel(currentId)
  }

  async function cancelQueuedDownload(engineId: AsrEngineId): Promise<void> {
    const isCurrent = state.asrDownloadQueue[0] === engineId
    if (!isCurrent) {
      state.asrDownloadQueue = state.asrDownloadQueue.filter((id) => id !== engineId)
      return
    }
    queueCancelPendingId = engineId
    const cancelled = await cancelDownload(engineId)
    if (!cancelled) {
      queueCancelPendingId = null
      queueDispatchedId = null
      state.asrDownloadQueue.shift()
      if (state.asrOverview !== null) advanceDownloadQueue(state.asrOverview)
    }
  }

  async function hydrate(): Promise<void> {
    const result = await window.companion.voice.getAsrOverview()
    if (result.ok) {
      applyOverview(result.data)
    } else {
      state.overviewError = result.error?.message ?? '无法读取语音状态'
    }
  }

  async function downloadModel(engineId: AsrEngineId): Promise<void> {
    state.overviewError = null
    const result = await window.companion.voice.downloadAsrModel({ engineId })
    if (!result.ok) {
      const message = result.error?.message ?? '下载失败'
      state.overviewError = message
      if (state.asrDownloadQueue[0] === engineId) {
        queueDispatchedId = null
        state.asrQueueError = message
      }
    }
  }

  async function cancelDownload(engineId: AsrEngineId): Promise<boolean> {
    const result = await window.companion.voice.cancelAsrDownload({ engineId })
    return result.ok ? result.data.cancelled : false
  }

  async function pauseDownload(engineId: AsrEngineId): Promise<boolean> {
    const result = await window.companion.voice.pauseAsrDownload({ engineId })
    if (!result.ok) state.overviewError = result.error?.message ?? '暂停下载失败'
    return result.ok ? result.data.paused : false
  }

  async function resumeDownload(engineId: AsrEngineId): Promise<boolean> {
    const result = await window.companion.voice.resumeAsrDownload({ engineId })
    if (!result.ok) state.overviewError = result.error?.message ?? '继续下载失败'
    return result.ok ? result.data.resumed : false
  }

  async function deleteModel(engineId: AsrEngineId): Promise<boolean> {
    state.overviewError = null
    const result = await window.companion.voice.deleteAsrModel({ engineId })
    if (!result.ok) {
      state.overviewError = result.error?.message ?? '删除模型失败'
      return false
    }
    return true
  }

  async function selectEngine(engineId: AsrEngineId): Promise<boolean> {
    const result = await window.companion.voice.selectAsrEngine({ engineId })
    if (!result.ok) {
      state.overviewError = result.error?.message ?? '切换失败'
      return false
    }
    return true
  }

  /** P3V-09：设置/清除备用引擎（null = 清除）。overview 经 asr-model-state 事件刷新。 */
  async function setFallbackEngine(engineId: AsrEngineId | null): Promise<boolean> {
    state.overviewError = null
    const result = await window.companion.voice.setAsrFallbackEngine({ engineId })
    if (!result.ok) {
      state.overviewError = result.error?.message ?? '设置备用模型失败'
      return false
    }
    return true
  }

  // ── P3V-10：大资源根目录（状态无路径；换根重启生效）──

  async function hydrateAssetRoot(): Promise<void> {
    const result = await window.companion.voice.getAssetRoot()
    if (result.ok) {
      state.assetRoot = result.data
    } else {
      state.assetRootNotice = result.error?.message ?? '无法读取资源存储位置'
    }
  }

  function applyAssetRootChange(result: {
    ok: boolean
    data?: AssetRootChangeResult
    error?: { message?: string }
  }): void {
    if (!result.ok || result.data === undefined) {
      state.assetRootNotice = result.error?.message ?? '更改存储位置失败'
      return
    }
    state.assetRoot = result.data.status
    state.assetRootRestartRequired = result.data.restartRequired
    state.assetRootNotice = result.data.restartRequired
      ? '新的存储位置将在重启应用后生效；重启前不会把模型下载到旧位置'
      : null
  }

  async function chooseAssetRoot(): Promise<void> {
    applyAssetRootChange(await window.companion.voice.chooseAssetRoot())
  }

  async function resetAssetRoot(): Promise<void> {
    applyAssetRootChange(await window.companion.voice.resetAssetRoot())
  }

  // ── P3V-16..20：GPT-SoVITS 运行时与音色（投影无路径；安装即发即回走事件）──

  const gptVoices = computed(() => state.gptRuntime?.voices ?? [])
  /** 当前是否有可用运行时（false = 这台机器上还发不出定制音色）。 */
  const gptRuntimeReady = computed(() => state.gptRuntime?.source.active ?? false)
  /** 进行中的安装任务（null = 没有）。 */
  const gptRuntimeDownload = computed(() => {
    const download = state.gptRuntime?.download ?? null
    if (download === null) return null
    return download.state === 'downloading' || download.state === 'paused' ? download : null
  })

  async function hydrateGptRuntime(): Promise<void> {
    const result = await window.companion.voice.getGptRuntime()
    if (result.ok) {
      state.gptRuntime = result.data
    } else {
      state.gptRuntimeNotice = result.error?.message ?? '无法读取 GPT-SoVITS 状态'
    }
  }

  async function installGptRuntime(variant: GptRuntimeVariantId): Promise<boolean> {
    state.gptRuntimeNotice = null
    const result = await window.companion.voice.installGptRuntime({ variant })
    if (!result.ok) {
      state.gptRuntimeNotice = result.error?.message ?? '开始安装失败'
      return false
    }
    // 即发即回：进度经 asset-download 事件回来；先拉一次快照让按钮立刻变态
    await hydrateGptRuntime()
    return true
  }

  async function pauseGptRuntime(variant: GptRuntimeVariantId): Promise<void> {
    await window.companion.voice.pauseGptRuntimeDownload({ variant })
    await hydrateGptRuntime()
  }

  async function resumeGptRuntime(variant: GptRuntimeVariantId): Promise<void> {
    await window.companion.voice.resumeGptRuntimeDownload({ variant })
    await hydrateGptRuntime()
  }

  async function cancelGptRuntime(variant: GptRuntimeVariantId): Promise<void> {
    await window.companion.voice.cancelGptRuntimeDownload({ variant })
    await hydrateGptRuntime()
  }

  async function deleteGptRuntime(): Promise<boolean> {
    state.gptRuntimeNotice = null
    const result = await window.companion.voice.deleteGptRuntime()
    if (!result.ok) {
      state.gptRuntimeNotice = result.error?.message ?? '删除运行环境失败'
      return false
    }
    await hydrateGptRuntime()
    return true
  }

  function applyGptSourceResult(result: {
    ok: boolean
    data?: GptRuntimeSourceResult
    error?: { message?: string }
  }): boolean {
    if (!result.ok || result.data === undefined) {
      state.gptRuntimeNotice = result.error?.message ?? '设置 GPT-SoVITS 位置失败'
      return false
    }
    state.gptRuntime = result.data.overview
    if (!result.data.accepted) {
      state.gptRuntimeNotice =
        result.data.reason === 'not-gpt-sovits'
          ? '这个文件夹里没有找到 GPT-SoVITS 整合包（需要 runtime\\python.exe 与 api_v2.py）'
          : null
      return false
    }
    state.gptRuntimeNotice = result.data.overview.source.restartRequired
      ? '已记住这个位置，重启 Nacime 后生效'
      : null
    return true
  }

  async function chooseGptRuntimeDir(): Promise<boolean> {
    return applyGptSourceResult(await window.companion.voice.chooseGptRuntimeDir())
  }

  async function clearGptRuntimeDir(): Promise<boolean> {
    return applyGptSourceResult(await window.companion.voice.clearGptRuntimeDir())
  }

  /** P3V-20：挑一个音色文件；成功后记住**文件名**用于表单回显。 */
  async function pickGptVoiceFile(kind: GptVoiceFileKind): Promise<boolean> {
    const result = await window.companion.voice.pickGptVoiceFile({ kind })
    if (!result.ok) {
      state.gptRuntimeNotice = result.error?.message ?? '选择文件失败'
      return false
    }
    if (!result.data.picked) return false
    state.gptVoiceStagedFiles = {
      ...state.gptVoiceStagedFiles,
      [kind]: result.data.fileName ?? null
    }
    return true
  }

  async function importGptVoice(request: GptVoiceImportRequest): Promise<boolean> {
    state.gptRuntimeNotice = null
    const result = await window.companion.voice.importGptVoice(request)
    if (!result.ok) {
      state.gptRuntimeNotice = result.error?.message ?? '导入音色失败'
      return false
    }
    state.gptRuntime = result.data.overview
    if (!result.data.ok) {
      state.gptRuntimeNotice =
        result.data.reason === 'files-missing'
          ? '还差文件没选：需要 GPT 权重、SoVITS 权重和参考音频各一个'
          : '这个音色已经在列表里了'
      return false
    }
    state.gptVoiceStagedFiles = { 'gpt-weights': null, 'sovits-weights': null, 'ref-audio': null }
    return true
  }

  async function deleteGptVoice(voiceId: string): Promise<boolean> {
    state.gptRuntimeNotice = null
    const result = await window.companion.voice.deleteGptVoice({ voiceId })
    if (!result.ok) {
      state.gptRuntimeNotice = result.error?.message ?? '删除音色失败'
      return false
    }
    state.gptRuntime = result.data.overview
    if (!result.data.ok) {
      state.gptRuntimeNotice = '这个音色来自你的 GPT-SoVITS 安装配置，不能在这里删除'
      return false
    }
    return true
  }

  /** 大资产下载事件：只认 GPT runtime 的 assetId，其余（未来音色包）忽略。 */
  function applyAssetDownload(status: AssetDownloadStatus): void {
    const current = state.gptRuntime
    if (current === null) return
    if (!status.assetId.startsWith('gpt-runtime-')) return
    state.gptRuntime = { ...current, download: status }
    if (status.state === 'done' || status.state === 'error') {
      // 安装收尾/失败：拉一次完整快照，拿到 installed 与 restartRequired 的真值
      void hydrateGptRuntime()
    }
  }

  /** 麦克风权限/设备刷新（页面侧 enumerateDevices；权限拒绝仍能列出占位设备）。 */
  async function refreshDevices(): Promise<void> {
    if (typeof navigator === 'undefined' || navigator.mediaDevices === undefined) {
      state.micPermission = 'unknown'
      return
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const audio = devices.filter((d) => d.kind === 'audioinput')
      state.micDevices = audio.map((d) => ({
        id: d.deviceId,
        label: d.label.length > 0 ? d.label : '麦克风（未授权时无名称）'
      }))
      // permission 状态：有 labeled 设备 = 已授权过（Chromium 规则）
      state.micPermission = audio.some((d) => d.label.length > 0) ? 'granted' : state.micPermission
    } catch {
      state.micPermission = 'unknown'
    }
  }

  function setMicPermission(next: MicPermissionState): void {
    state.micPermission = next
  }

  function setInputDevice(deviceId: string | null): void {
    state.inputDeviceId = deviceId
  }

  function setMicLevel(level: number): void {
    state.micLevel = level
  }

  function resetTest(): void {
    state.partialTranscript = ''
    state.lastTranscript = ''
    state.testError = null
    state.micLevel = 0
  }

  /** P3B-18：停止当前说话（cancel-speaking；幂等）。试听中取消同样走这里。 */
  async function cancelSpeaking(): Promise<void> {
    await window.companion.voice.cancelSpeaking()
    state.testingTts = false
  }

  function subscribe(): () => void {
    subscriptionUsers += 1
    if (sharedSubscription === null) {
      const offOverview = window.companion.voice.onAsrOverview((overview) => {
        applyOverview(overview)
      })
      const offVoice = window.companion.voice.onVoiceState((event) => {
        // 事件无自带序列号：VAD/转写类直接应用（main 侧已按事件发生序发送）
        applyEvent(event)
      })
      // P3V-16：大资产下载进度（GPT runtime 安装；音色包未来复用同一通道）
      const offAsset = window.companion.voice.onAssetDownload((status) => {
        applyAssetDownload(status)
      })
      sharedSubscription = () => {
        offOverview()
        offVoice()
        offAsset()
      }
    }

    let released = false
    return () => {
      if (released) return
      released = true
      subscriptionUsers = Math.max(0, subscriptionUsers - 1)
      if (subscriptionUsers === 0) {
        sharedSubscription?.()
        sharedSubscription = null
      }
    }
  }

  return {
    state,
    engineList,
    selectedEngineId,
    fallbackEngineId,
    canListen,
    applyEvent,
    hydrate,
    downloadModel,
    cancelDownload,
    pauseDownload,
    resumeDownload,
    queueModelDownloads,
    enqueueModelDownload,
    retryDownloadQueue,
    cancelQueuedDownload,
    deleteModel,
    selectEngine,
    setFallbackEngine,
    hydrateAssetRoot,
    chooseAssetRoot,
    resetAssetRoot,
    gptVoices,
    gptRuntimeReady,
    gptRuntimeDownload,
    hydrateGptRuntime,
    installGptRuntime,
    pauseGptRuntime,
    resumeGptRuntime,
    cancelGptRuntime,
    deleteGptRuntime,
    chooseGptRuntimeDir,
    clearGptRuntimeDir,
    pickGptVoiceFile,
    importGptVoice,
    deleteGptVoice,
    applyAssetDownload,
    refreshDevices,
    setMicPermission,
    setInputDevice,
    setMicLevel,
    resetTest,
    cancelSpeaking,
    hydrateTts,
    testTts,
    subscribe
  }
})

/** 编排层/组件依赖的 store 实例类型。 */
export type VoiceStore = ReturnType<typeof useVoiceStore>
