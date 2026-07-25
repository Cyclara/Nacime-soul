// src/main/config/schema/memory.ts
// Memory 域 Valibot schema
// 依据：S-005 §3.4

import * as v from 'valibot'

/**
 * DMAE 子配置 schema。
 * 默认值严格为 100/30/20/0.5/8/0.3/1.5/0.3。
 * 禁止使用旧文档误值 15、0.15、0.1（S-005 §3.4）。
 */
const DmaeConfigSchema = v.object({
  enabled: v.boolean(),
  maxScore: v.literal(100),
  promptThreshold: v.pipe(v.number(), v.finite(), v.minValue(1), v.maxValue(99)),
  userRewardBase: v.pipe(v.number(), v.finite(), v.minValue(10), v.maxValue(30)),
  wakeGamma: v.pipe(v.number(), v.finite(), v.minValue(0.3), v.maxValue(0.8)),
  modelRewardBase: v.pipe(v.number(), v.finite(), v.minValue(5), v.maxValue(12)),
  wakeLambda: v.pipe(v.number(), v.finite(), v.minValue(0.1), v.maxValue(0.5)),
  decayAlpha: v.pipe(v.number(), v.finite(), v.minValue(0.3), v.maxValue(2)),
  decayBeta: v.pipe(v.number(), v.finite(), v.minValue(0.05), v.maxValue(0.5))
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
  dmae: DmaeConfigSchema
})
