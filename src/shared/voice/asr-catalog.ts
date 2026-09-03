// src/shared/voice/asr-catalog.ts
// P3V-01：ASR 模型目录（shared——首次设置向导与设置页读同一份数据）。
//
// 分层理由（S-023 §3.1）：下载 URL 与逐文件 sha256 是 main-only 的实现细节，
// 放 `src/main/voice/asr/download-catalog.ts`；本文件只有 renderer 也需要的
// 展示元数据（体积/语言/流式/资源等级/场景/限制）。**本文件不含任何 URL 与路径。**
//
// 体积口径（用户明确要求「在语音模型后面加上下载需要多少 MB」）：
//   - `downloadBytes` = 该模型全部下载文件字节数之和（已与上游逐文件核对）。
//   - 显示用十进制 MB（1 MB = 1e6 B），与 Hugging Face / GitHub Release 页面一致。
//     不用 MiB：用户看到的下载页写多少，APP 就显示多少，否则「357 MB 的模型
//     显示成 340 MB」会被当成下错文件。
//   - 安装后占用会略大于下载体积（多文件直下无压缩，差异主要是文件系统簇），
//     需要显示时另开字段，**不得把两者混称**。

import type { AsrEngineId } from './asr-settings-types'

/** 识别模式：流式=边说边出字；离线=整句说完再出字。 */
export type AsrModelMode = 'streaming' | 'offline'

/** 资源占用等级（CPU/内存的粗分级，给用户选低配设备用）。 */
export type AsrResourceLevel = 'light' | 'medium' | 'heavy'

/** UI 徽章（卡片右上角小标签）。 */
export type AsrModelBadge = 'recommended' | 'light' | 'dialect' | 'english' | 'fallback'

/** 单个模型在模型卡上的完整展示数据。 */
export interface AsrModelCatalogEntry {
  readonly engineId: AsrEngineId
  /** UI 显示名。 */
  readonly label: string
  /** 下载字节数（= 逐文件之和；main 侧 download-catalog 有测试断言一致性）。 */
  readonly downloadBytes: number
  /** 支持语言的中文短标签（用于标签行）。 */
  readonly languages: readonly string[]
  readonly mode: AsrModelMode
  readonly resourceLevel: AsrResourceLevel
  readonly badges: readonly AsrModelBadge[]
  /** 一句话说明（卡片主文案）。 */
  readonly summary: string
  /** 适用场景。 */
  readonly scenario: string
  /** 明确限制——必须写清楚做不到什么，不许只报喜。 */
  readonly limitation: string
}

/**
 * Silero VAD：不是识别引擎，是「有没有人在说话」的前置依赖（打断也靠它）。
 * 单独列出，让首次设置能把它算进总下载量。
 */
export const ASR_VAD_CATALOG_ENTRY = Object.freeze({
  label: 'Silero VAD（说话检测）',
  downloadBytes: 643_854,
  summary: '判断你什么时候开始说话、什么时候说完，也是打断她说话的开关。',
  limitation: '不做识别，必须和下面任意一个识别模型一起用。'
})

/**
 * 6 个识别模型。顺序 = UI 默认展示顺序（推荐在前，备用在后）。
 * 前两个是 P3B 已有资产，后四个是 P3V-01 新增。
 */
export const ASR_MODEL_CATALOG: readonly AsrModelCatalogEntry[] = Object.freeze([
  {
    engineId: 'zipformer-bilingual-zh-en',
    label: 'Zipformer Bilingual',
    downloadBytes: 356_862_456,
    languages: ['中文', '英文'],
    mode: 'streaming',
    resourceLevel: 'medium',
    badges: ['recommended'],
    summary: '中英双语流式识别，一句话里中英夹杂也能跟上，首字延迟低。',
    scenario: '日常实时聊天的首选；说到一半就开始出字，配合打断最自然。',
    limitation: '只认中文和英文；日语、韩语、粤语请改用 SenseVoice。'
  },
  {
    engineId: 'paraformer-bilingual-zh-en',
    label: 'Paraformer Bilingual',
    downloadBytes: 237_202_501,
    languages: ['中文', '方言口音', '英文'],
    mode: 'streaming',
    resourceLevel: 'medium',
    badges: ['dialect'],
    summary: '中英双语流式识别，对带口音和方言味的普通话更宽容。',
    scenario: '普通话不太标准、或家乡口音较重时比 Zipformer 更稳。',
    limitation: '纯英文长句的准确率不如 Zipformer；不支持日韩粤。'
  },
  {
    engineId: 'zipformer-streaming-zh-14m',
    label: 'Zipformer Streaming ZH',
    downloadBytes: 55_616_588,
    languages: ['中文'],
    mode: 'streaming',
    resourceLevel: 'light',
    badges: ['light'],
    summary: '只有 14M 参数的纯中文流式识别，体积和占用都极小。',
    scenario: '老电脑、低配笔记本，或你只想先花 56 MB 把语音跑通。',
    limitation: '只认中文；夹英文单词会认错或漏掉。'
  },
  {
    engineId: 'sherpa-sensevoice',
    label: 'SenseVoice',
    downloadBytes: 163_002_883,
    languages: ['中文', '英文', '日文', '韩文', '粤语'],
    mode: 'offline',
    resourceLevel: 'medium',
    badges: ['fallback'],
    summary: '五种语言自动识别，说完整句再一次性出字，准确率稳。',
    scenario: '当备用模型很合适；也适合你经常切换语言说话。',
    limitation: '不是流式——要等你说完才出字，比流式慢半拍。'
  },
  {
    engineId: 'funasr-paraformer',
    label: 'FunASR Paraformer',
    downloadBytes: 234_051_698,
    languages: ['中文'],
    mode: 'offline',
    resourceLevel: 'medium',
    badges: ['fallback'],
    summary: '纯中文离线识别，中文书面表达的准确率高。',
    scenario: '纯中文使用，且更看重准确率而不是响应速度。',
    limitation: '不是流式；不认英文和其他语言。'
  },
  {
    engineId: 'parakeet-tdt-v2',
    label: 'Parakeet TDT v2',
    downloadBytes: 661_190_513,
    languages: ['英文'],
    mode: 'offline',
    resourceLevel: 'heavy',
    badges: ['english'],
    summary: '英语专用高质量识别，自带标点和大小写。',
    scenario: '你主要用英语聊天，且对英语识别质量要求高。',
    limitation: '完全不认中文；体积 661 MB 是最大的一个，占用也最高。'
  }
])

