// src/main/ipc/validators.ts
// IPC invoke 通道 validator + isTrustedSender
// 依据：S-003 §3.5/§3.6、S-001 P1-11
//
// 设计要点：
//   1. IPC_INVOKE_CHANNELS 中全部 invoke 通道都有 validator；event 载荷由 shared validator 覆盖
//   2. IPC_VALIDATORS satisfies Record<IpcInvokeChannel, Validator> 保证全覆盖
//   3. isTrustedSender 纯函数（不依赖 electron），校验 webContents.id + origin
//   4. validator 只做"形状检查"；深层值范围由 ConfigStore/ChatService 的 schema 完成
//   5. 所有 record validator：对象非 null/非数组、hasOnlyKeys 拒绝多余字段、
//      字符串限长度、数字必须 finite、ID 用白名单正则
//
// event validator 和 helper 函数在 @shared/ipc/validators（preload 也需要用，
// S-003 §3.7 要求 preload subscribe 验证事件载荷）

import type { Validator } from '@shared/ipc/contracts'
import type { IpcInvokeChannel } from '@shared/ipc/channels'
import type { IpcInvokeMap } from '@shared/ipc/contracts'
import { THEME_SETTING_IDS } from '@shared/config/themes'
import type {
  ChatCancelRequest,
  ChatDeleteTurnRequest,
  ChatDeleteMessageRequest,
  ChatDeleteSelectedRequest,
  ChatClearSessionRequest,
  ChatListRequest,
  ChatRenderAckRequest,
  ChatRetryRequest,
  ChatSearchRequest,
  ChatSendRequest
} from '@shared/chat/types'
import type { ChatFeedbackRequest } from '@shared/compliance/types'
import type { Live2dStageReadyRequest, Live2dStageReport } from '@shared/live2d/stage-types'
import type { Live2dFramingPreviewRequest } from '@shared/live2d/public-types'
import {
  isAsrEngineId,
  isAsrEngineRequest,
  isAsrSelectEngineRequest,
  isAsrSetFallbackEngineRequest
} from '@shared/voice/asr-settings-types'
import {
  isGptRuntimeVariantRequest,
  isGptVoiceDeleteRequest,
  isGptVoiceFilePickRequest,
  isGptVoiceImportRequest
} from '@shared/voice/gpt-runtime-types'
import { isVoiceTestTtsRequest } from '@shared/voice/voice-events'
import type {
  ConfigResetRequest,
  ConfigUpdateRequest,
  ModelConnectionTestRequest
} from '@shared/config/types'
import { CONFIG_DOMAINS } from '@shared/config/types'
import type {
  DmaeHistoryRequest,
  DmaePanelRequest,
  DmaeTrendRequest,
  DmaeExplainRequest,
  DmaeBenchmarkRequest,
  DmaeQualitativeRequest,
  DmaeMuteRequest,
  GrowthTimelineRequest,
  GrowthTrendRequest,
  MemoryDeleteRequest,
  MemoryDetailRequest,
  MemoryId,
  MemoryListRequest,
  MemoryPinRequest,
  MemoryRestoreRequest,
  RecycleBinEmptyRequest,
  RecycleBinListRequest,
  RecycleBinRestoreRequest,
  MemorySetL0FieldRequest,
  MemoryUpdateContentRequest
} from '@shared/memory/types'
import { L0_FIELD_DESCRIPTIONS } from '../memory/l0-store'

// helper 函数从 shared 导入（main 的 invoke validator 复用）
import {
  isString,
  isNumber,
  isBoolean,
  isPlainObject,
  hasOnlyKeys,
  isId,
  isUrlString,
  validatePartialFields
} from '@shared/ipc/validators'

// re-export：event validator 供 register.ts / 测试 / 预留使用
export { validateEventPayload } from '@shared/ipc/validators'

// === invoke 通道 validator ===

// --- ChatListRequest ---
function isChatListRequest(value: unknown): value is ChatListRequest {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['sessionId', 'limit'])) return false
  // sessionId 可选
  if ('sessionId' in value && value.sessionId !== undefined) {
    if (!isId(value.sessionId)) return false
  }
  if (!isNumber(value.limit, { min: 1, max: 500, integer: true })) return false
  return true
}

// --- ChatSendRequest ---
function isChatSendRequest(value: unknown): value is ChatSendRequest {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['sessionId', 'text', 'clientRequestId'])) return false
  if (!isId(value.sessionId)) return false
  if (typeof value.text !== 'string') return false
  const trimmed = value.text.trim()
  if (trimmed.length < 1 || trimmed.length > 20_000) return false
  if (!isId(value.clientRequestId)) return false
  return true
}

// --- ChatCancelRequest ---
function isChatCancelRequest(value: unknown): value is ChatCancelRequest {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['requestId'])) return false
  if (!isId(value.requestId)) return false
  return true
}

// --- ChatRenderAckRequest（P3B-15A paint ack；requestId 同 id 界，sequence 严格非负整数）---
function isChatRenderAckRequest(value: unknown): value is ChatRenderAckRequest {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['requestId', 'sequence'])) return false
  if (!isId(value.requestId)) return false
  if (
    typeof value.sequence !== 'number' ||
    !Number.isInteger(value.sequence) ||
    value.sequence < 0
  ) {
    return false
  }
  return true
}

// --- ChatRetryRequest ---
function isChatRetryRequest(value: unknown): value is ChatRetryRequest {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['sessionId', 'messageId'])) return false
  if (!isId(value.sessionId)) return false
  if (!isId(value.messageId)) return false
  return true
}

// --- ChatDeleteTurnRequest（验收反馈⑥：与 retry 同形状） ---
function isChatDeleteTurnRequest(value: unknown): value is ChatDeleteTurnRequest {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['sessionId', 'messageId'])) return false
  if (!isId(value.sessionId)) return false
  if (!isId(value.messageId)) return false
  return true
}

// --- ChatDeleteMessageRequest（验收反馈⑥c：与 delete-turn 同形状） ---
function isChatDeleteMessageRequest(value: unknown): value is ChatDeleteMessageRequest {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['sessionId', 'messageId'])) return false
  if (!isId(value.sessionId)) return false
  if (!isId(value.messageId)) return false
  return true
}

