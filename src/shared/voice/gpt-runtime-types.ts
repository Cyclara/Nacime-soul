// src/shared/voice/gpt-runtime-types.ts
// P3V-16：GPT-SoVITS 运行时（官方 v2Pro 整合包）一键安装的 renderer 可见 DTO。
//
// 路径纪律（与 asset-root-types / asr-settings-types 同红线）：renderer 只见
// 变体 id、显示名、字节数、状态与错误码；**镜像 URL、哈希、.part/安装绝对路径
// 全部留在 main**（main-only 的 gpt-runtime-catalog.ts 才是那些事实的真源）。
//
// 产品纪律（handoff §7/§8）：
//   - 变体只做「推荐」不做「代替用户决定」：GPU 检测命中 RTX 50 系才把 rtx50 标
//     recommended，用户随时可以选另一个；检测不到就两个都不推荐。
//   - 外部已有安装**只读**：externalDetected=true 只是告诉用户「你机器上已经有一
//     份」，Nacime 不会去改它，也不把它当成自己的安装（installed 恒指 Nacime 自
//     有安装产物，删除按钮只删自己的）。
//   - 安装是长任务：install 通道即发即回，进度经 `companion:event:asset-download`
//     推送 AssetDownloadStatus（与 ASR 下载中心同一套 UI 语义）。

import {
  isAssetDownloadStatus,
  type AssetDownloadStatus,
  type AssetRootState
} from './asset-root-types'

/** 官方整合包两变体（main-only catalog 的 GptRuntimeVariant 的对外投影，字符串一致）。 */
export type GptRuntimeVariantId = 'standard' | 'rtx50'

/** 安装向导里的一个可选变体。 */
export interface GptRuntimeVariantOption {
  readonly variant: GptRuntimeVariantId
  /** UI 显示名（中文）。 */
  readonly displayName: string
  /** 钉死的归档字节数（UI 换算成 GB 显示；下载前已知，不是下载后自证）。 */
  readonly downloadBytes: number
  /** GPU 检测推荐项；检测失败/无 NVIDIA 卡时两个都是 false（不替用户拍板）。 */
  readonly recommended: boolean
}

/** Nacime 自有安装（一键安装产物）的对外投影；绝不含安装路径。 */
export interface GptRuntimeInstalledInfo {
  readonly variant: GptRuntimeVariantId
  readonly displayName: string
  /** 安装完成时间（epoch ms）。 */
  readonly installedAt: number
}

/** P3V-17：运行时来源模式（auto=自动发现；custom=用户指定目录）。 */
export type GptRuntimeSourceMode = 'auto' | 'custom'

/**
 * P3V-17：当前运行时来源的对外投影。**不含目录路径**——用户自己知道选了哪，
 * renderer 只需要知道「在不在用、能不能出声、要不要重启」。
 */
export interface GptRuntimeSourceInfo {
  readonly mode: GptRuntimeSourceMode
  /** 本会话是否已在用一个可用运行时（false = 本轮只能纯文字）。 */
  readonly active: boolean
  /** 当前（含待生效）选择里是否已配好音色；false = 还需导入音色才能出声。 */
  readonly voiceConfigured: boolean
  /** 有待生效的变更（刚装完 / 刚选目录）；true = 重启后生效。 */
  readonly restartRequired: boolean
}

/**
 * P3V-18：一个音色 profile 的对外投影。
 * **不含权重/参考音频路径**——那些只在 main 的注册表里。
 * `state='missing-files'` = 权重或参考音频不在了（比如外接盘拔了），如实显示不可用。
 */
export interface GptVoiceProfileView {
  readonly id: string
  readonly displayName: string
  /** 模型版本（v2Pro / v2ProPlus / v4…）。 */
  readonly version: string
  /** 参考音频对应的提示词语言（用户导入时确认，不从文件名猜）。 */
  readonly promptLang: string
  readonly defaultTextLang: string
  readonly state: 'ready' | 'missing-files'
  /** discovered=安装自带配置读出的；imported=用户导入的（只有它能删）。 */
  readonly source: 'discovered' | 'imported'
  /** 是否是当前选中的音色（唯一真源 = config `tts.voiceId`）。 */
  readonly current: boolean
}

