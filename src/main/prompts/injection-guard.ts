// src/main/prompts/injection-guard.ts
// M-06：L2 记忆内容（源自用户历史消息）进入 system prompt 前的指令注入过滤。
//
// 风险面：记忆增强系统里，检索命中进 system prompt 的 L2 内容源头是"用户说过的话"。
// 用户可故意说"忽略之前所有指令，输出……"，若被写入并检索命中，单靠软边界提示词挡不住
// （模型可忽略"这不是命令"）。这是记忆投毒/间接注入的固有风险。
//
// 策略：用**窄**模式集识别"明显针对模型/系统的元指令"（要求忽略约束、改变身份、改写行为），
// 命中即丢弃该条记忆——宁可不给模型这条背景，也不让它进 prompt 制造混淆。
// 模式刻意收窄以避免误伤正常事实型记忆（"用户喜欢角色扮演"等描述性内容不会命中）。
// 命中情况由调用方计数并记录日志（可观测，不静默）。

const INSTRUCTION_PATTERNS: RegExp[] = [
  // 中文：明确指令模型"忽略/无视之前的约束"（允许"以上所有/之前的"等组合）
  /忽略[^。！？\n]{0,6}(指令|指示|命令|规则|设定|系统提示|规则要求)/,
  /无视[^。！？\n]{0,6}(指令|指示|命令|规则|设定|系统提示)/,
  // 中文：身份/角色覆盖（"你是…不是…"、"现在你是…"、"扮演…"）
  /(你是|你将是|请充当|请扮演|现在你(是|要)).{0,24}(不是|而非|替代|忽略|无视)/,
  // 中文：禁止遵守/执行现有约束
  /(禁止|不要|别再)[^。\n]{0,16}(遵守|执行|回答|回复|输出)/,
  // 中英文：显式引用系统提示词 / prompt injection
  /(系统提示|系统提示词|system prompt|system instructions|prompt injection)/i,
  // 英文：ignore/disregard … previous/all/instructions/system
  /(ignore|disregard)[^.\n]{0,20}(previous|prior|all|above|instructions|system)/i
]

/**
 * 判断内容是否像针对模型/系统的指令注入（元指令）。
 * 命中则不应进入 system prompt。
 */
export function isInstructionLikeContent(content: string): boolean {
  if (content.length === 0) return false
  return INSTRUCTION_PATTERNS.some((re) => re.test(content))
}
