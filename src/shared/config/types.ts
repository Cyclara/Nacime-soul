// src/shared/config/types.ts
// 配置类型契约
// 依据：S-005 §3.1-§3.7、S-002 §3.3、S-003 §3.5

import type { ErrorCode } from '../errors'
import type { DmaeAnomalyConfig, UserDmaePreset } from '../memory/dmae-config'
import type { ThemeSetting } from './themes'

// === 协议与枚举 ===

export type Protocol = 'openai-compatible' | 'anthropic'
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high'
export type ConfigDomain = 'model' | 'tts' | 'memory' | 'ui' | 'security'

// === Model ===

export interface ModelConfig {
  provider: string
  protocol: Protocol
  baseUrl: string
  model: string
  displayName: string
  temperature: number
  topP: number
  maxTokens: number
  timeoutMs: number
  reasoningEffort: ReasoningEffort
  compatOverrides: {
    thinkingFormat?: 'none' | 'thinking_type' | 'enable_thinking' | 'reasoning_split'
    supportsToolCalls?: boolean
    supportsVision?: boolean
    maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  }
}

// === TTS ===

export interface TtsConfig {
  enabled: boolean
  provider: string
  voiceId: string
  speed: number
  pitch: number
  volume: number
  sampleRate: 16000 | 22050 | 24000 | 44100 | 48000
  cacheEnabled: boolean
  earlyPlaybackEnabled: boolean
}

// === Memory ===

export interface MemoryConfig {
  enabled: boolean
  embeddingProvider: string
  embeddingModel: string
  embeddingDimension: number
  maxActive: number
  minRetrievalScore: number
  /**
   * M-42：L0 归属语义门的独立模型（与提取不同的模型/供应商，便宜小模型档即可）。
   * 各字段空串 = 回退提取同款（chat 模型）；apiKey 复用 secretStore 'modelApiKey'。
   * 纯配置面能力（无设置 UI），setup.ts resolveAttributionGateTarget 消费。
   */
  attributionGate: {
    provider: string
    model: string
    baseUrl: string
  }
  dmae: {
    enabled: boolean
    maxScore: 100
    promptThreshold: number
    userRewardBase: number
    wakeGamma: number
    modelRewardBase: number
    wakeLambda: number
    decayAlpha: number
    decayBeta: number
    /** P2-31.5A：只存用户预设；内置预设常驻代码（BUILTIN_PRESETS）。默认 [] */
    presets: UserDmaePreset[]
    /** P2-31.5A：异常检测静音/窗口，13 个键完整列。 */
    anomaly: DmaeAnomalyConfig
    /** P2-31.5A：每 N 个全局 DMAE turn 采样一次。1..10，默认 1。 */
    historySampleEveryTurns: number
  }
}

// === UI ===

export interface UiConfig {
  locale: 'zh-CN' | 'en-US'
  theme: ThemeSetting
  fontScale: number
  reduceMotion: boolean
  window: {
    width: number
    height: number
    x?: number
    y?: number
    maximized: boolean
  }
  chat: {
    sendOnEnter: boolean
    showTimestamps: boolean
    /** 是否在 UI 显示思考过程（reasoning_content）。默认 true，可在设置关闭 */
    showReasoning: boolean
  }
  live2d: {
    enabled: boolean
    zoom: number
    alwaysOnTop: boolean
  }
}

// === Security ===

export interface SecurityConfig {
  allowHttpLocalhostInDev: boolean
  diagnostics: {
    logLevel: 'error' | 'warn' | 'info' | 'debug'
    retentionDays: number
    maxTotalMb: number
  }
  privacy: {
    includeCrashDumpsInExport: boolean
    monthlyGcDigest: boolean
  }
}

// === 根配置 ===

export interface AppConfigV1 {
  schemaVersion: 1
  model: ModelConfig
  tts: TtsConfig
  memory: MemoryConfig
  ui: UiConfig
  security: SecurityConfig
}

// === 公开快照（给 renderer，不含 API Key）===