// --- ChatDeleteSelectedRequest（验收反馈⑦：批量按轮删除，id 数组 1..500） ---
function isChatDeleteSelectedRequest(value: unknown): value is ChatDeleteSelectedRequest {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['sessionId', 'messageIds'])) return false
  if (!isId(value.sessionId)) return false
  if (!Array.isArray(value.messageIds)) return false
  if (value.messageIds.length < 1 || value.messageIds.length > 500) return false
  return value.messageIds.every((id) => isId(id))
}

// --- ChatClearSessionRequest（验收反馈⑦：清空会话） ---
function isChatClearSessionRequest(value: unknown): value is ChatClearSessionRequest {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['sessionId'])) return false
  if (!isId(value.sessionId)) return false
  return true
}

// --- ChatSearchRequest（P2-44：全文搜索） ---
// query 1..128 字符（空白查询合法——buildFtsQuery 归约为空结果）；limit 可选 1..100 整数
function isChatSearchRequest(value: unknown): value is ChatSearchRequest {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['query', 'limit'])) return false
  if (!isString(value.query, { minLen: 1, maxLen: 128 })) return false
  if ('limit' in value && value.limit !== undefined) {
    if (!isNumber(value.limit, { min: 1, max: 100, integer: true })) return false
  }
  return true
}

// --- ChatFeedbackRequest（P3C1-07：合规用户反馈，F5-001 §3.7）---
// kind 白名单两值；幂等语义在 compliance feedback service（重复/忽略均 ok）
function isChatFeedbackRequest(value: unknown): value is ChatFeedbackRequest {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['sessionId', 'turnId', 'messageId', 'kind'])) return false
  if (!isId(value.sessionId)) return false
  if (!isId(value.turnId)) return false
  if (!isId(value.messageId)) return false
  return value.kind === 'dislike' || value.kind === 'out-of-character'
}

// --- Live2D stage（P3A-05：只接受当前实例 ID 与无正文状态元数据） ---
function isLive2dModelId(value: unknown): value is string {
  return isId(value, { maxLen: 128 })
}

function isLive2dSelectModelRequest(value: unknown): value is { modelId: string } {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ['modelId'])) return false
  return isLive2dModelId(value.modelId)
}

function isLive2dVisibleRequest(value: unknown): value is { visible: boolean } {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ['visible'])) return false
  return isBoolean(value.visible)
}

/** 取景预览：framing=null 结束预览；非 null 时三个字段都必须在合同范围内。 */
function isLive2dFramingPreviewRequest(value: unknown): value is Live2dFramingPreviewRequest {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ['framing'])) return false
  if (value.framing === null) return true
  const framing = value.framing
  if (!isPlainObject(framing) || !hasOnlyKeys(framing, ['zoom', 'offsetX', 'offsetY'])) return false
  return (
    isNumber(framing.zoom, { min: 0.25, max: 3 }) &&
    isNumber(framing.offsetX, { min: -100, max: 100 }) &&
    isNumber(framing.offsetY, { min: -100, max: 100 })
  )
}

function isStageInstanceId(value: unknown): value is string {
  return isId(value, { maxLen: 128 })
}

function isLive2dStageReadyRequest(value: unknown): value is Live2dStageReadyRequest {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ['stageInstanceId'])) return false
  return isStageInstanceId(value.stageInstanceId)
}

function isLive2dStageReport(value: unknown): value is Live2dStageReport {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['stageInstanceId', 'status', 'fps', 'modelLoadMs', 'errorCode']))
    return false
  if (!isStageInstanceId(value.stageInstanceId)) return false
  if (!['starting', 'loading-model', 'ready', 'degraded', 'error'].includes(String(value.status)))
    return false
  if ('fps' in value && value.fps !== undefined && !isNumber(value.fps, { min: 0, max: 240 }))
    return false
  if (
    'modelLoadMs' in value &&
    value.modelLoadMs !== undefined &&
    !isNumber(value.modelLoadMs, { min: 0, max: 120_000, integer: true })
  ) {
    return false
  }
  if (
    'errorCode' in value &&
    value.errorCode !== undefined &&
    !isString(value.errorCode, { minLen: 1, maxLen: 64 })
  ) {
    return false
  }
  return true
}

// --- ModelConnectionTestRequest ---
function isModelConnectionTestRequest(value: unknown): value is ModelConnectionTestRequest {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['provider', 'baseUrl', 'model', 'apiKey', 'timeoutMs'])) return false
  if (!isString(value.provider, { minLen: 1, maxLen: 64 })) return false
  if (!isUrlString(value.baseUrl)) return false
  if (!isString(value.model, { minLen: 1, maxLen: 128 })) return false
  // apiKey 可选
  if ('apiKey' in value && value.apiKey !== undefined) {
    if (!isString(value.apiKey, { minLen: 1, maxLen: 4096 })) return false
  }
  // timeoutMs 可选
  if ('timeoutMs' in value && value.timeoutMs !== undefined) {
    if (!isNumber(value.timeoutMs, { min: 1000, max: 30_000, integer: true })) return false
  }
  return true
}

// --- ConfigResetRequest ---
// 域白名单由 CONFIG_DOMAINS 派生（开工裁定 §2.2，禁止人工域数组）
function isConfigResetRequest(value: unknown): value is ConfigResetRequest {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['domain', 'confirm'])) return false
  if (typeof value.domain !== 'string') return false
  if (!(CONFIG_DOMAINS as readonly string[]).includes(value.domain)) return false
  if (value.confirm !== true) return false
  return true
}

// --- ConfigUpdateRequest（最复杂）---

/** compatOverrides 子对象验证 */
function isCompatOverrides(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  if (
    !hasOnlyKeys(value, ['thinkingFormat', 'supportsToolCalls', 'supportsVision', 'maxTokensField'])
  ) {
    return false
  }
  if ('thinkingFormat' in value && value.thinkingFormat !== undefined) {
    if (
      value.thinkingFormat !== 'none' &&
      value.thinkingFormat !== 'thinking_type' &&
      value.thinkingFormat !== 'enable_thinking' &&
      value.thinkingFormat !== 'reasoning_split'
    ) {
      return false
    }
  }
  if ('supportsToolCalls' in value && value.supportsToolCalls !== undefined) {
    if (!isBoolean(value.supportsToolCalls)) return false
  }
  if ('supportsVision' in value && value.supportsVision !== undefined) {
    if (!isBoolean(value.supportsVision)) return false
  }
  if ('maxTokensField' in value && value.maxTokensField !== undefined) {
    if (value.maxTokensField !== 'max_tokens' && value.maxTokensField !== 'max_completion_tokens') {
      return false
    }
  }
  return true
}

