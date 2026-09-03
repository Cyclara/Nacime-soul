// src/main/voice/tts/segmenter-boundaries.ts
// P3B-07 / F5-007-1：分句边界判定层（§1.8）。
//
// 职责：ScanContext 保护区状态推进 + 边界候选分级 + 英文句号排除（§1.8.3）+
// 不安全结尾（§1.8.4）。只做单 grapheme 判定；提交策略（minUnits/target/hard、
// 尾吸收、多 segment 切分）在 segmenter.ts。

/** 一级强边界标点（§1.8.2）；英文句号 `.` 单独走 isEnglishPeriodBoundary。 */
export const STRONG_PUNCTUATION: ReadonlySet<string> = new Set([
  '。',
  '！',
  '？',
  '；',
  '!',
  '?',
  ';'
])
/** 二级软边界标点：只在 hold/target 触发时可用。 */
export const SOFT_PUNCTUATION: ReadonlySet<string> = new Set(['，', ',', '、', '：', ':'])

export type BoundaryLevel = 'strong' | 'ellipsis' | 'newline' | 'soft' | 'period'

export interface ScanContext {
  parenDepth: number // () （）
  bracketDepth: number // [] 【】
  braceDepth: number // {} ｛
  quoteStack: Array<'“' | '"' | '‘' | "'">
  inlineCode: boolean // `code`
  fencedCode: boolean // ```
  escaped: boolean
  /** 连续反引号计数（``` 三连围栏判定用）。 */
  backtickRun: number
}

export function createScanContext(): ScanContext {
  return {
    parenDepth: 0,
    bracketDepth: 0,
    braceDepth: 0,
    quoteStack: [],
    inlineCode: false,
    fencedCode: false,
    escaped: false,
    backtickRun: 0
  }
}

/** 保护区是否未全部闭合（depth>0 / 引号栈非空 / code 状态）。 */
export function isProtected(context: ScanContext): boolean {
  return (
    context.parenDepth > 0 ||
    context.bracketDepth > 0 ||
    context.braceDepth > 0 ||
    context.quoteStack.length > 0 ||
    context.inlineCode ||
    context.fencedCode
  )
}

const OPEN_PARENS: ReadonlySet<string> = new Set(['(', '（'])
const CLOSE_PARENS: ReadonlySet<string> = new Set([')', '）'])
const OPEN_BRACKETS: ReadonlySet<string> = new Set(['[', '【'])
const CLOSE_BRACKETS: ReadonlySet<string> = new Set([']', '】'])
const OPEN_BRACES: ReadonlySet<string> = new Set(['{', '｛'])
const CLOSE_BRACES: ReadonlySet<string> = new Set(['}', '｝'])
/** 单引号（' 和 ‘）也进栈；LLM 输出常见中西引号混用，按出现序配对。 */
const OPEN_QUOTES: ReadonlyMap<string, '“' | '"' | '‘'> = new Map([
  ['“', '“'],
  ['"', '"'],
  ['‘', '‘'],
  ["'", '‘']
])
const CLOSE_QUOTES: ReadonlyMap<string, '“' | '"' | '‘'> = new Map([
  ['”', '“'],
  ['"', '"'],
  ['’', '‘'],
  ["'", '‘']
])

/**
 * 消费一个 grapheme，推进 ScanContext；返回消费后它构成的边界候选级别
 * （null = 不构成边界）。调用方必须按序逐个消费整段文本。
 *
 * 规则要点：
 *   - `…` 只有与前一个 grapheme 同为 `…` 才是省略号完成（单个先等，防 delta 中切）；
 *   - 换行是强边界，但代码围栏内不算；
 *   - 软边界标点只在保护区全闭合时报告（能否使用由提交策略决定）；
 *   - `.` 报告为 'period' 候选，最终成立与否由 isEnglishPeriodBoundary 判定。
 */