export interface PublicModelConfig {
  provider: string
  protocol: Protocol
  baseUrl: string
  model: string
  displayName: string
  temperature: number
  topP: number
  maxTokens: number
  timeoutMs: number
  /** 思考模式档位（UI toggle 只用 'off' 和 'high' 两值） */
  reasoningEffort: ReasoningEffort
  /**
   * 当前 provider/model 是否支持思考模式。
   * false 时 UI toggle 应禁用（灰色 + hover 提示"当前模型不支持思考模式"）。
   * 来自 compat 层：thinkingFormat !== 'none' 即支持。
   */
  supportsThinking: boolean
  hasApiKey: boolean
  validated: boolean
}

export type PublicSecurityConfig = SecurityConfig

export interface PublicConfigSnapshot {
  schemaVersion: number
  model: PublicModelConfig
  ui: UiConfig
  tts: TtsConfig & { hasApiKey: boolean }
  memory: MemoryConfig
  security: PublicSecurityConfig
}

// === IPC 请求/响应 ===

export interface ConfigUpdateRequest {
  expectedSchemaVersion: number
  domains: Partial<{
    model: Partial<ModelConfig> & { apiKey?: string }
    tts: Partial<TtsConfig> & { apiKey?: string }
    memory: Partial<MemoryConfig>
    ui: Partial<UiConfig>
    security: Partial<SecurityConfig>
  }>
}

export interface ConfigResetRequest {
  domain: ConfigDomain
  confirm: true
}

export interface ModelConnectionTestRequest {
  provider: string // 1..64，slug
  baseUrl: string // https；dev 显式允许 localhost
  model: string // 1..128
  apiKey?: string // 1..4096；仅本次调用，不记录
  timeoutMs?: number // 1_000..30_000
}

export interface ConnectionTestResult {
  ok: boolean
  latencyMs?: number
  code?: ErrorCode
}

// === 诊断 ===

export type ConfigStatus = 'ok' | 'missing' | 'invalid' | 'read-error'

export interface ConfigDiagnostics {
  status: ConfigStatus
  path: string
  issues?: Array<{ path: string; message: string }>
  healed: boolean
}

export interface ConfigChangedEvent {
  domain: ConfigDomain
  config: Readonly<AppConfigV1>
}

/** 递归可选类型，用于 ConfigStore.update 的 patch */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P]
}

/**
 * ConfigStore 接口。实现见 src/main/config/store.ts（P1-07）。
 * 依据 S-005 §3.8。
 * subscribe 返回退订函数（结构等同 Unsubscribe，避免与 ipc/contracts 循环依赖）。
 */
export interface ConfigStore {
  /** 读取并校验配置文件，缺失/损坏时用默认值 healing。只在启动时调用一次 */
  setup(): ConfigDiagnostics
  /** 获取当前内存配置（frozen，不可变） */
  get(): Readonly<AppConfigV1>
  /**
   * 合并 patch 到当前配置，校验后原子写入。
   * opts.immediate=true（默认）立即写入；false 时 250ms 防抖（窗口位置/音量等高频项）。
   * 明确"保存"按钮用默认 immediate=true 绕过防抖。
   */
  update(
    patch: DeepPartial<AppConfigV1>,
    opts?: { immediate?: boolean }
  ): Promise<Readonly<AppConfigV1>>
  /** 将指定域重置为默认值 */
  resetDomain(domain: ConfigDomain): Promise<Readonly<AppConfigV1>>
  /** 订阅配置变更事件，返回退订函数 */
  subscribe(listener: (event: ConfigChangedEvent) => void): () => void
}

// === Data DEK 生命周期（P1-09A 实现，此处只定义类型）===

export interface WrappedDataKeyV1 {
  version: 1
  algorithm: 'AES-256-GCM'
  local: { format: 'safeStorage'; ciphertext: string }
  export?: {
    kdf: 'scrypt'
    N: 131072
    r: 8
    p: 1
    salt: string
    iv: string
    tag: string
    wrappedDek: string
  }
}
