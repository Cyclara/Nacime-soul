// src/main/voice/tts/segmenter-unicode.ts
// P3B-07 / F5-007-1：grapheme 分段与语音权重长度（§1.7）。
//
// 铁律：`Intl.Segmenter(..., {granularity:'grapheme'})` 是早播运行前提；
// 不可用时抛错（controller 捕获后本轮 text-only），**绝不**用 Array.from() 冒充
// fallback--它虽不切 surrogate pair，仍会拆 ZWJ、肤色修饰符、旗帜与组合附加符
// （ETTS-S09 的 cluster 全在这里守住）。

let segmenterCache: Intl.Segmenter | null | undefined

function getSegmenter(): Intl.Segmenter | null {
  if (segmenterCache === undefined) {
    try {
      segmenterCache = new Intl.Segmenter('und', { granularity: 'grapheme' })
    } catch {
      segmenterCache = null
    }
  }
  return segmenterCache
}

/** Intl.Segmenter grapheme 粒度是否可用（不可用时调用方应整轮降级 text-only）。 */
export function isGraphemeSegmenterAvailable(): boolean {
  return getSegmenter() !== null
}

/** 把文本切成 grapheme cluster 序列；Segmenter 不可用直接抛错（不降级切法）。 */
export function segmentGraphemes(text: string): string[] {
  const segmenter = getSegmenter()
  if (segmenter === null) {
    throw new Error('Intl.Segmenter (grapheme) unavailable: early-tts degrades to text-only')
  }
  const out: string[] = []
  for (const part of segmenter.segment(text)) {
    out.push(part.segment)
  }
  return out
}

const CJK_SCRIPT = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u
const LETTER_OR_NUMBER = /\p{Letter}|\p{Number}/u

/**
 * 语音权重长度：CJK 日韩表意/音节文字每个 grapheme 记 1；其他字母/数字记 0.35；
 * 标点、空白、Markdown marker 记 0（§1.7）。中文一句 8-12 字已可听，
 * 英文 8 字符通常不完整--这就是两个 minUnits 基线的来源。
 */
export function speechUnits(text: string): number {
  let units = 0
  for (const grapheme of segmentGraphemes(text)) {
    if (CJK_SCRIPT.test(grapheme)) {
      units += 1
    } else if (LETTER_OR_NUMBER.test(grapheme)) {
      units += 0.35
    }
  }
  return units
}

/** grapheme 数（target/hard 上限按它计，不按 UTF-16 length）。 */
export function graphemeCount(text: string): number {
  return segmentGraphemes(text).length
}
