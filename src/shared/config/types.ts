// src/shared/config/types.ts
// 配置类型契约
// 依据：S-005 §3.1-§3.7、S-002 §3.3、S-003 §3.5

import type { ErrorCode } from '../errors'
import type { DmaeAnomalyConfig, UserDmaePreset } from '../memory/dmae-config'
import type { ComplianceGateScope } from '../compliance/types'
import type { GcPolicy } from '../memory/gc-types'
import type { AsrEngineId } from '../voice/asr-settings-types'
import type { ThemeSetting } from './themes'

// === 协议与枚举 ===

export type Protocol = 'openai-compatible' | 'anthropic'
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high'

/**
 * 配置域单真源（F5-勘误-2026-08-24-Phase3开工裁定 §2.1/§2.2 强制）。
 * ConfigDomain 由本常量派生；detectChangedDomain、reset-domain 域白名单、
 * renderer 侧域遍历一律从本常量派生，禁止再维护人工域数组。
 */
export const CONFIG_DOMAINS = [
  'model',
  'tts',
  'memory',
  'ui',
  'security',
  'persona',
  'voice'
] as const
export type ConfigDomain = (typeof CONFIG_DOMAINS)[number]

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
  /** P3G：GC 管保留权，DMAE 不得写入该策略或 L2 生命周期。 */
  gc?: GcPolicy
}

// === UI ===

export type OnboardingStage =
  | 'provider-setup'
  | 'connection-test'
  /** P3V-14：模型连接成功后、第一次见面前的可跳过语音资源设置。 */
  | 'voice-setup'
  | 'first-conversation'
  | 'complete'

export interface OnboardingConfigV1 {
  /** 引导内容版本；后续文案升级据此决定是否提示，不重跑首次见面。 */
  version: 1
  stage: OnboardingStage
  /** 首次完成时间；未完成时省略。 */
  completedAt?: number
  /** Phase 3b 首次启用语音时才写；本阶段仅预留持久化合同。 */
  voiceSendMode?: 'draft' | 'send'
}

export interface UiConfig {
  locale: 'zh-CN' | 'en-US'
  theme: ThemeSetting
  fontScale: number
  reduceMotion: boolean
  onboarding: OnboardingConfigV1
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
    /**
     * 取景偏移，单位为画布尺寸百分比（-100..100），与分辨率无关，窗口缩放后构图不变。
     * offsetX 正数向右；offsetY 正数向上——上移会露出更多身体，配合较小 zoom 即为全身取景。
     */
    offsetX: number
    offsetY: number
    /** main-owned registry model ID；undefined 保持旧配置兼容，由 main 选择默认模型。 */
    selectedModelId?: string
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

// === Persona（F5-001 C0；S-005-补充 §1.2 + 开工裁定 §1.2/§1.8）===

export interface ComplianceGateConfig {
  /** 门控管线总开关（含遥测采集）。默认 true；false = kill switch（Null Object，不采集）。 */
  enabled: boolean
  /** 干预级别。默认 'observe'——"默认安装不干预"由 observe 单独承担（裁定 1.8）。 */
  scope: ComplianceGateScope
  /** 首段边界门的保留阈值下限。默认 32（待校准基线，C2 门前回放网格定稿）。 */
  firstSegmentMinChars: number
  /** 单个 segment 的硬上限。默认 512。 */
  segmentMaxChars: number
  /** 单轮同步正则 CPU 预算。默认 30。 */
  budgetMs: number
  /** 架构只允许不重生成或重生成一次。 */
  maxRegenerations: 0 | 1
  /** 首段时限门：自首个非空 delta 起的墙钟上限（裁定 1.2）。整数 100–2000，默认 400（待校准基线）。 */
  maxHoldMs: number
}

export interface ComplianceAuditConfig {
  enabled: boolean
  /** 非强制轮的随机审计率；规则命中/用户反馈可由运行时策略强制送审。 */
  sampleRate: number
  timeoutMs: number
  recentTurnWindow: number
}

export interface ComplianceConfig {
  gate: ComplianceGateConfig
  audit: ComplianceAuditConfig
  /** 数组整体替换；默认 []。禁止改 Record（deepMergeWithDefaults 只遍历默认对象 key）。 */
  disabledRuleIds: string[]
  /** 默认 false；仅开发构建允许实际生效。 */
  debugCaptureText: boolean
}

export interface PersonaConfig {
  compliance: ComplianceConfig
}

// === Voice（P3B-14；S-Phase3 语音设置；配置键走账本流程登记）===

export interface VoiceConfig {
  /**
   * ASR 引擎（闭集，全本地，无云选项；默认 SenseVoice）。
   * 切换 = 丢弃旧引擎实例 + 新引擎完整重载（P3B-11 冻结政策）。
   *
   * P3V-09 起本键是「当前生效引擎」的**兼容读法**：主选择的新写法是
   * `asrPrimaryEngineId`，写路径两键同写保持一致；旧配置只有本键时，
   * 主引擎由它迁移（读侧 `asrPrimaryEngineId ?? asrEngineId`）。
   */
  asrEngineId: AsrEngineId
  /**
   * P3V-09：主要模型。undefined 占位（旧配置迁移语义），不给实值默认——
   * 否则 deepMerge 会把只有 asrEngineId 的旧用户顶回默认引擎。
   */
  asrPrimaryEngineId?: AsrEngineId
  /**
   * P3V-09：备用模型（识别失败时回退一次）。持久层用 **空串** 而非 null 表达
   * 「不设备用」：deepMergeWithDefaults 会把 null 补丁顶回默认值，null 会让
   * 「清除备用」静默失效（tts.voiceId 空串同款先例）。engine-manager 的 API
   * 边界仍以 null 表达，两态映射只发生在 config 接线处。
   */
  asrFallbackEngineId: AsrEngineId | ''
}

// === 根配置 ===

export interface AppConfigV1 {
  schemaVersion: 1
  model: ModelConfig
  tts: TtsConfig
  memory: MemoryConfig
  ui: UiConfig
  security: SecurityConfig
  persona: PersonaConfig
  voice: VoiceConfig
}

/**
 * 编译期双向断言（开工裁定 §2.3）：ConfigDomain ≡ keyof AppConfigV1 去掉 schemaVersion。
 * 任一侧加域不同步即 typecheck 失败——本行就是护栏，值永不使用。
 */
type AssertMutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
export const configDomainBidirectionalAssertion: AssertMutuallyAssignable<
  ConfigDomain,
  Exclude<keyof AppConfigV1, 'schemaVersion'>
> = true

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
  persona: PersonaConfig
  voice: VoiceConfig
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
    // persona 接受深层局部 patch（S-005-补充 §1.2）；既有五域顶层 Partial 合同不由 C0 改写
    persona: DeepPartial<PersonaConfig>
    voice: Partial<VoiceConfig>
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
