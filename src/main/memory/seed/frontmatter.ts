// src/main/memory/seed/frontmatter.ts
// P2-36: Seed 文件 YAML frontmatter 解析器。
// 依据：S-Phase2 P2-36（type/importance/confidence/source/tags）、
//       F5-006（source 字段 creator/user_explicit/inferred）、
//       formulas.ts IMPORTANCE_EXEMPT_THRESHOLD（importance≥10 硬豁免）。
//
// 设计要点：
//   1. 不引入 js-yaml 依赖--seed frontmatter 是固定 5 字段的子集，手写解析更可控
//   2. 格式错误抛 AppError('CFG_INVALID')，由 loader 捕获后跳过该文件
//   3. body = frontmatter 之后的正文（记忆内容），trim 尾部空白
//   4. 与 prompts/builder.ts 的 stripFrontmatter 对齐：---\n...\n---\n

import { AppError } from '@shared/errors'

/** Seed 条目来源（P2-37 source 字段三值） */
export type SeedSource = 'creator' | 'user_explicit' | 'inferred'

/** Seed frontmatter 固定 5 字段 */
export interface SeedFrontmatter {
  /** 固定 'seed' */
  type: 'seed'
  /** 1..10；10 = DMAE Decay 硬豁免（IMPORTANCE_EXEMPT_THRESHOLD） */
  importance: number
  /** 0..1 */
  confidence: number
  /** creator=创建者预置 / user_explicit=用户明确陈述 / inferred=推断 */
  source: SeedSource
  /** 0..16 个标签，每个 1..32 字符 */
  tags: string[]
}

/** 解析结果 */
export interface ParsedSeedFile {
  frontmatter: SeedFrontmatter
  /** frontmatter 之后的正文（记忆内容），trim 后非空 */
  body: string
}

/** frontmatter 正则：---\n...\n---\n */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/** importance 合法范围（与 l2_memories CHECK 约束一致） */
const IMPORTANCE_MIN = 1
const IMPORTANCE_MAX = 10

/** confidence 合法范围 */
const CONFIDENCE_MIN = 0
const CONFIDENCE_MAX = 1

/** tags 上限 */
const TAGS_MAX = 16
/** 单个 tag 长度上限 */
const TAG_MAX_LEN = 32
/** body 长度上限（与 L2 content maxLength 一致，S-020 §1.2） */
const BODY_MAX_LEN = 500

/**
 * 解析 seed 文件的 YAML frontmatter + body。
 *
 * 格式：
 * ```
 * ---
 * type: seed
 * importance: 10
 * confidence: 1.0
 * source: creator
 * tags: [核心认知, 角色身份]
 * ---
 * <body>
 * ```
 *
 * 格式错误（缺字段、类型不符、值越界）抛 AppError('CFG_INVALID')。
 * 调用方应 try/catch 并跳过该文件。
 */
export function parseSeedFrontmatter(content: string): ParsedSeedFile {
  if (typeof content !== 'string' || content.length === 0) {
    throw new AppError({
      code: 'CFG_INVALID',
      severity: 'error',
      retryable: false,
      userMessage: 'seed file content is empty'
    })
  }

  const match = content.match(FRONTMATTER_RE)
  if (!match) {
    throw new AppError({
      code: 'CFG_INVALID',
      severity: 'error',
      retryable: false,
      userMessage: 'seed file missing frontmatter (expected --- ... ---)'
    })
  }

  const yamlBlock = match[1]
  const body = content.slice(match[0].length).trim()
  if (body.length === 0) {
    throw new AppError({
      code: 'CFG_INVALID',
      severity: 'error',
      retryable: false,
      userMessage: 'seed file body is empty'
    })
  }
  if (body.length > BODY_MAX_LEN) {
    throw new AppError({
      code: 'CFG_INVALID',
      severity: 'error',
      retryable: false,
      userMessage: `seed file body exceeds ${BODY_MAX_LEN} chars`
    })
  }

  const fields = parseSimpleYaml(yamlBlock)
  const frontmatter = validateFrontmatter(fields)

  return { frontmatter, body }
}

/**
 * 解析固定子集 YAML（key: value 行 + key: [a, b, c] 数组）。
 * 不支持嵌套对象、多行字符串、引号转义--seed frontmatter 不需要。
 * 未知字段忽略（前向兼容）。
 */
