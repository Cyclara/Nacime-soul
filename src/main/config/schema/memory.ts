// src/main/config/schema/memory.ts
// Memory 域 Valibot schema
// 依据：S-005 §3.4、S-005-补充 §1.3/§1.4/§1.5/§1.6（P2-31.5A 冻结的四字段 schema）

import * as v from 'valibot'
import { ANOMALY_RULE_IDS, PRESET_ID_REGEX, type AnomalyRuleId } from '@shared/memory/dmae-config'

// === 预设 schema（S-005-补充 §1.3）===

const TimestampSchema = v.pipe(
  v.number(),
  v.finite(),
  v.integer(),
  v.minValue(0),
  v.maxValue(Number.MAX_SAFE_INTEGER)
)

const PresetIdSchema = v.pipe(
  v.string(),
  v.trim(),
  v.regex(PRESET_ID_REGEX, '预设 id 必须匹配 preset.user.* 命名空间')
)

/** 可调参数的 overrides（partial，允许空对象 = 命名的默认基线） */
const TunableOverridesSchema = v.partial(
  v.strictObject({
    promptThreshold: v.pipe(v.number(), v.finite(), v.minValue(1), v.maxValue(99)),
    userRewardBase: v.pipe(v.number(), v.finite(), v.minValue(10), v.maxValue(30)),
    wakeGamma: v.pipe(v.number(), v.finite(), v.minValue(0.3), v.maxValue(0.8)),
    modelRewardBase: v.pipe(v.number(), v.finite(), v.minValue(5), v.maxValue(12)),
    wakeLambda: v.pipe(v.number(), v.finite(), v.minValue(0.1), v.maxValue(0.5)),
    decayAlpha: v.pipe(v.number(), v.finite(), v.minValue(0.3), v.maxValue(2)),
    decayBeta: v.pipe(v.number(), v.finite(), v.minValue(0.05), v.maxValue(0.5))
  })
)

export const UserDmaePresetSchema = v.pipe(
  v.strictObject({
    id: PresetIdSchema,
    name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(40)),
    description: v.pipe(v.string(), v.trim(), v.maxLength(160)),
    baseline: v.literal('default'),
    overrides: TunableOverridesSchema,
    /** config 中只允许用户预设；builtin=true 只存在于代码常量 */
    builtin: v.literal(false),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema
  }),
  v.check((preset) => preset.updatedAt >= preset.createdAt, 'updatedAt 不能早于 createdAt')
)

export const DmaePresetsSchema = v.pipe(
  v.array(UserDmaePresetSchema),
  v.maxLength(50),
  v.check(
    (presets) => new Set(presets.map((preset) => preset.id)).size === presets.length,
    '预设 id 必须唯一'
  )
)

// === 异常检测窗口 schema（S-005-补充 §1.4.2）===

const MuteUntilSchema = v.pipe(
  v.number(),
  v.finite(),
  v.integer(),
  v.minValue(0),
  v.maxValue(Number.MAX_SAFE_INTEGER)
)

const WindowDaysSchema = v.pipe(v.number(), v.finite(), v.integer(), v.minValue(1), v.maxValue(365))

const WindowTurnsSchema = v.pipe(
  v.number(),
  v.finite(),
  v.integer(),
  v.minValue(1),
  v.maxValue(10_000)
)

const DaysWindowSchema = v.strictObject({ days: WindowDaysSchema })
const TurnsWindowSchema = v.strictObject({ turns: WindowTurnsSchema })
const DaysAndTurnsWindowSchema = v.strictObject({
  days: WindowDaysSchema,
  turns: WindowTurnsSchema
})
const NoWindowSchema = v.strictObject({})

/**
 * 不用 v.record：固定 strictObject 才能要求 13 个键在标准输出中全部存在。
 * 每条规则的窗口维度按 F5-002 §3.3 冻结，拒绝不支持的维度。
 */
