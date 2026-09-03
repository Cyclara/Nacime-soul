// src/shared/voice/asr-settings-types.ts
// P3B-14：ASR 引擎管理/模型下载的 renderer 可见 DTO。
//
// 冻结政策（P3B-11 funasr-provider.ts 头注释，此处是它的对外投影）：
//   - **无云 ASR 选项**：引擎清单是闭集枚举，全 localOnly（审计裁定 3）；
//     UI 不出现任何「云识别」入口。
//   - **仅用户显式选择**：selectEngine 是唯一切换路径，且 = 丢弃旧引擎实例 +
//     新引擎完整重载（两引擎不同时持有 recognizer）。
//   - 下载可中止；状态可读（AsrModelState 复用 P3B-09 冻结枚举）。
//
// 引擎 id 与 main 侧常量（SHERPA_SENSEVOICE_ENGINE_ID / FUNASR_PARAFORMER_
// ENGINE_ID）字符串一致；engine-manager 侧有编译期互检。

import type { AsrErrorCode, AsrModelState } from './asr-types'
import { isAssetDownloadStatus, type AssetDownloadStatus } from './asset-root-types'

/**
 * 引擎注册表 id 闭集（config `voice.asrEngineId` / `asrPrimaryEngineId` /
 * `asrFallbackEngineId` 的取值域）。
 *
 * P3V-01 扩容 2 → 6：前两个是 P3B 的离线引擎（归档下载），后四个是本轮新增
 * （Hugging Face 钉死 revision 多文件直下）。全部 localOnly——**不引入云 ASR**。
 * 富元数据（下载体积/语言/流式/场景/限制）在 `asr-catalog.ts`；本文件只管 id 闭集
 * 与 IPC DTO 形状。
 */
export type AsrEngineId = OfflineAsrEngineId | StreamingAsrEngineId

/**
 * 走**冻结**离线 ABI（`AsrEngine.recognize(Int16Array)`，整段话一次出文本）的引擎。
 * VAD 切好段再整段识别；这条路径 P3B 已上线，本轮只加 Parakeet 一个成员。
 */
export type OfflineAsrEngineId = 'sherpa-sensevoice' | 'funasr-paraformer' | 'parakeet-tdt-v2'

/**
 * 走**新增**流式 ABI（`AsrStreamSession`，边说边出 partial）的引擎。
 * 拆成独立联合类型的意义：两条 ABI 各自 `Record` 穷举，任一侧加引擎却忘了配
 * 实现，typecheck 立刻失败——而不是运行时才发现某个引擎选了没法用。
 */
export type StreamingAsrEngineId =
  'zipformer-bilingual-zh-en' | 'paraformer-bilingual-zh-en' | 'zipformer-streaming-zh-14m'

/** 单引擎在设置页的投影。 */
export interface AsrEngineOverview {
  readonly engineId: AsrEngineId
  /** UI 显示名（中文）。 */
  readonly label: string
  readonly localOnly: true
  readonly modelState: AsrModelState
  /** 下载进度 0..1（modelState='downloading' 时）。 */
  readonly progressRatio?: number
  readonly errorCode?: AsrErrorCode
  /** 下载体积提示（字节；UI 换算显示）。 */
  readonly downloadBytes: number
  /** P3V-15：下载中心细节；非活动/无历史时可省略。assetId 恒等 engineId。 */
  readonly download?: AssetDownloadStatus
  /** 是否当前主引擎（P3V-09 起主/备分流，selected 专指主）。 */
  readonly selected: boolean
  /** 是否用户指定的备用引擎（主备不得同体，两标志互斥）。 */
  readonly fallback: boolean
}

/** Silero VAD 模型（~630KB，语音输入的前置依赖）状态。 */
export interface AsrVadModelStatus {
  readonly state: AsrModelState
  readonly progressRatio?: number
  readonly errorCode?: AsrErrorCode
  /** P3V-15：VAD 下载中心细节；assetId 恒为 'vad'。 */
  readonly download?: AssetDownloadStatus
}

/** `companion:voice:get-asr-overview` 响应。 */
export interface AsrOverview {
  readonly selectedEngineId: AsrEngineId
  /** P3V-09：备用引擎（null = 未设备用）。 */
  readonly fallbackEngineId: AsrEngineId | null
  readonly engines: readonly AsrEngineOverview[]
  readonly vadModel: AsrVadModelStatus
}

/** `companion:voice:asr-download-model` / `asr-cancel-download` 请求。 */
export interface AsrEngineRequest {
  readonly engineId: AsrEngineId
}

/** `companion:voice:asr-select-engine` 请求。 */
export interface AsrSelectEngineRequest {
  readonly engineId: AsrEngineId
}

/**
 * P3V-09：`companion:voice:asr-set-fallback-engine` 请求。
 * engineId=null 清除备用；主备同体由 manager 拒绝（CFG_INVALID）。
 */
export interface AsrSetFallbackEngineRequest {
  readonly engineId: AsrEngineId | null
}

// ── 运行时校验（IPC validator 共用）──

const ASR_ENGINE_IDS: readonly AsrEngineId[] = [
  'sherpa-sensevoice',
  'funasr-paraformer',
  'zipformer-bilingual-zh-en',
  'paraformer-bilingual-zh-en',
  'zipformer-streaming-zh-14m',
  'parakeet-tdt-v2'
]