/** ModelConfig partial 验证（含可选 apiKey） */
function isPartialModelConfig(value: unknown): boolean {
  return validatePartialFields(value, {
    provider: (v) => isString(v, { minLen: 1, maxLen: 64 }),
    protocol: (v) => v === 'openai-compatible' || v === 'anthropic',
    baseUrl: (v) => isUrlString(v) && isString(v, { maxLen: 2048 }),
    model: (v) => isString(v, { minLen: 1, maxLen: 128 }),
    displayName: (v) => isString(v, { maxLen: 64 }),
    temperature: (v) => isNumber(v, { min: 0, max: 2 }),
    topP: (v) => isNumber(v, { min: 0, max: 1 }),
    maxTokens: (v) => isNumber(v, { min: 64, max: 65_536, integer: true }),
    timeoutMs: (v) => isNumber(v, { min: 1000, max: 300_000, integer: true }),
    reasoningEffort: (v) => v === 'off' || v === 'low' || v === 'medium' || v === 'high',
    compatOverrides: (v) => isCompatOverrides(v),
    apiKey: (v) => isString(v, { minLen: 1, maxLen: 4096 })
  })
}

/**
 * VoiceConfig partial 验证（P3B-14；asrEngineId 闭集全本地，无云选项）。
 * P3V-09：闭集 2 → 6（复用 shared 的 isAsrEngineId 单真源，不再维护第二份
 * 硬编码清单）+ 主/备双键。asrFallbackEngineId 空串=清除备用（见 config 类型
 * 注释——null 落不了盘）。
 */
function isPartialVoiceConfig(value: unknown): boolean {
  return validatePartialFields(value, {
    asrEngineId: (v) => isAsrEngineId(v),
    asrPrimaryEngineId: (v) => isAsrEngineId(v),
    asrFallbackEngineId: (v) => v === '' || isAsrEngineId(v)
  })
}

/** TtsConfig partial 验证（含可选 apiKey） */
function isPartialTtsConfig(value: unknown): boolean {
  return validatePartialFields(value, {
    enabled: (v) => isBoolean(v),
    provider: (v) => isString(v, { minLen: 1, maxLen: 64 }),
    voiceId: (v) => isString(v, { maxLen: 128 }),
    speed: (v) => isNumber(v, { min: 0.5, max: 2 }),
    pitch: (v) => isNumber(v, { min: -12, max: 12 }),
    volume: (v) => isNumber(v, { min: 0, max: 1 }),
    sampleRate: (v) => v === 16000 || v === 22050 || v === 24000 || v === 44100 || v === 48000,
    cacheEnabled: (v) => isBoolean(v),
    earlyPlaybackEnabled: (v) => isBoolean(v),
    apiKey: (v) => isString(v, { minLen: 1, maxLen: 4096 })
  })
}

// === Phase 2 P2-31.5A：DMAE 预设/异常检测 validator（S-005-补充 §1.7）===

import {
  ANOMALY_RULE_IDS,
  PRESET_ID_REGEX,
  WINDOW_KEYS,
  type AnomalyRuleId
} from '@shared/memory/dmae-config'

const ANOMALY_RULE_ID_SET = new Set<string>(ANOMALY_RULE_IDS)

function isAnomalyRuleId(value: unknown): value is AnomalyRuleId {
  return typeof value === 'string' && ANOMALY_RULE_ID_SET.has(value)
}

/** 可调参数 overrides（partial，允许空对象） */
function isTunableOverrides(value: unknown): boolean {
  return validatePartialFields(value, {
    promptThreshold: (x) => isNumber(x, { min: 1, max: 99 }),
    userRewardBase: (x) => isNumber(x, { min: 10, max: 30 }),
    wakeGamma: (x) => isNumber(x, { min: 0.3, max: 0.8 }),
    modelRewardBase: (x) => isNumber(x, { min: 5, max: 12 }),
    wakeLambda: (x) => isNumber(x, { min: 0.1, max: 0.5 }),
    decayAlpha: (x) => isNumber(x, { min: 0.3, max: 2 }),
    decayBeta: (x) => isNumber(x, { min: 0.05, max: 0.5 })
  })
}

function isDmaePreset(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  if (
    !hasOnlyKeys(value, [
      'id',
      'name',
      'description',
      'baseline',
      'overrides',
      'builtin',
      'createdAt',
      'updatedAt'
    ])
  )
    return false

  return (
    isString(value.id, { minLen: 13, maxLen: 76 }) &&
    PRESET_ID_REGEX.test(value.id) &&
    isString(value.name, { minLen: 1, maxLen: 40 }) &&
    isString(value.description, { maxLen: 160 }) &&
    value.baseline === 'default' &&
    isTunableOverrides(value.overrides) &&
    value.builtin === false &&
    isNumber(value.createdAt, { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true }) &&
    isNumber(value.updatedAt, { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true }) &&
    value.updatedAt >= value.createdAt
  )
}

function isDmaePresets(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 50) return false
  if (!value.every(isDmaePreset)) return false
  return new Set(value.map((preset) => (preset as { id: string }).id)).size === value.length
}

function isPartialMuted(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  return Object.entries(value).every(
    ([ruleId, until]) =>
      isAnomalyRuleId(ruleId) &&
      isNumber(until, { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true })
  )
}

function isWindowPatch(ruleId: AnomalyRuleId, value: unknown): boolean {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, [...WINDOW_KEYS[ruleId]])) return false
  if ('days' in value && !isNumber(value.days, { min: 1, max: 365, integer: true })) return false
  if ('turns' in value && !isNumber(value.turns, { min: 1, max: 10_000, integer: true }))
    return false
  return true
}

function isPartialWindows(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  return Object.entries(value).every(
    ([ruleId, window]) => isAnomalyRuleId(ruleId) && isWindowPatch(ruleId as AnomalyRuleId, window)
  )
}

function isPartialAnomalyConfig(value: unknown): boolean {
  return validatePartialFields(value, {
    muted: isPartialMuted,
    windows: isPartialWindows
  })
}

