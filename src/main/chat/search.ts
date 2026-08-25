// src/main/chat/search.ts
// P2-44: 聊天记录全文搜索（SQLite FTS5 关键词检索）。
// 依据：2026-08-23 用户验收需求（DeepSeek 式聊天记录搜索）。
//
// 设计要点：
//   1. unicode61 分词器把连续中文当作一个 token（"今天天气"整词入索引），
//      搜"天气"必然不命中。因此索引前在 TS 侧把 CJK 字逐字空格分隔
//      （segmentForFts），查询侧同步分隔并组 phrase（buildFtsQuery）。
//      已在 Electron 运行时（SQLite 3.53.2）实测：CJK phrase、latin 前缀、
//      大小写不敏感、单字、混合 AND、词序错误不命中，行为全部正确。
//   2. messages_fts 是独立 FTS5 表（不用 content= 外联表）：分词逻辑在 TS，
//      SQL 触发器调不到，同步只能发生在 TS 写入路径（sqlite-session-store）。
//      rowid 与 messages.rowid 一一对应。
//   3. snippet 在 TS 侧截（不用 FTS5 snippet()——它返回的是加分隔空格后的
//      seg 形态，展示给用户会漏馅）；高亮由 renderer 按原始查询词切 <mark>。
//   4. 排序 created_at DESC（聊天记录场景新近优先），LIMIT 由 validator 钳 1..100。
//
// 规模预案（写进文档的口径）：FTS5 在百万行级消息量下仍是毫秒级。
// 若未来消息量/查询复杂度超出（如跨设备同步、语义搜索），可平滑替换为
// FlexSearch（内存索引）、Meilisearch（本地引擎）或 Elasticsearch（重型），
// 本模块的 query->hits 接口形状不变，只需替换 searchMessages 的实现。

import type { Database } from 'better-sqlite3'
import type { ChatSearchHit } from '@shared/chat/types'

// === CJK / latin 字符分类 ===
// unicode61 只认 [字母+数字] 连续 run 为 token；CJK 表意/假名/谚文虽属"字母"，
// 但连续不分词（无空格语言），所以逐字拆。全角 ASCII 先折半角再归类。

type CharClass = 'cjk' | 'latin' | 'boundary'

function classifyCodePoint(cp: number): CharClass {
  if (
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意文字
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意文字
    (cp >= 0x3040 && cp <= 0x309f) || // 平假名
    (cp >= 0x30a0 && cp <= 0x30ff) || // 片假名
    (cp >= 0x31f0 && cp <= 0x31ff) || // 片假名语音扩展
    (cp >= 0xff66 && cp <= 0xff9d) || // 半角片假名
    (cp >= 0xac00 && cp <= 0xd7af) || // 谚文音节
    (cp >= 0x1100 && cp <= 0x11ff) || // 谚文字母
    (cp >= 0x3130 && cp <= 0x318f) // 谚文兼容字母
  ) {
    return 'cjk'
  }
  // 全角 ASCII（Ａ-Ｚａ-ｚ０-９）折叠到半角再判断；全角标点落 boundary
  const folded = cp >= 0xff01 && cp <= 0xff5e ? cp - 0xfee0 : cp
  if (
    (folded >= 0x30 && folded <= 0x39) || // 0-9
    (folded >= 0x41 && folded <= 0x5a) || // A-Z
    (folded >= 0x61 && folded <= 0x7a) // a-z
  ) {
    return 'latin'
  }
  return 'boundary'
}

function toHalfWidth(ch: string): string {
  const cp = ch.codePointAt(0) ?? 0
  return cp >= 0xff01 && cp <= 0xff5e ? String.fromCodePoint(cp - 0xfee0) : ch
}

/**
 * 把任意文本切成 FTS 索引形态：CJK 逐字独立成 token，latin/数字连续 run
 * 保留为整 token，其余字符（标点、空白、emoji）全部视为分隔。索引与查询共用。
 */
export function segmentForFts(text: string): string {
  const tokens: string[] = []
  let latin = ''
  const flushLatin = (): void => {
    if (latin.length > 0) {
      tokens.push(latin)
      latin = ''
    }
  }
  for (const ch of text) {
    const cls = classifyCodePoint(ch.codePointAt(0) ?? 0)
    if (cls === 'latin') {
      // 小写化：unicode61 匹配时本就大小写不敏感；小写还能让 "OR"/"AND"/"NOT"
      // 这些 FTS5 大写关键字退化为普通 token，避免用户输入被当成操作符
      latin += toHalfWidth(ch).toLowerCase()
    } else if (cls === 'cjk') {
      flushLatin()
      tokens.push(ch)
    } else {
      flushLatin()
    }
  }
  flushLatin()
  return tokens.join(' ')
}

const LATIN_TOKEN = /^[A-Za-z0-9]+$/

/**
 * 把用户原始查询编译成 FTS5 MATCH 表达式：
 *   - 连续 CJK 字组 phrase（"天气" -> "天 气"），保证相邻匹配，词序错误不命中
 *   - 单个 CJK 字直接作为 token
 *   - latin run 直接作为 token；仅最后一个 latin token 加 * 前缀匹配（边输边搜）
 *   - 空白/标点/引号等 FTS 特殊字符在分词阶段已被剥离，输出必然语法合法
 *   - 多段空白分隔的查询词 = AND（FTS5 默认）
 * 返回 null 表示无可搜内容（纯标点/空白），调用方应返回空结果。
 */