function parseSimpleYaml(yaml: string): Record<string, string> {
  const result: Record<string, string> = {}
  const lines = yaml.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const colonIdx = trimmed.indexOf(':')
    if (colonIdx === -1) continue
    const key = trimmed.slice(0, colonIdx).trim()
    const value = trimmed.slice(colonIdx + 1).trim()
    if (key.length === 0) continue
    result[key] = value
  }
  return result
}

/**
 * 校验 frontmatter 字段并构造 SeedFrontmatter。
 * 任一必填字段缺失或值越界 -> AppError。
 */
function validateFrontmatter(fields: Record<string, string>): SeedFrontmatter {
  // type: 必须为 'seed'
  const type = fields.type
  if (type !== 'seed') {
    throw new AppError({
      code: 'CFG_INVALID',
      severity: 'error',
      retryable: false,
      userMessage: `seed frontmatter type must be 'seed', got: ${type ?? '(missing)'}`
    })
  }

  // importance: 整数 1..10
  const importance = parseNonNegativeInt(fields.importance, 'importance')
  if (importance < IMPORTANCE_MIN || importance > IMPORTANCE_MAX) {
    throw new AppError({
      code: 'CFG_INVALID',
      severity: 'error',
      retryable: false,
      userMessage: `importance must be ${IMPORTANCE_MIN}..${IMPORTANCE_MAX}, got: ${importance}`
    })
  }

  // confidence: 数值 0..1
  const confidence = parseNonNegativeNumber(fields.confidence, 'confidence')
  if (confidence < CONFIDENCE_MIN || confidence > CONFIDENCE_MAX) {
    throw new AppError({
      code: 'CFG_INVALID',
      severity: 'error',
      retryable: false,
      userMessage: `confidence must be ${CONFIDENCE_MIN}..${CONFIDENCE_MAX}, got: ${confidence}`
    })
  }

  // source: 枚举
  const source = fields.source
  if (source !== 'creator' && source !== 'user_explicit' && source !== 'inferred') {
    throw new AppError({
      code: 'CFG_INVALID',
      severity: 'error',
      retryable: false,
      userMessage: `source must be creator/user_explicit/inferred, got: ${source ?? '(missing)'}`
    })
  }

  // tags: 可选；[a, b, c] 或 a 形式
  const tags = parseTags(fields.tags)
  if (tags.length > TAGS_MAX) {
    throw new AppError({
      code: 'CFG_INVALID',
      severity: 'error',
      retryable: false,
      userMessage: `tags exceeds ${TAGS_MAX} items, got: ${tags.length}`
    })
  }
  for (const tag of tags) {
    if (tag.length === 0 || tag.length > TAG_MAX_LEN) {
      throw new AppError({
        code: 'CFG_INVALID',
        severity: 'error',
        retryable: false,
        userMessage: `tag length must be 1..${TAG_MAX_LEN}, got: ${tag.length}`
      })
    }
  }

  return { type, importance, confidence, source, tags }
}

/** 解析非负整数；缺失或非整数 -> AppError */
function parseNonNegativeInt(raw: string | undefined, name: string): number {
  if (raw === undefined || raw === '') {
    throw new AppError({
      code: 'CFG_INVALID',
      severity: 'error',
      retryable: false,
      userMessage: `${name} is required`
    })
  }
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new AppError({
      code: 'CFG_INVALID',
      severity: 'error',
      retryable: false,
      userMessage: `${name} must be a non-negative integer, got: ${raw}`
    })
  }
  return n
}

/** 解析非负数值；缺失或非数 -> AppError */
function parseNonNegativeNumber(raw: string | undefined, name: string): number {
  if (raw === undefined || raw === '') {
    throw new AppError({
      code: 'CFG_INVALID',
      severity: 'error',
      retryable: false,
      userMessage: `${name} is required`
    })
  }
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) {
    throw new AppError({
      code: 'CFG_INVALID',
      severity: 'error',
      retryable: false,
      userMessage: `${name} must be a non-negative number, got: ${raw}`
    })
  }
  return n
}

/**
 * 解析 tags 字段。
 * 支持两种形式：
 *   tags: [a, b, c]    -> ['a', 'b', 'c']
 *   tags: a            -> ['a']
 * 缺失 -> []（tags 可选）
 */
function parseTags(raw: string | undefined): string[] {
  if (raw === undefined || raw === '') return []
  const trimmed = raw.trim()
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim()
    if (inner === '') return []
    return inner
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
  }
  // 单值形式
  return [trimmed]
}