/** MemoryConfig.dmae 子对象验证 */
function isPartialDmaeConfig(value: unknown): boolean {
  return validatePartialFields(value, {
    enabled: (v) => isBoolean(v),
    maxScore: (v) => v === 100,
    promptThreshold: (v) => isNumber(v, { min: 1, max: 99 }),
    userRewardBase: (v) => isNumber(v, { min: 10, max: 30 }),
    wakeGamma: (v) => isNumber(v, { min: 0.3, max: 0.8 }),
    modelRewardBase: (v) => isNumber(v, { min: 5, max: 12 }),
    wakeLambda: (v) => isNumber(v, { min: 0.1, max: 0.5 }),
    decayAlpha: (v) => isNumber(v, { min: 0.3, max: 2 }),
    decayBeta: (v) => isNumber(v, { min: 0.05, max: 0.5 }),
    // P2-31.5A：四字段 validator（S-005-补充 §1.7）
    presets: isDmaePresets,
    anomaly: isPartialAnomalyConfig,
    historySampleEveryTurns: (v) => isNumber(v, { min: 1, max: 10, integer: true })
  })
}

function isPartialGcPolicy(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  if (
    !hasOnlyKeys(value, [
      'archiveToSoftDeleteDays',
      'softDeleteToPurgeDays',
      'recentAccessGraceDays',
      'anchorImportanceMin',
      'maxPurgePerRun',
      'schedule',
      'monthlyDigest',
      'coldStorage'
    ])
  )
    return false
  if ('archiveToSoftDeleteDays' in value && value.archiveToSoftDeleteDays !== undefined) {
    const tiers = value.archiveToSoftDeleteDays
    if (!isPlainObject(tiers) || !hasOnlyKeys(tiers, ['one_off', 'situational', 'stable']))
      return false
    if ('one_off' in tiers && !isNumber(tiers.one_off, { min: 7, max: 365, integer: true }))
      return false
    if (
      'situational' in tiers &&
      !isNumber(tiers.situational, { min: 14, max: 730, integer: true })
    )
      return false
    if ('stable' in tiers && tiers.stable !== null) return false
  }
  if (
    'softDeleteToPurgeDays' in value &&
    !isNumber(value.softDeleteToPurgeDays, { min: 7, max: 365, integer: true })
  )
    return false
  if (
    'recentAccessGraceDays' in value &&
    !isNumber(value.recentAccessGraceDays, { min: 7, max: 365, integer: true })
  )
    return false
  if (
    'anchorImportanceMin' in value &&
    !isNumber(value.anchorImportanceMin, { min: 1, max: 10, integer: true })
  )
    return false
  if (
    'maxPurgePerRun' in value &&
    !isNumber(value.maxPurgePerRun, { min: 1, max: 500, integer: true })
  )
    return false
  if ('monthlyDigest' in value && !isBoolean(value.monthlyDigest)) return false
  if ('schedule' in value && value.schedule !== undefined) {
    if (
      !validatePartialFields(value.schedule, {
        idleMinutes: (v) => isNumber(v, { min: 1, max: 60, integer: true }),
        minIntervalHours: (v) => isNumber(v, { min: 1, max: 168, integer: true }),
        eagerCountThreshold: (v) => isNumber(v, { min: 100, max: 100_000, integer: true })
      })
    )
      return false
  }
  if ('coldStorage' in value && value.coldStorage !== undefined) {
    if (
      !validatePartialFields(value.coldStorage, {
        enabled: (v) => isBoolean(v),
        dir: (v) => v === 'data/cold'
      })
    )
      return false
  }
  return true
}

/** MemoryConfig.attributionGate 子对象验证（M-42，对齐 AttributionGateConfigSchema） */
function isPartialAttributionGateConfig(value: unknown): boolean {
  return validatePartialFields(value, {
    provider: (v) => isString(v, { maxLen: 64 }),
    model: (v) => isString(v, { maxLen: 128 }),
    baseUrl: (v) => isString(v, { maxLen: 256 })
  })
}

/** MemoryConfig partial 验证 */
function isPartialMemoryConfig(value: unknown): boolean {
  if (
    !validatePartialFields(value, {
      enabled: (v) => isBoolean(v),
      embeddingProvider: (v) => isString(v, { maxLen: 64 }),
      embeddingModel: (v) => isString(v, { maxLen: 128 }),
      embeddingDimension: (v) => isNumber(v, { min: 64, max: 8192, integer: true }),
      maxActive: (v) => isNumber(v, { min: 1, max: 50, integer: true }),
      minRetrievalScore: (v) => isNumber(v, { min: -1, max: 1 }),
      attributionGate: (v) => isPartialAttributionGateConfig(v),
      dmae: (v) => isPartialDmaeConfig(v),
      gc: (v) => isPartialGcPolicy(v)
    })
  ) {
    return false
  }
  return true
}

/** UiConfig.window 子对象验证 */
function isPartialWindowConfig(value: unknown): boolean {
  return validatePartialFields(value, {
    width: (v) => isNumber(v, { min: 480, max: 3840, integer: true }),
    height: (v) => isNumber(v, { min: 600, max: 2160, integer: true }),
    x: (v) => isNumber(v, { integer: true }),
    y: (v) => isNumber(v, { integer: true }),
    maximized: (v) => isBoolean(v)
  })
}

/** UiConfig.chat 子对象验证 */
function isPartialChatUiConfig(value: unknown): boolean {
  return validatePartialFields(value, {
    sendOnEnter: (v) => isBoolean(v),
    showTimestamps: (v) => isBoolean(v),
    showReasoning: (v) => isBoolean(v)
  })
}

/** UiConfig.live2d 子对象验证 */
function isPartialLive2dConfig(value: unknown): boolean {
  return validatePartialFields(value, {
    enabled: (v) => isBoolean(v),
    zoom: (v) => isNumber(v, { min: 0.25, max: 3 }),
    alwaysOnTop: (v) => isBoolean(v),
    offsetX: (v) => isNumber(v, { min: -100, max: 100 }),
    offsetY: (v) => isNumber(v, { min: -100, max: 100 }),
    selectedModelId: (v) => isId(v, { maxLen: 128 })
  })
}

function isPartialOnboardingConfig(value: unknown): boolean {
  return validatePartialFields(value, {
    version: (v) => v === 1,
    stage: (v) =>
      v === 'provider-setup' ||
      v === 'connection-test' ||
      v === 'voice-setup' ||
      v === 'first-conversation' ||
      v === 'complete',
    completedAt: (v) => isNumber(v, { min: 0, integer: true }),
    voiceSendMode: (v) => v === 'draft' || v === 'send'
  })
}