export function consumeGrapheme(
  context: ScanContext,
  grapheme: string,
  prev: string | undefined
): BoundaryLevel | null {
  if (context.escaped) {
    context.escaped = false
    return null
  }

  // 反引号：三连围栏开关优先于 inline code
  if (grapheme === '`') {
    context.backtickRun++
    if (context.backtickRun === 3) {
      context.fencedCode = !context.fencedCode
      context.inlineCode = false
      context.backtickRun = 0
      return null
    }
    if (context.backtickRun === 1 && !context.fencedCode) context.inlineCode = !context.inlineCode
    return null
  }
  context.backtickRun = 0

  // 围栏代码块内：一切字符原样，不产生边界
  if (context.fencedCode) return null

  // 括号 / 引号 / 转义状态推进
  if (OPEN_PARENS.has(grapheme)) {
    context.parenDepth++
  } else if (CLOSE_PARENS.has(grapheme)) {
    if (context.parenDepth > 0) context.parenDepth--
  } else if (OPEN_BRACKETS.has(grapheme)) {
    context.bracketDepth++
  } else if (CLOSE_BRACKETS.has(grapheme)) {
    if (context.bracketDepth > 0) context.bracketDepth--
  } else if (OPEN_BRACES.has(grapheme)) {
    context.braceDepth++
  } else if (CLOSE_BRACES.has(grapheme)) {
    if (context.braceDepth > 0) context.braceDepth--
  } else if (OPEN_QUOTES.has(grapheme)) {
    context.quoteStack.push(OPEN_QUOTES.get(grapheme)!)
  } else if (CLOSE_QUOTES.has(grapheme)) {
    const opener = CLOSE_QUOTES.get(grapheme)!
    // 只在栈顶同型时弹出；不配对的闭引号忽略（容忍 LLM 输出瑕疵）
    if (context.quoteStack[context.quoteStack.length - 1] === opener) context.quoteStack.pop()
  } else if (grapheme === '\\') {
    context.escaped = true
    return null
  }

  // inline code 内：`foo.bar()` 的点不是句末
  if (context.inlineCode) return null

  // 边界候选：只在保护区全闭合时报告（闭括号/闭引号自身不是标点，
  // 它们之后的句末标点才报告--因此 `。”` 序列自然落在闭引号后的 。上）
  if (!isProtected(context)) {
    if (STRONG_PUNCTUATION.has(grapheme)) return 'strong'
    if (grapheme === '…' && prev === '…') return 'ellipsis'
    if (grapheme === '\n') return 'newline'
    if (SOFT_PUNCTUATION.has(grapheme)) return 'soft'
    if (grapheme === '.') return 'period'
  }
  return null
}

// ── 英文句号排除（§1.8.3）──

const KNOWN_ABBREVIATIONS = ['e.g.', 'i.e.', 'mr.', 'dr.', 'vs.', 'etc.', 'st.', 'no.']

export interface PeriodContext {
  readonly prevGrapheme: string | undefined
  readonly nextGrapheme: string | undefined
  /** 句点前同词 token（连续字母/数字/点），如 "example" / "v1" / "3"。 */
  readonly beforeToken: string
  /** 句点后同词 token，如 "com" / "2" / "14"。 */
  readonly afterToken: string
}

/**
 * `.` 是否可作为英文句末边界。排除：数字小数/版本号、URL/email token、
 * 已知缩写后接小写词、连续点的一部分。成立条件：前面是字母/数字，
 * 后面是空白+大写/中文/数字开头（或没有下一个字符，由调用方结合流状态判定）。
 */
export function isEnglishPeriodBoundary(ctx: PeriodContext): boolean {
  const { prevGrapheme, nextGrapheme, beforeToken, afterToken } = ctx
  if (prevGrapheme === undefined) return false
  // 连续点的一部分（... 省略号 / 多点）
  if (prevGrapheme === '.') return false
  if (/[\p{L}\p{N}]/u.test(prevGrapheme) === false) return false
  // §1.8.3 硬前提：句末句点后面必须是空白（3.14 / v1.2.3 / example.com
  // / e.g.xxx 的点后面直接跟字符，一律不是句末）
  if (nextGrapheme === undefined) return false
  if (!/^\s$/u.test(nextGrapheme)) return false
  // beforeToken 含点/@：多点 token 的尾点（e.g 的 "e.g"）、email 用户名段
  if (/[.@]/u.test(beforeToken)) return false
  if (/^(https?|www)$/iu.test(beforeToken)) return false
  // 已知缩写保守排除：Mr. Smith / Dr. Lee / e.g. this 都不在缩写后断句
  if (KNOWN_ABBREVIATIONS.includes(`${beforeToken.toLowerCase()}.`)) return false
  // 下一个词以大写/中文/数字开头 -> 句末边界
  return /^[\p{Lu}\p{Script=Han}\p{N}]/u.test(afterToken)
}

// ── 不安全结尾（§1.8.4）──

const CONNECTIVE_TAILS = [
  '但是',
  '因为',
  '所以说',
  '如果',
  '虽然',
  '不过',
  '然后',
  '接下来',
  'and',
  'but',
  'because',
  'if',
  'so',
  'then'
]

/** 语气词/确认词短答：整段只有它时单位不足（`嗯。` / `好的。`），不早播。 */
export const SHORT_ACKNOWLEDGEMENTS: readonly string[] = [
  '嗯',
  '好的',
  '是的',
  '对',
  '嗯嗯',
  '不',
  '好',
  '哦',
  'OK',
  'ok'
]

/** 剥掉末尾标点与空白，得到语义核心（连接词尾判定用）。 */
function trimTailPunctuation(text: string): string {
  return text.replace(/[\s。！？；!?;，,、…：:."'”』」）)\]】]+$/u, '')
}

/**
 * segment 以不安全形态结尾时不提交：冒号结尾、连接词尾（`我本来想说，但是。`）、
 * 短答整体（`好的。`）。开放保护区由扫描层排除，不在这里重复。
 */
export function hasUnsafeEnding(text: string): boolean {
  const core = trimTailPunctuation(text)
  if (core.length === 0) return true
  if (/[：:]$/.test(core)) return true
  const lower = core.toLowerCase()
  for (const tail of CONNECTIVE_TAILS) {
    if (lower.endsWith(tail)) return true
  }
  for (const ack of SHORT_ACKNOWLEDGEMENTS) {
    if (core === ack) return true
  }
  return false
}
