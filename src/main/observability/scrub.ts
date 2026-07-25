// src/main/observability/scrub.ts
// 脱敏管道：写盘前最后一道，对 msg 和 detail 生效
// 依据：F5-011 §3、S-001 P1-12

import { SCRUB_RULES, type ScrubRule } from '@shared/observability/types'

/**
 * 依序应用脱敏规则。
 * 默认用 SCRUB_RULES（F5-011 §3 定义），可传入自定义规则集。
 *
 * 管道顺序：openai-key -> bearer -> generic-key -> win-userpath -> unix-home
 *          -> data-uri -> long-base64 -> email -> cn-mobile -> url-query
 *
 * String.replace 配合 g-flag regex 不修改 lastIndex，多次调用安全。
 * 依据 F5-011 §3。
 */
export function scrub(text: string, rules?: ScrubRule[]): string {
  const activeRules = rules ?? SCRUB_RULES
  let result = text
  for (const rule of activeRules) {
    result = result.replace(rule.pattern, rule.replacement)
  }
  return result
}