/** UiConfig partial 验证 */
function isPartialUiConfig(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  if (
    !hasOnlyKeys(value, [
      'locale',
      'theme',
      'fontScale',
      'reduceMotion',
      'onboarding',
      'window',
      'chat',
      'live2d'
    ])
  ) {
    return false
  }
  if ('locale' in value && value.locale !== undefined) {
    if (value.locale !== 'zh-CN' && value.locale !== 'en-US') return false
  }
  if ('theme' in value && value.theme !== undefined) {
    // 主题白名单以共享注册表为真源——新增主题（light2/dark2/…）登记 THEME_IDS 后此处自动放行
    if (typeof value.theme !== 'string') return false
    if (!(THEME_SETTING_IDS as readonly string[]).includes(value.theme)) return false
  }
  if ('fontScale' in value && value.fontScale !== undefined) {
    if (!isNumber(value.fontScale, { min: 0.8, max: 1.5 })) return false
  }
  if ('reduceMotion' in value && value.reduceMotion !== undefined) {
    if (!isBoolean(value.reduceMotion)) return false
  }
  if ('onboarding' in value && value.onboarding !== undefined) {
    if (!isPartialOnboardingConfig(value.onboarding)) return false
  }
  if ('window' in value && value.window !== undefined) {
    if (!isPartialWindowConfig(value.window)) return false
  }
  if ('chat' in value && value.chat !== undefined) {
    if (!isPartialChatUiConfig(value.chat)) return false
  }
  if ('live2d' in value && value.live2d !== undefined) {
    if (!isPartialLive2dConfig(value.live2d)) return false
  }
  return true
}

/** SecurityConfig.diagnostics 子对象验证 */
function isPartialDiagnosticsConfig(value: unknown): boolean {
  return validatePartialFields(value, {
    logLevel: (v) => v === 'error' || v === 'warn' || v === 'info' || v === 'debug',
    retentionDays: (v) => isNumber(v, { min: 1, max: 30, integer: true }),
    maxTotalMb: (v) => isNumber(v, { min: 10, max: 500, integer: true })
  })
}

/** SecurityConfig.privacy 子对象验证 */
function isPartialPrivacyConfig(value: unknown): boolean {
  return validatePartialFields(value, {
    includeCrashDumpsInExport: (v) => isBoolean(v),
    monthlyGcDigest: (v) => isBoolean(v)
  })
}

/** SecurityConfig partial 验证 */
function isPartialSecurityConfig(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['allowHttpLocalhostInDev', 'diagnostics', 'privacy'])) return false
  if ('allowHttpLocalhostInDev' in value && value.allowHttpLocalhostInDev !== undefined) {
    if (!isBoolean(value.allowHttpLocalhostInDev)) return false
  }
  if ('diagnostics' in value && value.diagnostics !== undefined) {
    if (!isPartialDiagnosticsConfig(value.diagnostics)) return false
  }
  if ('privacy' in value && value.privacy !== undefined) {
    if (!isPartialPrivacyConfig(value.privacy)) return false
  }
  return true
}

// === F5-001 C0：persona 域深层局部 validator（S-005-补充 §1.5）===
// 开工裁定 §2.5：IPC validator 保留显式深层字段白名单——以下逐字段列出，
// 范围与 main/config/schema/persona.ts 的 Valibot schema 一一对应。

/** ComplianceGateScope 四值（与 shared/compliance/types.ts 单真源一致） */
function isComplianceGateScope(value: unknown): boolean {
  return (
    value === 'first-segment' || value === 'all-segments' || value === 'observe' || value === 'off'
  )
}

const COMPLIANCE_RULE_ID_RE = /^R-[A-Z]{2}-\d{2}$/

/** disabledRuleIds：数组 ≤256，元素形如 R-XX-00，不得重复 */
function isDisabledRuleIds(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 256) return false
  if (!value.every((id) => typeof id === 'string' && COMPLIANCE_RULE_ID_RE.test(id))) return false
  return new Set(value).size === value.length
}

/** ComplianceGateConfig partial 验证（含开工裁定 1.2 增补的 maxHoldMs） */
function isPartialComplianceGateConfig(value: unknown): boolean {
  if (
    !validatePartialFields(value, {
      enabled: (v) => isBoolean(v),
      scope: (v) => isComplianceGateScope(v),
      firstSegmentMinChars: (v) => isNumber(v, { min: 1, max: 512, integer: true }),
      segmentMaxChars: (v) => isNumber(v, { min: 64, max: 4096, integer: true }),
      budgetMs: (v) => isNumber(v, { min: 1, max: 100, integer: true }),
      maxRegenerations: (v) => v === 0 || v === 1,
      maxHoldMs: (v) => isNumber(v, { min: 100, max: 2000, integer: true })
    })
  ) {
    return false
  }
  // 跨字段关系：同一 patch 同时给两键时提前拒绝（单键场景的合并结果由 store 层 schema 把关）
  const patch = value as Record<string, unknown>
  if (patch.firstSegmentMinChars !== undefined && patch.segmentMaxChars !== undefined) {
    if ((patch.firstSegmentMinChars as number) > (patch.segmentMaxChars as number)) return false
  }
  return true
}

/** ComplianceAuditConfig partial 验证 */
function isPartialComplianceAuditConfig(value: unknown): boolean {
  return validatePartialFields(value, {
    enabled: (v) => isBoolean(v),
    sampleRate: (v) => isNumber(v, { min: 0, max: 1 }),
    timeoutMs: (v) => isNumber(v, { min: 1_000, max: 120_000, integer: true }),
    recentTurnWindow: (v) => isNumber(v, { min: 1, max: 20, integer: true })
  })
}

/** ComplianceConfig partial 验证 */
function isPartialComplianceConfig(value: unknown): boolean {
  return validatePartialFields(value, {
    gate: (v) => isPartialComplianceGateConfig(v),
    audit: (v) => isPartialComplianceAuditConfig(v),
    disabledRuleIds: (v) => isDisabledRuleIds(v),
    debugCaptureText: (v) => isBoolean(v)
  })
}

/** PersonaConfig partial 验证 */
function isPartialPersonaConfig(value: unknown): boolean {
  return validatePartialFields(value, {
    compliance: (v) => isPartialComplianceConfig(v)
  })
}

