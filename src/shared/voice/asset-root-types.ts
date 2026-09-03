// src/shared/voice/asset-root-types.ts
// P3V-03：资源根目录与下载状态 DTO（S-023 §3.3）。
//
// 路径纪律（与 asr-settings-types 同红线）：renderer 只见「默认位置 / 自定义位置」
// 与空间数字，**绝不见绝对路径**——真实路径只在 main 与「更改位置」原生对话框里
// 出现；用户选择也持久化在 main 私有文件（asset-root.json），不进 renderer 可读的
// config。
//
// 盘符丢失策略（用户明确要求）：自定义根目录不存在时**明确报错**（state='missing'），
// 不静默改回 C 盘默认；已下载资源不删除，盘回来即恢复。
//
/** 根目录三态：ok=可用；missing=自定义根所在盘/目录不存在；unwritable=存在但不可写。 */
export type AssetRootState = 'ok' | 'missing' | 'unwritable'

/** `companion:voice:get-asset-root` 响应 / choose/reset 的内嵌快照。 */
export interface AssetRootStatus {
  /** true=默认位置（系统应用数据目录）；false=用户自选。 */
  readonly isDefault: boolean
  /** 根目录所在盘剩余字节；missing/unwritable 时为 0（UI 显示「不可用」而非假数字）。 */
  readonly freeBytes: number
  /**
   * 当前选择需要的总下载字节（先含 VAD+主/备 ASR；P3V-16/20 再 additive 纳入
   * GPT runtime/音色）。计算必须由 main 调 shared catalog 函数，renderer 不另算。
   */
  readonly totalRequiredBytes: number
  readonly state: AssetRootState
}

/** `companion:voice:choose-asset-root` / `reset-asset-root` 响应。 */
export interface AssetRootChangeResult {
  readonly status: AssetRootStatus
  /** 本次是否真的改了（用户取消选择 / 与当前一致 = false）。 */
  readonly changed: boolean
  /** true=新根在下次启动生效——本会话的下载/引擎仍用旧根（运行中栈不热重建）。 */
  readonly restartRequired: boolean
}

// ── 大资产下载状态（GPT runtime / 音色包；ASR 模型沿用 asr-model-state 比例事件）──

export type AssetDownloadState = 'idle' | 'downloading' | 'paused' | 'done' | 'error' | 'cancelled'

/** 下载中心的人话阶段；不含路径，只描述当前工作。 */
export type AssetDownloadPhase = 'receiving' | 'verifying' | 'extracting' | 'installing'

/** 大资产下载错误码闭集（F5-011 纪律：枚举串，不是自由文本）。 */
export type AssetDownloadErrorCode =
  | 'download-failed'
  | 'hash-mismatch'
  | 'size-mismatch'
  | 'disk-full'
  | 'root-missing'
  | 'root-unwritable'
  | 'extract-failed'
  | 'cancelled'

/**
 * 单个大资产（8GB 级 GPT 整合包、音色包）的下载状态。
 * P3V-16/20 的 `companion:event:asset-download` 载荷；断点续传下的 receivedBytes
 * 是「已在本机 .part 中的字节数」，重试不归零。
 */
export interface AssetDownloadStatus {
  /** 资产 id（如 'gpt-runtime-standard'；有界非路径）。 */
  readonly assetId: string
  readonly state: AssetDownloadState
  /** 已接收字节（含续传前已落盘部分）。 */
  readonly receivedBytes: number
  /** 钉死的总字节（下载前已知，不是下载后自证）。 */
  readonly totalBytes: number
  /** 当前远端文件的安全 basename；绝不是本机路径。 */
  readonly currentFile?: string
  readonly phase?: AssetDownloadPhase
  readonly speedBytesPerSec?: number
  /** 当前实现是否可暂停后从 `.part` 续传；旧归档下载为 false。 */
  readonly resumable?: boolean
  readonly errorCode?: AssetDownloadErrorCode
}

// ── 运行时校验（IPC validator / renderer store 纵深防御共用）──

const ASSET_ROOT_STATES: readonly string[] = ['ok', 'missing', 'unwritable']

const ASSET_DOWNLOAD_STATES: readonly string[] = [
  'idle',
  'downloading',
  'paused',
  'done',
  'error',
  'cancelled'
]

const ASSET_DOWNLOAD_PHASES: readonly string[] = [
  'receiving',
  'verifying',
  'extracting',
  'installing'
]

const ASSET_DOWNLOAD_ERROR_CODES: readonly string[] = [
  'download-failed',
  'hash-mismatch',
  'size-mismatch',
  'disk-full',
  'root-missing',
  'root-unwritable',
  'extract-failed',
  'cancelled'
]

/** 资产 id 的字符串界（与 IPC 其余 id 同量级）。 */
export const ASSET_ID_MAX_LENGTH = 64

function isFiniteNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function hasOnlyKnownKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((k) => allowed.includes(k))
}

export function isAssetRootStatus(value: unknown): value is AssetRootStatus {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (!hasOnlyKnownKeys(v, ['isDefault', 'freeBytes', 'totalRequiredBytes', 'state'])) return false
  if (typeof v['isDefault'] !== 'boolean') return false
  if (!isFiniteNonNegativeInt(v['freeBytes'])) return false
  if (!isFiniteNonNegativeInt(v['totalRequiredBytes'])) return false
  return typeof v['state'] === 'string' && ASSET_ROOT_STATES.includes(v['state'])
}

export function isAssetRootChangeResult(value: unknown): value is AssetRootChangeResult {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (!hasOnlyKnownKeys(v, ['status', 'changed', 'restartRequired'])) return false
  if (typeof v['changed'] !== 'boolean') return false
  if (typeof v['restartRequired'] !== 'boolean') return false
  return isAssetRootStatus(v['status'])
}

export function isAssetDownloadStatus(value: unknown): value is AssetDownloadStatus {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (
    !hasOnlyKnownKeys(v, [
      'assetId',
      'state',
      'receivedBytes',
      'totalBytes',
      'currentFile',
      'phase',
      'speedBytesPerSec',
      'resumable',
      'errorCode'
    ])
  ) {
    return false
  }
  if (
    typeof v['assetId'] !== 'string' ||
    v['assetId'].length < 1 ||
    v['assetId'].length > ASSET_ID_MAX_LENGTH
  ) {
    return false
  }
  if (typeof v['state'] !== 'string' || !ASSET_DOWNLOAD_STATES.includes(v['state'])) return false
  if (!isFiniteNonNegativeInt(v['receivedBytes'])) return false
  if (!isFiniteNonNegativeInt(v['totalBytes'])) return false
  if (v['receivedBytes'] > v['totalBytes']) return false
  if (
    v['currentFile'] !== undefined &&
    (typeof v['currentFile'] !== 'string' ||
      v['currentFile'].length < 1 ||
      v['currentFile'].length > 255 ||
      v['currentFile'].includes('/') ||
      v['currentFile'].includes('\\'))
  ) {
    return false
  }
  if (
    v['phase'] !== undefined &&
    (typeof v['phase'] !== 'string' || !ASSET_DOWNLOAD_PHASES.includes(v['phase']))
  ) {
    return false
  }
  if (v['speedBytesPerSec'] !== undefined && !isFiniteNonNegativeInt(v['speedBytesPerSec'])) {
    return false
  }
  if (v['resumable'] !== undefined && typeof v['resumable'] !== 'boolean') return false
  return (
    v['errorCode'] === undefined ||
    (typeof v['errorCode'] === 'string' && ASSET_DOWNLOAD_ERROR_CODES.includes(v['errorCode']))
  )
}