/**
 * 编译期护栏：运行时数组必须覆盖 AsrEngineId 全部成员。
 * 漏一个 → `Record` 缺键 → typecheck 失败（而不是运行时静默拒绝合法 id）。
 */
const ASR_ENGINE_ID_COVERAGE: Record<AsrEngineId, true> = {
  'sherpa-sensevoice': true,
  'funasr-paraformer': true,
  'zipformer-bilingual-zh-en': true,
  'paraformer-bilingual-zh-en': true,
  'zipformer-streaming-zh-14m': true,
  'parakeet-tdt-v2': true
}
void ASR_ENGINE_ID_COVERAGE

const STREAMING_ASR_ENGINE_IDS: readonly StreamingAsrEngineId[] = [
  'zipformer-bilingual-zh-en',
  'paraformer-bilingual-zh-en',
  'zipformer-streaming-zh-14m'
]

/** 该引擎是否走流式 ABI（renderer 也要知道，用于卡片上的「流式/离线」标签）。 */
export function isStreamingAsrEngineId(value: AsrEngineId): value is StreamingAsrEngineId {
  return (STREAMING_ASR_ENGINE_IDS as readonly string[]).includes(value)
}

export function isAsrEngineId(value: unknown): value is AsrEngineId {
  return typeof value === 'string' && (ASR_ENGINE_IDS as readonly string[]).includes(value)
}

export function isAsrEngineRequest(value: unknown): value is AsrEngineRequest {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return Object.keys(v).length === 1 && isAsrEngineId(v['engineId'])
}

export function isAsrSelectEngineRequest(value: unknown): value is AsrSelectEngineRequest {
  return isAsrEngineRequest(value)
}

/** null 合法：清除备用。 */
export function isAsrSetFallbackEngineRequest(
  value: unknown
): value is AsrSetFallbackEngineRequest {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return Object.keys(v).length === 1 && (v['engineId'] === null || isAsrEngineId(v['engineId']))
}

const ASR_MODEL_STATES: readonly string[] = ['not-downloaded', 'downloading', 'ready', 'error']
const ASR_ENGINE_OVERVIEW_KEYS: readonly string[] = [
  'engineId',
  'label',
  'localOnly',
  'modelState',
  'progressRatio',
  'errorCode',
  'downloadBytes',
  'download',
  'selected',
  'fallback'
]

function isRatio(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function hasOnlyKnownKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((k) => allowed.includes(k))
}

/** overview 的引擎投影校验（event 通道纵深防御；preload 复用）。 */
export function isAsrEngineOverview(value: unknown): value is AsrEngineOverview {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (!hasOnlyKnownKeys(v, ASR_ENGINE_OVERVIEW_KEYS)) return false
  if (!isAsrEngineId(v['engineId'])) return false
  if (typeof v['label'] !== 'string') return false
  if (v['localOnly'] !== true) return false
  if (typeof v['modelState'] !== 'string' || !ASR_MODEL_STATES.includes(v['modelState'])) {
    return false
  }
  if (v['progressRatio'] !== undefined && !isRatio(v['progressRatio'])) return false
  if (v['errorCode'] !== undefined && typeof v['errorCode'] !== 'string') return false
  if (
    typeof v['downloadBytes'] !== 'number' ||
    !Number.isInteger(v['downloadBytes']) ||
    v['downloadBytes'] < 0
  ) {
    return false
  }
  if (v['download'] !== undefined) {
    if (!isAssetDownloadStatus(v['download'])) return false
    if ((v['download'] as AssetDownloadStatus).assetId !== v['engineId']) return false
  }
  if (typeof v['selected'] !== 'boolean' || typeof v['fallback'] !== 'boolean') return false
  // 主备不得同体（manager 侧保证，这里纵深防御）
  return !(v['selected'] === true && v['fallback'] === true)
}

/** `companion:event:asr-model-state` / `voice:get-asr-overview` 响应校验。 */
export function isAsrOverview(value: unknown): value is AsrOverview {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (!isAsrEngineId(v['selectedEngineId'])) return false
  if (v['fallbackEngineId'] !== null && !isAsrEngineId(v['fallbackEngineId'])) return false
  if (!Array.isArray(v['engines']) || v['engines'].length === 0) return false
  if (!v['engines'].every(isAsrEngineOverview)) return false
  const vad = v['vadModel'] as Record<string, unknown> | undefined
  if (typeof vad !== 'object' || vad === null) return false
  if (typeof vad['state'] !== 'string' || !ASR_MODEL_STATES.includes(vad['state'])) {
    return false
  }
  if (!hasOnlyKnownKeys(vad, ['state', 'progressRatio', 'errorCode', 'download'])) return false
  if (vad['progressRatio'] !== undefined && !isRatio(vad['progressRatio'])) return false
  if (vad['errorCode'] !== undefined && typeof vad['errorCode'] !== 'string') return false
  if (vad['download'] !== undefined) {
    if (!isAssetDownloadStatus(vad['download'])) return false
    if ((vad['download'] as AssetDownloadStatus).assetId !== 'vad') return false
  }
  return (
    Object.keys(v).sort().join() ===
    ['engines', 'selectedEngineId', 'fallbackEngineId', 'vadModel'].sort().join()
  )
}