/** ConfigUpdateRequest 验证 */
function isConfigUpdateRequest(value: unknown): value is ConfigUpdateRequest {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['expectedSchemaVersion', 'domains'])) return false
  if (!isNumber(value.expectedSchemaVersion, { integer: true, min: 0 })) return false
  if (!isPlainObject(value.domains)) return false
  // 域 key 白名单由 CONFIG_DOMAINS 派生（开工裁定 §2.2）；各域深层字段仍显式白名单（§2.5）
  if (!hasOnlyKeys(value.domains, [...CONFIG_DOMAINS])) {
    return false
  }
  if ('model' in value.domains && value.domains.model !== undefined) {
    if (!isPartialModelConfig(value.domains.model)) return false
  }
  if ('tts' in value.domains && value.domains.tts !== undefined) {
    if (!isPartialTtsConfig(value.domains.tts)) return false
  }
  if ('memory' in value.domains && value.domains.memory !== undefined) {
    if (!isPartialMemoryConfig(value.domains.memory)) return false
  }
  if ('ui' in value.domains && value.domains.ui !== undefined) {
    if (!isPartialUiConfig(value.domains.ui)) return false
  }
  if ('security' in value.domains && value.domains.security !== undefined) {
    if (!isPartialSecurityConfig(value.domains.security)) return false
  }
  if ('persona' in value.domains && value.domains.persona !== undefined) {
    if (!isPartialPersonaConfig(value.domains.persona)) return false
  }
  if ('voice' in value.domains && value.domains.voice !== undefined) {
    if (!isPartialVoiceConfig(value.domains.voice)) return false
  }
  return true
}

// === Phase 2：memory + growth invoke validator（S-003-补充 §3.5）===

/** MemoryId 正则：^l2_[0-9]+_[A-Za-z0-9]+$，1..64 字符 */
const MEMORY_ID_RE = /^l2_[0-9]+_[A-Za-z0-9]+$/

function isMemoryId(value: unknown): value is MemoryId {
  if (typeof value !== 'string') return false
  if (value.length < 1 || value.length > 64) return false
  return MEMORY_ID_RE.test(value)
}

const MEMORY_LIST_STATES = new Set(['active', 'dormant', 'archived', 'soft_deleted'])

function isMemoryListRequest(value: unknown): value is MemoryListRequest {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['state', 'search', 'limit', 'offset'])) return false
  if ('state' in value && value.state !== undefined) {
    if (typeof value.state !== 'string' || !MEMORY_LIST_STATES.has(value.state)) return false
  }
  if ('search' in value && value.search !== undefined) {
    if (!isString(value.search, { maxLen: 200 })) return false
  }
  if (!isNumber(value.limit, { min: 1, max: 200, integer: true })) return false
  if (!isNumber(value.offset, { min: 0, max: 100_000, integer: true })) return false
  return true
}

function isMemoryDetailRequest(value: unknown): value is MemoryDetailRequest {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['memoryId'])) return false
  return isMemoryId(value.memoryId)
}

function isMemoryPinRequest(value: unknown): value is MemoryPinRequest {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['memoryId', 'pinned'])) return false
  return isMemoryId(value.memoryId) && isBoolean(value.pinned)
}

function isMemoryDeleteRequest(value: unknown): value is MemoryDeleteRequest {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['memoryId', 'confirm'])) return false
  return isMemoryId(value.memoryId) && value.confirm === true
}

function isMemoryRestoreRequest(value: unknown): value is MemoryRestoreRequest {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['memoryId'])) return false
  return isMemoryId(value.memoryId)
}

function isRecycleBinListRequest(value: unknown): value is RecycleBinListRequest {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ['limit', 'offset'])) return false
  return (
    isNumber(value.limit, { min: 1, max: 200, integer: true }) &&
    isNumber(value.offset, { min: 0, max: 100_000, integer: true })
  )
}

function isRecycleBinRestoreRequest(value: unknown): value is RecycleBinRestoreRequest {
  return isMemoryRestoreRequest(value)
}

function isRecycleBinEmptyRequest(value: unknown): value is RecycleBinEmptyRequest {
  return isPlainObject(value) && hasOnlyKeys(value, ['confirm']) && value.confirm === true
}

/** M-44：编辑 L2 内容——trim 前 1..500 字符（上限与提取管线 judge.ts L2 一致） */
function isMemoryUpdateContentRequest(value: unknown): value is MemoryUpdateContentRequest {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['memoryId', 'content'])) return false
  return isMemoryId(value.memoryId) && isString(value.content, { minLen: 1, maxLen: 500 })
}

/** L0 白名单字段 key 真源：main 侧 L0_FIELD_DESCRIPTIONS（S-021 §1.3） */
const L0_FIELD_KEY_SET: ReadonlySet<string> = new Set(Object.keys(L0_FIELD_DESCRIPTIONS))

/** M-44：设定/清空 L0 字段——field 白名单 + value 0..120（上限与提取管线 judge.ts L0 一致；空串=清空） */
function isMemorySetL0FieldRequest(value: unknown): value is MemorySetL0FieldRequest {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['field', 'value'])) return false
  if (!isString(value.field, { minLen: 1, maxLen: 32 })) return false
  if (!L0_FIELD_KEY_SET.has(value.field)) return false
  return isString(value.value, { minLen: 0, maxLen: 120 })
}

const DMAE_HISTORY_DAYS = new Set([7, 30, 90])

function isDmaeHistoryRequest(value: unknown): value is DmaeHistoryRequest {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['memoryId', 'days'])) return false
  if (!isMemoryId(value.memoryId)) return false
  return typeof value.days === 'number' && DMAE_HISTORY_DAYS.has(value.days)
}

function isGrowthTimelineRequest(value: unknown): value is GrowthTimelineRequest {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['limit'])) return false
  return isNumber(value.limit, { min: 1, max: 100, integer: true })
}

const GROWTH_TREND_METRICS = new Set(['understanding', 'l0FillRate', 'l2Total'])

function isGrowthTrendRequest(value: unknown): value is GrowthTrendRequest {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['metric', 'days'])) return false
  if (typeof value.metric !== 'string' || !GROWTH_TREND_METRICS.has(value.metric)) return false
  return typeof value.days === 'number' && DMAE_HISTORY_DAYS.has(value.days)
}

// === Phase 2 P2-32：DMAE 面板 invoke validator（F5-002 §3.7）===

