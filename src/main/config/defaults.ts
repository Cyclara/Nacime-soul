// src/main/config/defaults.ts
// 默认配置 DOMAIN_DEFAULTS → DEFAULT_CONFIG_V1 + deepFreeze
// 依据：S-005 §3.7；persona 默认值见 S-005-补充 §1.4 + 开工裁定 1.2/1.8

import type { AppConfigV1, ConfigDomain } from '@shared/config/types'
import { DEFAULT_ANOMALY_MUTED, DEFAULT_ANOMALY_WINDOWS } from '@shared/memory/dmae-config'

/**
 * 各域默认值映射类型：逐域对齐 AppConfigV1。
 * 开工裁定 §2.4 原文为 `satisfies Record<ConfigDomain, object>`；此处用等价的
 * 映射类型落地同一护栏且更强——漏一个域、多一个未知域、域内形状错都在此编译失败，
 * 同时保住字面量上下文类型（Record<..., object> 会把 'openai-compatible' 等
 * 字面量放宽成 string，导致 DEFAULT_CONFIG_V1 赋值编译失败）。
 * 与 shared/config/types.ts 的双向断言互为冗余护栏。
 */
type DomainDefaults = { [K in ConfigDomain]: AppConfigV1[K] }

/**
 * 深度冻结对象，使 DEFAULT_CONFIG_V1 在运行时不可变。
 * 防止任何模块意外修改默认值导致后续用户拿到被污染的默认。
 */
function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== 'object') {
    return value
  }
  // 先冻结自身，再递归冻结属性，防止循环引用导致无限递归
  if (!Object.isFrozen(value)) {
    Object.freeze(value)
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item)
    }
  } else {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value as Readonly<T>
}

/**
 * 各域默认值单真源（开工裁定 §2.4 强制，映射类型落地见上方 DomainDefaults 注释）。
 * DMAE 默认值严格为 100/30/20/0.5/8/0.3/1.5/0.3，禁止旧文档误值。
 */
const DOMAIN_DEFAULTS = {
  model: {
    provider: 'deepseek',
    protocol: 'openai-compatible',
    // DeepSeek 官方 base_url（OpenAI 兼容）：https://api.deepseek.com
    // Anthropic 兼容端点：https://api.deepseek.com/anthropic（Phase 4+ Anthropic Adapter 用）
    // 来源：https://api-docs.deepseek.com/zh-cn/（2026-07-15 实测）
    // DeepSeek 同时支持 /v1/chat/completions 和 /chat/completions 路径，此处对齐官方文档
    baseUrl: 'https://api.deepseek.com',
    // deepseek-chat 将于 2026/07/24 废弃，改用 deepseek-v4-flash（DeepSeek V4 Flash，1M 上下文，384K 输出）
    // deepseek-v4-pro 用于复杂推理（Phase 4+ 多模型路由用），用户可在配置里填写
    model: 'deepseek-v4-flash',
    displayName: 'DeepSeek',
    temperature: 0.8,
    topP: 0.95,
    maxTokens: 2048,
    timeoutMs: 60_000,
    reasoningEffort: 'off',
    compatOverrides: {}
  },
  tts: {
    enabled: false,
    provider: 'edge',
    voiceId: '',
    speed: 1,
    pitch: 0,
    volume: 1,
    sampleRate: 24000,
    cacheEnabled: true,
    earlyPlaybackEnabled: false
  },
  memory: {
    enabled: false,
    embeddingProvider: '',
    embeddingModel: '',
    embeddingDimension: 1024,
    maxActive: 15,
    minRetrievalScore: 0.35,
    // M-42：归因门独立模型默认全空 = 回退提取同款 chat 模型
    attributionGate: { provider: '', model: '', baseUrl: '' },
    dmae: {
      enabled: true,
      maxScore: 100,
      promptThreshold: 30,
      userRewardBase: 20,
      wakeGamma: 0.5,
      modelRewardBase: 8,
      wakeLambda: 0.3,
      decayAlpha: 1.5,
      decayBeta: 0.3,
      // P2-31.5A：四字段默认。presets=[]（内置预设常驻代码，不落 config）。
      // muted/windows 完整列 13 键（deepMergeWithDefaults 只遍历默认对象已有键）。
      presets: [],
      anomaly: {
        muted: DEFAULT_ANOMALY_MUTED,
        windows: DEFAULT_ANOMALY_WINDOWS
      },
      historySampleEveryTurns: 1
    },
    gc: {
      archiveToSoftDeleteDays: { one_off: 30, situational: 60, stable: null },
      softDeleteToPurgeDays: 90,
      recentAccessGraceDays: 90,
      anchorImportanceMin: 8,
      maxPurgePerRun: 500,
      schedule: { idleMinutes: 5, minIntervalHours: 20, eagerCountThreshold: 5000 },
      monthlyDigest: false,
      coldStorage: { enabled: true, dir: 'data/cold' }
    }
  },
  ui: {
    locale: 'zh-CN',
    theme: 'light', // P2-46：默认浅色（此前 'system' 跟随 OS，深色系统会开局深色）
    fontScale: 1,
    reduceMotion: false,
    onboarding: {
      version: 1,
      stage: 'provider-setup',
      // 这些可选键必须在 defaults 中占位，否则 deepMergeWithDefaults 会静默剔除它们。
      completedAt: undefined,
      voiceSendMode: undefined
    },
    // x/y 以 undefined 占位键列出：deepMergeWithDefaults 只遍历默认对象已有键，
    // 不占位则运行期写入的窗口位置会被静默剔除（66143e6 漏网缺陷，08-22 真机验收抓获）；
    // JSON.stringify 落盘时丢弃 undefined——首次启动 config 仍无 x/y，Electron 居中语义不变
    window: { width: 900, height: 720, x: undefined, y: undefined, maximized: false },
    chat: { sendOnEnter: true, showTimestamps: false, showReasoning: true },
    live2d: {
      enabled: false,
      zoom: 1,
      alwaysOnTop: true,
      offsetX: 0,
      offsetY: 0,
      selectedModelId: undefined
    }
  },
  security: {
    allowHttpLocalhostInDev: true,
    diagnostics: { logLevel: 'info', retentionDays: 7, maxTotalMb: 50 },
    privacy: { includeCrashDumpsInExport: false, monthlyGcDigest: false }
  },
  persona: {
    compliance: {
      gate: {
        // 开工裁定 1.8：默认 true + scope='observe'——"默认安装不干预"由 observe 承担；
        // enabled=false 是 kill switch（连遥测采集也停止）。
        enabled: true,
        scope: 'observe',
        firstSegmentMinChars: 32, // 待校准基线，C2 门前回放网格定稿
        segmentMaxChars: 512,
        budgetMs: 30,
        maxRegenerations: 1,
        maxHoldMs: 400 // 开工裁定 1.2：首段时限门默认 400ms（待校准基线）
      },
      audit: {
        enabled: true,
        sampleRate: 0.25,
        timeoutMs: 20_000,
        recentTurnWindow: 3
      },
      disabledRuleIds: [],
      // 默认 false；仅开发构建允许实际生效（F5-001 §5 隐私红线）
      debugCaptureText: false
    }
  }
} satisfies DomainDefaults

/**
 * Phase 1 默认配置。schemaVersion + 六域，全部值来自 DOMAIN_DEFAULTS。
 */
export const DEFAULT_CONFIG_V1: Readonly<AppConfigV1> = deepFreeze({
  schemaVersion: 1,
  ...DOMAIN_DEFAULTS
})

export { deepFreeze }