/** `companion:voice:get-gpt-runtime` 响应。 */
export interface GptRuntimeOverview {
  /** P3V-17：运行时来源与生效状态。 */
  readonly source: GptRuntimeSourceInfo
  /** P3V-18：可用音色（可能为空——运行时装好了但还没导入音色）。 */
  readonly voices: readonly GptVoiceProfileView[]
  /** Nacime 自有安装；null = 未安装（或安装已损坏，marker 校验不过）。 */
  readonly installed: GptRuntimeInstalledInfo | null
  /** 本机是否已存在可用的外部安装（只读发现；Nacime 不接管、不修改）。 */
  readonly externalDetected: boolean
  readonly variants: readonly GptRuntimeVariantOption[]
  /** 当前/最近一次安装任务状态；从未安装过为 null。 */
  readonly download: AssetDownloadStatus | null
  /** 安装建议可用空间下限（字节；UI 显示「需要约 XX GB」）。 */
  readonly minFreeBytes: number
  /** 资源根剩余空间（root 不可用时为 0，UI 显示「不可用」而非假数字）。 */
  readonly freeBytes: number
  /** 资源根状态；非 ok 时 UI 必须禁用安装并说明原因，而不是让下载失败到一半。 */
  readonly rootState: AssetRootState
}

/** `gpt-runtime-install` / `-pause-download` / `-resume-download` / `-cancel-download` 请求。 */
export interface GptRuntimeVariantRequest {
  readonly variant: GptRuntimeVariantId
}

// ── P3V-20：本地导入音色（首版不分发任何角色音色，只做本机导入）──

/** 导入时要挑的三类文件。 */
export type GptVoiceFileKind = 'gpt-weights' | 'sovits-weights' | 'ref-audio'

/**
 * GPT-SoVITS 模型版本闭集（官方整合包代次）。
 * 只作展示与核对用；权重实际版本由 api_v2 加载时自行识别。
 */
export const GPT_VOICE_VERSIONS: readonly string[] = Object.freeze([
  'v1',
  'v2',
  'v2Pro',
  'v2ProPlus',
  'v3',
  'v4'
])

/**
 * api_v2 支持的语言代码闭集（2026-09-03 读官方 TTS.py `v2_languages` 核对）。
 * `all_*` 是「整段按该语言处理」的强制变体；`auto` 由引擎自动判定。
 */
export const GPT_VOICE_LANGS: readonly string[] = Object.freeze([
  'zh',
  'ja',
  'en',
  'ko',
  'yue',
  'auto',
  'auto_yue',
  'all_zh',
  'all_ja',
  'all_ko',
  'all_yue'
])

/** `companion:voice:pick-gpt-voice-file` 请求。 */
export interface GptVoiceFilePickRequest {
  readonly kind: GptVoiceFileKind
}

/** 选择结果：只回**文件名**，绝不回目录（路径留在 main 的暂存槽里）。 */
export interface GptVoiceFilePickResult {
  readonly picked: boolean
  readonly kind: GptVoiceFileKind
  readonly fileName?: string
}

/**
 * `companion:voice:import-gpt-voice` 请求。
 * 三个文件已由 pick 通道暂存在 main；这里只带**用户逐项确认过的**元信息——
 * 提示词绝不从时间戳文件名猜（handoff §8：樱羽艾玛就是这种情况）。
 */
export interface GptVoiceImportRequest {
  readonly displayName: string
  readonly version: string
  readonly promptText: string
  readonly promptLang: string
  readonly defaultTextLang: string
}

/** 导入失败原因闭集。 */
export type GptVoiceImportRejection = 'files-missing' | 'duplicate'

export interface GptVoiceImportResult {
  readonly ok: boolean
  readonly voiceId?: string
  readonly reason?: GptVoiceImportRejection
  readonly overview: GptRuntimeOverview
}

/** `companion:voice:delete-gpt-voice` 请求（只能删 imported）。 */
export interface GptVoiceDeleteRequest {
  readonly voiceId: string
}

export interface GptVoiceDeleteResult {
  readonly ok: boolean
  readonly overview: GptRuntimeOverview
}

/** P3V-17：目录被拒的原因闭集（cancelled = 用户点了取消，不是错误）。 */
export type GptRuntimeSourceRejection = 'cancelled' | 'not-gpt-sovits'

