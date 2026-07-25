// src/main/config/schema/model.ts
// Model 域 Valibot schema
// 依据：S-005 §3.2

import * as v from 'valibot'

/** Provider 协议。Phase 1 运行时只注册 openai-compatible；anthropic 仅为向前兼容的存储值，不能执行 */
export const ProtocolSchema = v.picklist(['openai-compatible', 'anthropic'])

/** 推理力度。日常聊天用 off */
export const ReasoningEffortSchema = v.picklist(['off', 'low', 'medium', 'high'])

/** compatOverrides 字段：显式覆盖 > 自动检测 > 默认 */
const CompatOverridesSchema = v.object({
  thinkingFormat: v.optional(
    v.picklist(['none', 'thinking_type', 'enable_thinking', 'reasoning_split'])
  ),
  supportsToolCalls: v.optional(v.boolean()),
  supportsVision: v.optional(v.boolean()),
  maxTokensField: v.optional(v.picklist(['max_tokens', 'max_completion_tokens']))
})

/**
 * Model 配置 schema。
 * baseUrl 只做 URL 格式校验；https/localhost 限制由 network-policy（P1-09B）层执行。
 */
export const ModelConfigSchema = v.object({
  provider: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(64)),
  protocol: ProtocolSchema,
  baseUrl: v.pipe(v.string(), v.trim(), v.url(), v.maxLength(2048)),
  model: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(128)),
  displayName: v.pipe(v.string(), v.trim(), v.maxLength(64)),
  temperature: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(2)),
  topP: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1)),
  maxTokens: v.pipe(v.number(), v.integer(), v.minValue(64), v.maxValue(65_536)),
  timeoutMs: v.pipe(v.number(), v.integer(), v.minValue(1_000), v.maxValue(300_000)),
  reasoningEffort: ReasoningEffortSchema,
  compatOverrides: CompatOverridesSchema
})