function isDmaePanelRequest(value: unknown): value is DmaePanelRequest | undefined {
  if (value === undefined) return true
  if (!isPlainObject(value) || !hasOnlyKeys(value, ['eligibleCursor', 'eligibleLimit']))
    return false
  if (
    'eligibleLimit' in value &&
    value.eligibleLimit !== undefined &&
    !isNumber(value.eligibleLimit, { min: 1, max: 200, integer: true })
  ) {
    return false
  }
  if ('eligibleCursor' in value && value.eligibleCursor !== undefined) {
    const cursor = value.eligibleCursor
    if (!isPlainObject(cursor) || !hasOnlyKeys(cursor, ['turn', 'activation', 'memoryId']))
      return false
    if (
      !isNumber(cursor.turn, { min: 0, integer: true }) ||
      !isNumber(cursor.activation, { min: 0, max: 100 })
    )
      return false
    if (!isMemoryId(cursor.memoryId)) return false
  }
  return true
}

function isDmaeTrendRequest(value: unknown): value is DmaeTrendRequest {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['days'])) return false
  return typeof value.days === 'number' && DMAE_HISTORY_DAYS.has(value.days)
}

function isDmaeExplainRequest(value: unknown): value is DmaeExplainRequest {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['memoryId'])) return false
  return isMemoryId(value.memoryId)
}

// === Phase 2 P2-34：DMAE 基准体检 invoke validator（F5-002 §3.6）===

function isDmaeBenchmarkRequest(value: unknown): value is DmaeBenchmarkRequest {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['windowDays'])) return false
  return typeof value.windowDays === 'number' && DMAE_HISTORY_DAYS.has(value.windowDays)
}

/** Q1~Q3 是 0..3 整数；note 可选字符串（≤200 字符） */
function isDmaeQualitativeRequest(value: unknown): value is DmaeQualitativeRequest {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['q1', 'q2', 'q3', 'note'])) return false
  for (const k of ['q1', 'q2', 'q3'] as const) {
    if (!isNumber(value[k], { min: 0, max: 3, integer: true })) return false
  }
  if ('note' in value && value.note !== undefined) {
    if (!isString(value.note, { minLen: 0, maxLen: 200 })) return false
  }
  return true
}

/** M-26：DMAE 异常静音请求：ruleId 必须是注册表内规则，days 1-365 正整数 */
function isDmaeMuteRequest(value: unknown): value is DmaeMuteRequest {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['ruleId', 'days'])) return false
  if (!isString(value.ruleId, { minLen: 3, maxLen: 16 })) return false
  if (!(ANOMALY_RULE_IDS as readonly string[]).includes(value.ruleId as string)) return false
  if (!isNumber(value.days, { min: 1, max: 365, integer: true })) return false
  return true
}

// === IPC_VALIDATORS：satisfies Record 保证全覆盖 ===