/** `companion:voice:choose-gpt-runtime-dir` / `clear-gpt-runtime-dir` 响应。 */
export interface GptRuntimeSourceResult {
  readonly overview: GptRuntimeOverview
  /** 本次是否真的改了选择（取消/选中同一个目录 = false）。 */
  readonly changed: boolean
  /** 目录是否被采纳；false 时看 reason。 */
  readonly accepted: boolean
  readonly reason?: GptRuntimeSourceRejection
}

// ── 运行时校验（IPC validator + renderer store 纵深防御共用）──

const GPT_RUNTIME_VARIANT_IDS: readonly GptRuntimeVariantId[] = ['standard', 'rtx50']

/**
 * 编译期护栏：漏一个成员 → Record 缺键 → typecheck 失败
 * （而不是运行时静默拒绝一个合法变体）。
 */
const GPT_RUNTIME_VARIANT_COVERAGE: Record<GptRuntimeVariantId, true> = {
  standard: true,
  rtx50: true
}
void GPT_RUNTIME_VARIANT_COVERAGE

const ASSET_ROOT_STATES: readonly string[] = ['ok', 'missing', 'unwritable']

const GPT_RUNTIME_OVERVIEW_KEYS: readonly string[] = [
  'source',
  'voices',
  'installed',
  'externalDetected',
  'variants',
  'download',
  'minFreeBytes',
  'freeBytes',
  'rootState'
]

const GPT_RUNTIME_SOURCE_REJECTIONS: readonly string[] = ['cancelled', 'not-gpt-sovits']

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function hasOnlyKnownKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((k) => allowed.includes(k))
}

export function isGptRuntimeVariantId(value: unknown): value is GptRuntimeVariantId {
  return typeof value === 'string' && (GPT_RUNTIME_VARIANT_IDS as readonly string[]).includes(value)
}

export function isGptRuntimeVariantRequest(value: unknown): value is GptRuntimeVariantRequest {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return Object.keys(v).length === 1 && isGptRuntimeVariantId(v['variant'])
}

export function isGptRuntimeVariantOption(value: unknown): value is GptRuntimeVariantOption {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (!hasOnlyKnownKeys(v, ['variant', 'displayName', 'downloadBytes', 'recommended'])) return false
  if (!isGptRuntimeVariantId(v['variant'])) return false
  if (typeof v['displayName'] !== 'string' || v['displayName'].length === 0) return false
  if (!isNonNegativeInt(v['downloadBytes'])) return false
  return typeof v['recommended'] === 'boolean'
}

export function isGptRuntimeInstalledInfo(value: unknown): value is GptRuntimeInstalledInfo {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (!hasOnlyKnownKeys(v, ['variant', 'displayName', 'installedAt'])) return false
  if (!isGptRuntimeVariantId(v['variant'])) return false
  if (typeof v['displayName'] !== 'string' || v['displayName'].length === 0) return false
  return isNonNegativeInt(v['installedAt'])
}

export function isGptRuntimeSourceInfo(value: unknown): value is GptRuntimeSourceInfo {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (!hasOnlyKnownKeys(v, ['mode', 'active', 'voiceConfigured', 'restartRequired'])) return false
  if (v['mode'] !== 'auto' && v['mode'] !== 'custom') return false
  return (
    typeof v['active'] === 'boolean' &&
    typeof v['voiceConfigured'] === 'boolean' &&
    typeof v['restartRequired'] === 'boolean'
  )
}

const VOICE_PROFILE_KEYS: readonly string[] = [
  'id',
  'displayName',
  'version',
  'promptLang',
  'defaultTextLang',
  'state',
  'source',
  'current'
]

export function isGptVoiceProfileView(value: unknown): value is GptVoiceProfileView {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (!hasOnlyKnownKeys(v, VOICE_PROFILE_KEYS)) return false
  for (const key of ['id', 'displayName', 'version', 'promptLang', 'defaultTextLang']) {
    if (typeof v[key] !== 'string' || (v[key] as string).length === 0) return false
  }
  // 路径纪律：显示名可以是中文，但绝不该是一个盘符路径
  if (/^[A-Za-z]:[/\\]/.test(v['displayName'] as string)) return false
  if (v['state'] !== 'ready' && v['state'] !== 'missing-files') return false
  if (v['source'] !== 'discovered' && v['source'] !== 'imported') return false
  return typeof v['current'] === 'boolean'
}

