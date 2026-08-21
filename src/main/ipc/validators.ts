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
  ChatRetryRequest,
  ChatSendRequest
} from '@shared/chat/types'
import type {
  ConfigResetRequest,
  ConfigUpdateRequest,
  ModelConnectionTestRequest
} from '@shared/config/types'
import type {
  DmaeHistoryRequest,
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
function isConfigResetRequest(value: unknown): value is ConfigResetRequest {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['domain', 'confirm'])) return false
  if (
    value.domain !== 'model' &&
    value.domain !== 'tts' &&
    value.domain !== 'memory' &&
    value.domain !== 'ui' &&
    value.domain !== 'security'
  ) {
    return false
  }
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
      dmae: (v) => isPartialDmaeConfig(v)
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
    alwaysOnTop: (v) => isBoolean(v)
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

/** ConfigUpdateRequest 验证 */
function isConfigUpdateRequest(value: unknown): value is ConfigUpdateRequest {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['expectedSchemaVersion', 'domains'])) return false
  if (!isNumber(value.expectedSchemaVersion, { integer: true, min: 0 })) return false
  if (!isPlainObject(value.domains)) return false
  if (!hasOnlyKeys(value.domains, ['model', 'tts', 'memory', 'ui', 'security'])) {
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

/** M-44：编辑 L2 内容——trim 前 1..500 字符（上限与提取管线 judge.ts L2 一致） */
function isMemoryUpdateContentRequest(value: unknown): value is MemoryUpdateContentRequest {
  if (!isPlainObject(value)) return false
  if (!hasOnlyKeys(value, ['memoryId', 'content'])) return false
  return isMemoryId(value.memoryId) && isString(value.content, { minLen: 1, maxLen: 500 })
}

/** L0 白名单字段 key 真源：main 侧 L0_FIELD_DESCRIPTIONS（S-011 §1.3） */
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
  'companion:memory:update-content': isMemoryUpdateContentRequest,
  'companion:memory:set-l0-field': isMemorySetL0FieldRequest,
  'companion:memory:get-dmae-snapshot': (v: unknown): v is undefined => v === undefined,
  'companion:memory:get-dmae-history': isDmaeHistoryRequest,
  // ── Phase 2：growth（3 invoke）──
  'companion:growth:get-profile': (v: unknown): v is undefined => v === undefined,
  'companion:growth:get-timeline': isGrowthTimelineRequest,
  'companion:growth:get-trend': isGrowthTrendRequest,
  // ── Phase 2 P2-32：DMAE 面板（F5-002 §3.7）──
  'companion:dmae:get-panel': (v: unknown): v is undefined => v === undefined,
  'companion:dmae:get-trend': isDmaeTrendRequest,
  'companion:dmae:explain': isDmaeExplainRequest,
  // ── Phase 2 P2-34：DMAE 基准体检（F5-002 §3.6）──
  'companion:dmae:run-benchmark': isDmaeBenchmarkRequest,
  'companion:dmae:record-qualitative': isDmaeQualitativeRequest,
  // ── M-26：DMAE 异常静音（F5-002 §3.7 第 6 通道）──
  'companion:dmae:mute-anomaly': isDmaeMuteRequest
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
