// src/main/config/schema/persona.ts
// Persona 域 Valibot schema（F5-001 C0；S-005-补充 §1.3 + 开工裁定 1.2 增补 maxHoldMs）
//
// persona 是用户可写边界：采用 strictObject，错拼字段立即拒绝，
// 避免被静默剥离后让 UI 误以为保存成功。

import * as v from 'valibot'

export const ComplianceGateScopeSchema = v.picklist([
  'first-segment',
  'all-segments',
  'observe',
  'off'
])

const RuleIdSchema = v.pipe(v.string(), v.regex(/^R-[A-Z]{2}-\d{2}$/))

export const ComplianceGateConfigSchema = v.pipe(
  v.strictObject({
    enabled: v.boolean(),
    scope: ComplianceGateScopeSchema,
    firstSegmentMinChars: v.pipe(
      v.number(),
      v.finite(),
      v.integer(),
      v.minValue(1),
      v.maxValue(512)
    ),
    segmentMaxChars: v.pipe(v.number(), v.finite(), v.integer(), v.minValue(64), v.maxValue(4096)),
    budgetMs: v.pipe(v.number(), v.finite(), v.integer(), v.minValue(1), v.maxValue(100)),
    maxRegenerations: v.picklist([0, 1]),
    // 首段时限门（开工裁定 1.2）：整数 100–2000，默认 400，待校准基线
    maxHoldMs: v.pipe(v.number(), v.finite(), v.integer(), v.minValue(100), v.maxValue(2000))
  }),
  v.check(
    (gate) => gate.firstSegmentMinChars <= gate.segmentMaxChars,
    'firstSegmentMinChars 不得大于 segmentMaxChars'
  )
)

export const ComplianceAuditConfigSchema = v.strictObject({
  enabled: v.boolean(),
  sampleRate: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1)),
  timeoutMs: v.pipe(v.number(), v.finite(), v.integer(), v.minValue(1_000), v.maxValue(120_000)),
  recentTurnWindow: v.pipe(v.number(), v.finite(), v.integer(), v.minValue(1), v.maxValue(20))
})

export const ComplianceConfigSchema = v.strictObject({
  gate: ComplianceGateConfigSchema,
  audit: ComplianceAuditConfigSchema,
  disabledRuleIds: v.pipe(
    v.array(RuleIdSchema),
    v.maxLength(256),
    v.check((ids) => new Set(ids).size === ids.length, 'disabledRuleIds 不得包含重复规则 ID')
  ),
  debugCaptureText: v.boolean()
})

export const PersonaConfigSchema = v.strictObject({
  compliance: ComplianceConfigSchema
})