export function buildFtsQuery(rawQuery: string): string | null {
  const tokens = segmentForFts(rawQuery)
    .split(' ')
    .filter((t) => t.length > 0)
  if (tokens.length === 0) return null

  const terms: string[] = []
  let cjkRun: string[] = []
  const flushCjk = (): void => {
    if (cjkRun.length === 1) terms.push(cjkRun[0])
    else if (cjkRun.length > 1) terms.push(`"${cjkRun.join(' ')}"`)
    cjkRun = []
  }
  for (const tok of tokens) {
    if (LATIN_TOKEN.test(tok)) {
      flushCjk()
      terms.push(tok)
    } else {
      cjkRun.push(tok)
    }
  }
  flushCjk()

  const last = terms[terms.length - 1]
  if (LATIN_TOKEN.test(last)) {
    terms[terms.length - 1] = `${last}*`
  }
  return terms.join(' ')
}

/**
 * 从原始查询提取展示用定位词：按空白切词后做与 renderer 侧 queryToNeedles
 * 相同的清洗（全角折半角、剥离非字母/非数字）——"code!" 按 "code" 定位、
 * "天气。" 按 "天气" 定位，与 FTS 实际命中的 token 对齐。
 * 用于 main 侧 snippet 截取定位；renderer 高亮规则见 utils/search-highlight.ts。
 */
export function extractNeedles(rawQuery: string): string[] {
  return rawQuery
    .split(/\s+/)
    .map((part) => foldFullWidth(part).replace(/[^\p{L}\p{N}]+/gu, ''))
    .filter((s) => s.length > 0)
}

function foldFullWidth(s: string): string {
  return Array.from(s).map(toHalfWidth).join('')
}

// === snippet 截取 ===

const SNIPPET_MAX_CHARS = 96 // 结果行单/双行能容纳的大致长度
const SNIPPET_BEFORE = 24 // 命中词前文保留

function toCodePoints(text: string): string[] {
  return Array.from(text)
}

/** 大小写不敏感地找任一 needle 的最早出现，返回码点索引（needle 长者优先试） */
function findFirstHit(text: string, needles: string[]): { index: number; length: number } | null {
  const lower = text.toLowerCase()
  const sorted = [...needles].sort((a, b) => b.length - a.length)
  let best: { index: number; length: number } | null = null
  for (const needle of sorted) {
    const at = lower.indexOf(needle.toLowerCase())
    if (at < 0) continue
    const cpIndex = toCodePoints(lower.slice(0, at)).length
    if (best === null || cpIndex < best.index) {
      best = { index: cpIndex, length: toCodePoints(needle).length }
    }
  }
  return best
}

/**
 * 围绕首个命中词截 snippet：压平空白为单空格，命中词前文 ~24 字、后文补到 ~96 字，
 * 两端截断处加 …。找不到命中词（前缀匹配的边界情形）退化为开头 96 字。
 */
export function buildSnippet(content: string, needles: string[]): string {
  const text = content.replace(/\s+/g, ' ').trim()
  const cps = toCodePoints(text)
  if (cps.length <= SNIPPET_MAX_CHARS) return text

  const hit = findFirstHit(text, needles)
  if (hit === null) {
    return cps.slice(0, SNIPPET_MAX_CHARS).join('').trimEnd() + '…'
  }
  const start = Math.max(0, hit.index - SNIPPET_BEFORE)
  const end = Math.min(cps.length, hit.index + hit.length + (SNIPPET_MAX_CHARS - SNIPPET_BEFORE))
  let snippet = cps.slice(start, end).join('').trim()
  if (start > 0) snippet = '…' + snippet
  if (end < cps.length) snippet = snippet + '…'
  return snippet
}

// === 搜索 ===

interface SearchRow {
  id: string
  session_id: string
  content: string
  created_at: number
}

/**
 * 全库搜索消息正文。命中按 created_at DESC（新近优先）返回，最多 limit 条。
 * 空查询/纯标点查询返回 []；MATCH 表达式由 buildFtsQuery 生成、语法必然合法，
 * try/catch 只是防御层（防御失败也返回 [] 而非炸 IPC）。
 */
export function searchMessages(db: Database, rawQuery: string, limit = 50): ChatSearchHit[] {
  const ftsQuery = buildFtsQuery(rawQuery)
  if (ftsQuery === null) return []
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)))

  let rows: SearchRow[]
  try {
    rows = db
      .prepare(
        `SELECT m.id AS id, m.session_id AS session_id, m.content AS content, m.created_at AS created_at
         FROM messages_fts
         JOIN messages m ON m.rowid = messages_fts.rowid
         WHERE messages_fts MATCH ?
         ORDER BY m.created_at DESC
         LIMIT ?`
      )
      .all(ftsQuery, safeLimit) as SearchRow[]
  } catch {
    return []
  }

  const needles = extractNeedles(rawQuery)
  return rows.map((row) => ({
    messageId: row.id,
    sessionId: row.session_id,
    snippet: buildSnippet(row.content, needles),
    createdAt: row.created_at
  }))
}
