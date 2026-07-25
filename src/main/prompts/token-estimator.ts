// src/main/prompts/token-estimator.ts
// P1-21A: Token 估算器
// 依据：S-001 P1-21A、技术分析 §2.7（预算纪律）、Pi estimateTokens
//
// 估算策略（S-001 P1-21A 风险"tokenizer 估算与供应商计数有偏差"）：
//   - CJK 字符（中日韩）：~1 token/字符（保守估计，实际 1-2 token）
//   - ASCII/其他字符：~4 字符/token（沿用 Pi 的 chars/4 估算）
//   - 混合文本：分别计算后相加
//
// 这个估算故意偏保守（对 CJK 高估），因为预算器宁可过早裁剪也不要超预算。
// 真实 token 计数由 provider 返回的 usage chunk 提供，预算器只用估算做预裁剪。

/**
 * 估算文本的 token 数。
 *
 * CJK 字符按 ~1 token/字符 估算，其他字符按 ~4 字符/token 估算。
 * 空字符串返回 0。
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0

  let cjk = 0
  let other = 0

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    // CJK Unified Ideographs (0x4E00-0x9FFF)
    // CJK Symbols and Punctuation (0x3000-0x303F)
    // Hiragana (0x3040-0x309F), Katakana (0x30A0-0x30FF)
    // Hangul Syllables (0xAC00-0xD7AF)
    // CJK Compatibility (0xF900-0xFAFF)
    // Fullwidth Forms (0xFF00-0xFFEF)
    if (
      (code >= 0x3000 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xffef)
    ) {
      cjk++
    } else {
      other++
    }
  }

  return Math.ceil(cjk + other / 4)
}

/**
 * 估算 LlmMessage 数组的总 token 数（不含 system 消息分隔开销）。
 */
export function estimateMessagesTokens(messages: Array<{ content: string }>): number {
  return messages.reduce((sum, msg) => sum + estimateTokens(msg.content), 0)
}