/** 按 id 查目录条目；未知 id 返回 undefined（调用方决定是报错还是跳过）。 */
export function findAsrModelCatalogEntry(engineId: AsrEngineId): AsrModelCatalogEntry | undefined {
  return ASR_MODEL_CATALOG.find((entry) => entry.engineId === engineId)
}

// ── 安装预设 ──

/** 预设 id。custom = 用户自己勾选，不预置模型清单。 */
export type AsrPresetId = 'standard' | 'light' | 'custom'

export interface AsrPreset {
  readonly id: AsrPresetId
  readonly label: string
  readonly description: string
  /** 需要下载的识别模型（不含 VAD——VAD 恒为必需，单独累加）。 */
  readonly engineIds: readonly AsrEngineId[]
  /** 主要模型；custom 预设为 null（用户自选）。 */
  readonly primaryEngineId: AsrEngineId | null
  /** 备用模型；无备用或 custom 为 null。 */
  readonly fallbackEngineId: AsrEngineId | null
}

/**
 * 三个预设（交接文档 §3.2 已确认）。
 * 标准推荐 = Silero + Zipformer Bilingual（主）+ SenseVoice（备）≈ 520 MB；
 * 轻量 = Silero + Zipformer ZH 14M ≈ 56 MB，无备用模型。
 */
export const ASR_PRESETS: readonly AsrPreset[] = Object.freeze([
  {
    id: 'standard',
    label: '标准推荐',
    description: '中英双语流式识别 + 多语言备用，日常聊天最顺。',
    engineIds: ['zipformer-bilingual-zh-en', 'sherpa-sensevoice'],
    primaryEngineId: 'zipformer-bilingual-zh-en',
    fallbackEngineId: 'sherpa-sensevoice'
  },
  {
    id: 'light',
    label: '轻量模式',
    description: '只装一个纯中文小模型，省空间、低配也能跑。',
    engineIds: ['zipformer-streaming-zh-14m'],
    primaryEngineId: 'zipformer-streaming-zh-14m',
    fallbackEngineId: null
  },
  {
    id: 'custom',
    label: '自定义',
    description: '自己挑要装哪些模型，并指定主要 / 备用。',
    engineIds: [],
    primaryEngineId: null,
    fallbackEngineId: null
  }
])

export function findAsrPreset(presetId: AsrPresetId): AsrPreset | undefined {
  return ASR_PRESETS.find((preset) => preset.id === presetId)
}

/**
 * 一组模型的总下载量（含 VAD——语音要能用就绕不开它）。
 * 首次设置底部「总下载量」与设置页批量下载共用本函数，避免两处算法漂移。
 */
export function totalAsrDownloadBytes(
  engineIds: readonly AsrEngineId[],
  options?: { readonly includeVad?: boolean }
): number {
  const includeVad = options?.includeVad ?? true
  // 去重：用户在自定义里重复勾同一个模型不该被算两次
  const unique = [...new Set(engineIds)]
  const modelBytes = unique.reduce((sum, engineId) => {
    return sum + (findAsrModelCatalogEntry(engineId)?.downloadBytes ?? 0)
  }, 0)
  return modelBytes + (includeVad ? ASR_VAD_CATALOG_ENTRY.downloadBytes : 0)
}

/**
 * 下载体积文案。十进制 MB/GB（见文件头口径说明）。
 * 小于 1 MB 保留两位小数（Silero 0.64 MB 不能显示成 "0 MB" 或 "1 MB"）。
 */
export function formatAsrDownloadSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1_000_000) return `${(bytes / 1_000_000).toFixed(2)} MB`
  if (bytes < 1_000_000_000) return `${Math.round(bytes / 1_000_000)} MB`
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`
}

/**
 * 预设/批量下载总量比单模型卡多保留一位：标准 520.5 MB、轻量 56.3 MB。
 * 单模型仍沿用上游页面的整数显示（357 MB 等），两个口径各有明确用途。
 */
export function formatAsrDownloadTotal(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1_000_000) return `${(bytes / 1_000_000).toFixed(2)} MB`
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`
}

// ── 展示辅助（renderer 与首次设置共用，避免两处各写一套中文）──

export function asrModeLabel(mode: AsrModelMode): string {
  return mode === 'streaming' ? '流式（边说边出字）' : '离线（说完再出字）'
}

export function asrResourceLevelLabel(level: AsrResourceLevel): string {
  switch (level) {
    case 'light':
      return '占用低'
    case 'medium':
      return '占用中等'
    case 'heavy':
      return '占用较高'
  }
}

export function asrBadgeLabel(badge: AsrModelBadge): string {
  switch (badge) {
    case 'recommended':
      return '推荐'
    case 'light':
      return '轻量'
    case 'dialect':
      return '方言友好'
    case 'english':
      return '英语专用'
    case 'fallback':
      return '适合做备用'
  }
}
