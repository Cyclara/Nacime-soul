// src/renderer/src/live2d/expression/map.ts
// P3A-20：语义情绪到模型 expression alias 的可审计映射。
//
// 模型实际 expression 名称因作者而异；alias 表由 manifest 的 expressionNames 解析，缺失
// 时回 neutral，不抛错、不让聊天轮失败。

import type { Live2dSemanticEmotion } from '@shared/live2d/types'

export type SemanticEmotion = Live2dSemanticEmotion

export interface ExpressionAliasMap {
  readonly neutral: readonly string[]
  readonly smile: readonly string[]
  readonly happy: readonly string[]
  readonly surprised: readonly string[]
  readonly sad: readonly string[]
  readonly angry: readonly string[]
  readonly shy: readonly string[]
  readonly confused: readonly string[]
}

/**
 * 通用别名只按**语义名**匹配。此前这里还带着 `exp_01`..`exp_08` 的编号猜测，但编号与情绪
 * 毫无约定关系——按 Mao 的 .exp3.json 实测，`exp_03` 是纯闭眼、`exp_06` 是害羞、`exp_08`
 * 是生气，与当时「happy/angry/confused」的猜测几乎全错。编号猜测已删除：宁可解析不到回
 * neutral（并打 warn），也不要自信地做出错误表情。内置模型走下面的显式表。
 */
export const DEFAULT_EXPRESSION_ALIASES: ExpressionAliasMap = {
  neutral: ['neutral', 'normal', 'default'],
  smile: ['smile', 'joy'],
  happy: ['happy', 'joy', 'laugh'],
  surprised: ['surprised', 'surprise', 'shock'],
  sad: ['sad', 'sorrow'],
  angry: ['angry', 'anger'],
  shy: ['shy', 'blush', 'blushing'],
  confused: ['confused', 'thinking']
}

/**
 * 内置 Mao 的显式映射，逐条读 `resources/live2d/models/mao/expressions/*.exp3.json` 的实际
 * 参数得出，不是按编号猜的：
 *   exp_01 眼睁×1、其余全 0            → neutral
 *   exp_02 闭眼 + 笑眼                  → smile
 *   exp_03 纯闭眼（无其他通道）          → 非情绪，不映射
 *   exp_04 睁大眼×1.2 + 笑眼 + 眼神效果  → happy / surprised（Mao 无专门惊讶表情，睁大眼最接近）
 *   exp_05 眉尾下垂 + 嘴角下垂           → sad
 *   exp_06 脸红 + 眉尾下垂               → shy
 *   exp_07 睁大眼 + 眼球变形 + 眉上扬 + 嘴角下垂 → confused
 *   exp_08 眼形变化 + 生气嘴 + 怒纹      → angry
 */
export const MAO_EXPRESSION_ALIASES: ExpressionAliasMap = {
  neutral: ['exp_01'],
  smile: ['exp_02', 'exp_04'],
  happy: ['exp_04', 'exp_02'],
  surprised: ['exp_04'],
  sad: ['exp_05'],
  angry: ['exp_08'],
  shy: ['exp_06'],
  confused: ['exp_07']
}

/** 内置模型的表由我们自己核对过资产得出；第三方模型只能靠语义名匹配。 */
export const BUILTIN_EXPRESSION_ALIASES: Readonly<Record<string, ExpressionAliasMap>> = {
  mao: MAO_EXPRESSION_ALIASES
}

/** 受控 URL 形如 `nacime-live2d://model/<id>/<file>`；stage 侧只需要其中的模型 id。 */
export function modelIdFromStageUrl(url: string): string | null {
  const match = /^nacime-live2d:\/\/model\/([^/]+)\//.exec(url)
  return match === null ? null : decodeURIComponent(match[1]!)
}

/** 内置模型用显式表优先、通用语义名兜底；未知模型只用通用表。 */
export function aliasesForModel(modelId: string | null): ExpressionAliasMap {
  const specific = modelId === null ? undefined : BUILTIN_EXPRESSION_ALIASES[modelId]
  if (specific === undefined) return DEFAULT_EXPRESSION_ALIASES
  const keys = Object.keys(DEFAULT_EXPRESSION_ALIASES) as (keyof ExpressionAliasMap)[]
  const merged = {} as { -readonly [K in keyof ExpressionAliasMap]: string[] }
  for (const key of keys) merged[key] = [...specific[key], ...DEFAULT_EXPRESSION_ALIASES[key]]
  return merged
}

export interface ResolvedExpression {
  readonly requested: SemanticEmotion
  readonly resolved: string
  readonly fallback: boolean
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase()
}

export function resolveExpression(
  emotion: SemanticEmotion,
  availableNames: readonly string[],
  aliases: ExpressionAliasMap = DEFAULT_EXPRESSION_ALIASES
): ResolvedExpression {
  const byName = new Map(availableNames.map((name) => [normalize(name), name]))
  const candidates = aliases[emotion]
  for (const candidate of candidates) {
    const resolved = byName.get(normalize(candidate))
    if (resolved !== undefined) return { requested: emotion, resolved, fallback: false }
  }
  for (const candidate of aliases.neutral) {
    const resolved = byName.get(normalize(candidate))
    if (resolved !== undefined) return { requested: emotion, resolved, fallback: true }
  }
  return { requested: emotion, resolved: '', fallback: true }
}