export const DmaeAnomalyMutedSchema = v.strictObject({
  R01: MuteUntilSchema,
  R02: MuteUntilSchema,
  R03: MuteUntilSchema,
  R04: MuteUntilSchema,
  R05: MuteUntilSchema,
  R06: MuteUntilSchema,
  R07: MuteUntilSchema,
  R08: MuteUntilSchema,
  R09: MuteUntilSchema,
  R10: MuteUntilSchema,
  R11: MuteUntilSchema,
  R12: MuteUntilSchema,
  R13: MuteUntilSchema
})

export const DmaeAnomalyWindowsSchema = v.strictObject({
  R01: DaysWindowSchema,
  R02: DaysWindowSchema,
  R03: DaysWindowSchema,
  R04: TurnsWindowSchema,
  R05: TurnsWindowSchema,
  R06: NoWindowSchema,
  R07: TurnsWindowSchema,
  R08: TurnsWindowSchema,
  R09: DaysWindowSchema,
  R10: DaysAndTurnsWindowSchema,
  R11: DaysWindowSchema,
  R12: NoWindowSchema,
  R13: NoWindowSchema
})

export const DmaeAnomalyConfigSchema = v.strictObject({
  muted: DmaeAnomalyMutedSchema,
  windows: DmaeAnomalyWindowsSchema
})

// === 历史采样频率 schema（S-005-补充 §1.5）===

export const HistorySampleEveryTurnsSchema = v.pipe(
  v.number(),
  v.finite(),
  v.integer(),
  v.minValue(1),
  v.maxValue(10)
)

// === 合并后的 DmaeConfigSchema（S-005-补充 §1.6）===

/**
 * DMAE 子配置 schema。
 * 既有 9 字段 + P2-31.5A 四字段（presets/anomaly/historySampleEveryTurns）。
 * 默认值严格为 100/30/20/0.5/8/0.3/1.5/0.3。
 */
const DmaeConfigSchema = v.strictObject({
  enabled: v.boolean(),
  maxScore: v.literal(100),
  promptThreshold: v.pipe(v.number(), v.finite(), v.minValue(1), v.maxValue(99)),
  userRewardBase: v.pipe(v.number(), v.finite(), v.minValue(10), v.maxValue(30)),
  wakeGamma: v.pipe(v.number(), v.finite(), v.minValue(0.3), v.maxValue(0.8)),
  modelRewardBase: v.pipe(v.number(), v.finite(), v.minValue(5), v.maxValue(12)),
  wakeLambda: v.pipe(v.number(), v.finite(), v.minValue(0.1), v.maxValue(0.5)),
  decayAlpha: v.pipe(v.number(), v.finite(), v.minValue(0.3), v.maxValue(2)),
  decayBeta: v.pipe(v.number(), v.finite(), v.minValue(0.05), v.maxValue(0.5)),
  // P2-31.5A 冻结
  presets: DmaePresetsSchema,
  anomaly: DmaeAnomalyConfigSchema,
  historySampleEveryTurns: HistorySampleEveryTurnsSchema
})

// === M-42 归因门独立模型 schema（空串 = 回退提取同款）===

export const AttributionGateConfigSchema = v.strictObject({
  provider: v.pipe(v.string(), v.trim(), v.maxLength(64)),
  model: v.pipe(v.string(), v.trim(), v.maxLength(128)),
  baseUrl: v.pipe(v.string(), v.trim(), v.maxLength(256))
})

/**
 * Memory 配置 schema。
 * Phase 1 只存配置，不实现实际记忆功能（Phase 2+）。
 */
export const MemoryConfigSchema = v.object({
  enabled: v.boolean(),
  embeddingProvider: v.pipe(v.string(), v.trim(), v.maxLength(64)),
  embeddingModel: v.pipe(v.string(), v.trim(), v.maxLength(128)),
  embeddingDimension: v.pipe(v.number(), v.integer(), v.minValue(64), v.maxValue(8192)),
  maxActive: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50)),
  minRetrievalScore: v.pipe(v.number(), v.finite(), v.minValue(-1), v.maxValue(1)),
  attributionGate: AttributionGateConfigSchema,
  dmae: DmaeConfigSchema
})

// re-export ANOMALY_RULE_IDS 供测试/诊断模块按 id 集合核对
export { ANOMALY_RULE_IDS }
export type { AnomalyRuleId }
