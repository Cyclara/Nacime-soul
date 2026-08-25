// src/renderer/src/utils/search-highlight.ts
// P2-44: 搜索结果高亮切分 + 结果行时间格式化。
//
// 高亮不走 v-html（用户正文+查询词都是不可信输入，注入风险），
// 用本工具把 snippet 切成 { text, hit } 段，组件 v-for 渲染 <mark>。
//
// needle 清洗规则与 main 侧 chat/search.ts extractNeedles 保持一致：
// 全角 ASCII 折半角、剥离非字母/非数字字符——
// "code!" 按 "code" 匹配、"天气。" 按 "天气" 匹配，与 FTS 实际命中的 token 对齐。

export interface HighlightPart {
  text: string
  hit: boolean
}

function foldFullWidth(s: string): string {
  return Array.from(s)
    .map((ch) => {
      const cp = ch.codePointAt(0) ?? 0
      return cp >= 0xff01 && cp <= 0xff5e ? String.fromCodePoint(cp - 0xfee0) : ch
    })
    .join('')
}

/** 从原始查询提取高亮词（与 main 侧 extractNeedles 同规则，跨进程各留一份） */
export function queryToNeedles(query: string): string[] {
  return query
    .split(/\s+/)
    .map((part) => foldFullWidth(part).replace(/[^\p{L}\p{N}]+/gu, ''))
    .filter((s) => s.length > 0)
}

/**
 * 把 snippet 按 needles 切成高亮段。大小写不敏感；多个 needle 命中同一区域时
 * 长者优先（"天气" 整体高亮，而不是拆成 "天" "气" 两段）。无命中时原样返回单段。
 */
export function splitByNeedles(text: string, needles: string[]): HighlightPart[] {
  const valid = needles.filter((n) => n.length > 0).sort((a, b) => b.length - a.length)
  if (text.length === 0) return []
  if (valid.length === 0) return [{ text, hit: false }]

  const parts: HighlightPart[] = []
  const lower = text.toLowerCase()
  let cursor = 0
  while (cursor < text.length) {
    let bestAt = -1
    let bestLen = 0
    for (const needle of valid) {
      const at = lower.indexOf(needle.toLowerCase(), cursor)
      if (at >= 0 && (bestAt < 0 || at < bestAt)) {
        bestAt = at
        bestLen = needle.length
      }
    }
    if (bestAt < 0) break
    if (bestAt > cursor) parts.push({ text: text.slice(cursor, bestAt), hit: false })
    parts.push({ text: text.slice(bestAt, bestAt + bestLen), hit: true })
    cursor = bestAt + bestLen
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), hit: false })
  return parts
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * 结果行右侧时间戳（DeepSeek 式）：
 *   今天 → HH:mm；今年更早 → M月D日；跨年 → YYYY年M月D日。
 * 与消息列表的 time-divider 同一套本地时区日历日口径。
 */
export function formatSearchTime(createdAt: number, now: number): string {
  const d = new Date(createdAt)
  const nowDate = new Date(now)
  const sameDay =
    d.getFullYear() === nowDate.getFullYear() &&
    d.getMonth() === nowDate.getMonth() &&
    d.getDate() === nowDate.getDate()
  if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (d.getFullYear() === nowDate.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}