export const IPC_VALIDATORS = {
  'companion:app:get-info': (v: unknown): v is undefined => v === undefined,
  'companion:app:open-user-data': (v: unknown): v is undefined => v === undefined,
  // ── M-50：自动更新 ──
  'companion:app:check-for-updates': (v: unknown): v is undefined => v === undefined,
  'companion:app:get-update-status': (v: unknown): v is undefined => v === undefined,
  'companion:app:quit-and-install': (v: unknown): v is undefined => v === undefined,
  'companion:window:minimize': (v: unknown): v is undefined => v === undefined,
  'companion:window:toggle-maximize': (v: unknown): v is undefined => v === undefined,
  'companion:window:close': (v: unknown): v is undefined => v === undefined,
  'companion:window:get-state': (v: unknown): v is undefined => v === undefined,
  'companion:config:get': (v: unknown): v is undefined => v === undefined,
  'companion:config:update': isConfigUpdateRequest,
  'companion:config:test-model': isModelConnectionTestRequest,
  'companion:config:reset-domain': isConfigResetRequest,
  'companion:chat:list': isChatListRequest,
  'companion:chat:create-session': (v: unknown): v is undefined => v === undefined,
  'companion:chat:get-last-session': (v: unknown): v is undefined => v === undefined,
  'companion:chat:send': isChatSendRequest,
  'companion:chat:cancel': isChatCancelRequest,
  'companion:chat:retry': isChatRetryRequest,
  'companion:chat:delete-turn': isChatDeleteTurnRequest,
  'companion:chat:delete-message': isChatDeleteMessageRequest,
  'companion:chat:delete-selected': isChatDeleteSelectedRequest,
  'companion:chat:clear-session': isChatClearSessionRequest,
  'companion:chat:search': isChatSearchRequest,
  // P3C1-07：合规用户反馈（F5-001 §3.7）
  'companion:chat:feedback': isChatFeedbackRequest,
  // P3B-15A：paint ack（合法 requestId/递增 sequence 的语义校验在 handler 侧 tracker）
  'companion:chat:ack-rendered': isChatRenderAckRequest,
  // P3C1-08：合规调试快照（F5-001 §3.10；无载荷）
  'companion:compliance:get-snapshot': (v: unknown): v is undefined => v === undefined,
  // P3A-05：stage capability only，具体 sender 权限由 register.ts capability guard 执行。
  'companion:stage:ready': isLive2dStageReadyRequest,
  'companion:stage:report-state': isLive2dStageReport,
  'companion:live2d:get-state': (v: unknown): v is undefined => v === undefined,
  'companion:live2d:choose-import-source': (v: unknown): v is undefined => v === undefined,
  'companion:live2d:select-model': isLive2dSelectModelRequest,
  'companion:live2d:set-visible': isLive2dVisibleRequest,
  'companion:live2d:reset-window-placement': (v: unknown): v is undefined => v === undefined,
  'companion:live2d:preview-framing': isLive2dFramingPreviewRequest,
  'companion:live2d:retry-load': (v: unknown): v is undefined => v === undefined,
  'companion:debug:get-snapshot': (v: unknown): v is undefined => v === undefined,
  'companion:debug:open-log-folder': (v: unknown): v is undefined => v === undefined,
  // ── Phase 2：memory（9 invoke）──
  'companion:memory:get-overview': (v: unknown): v is undefined => v === undefined,
  'companion:memory:get-l0': (v: unknown): v is undefined => v === undefined,
  'companion:memory:list-l2': isMemoryListRequest,
  'companion:memory:get-detail': isMemoryDetailRequest,
  'companion:memory:set-pinned': isMemoryPinRequest,
  'companion:memory:soft-delete': isMemoryDeleteRequest,
  'companion:memory:restore': isMemoryRestoreRequest,
  'companion:memory:list-recycle-bin': isRecycleBinListRequest,
  'companion:memory:restore-from-recycle-bin': isRecycleBinRestoreRequest,
  'companion:memory:empty-recycle-bin': isRecycleBinEmptyRequest,
  'companion:memory:update-content': isMemoryUpdateContentRequest,
  'companion:memory:set-l0-field': isMemorySetL0FieldRequest,
  'companion:memory:get-dmae-snapshot': (v: unknown): v is undefined => v === undefined,
  'companion:memory:get-dmae-history': isDmaeHistoryRequest,
  // ── Phase 2：growth（3 invoke）──
  'companion:growth:get-profile': (v: unknown): v is undefined => v === undefined,
  'companion:growth:get-timeline': isGrowthTimelineRequest,
  'companion:growth:get-trend': isGrowthTrendRequest,
  // ── Phase 2 P2-32：DMAE 面板（F5-002 §3.7）──
  'companion:dmae:get-panel': isDmaePanelRequest,
  'companion:dmae:get-trend': isDmaeTrendRequest,
  'companion:dmae:explain': isDmaeExplainRequest,
  // ── Phase 2 P2-34：DMAE 基准体检（F5-002 §3.6）──
  'companion:dmae:run-benchmark': isDmaeBenchmarkRequest,
  'companion:dmae:record-qualitative': isDmaeQualitativeRequest,
  // ── M-26：DMAE 异常静音（F5-002 §3.7 第 6 通道）──
  'companion:dmae:mute-anomaly': isDmaeMuteRequest,
  // ── P3B-14：语音设置（ASR 引擎管理/模型下载；chat capability）──
  'companion:voice:get-asr-overview': (v: unknown): v is undefined => v === undefined,
  'companion:voice:asr-download-model': isAsrEngineRequest,
  'companion:voice:asr-cancel-download': isAsrEngineRequest,
  'companion:voice:asr-pause-download': isAsrEngineRequest,
  'companion:voice:asr-resume-download': isAsrEngineRequest,
  'companion:voice:asr-delete-model': isAsrEngineRequest,
  'companion:voice:asr-select-engine': isAsrSelectEngineRequest,
  // ── P3V-09/10：主备选择 + 大资源根目录 ──
  'companion:voice:asr-set-fallback-engine': isAsrSetFallbackEngineRequest,
  'companion:voice:get-asset-root': (v: unknown): v is undefined => v === undefined,
  'companion:voice:choose-asset-root': (v: unknown): v is undefined => v === undefined,
  'companion:voice:reset-asset-root': (v: unknown): v is undefined => v === undefined,
  // ── P3V-16：GPT-SoVITS 运行时一键安装（变体闭集校验；delete 无载荷）──
  'companion:voice:get-gpt-runtime': (v: unknown): v is undefined => v === undefined,
  'companion:voice:gpt-runtime-install': isGptRuntimeVariantRequest,
  'companion:voice:gpt-runtime-pause-download': isGptRuntimeVariantRequest,
  'companion:voice:gpt-runtime-resume-download': isGptRuntimeVariantRequest,
  'companion:voice:gpt-runtime-cancel-download': isGptRuntimeVariantRequest,
  'companion:voice:gpt-runtime-delete': (v: unknown): v is undefined => v === undefined,
  // ── P3V-17：选择/清除已有安装目录（路径只在 main 的原生对话框里出现，不入参）──
  'companion:voice:choose-gpt-runtime-dir': (v: unknown): v is undefined => v === undefined,
  'companion:voice:clear-gpt-runtime-dir': (v: unknown): v is undefined => v === undefined,
  // ── P3V-20：本地导入音色（文件路径不入参；语言/版本闭集；提示词必填）──
  'companion:voice:pick-gpt-voice-file': isGptVoiceFilePickRequest,
  'companion:voice:import-gpt-voice': isGptVoiceImportRequest,
  'companion:voice:delete-gpt-voice': isGptVoiceDeleteRequest,
  // ── P3B-14：语音输入（冻结通道名；测试录音先落地，P3B-18 扩全编排）──
  'companion:voice:start-listening': (v: unknown): v is undefined => v === undefined,
  'companion:voice:stop-listening': (v: unknown): v is undefined => v === undefined,
  // ── P3B-18：TTS 编排（VoiceOrchestrator）──
  'companion:voice:get-state': (v: unknown): v is undefined => v === undefined,
  'companion:voice:test-tts': isVoiceTestTtsRequest,
  'companion:voice:cancel-speaking': (v: unknown): v is undefined => v === undefined
} satisfies { [K in IpcInvokeChannel]: Validator<IpcInvokeMap[K]['req']> }

/**
 * 校验 invoke 通道 payload。
 * 依据 S-003 §3.5 validateIpcPayload。
 */
export function validateIpcPayload<K extends IpcInvokeChannel>(
  channel: K,
  payload: unknown
): payload is IpcInvokeMap[K]['req'] {
  return IPC_VALIDATORS[channel](payload)
}

// === isTrustedSender（S-003 §3.6）===

/** sender 信息（从 IpcMainInvokeEvent 提取） */
export interface SenderInfo {
  url: string
  webContentsId: number
}

/** IPC guard 配置 */
export interface IpcGuardConfig {
  /** 受信任的 origin（dev server URL，或 'file://' 表示打包后本地文件） */
  trustedOrigins: Set<string>
  /** 受信任的 webContents.id 集合（已登记的 BrowserWindow） */
  trustedWebContentsIds: Set<number>
}

/**
 * 判断 sender 是否受信任。
 * 依据 S-003 §3.6：同时校验 webContents.id 和 senderFrame.url。
 * 不能只比 URL--contextIsolation 下恶意帧可伪造 URL。
 *
 * 校验逻辑：
 *   1. webContents.id 必须在 trustedWebContentsIds 中
 *   2. senderFrame.url 的 origin 必须在 trustedOrigins 中
 *   3. file:// 协议用 'file://' 作为 trustedOrigins 的 key
 */
export function isTrustedSender(sender: SenderInfo, config: IpcGuardConfig): boolean {
  // 1. 检查 webContents.id
  if (!config.trustedWebContentsIds.has(sender.webContentsId)) return false

  // 2. 检查 origin
  if (!sender.url) return false
  try {
    const url = new URL(sender.url)
    if (url.protocol === 'file:') {
      return config.trustedOrigins.has('file://')
    }
    return config.trustedOrigins.has(url.origin)
  } catch {
    return false
  }
}