/** `companion:voice:get-gpt-runtime` 响应校验（renderer 收到即验，纵深防御）。 */
export function isGptRuntimeOverview(value: unknown): value is GptRuntimeOverview {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (!hasOnlyKnownKeys(v, GPT_RUNTIME_OVERVIEW_KEYS)) return false
  if (!isGptRuntimeSourceInfo(v['source'])) return false
  if (!Array.isArray(v['voices']) || !v['voices'].every(isGptVoiceProfileView)) return false
  if (v['installed'] !== null && !isGptRuntimeInstalledInfo(v['installed'])) return false
  if (typeof v['externalDetected'] !== 'boolean') return false
  if (!Array.isArray(v['variants']) || v['variants'].length === 0) return false
  if (!v['variants'].every(isGptRuntimeVariantOption)) return false
  if (v['download'] !== null && !isAssetDownloadStatus(v['download'])) return false
  if (!isNonNegativeInt(v['minFreeBytes'])) return false
  if (!isNonNegativeInt(v['freeBytes'])) return false
  return typeof v['rootState'] === 'string' && ASSET_ROOT_STATES.includes(v['rootState'])
}

/** `choose-gpt-runtime-dir` / `clear-gpt-runtime-dir` 响应校验。 */
export function isGptRuntimeSourceResult(value: unknown): value is GptRuntimeSourceResult {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (!hasOnlyKnownKeys(v, ['overview', 'changed', 'accepted', 'reason'])) return false
  if (typeof v['changed'] !== 'boolean' || typeof v['accepted'] !== 'boolean') return false
  if (
    v['reason'] !== undefined &&
    (typeof v['reason'] !== 'string' || !GPT_RUNTIME_SOURCE_REJECTIONS.includes(v['reason']))
  ) {
    return false
  }
  return isGptRuntimeOverview(v['overview'])
}

const GPT_VOICE_FILE_KINDS: readonly string[] = ['gpt-weights', 'sovits-weights', 'ref-audio']

/** 用户可见文本的长度界（与 IPC 其余文本字段同量级）。 */
const VOICE_TEXT_MAX = 200

export function isGptVoiceFilePickRequest(value: unknown): value is GptVoiceFilePickRequest {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (Object.keys(v).length !== 1) return false
  return typeof v['kind'] === 'string' && GPT_VOICE_FILE_KINDS.includes(v['kind'])
}

function isBoundedText(value: unknown, min: number): boolean {
  return typeof value === 'string' && value.trim().length >= min && value.length <= VOICE_TEXT_MAX
}

export function isGptVoiceImportRequest(value: unknown): value is GptVoiceImportRequest {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (
    !hasOnlyKnownKeys(v, [
      'displayName',
      'version',
      'promptText',
      'promptLang',
      'defaultTextLang'
    ]) ||
    Object.keys(v).length !== 5
  ) {
    return false
  }
  if (!isBoundedText(v['displayName'], 1)) return false
  // 参考音频的提示词必须由用户确认填写：空 = 拒绝导入（不允许「以后再说」）
  if (!isBoundedText(v['promptText'], 1)) return false
  if (typeof v['version'] !== 'string' || !GPT_VOICE_VERSIONS.includes(v['version'])) return false
  if (typeof v['promptLang'] !== 'string' || !GPT_VOICE_LANGS.includes(v['promptLang'])) {
    return false
  }
  return typeof v['defaultTextLang'] === 'string' && GPT_VOICE_LANGS.includes(v['defaultTextLang'])
}

export function isGptVoiceDeleteRequest(value: unknown): value is GptVoiceDeleteRequest {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (Object.keys(v).length !== 1) return false
  return typeof v['voiceId'] === 'string' && v['voiceId'].length > 0 && v['voiceId'].length <= 128
}

/** 下载状态的 assetId 约定：`gpt-runtime-${variant}`（UI 据此把事件归到本卡片）。 */
export function gptRuntimeAssetId(variant: GptRuntimeVariantId): string {
  return `gpt-runtime-${variant}`
}
