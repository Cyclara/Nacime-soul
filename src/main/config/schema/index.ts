// src/main/config/schema/index.ts
// 根配置 schema：组合六域 + schemaVersion
// 依据：S-005 §3.1、§3.2-§3.6；persona 域见 S-005-补充 §1.3

import * as v from 'valibot'
import { ModelConfigSchema } from './model'
import { TtsConfigSchema } from './tts'
import { MemoryConfigSchema } from './memory'
import { UiConfigSchema } from './ui'
import { SecurityConfigSchema } from './security'
import { PersonaConfigSchema } from './persona'
import { VoiceConfigSchema } from './voice'

/**
 * 根配置 schema。config.json 的结构契约。
 * schemaVersion 用 v.literal(1) 锁定，向前兼容由 F5-013 MigrationRunner 处理。
 */
export const AppConfigSchema = v.object({
  schemaVersion: v.literal(1),
  model: ModelConfigSchema,
  tts: TtsConfigSchema,
  memory: MemoryConfigSchema,
  ui: UiConfigSchema,
  security: SecurityConfigSchema,
  persona: PersonaConfigSchema,
  voice: VoiceConfigSchema
})

/** schema 的输入类型（用户提供的原始数据，可能含 unknown key） */
export type AppConfigInput = v.InferInput<typeof AppConfigSchema>

/** schema 的输出类型（校验后的干净数据），应与 AppConfigV1 结构一致 */
export type AppConfigOutput = v.InferOutput<typeof AppConfigSchema>

// re-export 各域 schema，供 ConfigStore 分域校验使用
export { ModelConfigSchema, ProtocolSchema, ReasoningEffortSchema } from './model'
export { TtsConfigSchema } from './tts'
export { MemoryConfigSchema } from './memory'
export { UiConfigSchema } from './ui'
export { SecurityConfigSchema } from './security'
export { PersonaConfigSchema, ComplianceGateScopeSchema } from './persona'
export { VoiceConfigSchema, AsrEngineIdSchema } from './voice'
