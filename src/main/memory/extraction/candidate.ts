// src/main/memory/extraction/candidate.ts
// MemoryCandidate 唯一 ABI + 给模型的 JSON Schema。依据 S-010 §1.2-§1.3。
//
// 设计要点：
//   1. parser 先产出不可变 RawMemoryCandidate，再附加 candidateId 成为 MemoryCandidate
//   2. candidateId 由解析器按 envelope 次序赋值（`${turnId}:${index}`），不让 LLM 生成
//   3. 不得把 shouldWrite/reason/contextSummary 加进稳定 ABI（是否写由 Judge 决定）
//   4. forbiddenOverclaims 非空时 Judge 无条件拒绝
//
// 安全红线：
//   - evidence.role 固定 'user'（Phase 2 候选证据只允许 user）
//   - evidence.quote 必须逐字复制自 user message（Judge 做子串校验）
//   - 模型的 confidence/certainty/attribution 全不可信，Judge 回查当前 turn

import type { L0FieldKey } from '../l0-store'
import type { MemoryType } from '../l2-store'

export type MemoryTargetLayer = 'l0' | 'l1' | 'l2'
export type CandidateCertainty = 'explicit' | 'inferred' | 'uncertain'
export type CandidateAttribution = 'user_explicit' | 'assistant_inferred' | 'mixed'
export type CandidateImportance = 'low' | 'medium' | 'high'

export interface MemoryEvidenceRef {
  /** 必须属于当前 turn，且可在 SessionStore 查到 */
  messageId: string
  /** Phase 2 候选证据只允许 user；保留 role 是为了 schema 自证与拒绝测试 */
  role: 'user'
  /** 逐字短引文；trim 后必须是该消息正文的连续子串 */
  quote: string
}

export interface MemoryCandidate {
  /** 由解析器按 envelope 次序赋值，不让 LLM 生成。格式：`${turnId}:${index}` */
  candidateId: string
  targetLayer: MemoryTargetLayer
  /** 仅 targetLayer='l0' 时必填；其余层禁止携带 */
  field?: L0FieldKey
  /** 保守、可独立理解的陈述；不是命令 */
  content: string
  /** 模型建议值；Judge 会结合来源重新夹取/降级 */
  confidence: number // 0..1
  certainty: CandidateCertainty
  attribution: CandidateAttribution
  evidence: readonly MemoryEvidenceRef[] // 1..3
  /** 仅 L2 必填，映射 F5-004 MemoryType；L0/L1 禁止携带 */
  memoryType?: MemoryType
  /** 仅 L2 使用；默认由 importance 映射为 3/5/8 */
  importance?: CandidateImportance
  /** 模型发现的过度概括标记；非空必拒绝 */
  forbiddenOverclaims: readonly string[] // 0..8，每项 1..32 字符
}

/** parser 产出的中间类型（无 candidateId），附加 ID 后成为 MemoryCandidate */
export type RawMemoryCandidate = Omit<MemoryCandidate, 'candidateId'>

export interface MemoryCandidateEnvelope {
  schemaVersion: 1
  candidates: readonly RawMemoryCandidate[] // 0..8
}

// === 给模型的 JSON Schema（S-010 §1.3）===
// 模型返回顶层对象而非裸数组，便于版本化和严格 schema 模式。
// 即使 provider 不支持 response_format/json_schema，同一份 schema 仍放进 system prompt
// 并在本地重新校验。candidateId 不在 schema 中（本地衍生字段）。

/**
 * 单个候选的 JSON Schema（可复用 $defs.candidate）。
 * envelope schema 的 candidates.items 引用此定义。
 */
export const CANDIDATE_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'targetLayer',
    'content',
    'confidence',
    'certainty',
    'attribution',
    'evidence',
    'forbiddenOverclaims'
  ],
  properties: {
    targetLayer: { enum: ['l0', 'l1', 'l2'] },
    field: {
      enum: [
        'preferredName',
        'name',
        'occupation',
        'likes',
        'dislikes',
        'age',
        'gender',
        'relationship_status',
        'permanentNote'
      ]
    },
    content: { type: 'string', minLength: 1, maxLength: 500 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    certainty: { enum: ['explicit', 'inferred', 'uncertain'] },
    attribution: { enum: ['user_explicit', 'assistant_inferred', 'mixed'] },
    evidence: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['messageId', 'role', 'quote'],
        properties: {
          messageId: { type: 'string', minLength: 1, maxLength: 64 },
          role: { const: 'user' },
          quote: { type: 'string', minLength: 1, maxLength: 240 }
        }
      }
    },
    memoryType: { enum: ['one_off', 'situational', 'stable'] },
    importance: { enum: ['low', 'medium', 'high'] },
    forbiddenOverclaims: {
      type: 'array',
      // 2026-08-20 验收实测：模型把本字段误解为预防性「不得推断清单」而逢项必填，
      // 触发 Judge 无条件拒绝（judge.ts step 4），3/3 候选全灭。此处描述是模型唯一
      // 可见的语义来源（schema 会被逐字嵌进 system prompt），必须写清自报弃用语义。
      description:
        '自报夸大通道：仅当 content 本身超出了 evidence 支持范围时，才把不被支持的夸大点列在这里；列出任意一项即视为该候选不合格，将被直接丢弃。content 完全忠于 evidence 时必须输出空数组 []；禁止把本字段当作预防性的「不得推断清单」填写。',
      maxItems: 8,
      items: { type: 'string', minLength: 1, maxLength: 32 }
    }
  },
  allOf: [
    {
      if: { properties: { targetLayer: { const: 'l0' } }, required: ['targetLayer'] },
      then: { required: ['field'] },
      else: { not: { required: ['field'] } }
    },
    {
      if: { properties: { targetLayer: { const: 'l2' } }, required: ['targetLayer'] },
      then: { required: ['memoryType'] },
      else: {
        not: { anyOf: [{ required: ['memoryType'] }, { required: ['importance'] }] }
      }
    }
  ]
} as const

/**
 * 完整 envelope 的 JSON Schema。S-010 §1.3。
 * 完整 envelope 中任一 candidate schema 非法时整 envelope 丢弃（不逐项救）。
 */
export const CANDIDATE_ENVELOPE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://nacime.local/schema/memory-candidates-v1.json',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'candidates'],
  properties: {
    schemaVersion: { const: 1 },
    candidates: {
      type: 'array',
      maxItems: 8,
      items: CANDIDATE_ITEM_SCHEMA
    }
  }
} as const

// === 字段长度约束（S-010 §1.2 字段约束表）===

export const CANDIDATE_LIMITS = {
  contentMin: 1,
  contentMax: 500,
  l0ValueMax: 120,
  l1TextMax: 240,
  l2ContentMax: 500,
  evidenceMin: 1,
  evidenceMax: 3,
  quoteMin: 1,
  quoteMax: 240,
  messageIdMax: 64,
  forbiddenOverclaimsMax: 8,
  overclaimItemMax: 32,
  candidatesMax: 8,
  envelopeMaxBytes: 64 * 1024 // 64 KiB 输入上限
} as const

/** importance -> L2 importance 数值映射（S-010 §1.2） */
export function importanceToValue(imp: CandidateImportance | undefined): number {
  if (imp === 'low') return 3
  if (imp === 'high') return 8
  return 5 // medium / 默认
}
