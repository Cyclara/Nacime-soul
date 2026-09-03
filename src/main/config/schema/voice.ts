// src/main/config/schema/voice.ts
// P3B-14：voice 域 Valibot schema（与 shared/config/types.ts VoiceConfig 一一对应）。
// 引擎 id 闭集：全本地、无云选项（审计裁定 3）；写错值在 schema 层立即拒绝。
//
// P3V-09：闭集 2 → 6（四个新模型），并新增主/备两键：
//   - asrPrimaryEngineId 可选——旧配置只有 asrEngineId，读侧用它迁移；
//   - asrFallbackEngineId 空串=不设备用（null 会被 deepMerge 顶回默认，
//     清除操作静默失效；见 shared/config/types.ts 注释）。

import * as v from 'valibot'
import type { AsrEngineId } from '@shared/voice/asr-settings-types'

/**
 * 引擎 id 闭集（与 shared ASR_ENGINE_IDS 同一集合）。
 * 不 import 数组常量而重新列举：valibot picklist 需要字面量元组做类型推断，
 * 两侧漂移由下方 asrEngineIdSchemaAssertion 编译期护栏兜住。
 */
export const AsrEngineIdSchema = v.picklist([
  'sherpa-sensevoice',
  'funasr-paraformer',
  'zipformer-bilingual-zh-en',
  'paraformer-bilingual-zh-en',
  'zipformer-streaming-zh-14m',
  'parakeet-tdt-v2'
])

/** schema 输出类型必须就是 shared 的 AsrEngineId（防两份闭集漂移）。 */
type AsrEngineIdSchemaOutput = v.InferOutput<typeof AsrEngineIdSchema>
const asrEngineIdSchemaAssertion: AsrEngineIdSchemaOutput extends AsrEngineId
  ? AsrEngineId extends AsrEngineIdSchemaOutput
    ? true
    : never
  : never = true
void asrEngineIdSchemaAssertion

/** 备用引擎：引擎 id 或空串（= 不设备用）。 */
export const AsrFallbackEngineIdSchema = v.union([AsrEngineIdSchema, v.literal('')])

export const VoiceConfigSchema = v.strictObject({
  asrEngineId: AsrEngineIdSchema,
  asrPrimaryEngineId: v.optional(AsrEngineIdSchema),
  asrFallbackEngineId: AsrFallbackEngineIdSchema
})
