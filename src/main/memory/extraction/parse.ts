// src/main/memory/extraction/parse.ts
// 确定性解析与截断恢复。依据 S-010 §1.4。
//
// 恢复目标：保存已经完整结束的前缀候选，不猜测模型本来想说什么。
// 算法固定为：
//   1. 输入上限 64 KiB；超过只记 outputChars 后返回 discarded
//   2. 去首尾空白；允许且只允许剥一层完整 ```json ... ``` 包裹
//   3. 第一次 JSON.parse；完整 envelope strict schema
//   4. 仅当 EOF 错误且已扫描到 candidates:[ 时进入恢复
//   5. 单次字符扫描状态机收集 candidates 数组中完整顶层对象切片
//   6. 遇到第一个未闭合对象即停止；永不补 } ] 引号 逗号
//   7. 无完整合法对象则返回空数组 discarded
// 整个函数不向调用方 throw。

import type { MemoryCandidate, RawMemoryCandidate } from './candidate'
import { CANDIDATE_LIMITS } from './candidate'

export interface CandidateParseResult {
  candidates: MemoryCandidate[]
  outcome: 'complete' | 'recovered-prefix' | 'discarded'
  /** 完整 envelope 中为非法 item 数；前缀恢复中仅统计已开始但未闭合的尾项（0 或 1） */
  droppedCount: number
  /** 模型输出字符数（用于日志，不含正文） */
  outputChars: number
}

/**
 * 为已解析的 RawMemoryCandidate 列表附加 candidateId。
 * candidateId 格式：`${turnId}:${index}`，index 是候选在原始 candidates 数组中的 0-based 位置。
 * 前缀恢复只保留连续前缀，所以恢复序号与原 index 相同。
 */
function assignIds(turnId: string, raws: readonly RawMemoryCandidate[]): MemoryCandidate[] {
  return raws.map((raw, index) => ({ ...raw, candidateId: `${turnId}:${index}` }))
}

/**
 * 剥一层完整 ```json ... ``` 包裹。代码块外有非空文字则返回 null（拒绝）。
 * 不带代码块的原样返回。
 */
function stripCodeBlock(text: string): string | null {
  const trimmed = text.trim()
  // 不以 ``` 开头 -> 原样返回（已 trim）
  if (!trimmed.startsWith('```')) return trimmed
  // 必须以 ``` 结尾（剥一层完整包裹）
  if (!trimmed.endsWith('```')) return null
  // 去掉首尾 ```
  let inner = trimmed.slice(3, -3)
  // 可选语言标识（json / jsonc 等），只剥第一行如果它是语言标识
  const firstNewline = inner.indexOf('\n')
  if (firstNewline >= 0) {
    const firstLine = inner.slice(0, firstNewline).trim()
    // 语言标识只含字母数字，不含 { } [ ] "
    if (firstLine.length > 0 && /^[A-Za-z0-9]+$/.test(firstLine)) {
      inner = inner.slice(firstNewline + 1)
    }
  }
  // 代码块内部可以有前后空白
  return inner.trim()
}

/**
 * 校验单个 candidate item 的基本不变量（shape/长度/枚举）。
 * 不做 evidence quote 子串校验（那是 Judge 的职责）。
 * 返回 true 表示通过基本 shape 校验。
 */
function isValidCandidateItem(v: unknown): v is RawMemoryCandidate {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const o = v as Record<string, unknown>

  // targetLayer
  if (o['targetLayer'] !== 'l0' && o['targetLayer'] !== 'l1' && o['targetLayer'] !== 'l2') {
    return false
  }
  const layer = o['targetLayer']

  // field：L0 必填、其余禁止
  if (layer === 'l0') {
    if (
      typeof o['field'] !== 'string' ||
      ![
        'preferredName',
        'name',
        'occupation',
        'likes',
        'dislikes',
        'age',
        'gender',
        'relationship_status',
        'permanentNote'
      ].includes(o['field'])
    ) {
      return false
    }
  } else {
    if ('field' in o && o['field'] !== undefined) return false
  }

  // content
  if (typeof o['content'] !== 'string') return false
  const content = o['content'] as string
  if (
    content.trim().length < CANDIDATE_LIMITS.contentMin ||
    content.length > CANDIDATE_LIMITS.contentMax
  ) {
    return false
  }

  // confidence
  if (typeof o['confidence'] !== 'number' || !Number.isFinite(o['confidence'])) return false
  if ((o['confidence'] as number) < 0 || (o['confidence'] as number) > 1) return false

  // certainty
  if (!['explicit', 'inferred', 'uncertain'].includes(o['certainty'] as string)) return false

  // attribution
  if (!['user_explicit', 'assistant_inferred', 'mixed'].includes(o['attribution'] as string)) {
    return false
  }

  // evidence
  if (!Array.isArray(o['evidence'])) return false
  const ev = o['evidence'] as unknown[]
  if (ev.length < CANDIDATE_LIMITS.evidenceMin || ev.length > CANDIDATE_LIMITS.evidenceMax)
    return false
  for (const e of ev) {
    if (typeof e !== 'object' || e === null || Array.isArray(e)) return false
    const eo = e as Record<string, unknown>
    if (
      typeof eo['messageId'] !== 'string' ||
      eo['messageId'].length < 1 ||
      eo['messageId'].length > CANDIDATE_LIMITS.messageIdMax
    ) {
      return false
    }
    if (eo['role'] !== 'user') return false
    if (
      typeof eo['quote'] !== 'string' ||
      eo['quote'].length < CANDIDATE_LIMITS.quoteMin ||
      eo['quote'].length > CANDIDATE_LIMITS.quoteMax
    ) {
      return false
    }
  }

  // forbiddenOverclaims
  if (!Array.isArray(o['forbiddenOverclaims'])) return false
  const oc = o['forbiddenOverclaims'] as unknown[]
  if (oc.length > CANDIDATE_LIMITS.forbiddenOverclaimsMax) return false
  for (const item of oc) {
    if (
      typeof item !== 'string' ||
      item.length < 1 ||
      item.length > CANDIDATE_LIMITS.overclaimItemMax
    ) {
      return false
    }
  }

  // memoryType / importance：L2 必填 memoryType；非 L2 禁止 memoryType + importance
  if (layer === 'l2') {
    if (!['one_off', 'situational', 'stable'].includes(o['memoryType'] as string)) return false
  } else {
    if ('memoryType' in o && o['memoryType'] !== undefined) return false
    if ('importance' in o && o['importance'] !== undefined) return false
  }

  // importance（L2 可选）
  if ('importance' in o && o['importance'] !== undefined) {
    if (!['low', 'medium', 'high'].includes(o['importance'] as string)) return false
  }

  return true
}

/**
 * 校验完整 envelope（schemaVersion + candidates 数组 + 逐 item）。
 * 完整 envelope 中任一 candidate 非法时返回 null（整 envelope 丢弃）。
 */
function validateEnvelope(v: unknown): RawMemoryCandidate[] | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (o['schemaVersion'] !== 1) return null
  if (!Array.isArray(o['candidates'])) return null
  const arr = o['candidates'] as unknown[]
  if (arr.length > CANDIDATE_LIMITS.candidatesMax) return null
  // 逐 item 校验；任一非法 -> 整 envelope 丢弃
  for (const item of arr) {
    if (!isValidCandidateItem(item)) return null
  }
  return arr as RawMemoryCandidate[]
}

/**
 * 单次字符扫描状态机，收集 candidates 数组中从 `{` 到匹配 `}` 的完整顶层对象切片。
 * 遇到第一个未闭合对象即停止。返回 { slices, reachedIncomplete }。
 *
 * 扫描规则：
 *   - 追踪 inString / escaped / objectDepth / arrayDepth
 *   - 只在 arrayDepth===1（candidates 数组内）且 objectDepth===0->1 时开始切片
 *   - objectDepth 回到 0 时切片完成
 *   - 字符串未闭合 / 对象未闭合 -> reachedIncomplete = true
 */
function scanCompleteObjects(
  text: string,
  candidatesArrayStart: number
): { slices: string[]; reachedIncomplete: boolean } {
  const slices: string[] = []
  let i = candidatesArrayStart
  const len = text.length
  let inString = false
  let escaped = false
  let objectDepth = 0
  // 我们从 candidates 数组的 [ 之后开始扫描，所以已在数组内
  let arrayDepth = 1
  let sliceStart = -1

  while (i < len) {
    const ch = text[i]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      i++
      continue
    }

    if (ch === '"') {
      inString = true
      i++
      continue
    }

    if (ch === '[') {
      arrayDepth++
      i++
      continue
    }
    if (ch === ']') {
      arrayDepth--
      if (arrayDepth === 0) {
        // candidates 数组结束
        break
      }
      i++
      continue
    }
    if (ch === '{') {
      if (arrayDepth === 1 && objectDepth === 0) {
        sliceStart = i
      }
      objectDepth++
      i++
      continue
    }
    if (ch === '}') {
      objectDepth--
      if (objectDepth === 0 && arrayDepth === 1 && sliceStart >= 0) {
        slices.push(text.slice(sliceStart, i + 1))
        sliceStart = -1
      } else if (objectDepth < 0) {
        // 不应发生：对象在数组外闭合 -> 语法错误
        return { slices, reachedIncomplete: true }
      }
      i++
      continue
    }
    i++
  }

  // 到达文本末尾或数组结束
  if (inString || objectDepth > 0) {
    return { slices, reachedIncomplete: true }
  }
  return { slices, reachedIncomplete: false }
}

/**
 * 定位 candidates 数组的起始位置（`candidates` 键后的 `[`）。
 * 返回 `[` 的索引，未找到返回 -1。
 */
function findCandidatesArrayStart(text: string): number {
  // 朴素查找 "candidates" 键后紧跟的 [
  const key = '"candidates"'
  const keyIdx = text.indexOf(key)
  if (keyIdx < 0) return -1
  // 跳过键名和可能的空白/冒号/空白
  let i = keyIdx + key.length
  while (
    i < text.length &&
    (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r' || text[i] === ':')
  ) {
    i++
  }
  if (i >= text.length || text[i] !== '[') return -1
  return i
}

/**
 * 解析模型输出为 MemoryCandidate[]。
 *
 * 算法依据 S-010 §1.4。整个函数不向调用方 throw。
 *
 * @param turnId 当前 turn ID（用于生成 candidateId）
 * @param raw 模型输出的原始字符串
 */
export function parseCandidateEnvelope(turnId: string, raw: string): CandidateParseResult {
  const outputChars = raw.length

  // 1. 输入上限 64 KiB
  if (raw.length > CANDIDATE_LIMITS.envelopeMaxBytes) {
    return { candidates: [], outcome: 'discarded', droppedCount: 0, outputChars }
  }

  // 2. 剥代码块
  const stripped = stripCodeBlock(raw)
  if (stripped === null) {
    // 代码块外有非空文字或代码块不完整
    return { candidates: [], outcome: 'discarded', droppedCount: 0, outputChars }
  }

  // 3. 第一次直接 JSON.parse
  try {
    const parsed = JSON.parse(stripped)
    const raws = validateEnvelope(parsed)
    if (raws === null) {
      // envelope 非法（schemaVersion 缺失 / candidate 非法等）-> 整丢
      // droppedCount = candidates 数组长度（如果有）
      const arr = Array.isArray((parsed as Record<string, unknown>)?.['candidates'])
        ? ((parsed as Record<string, unknown>)['candidates'] as unknown[]).length
        : 0
      return {
        candidates: [],
        outcome: 'discarded',
        droppedCount: arr,
        outputChars
      }
    }
    return {
      candidates: assignIds(turnId, raws),
      outcome: 'complete',
      droppedCount: 0,
      outputChars
    }
  } catch (e) {
    // 4. 仅当 EOF 类错误且已扫描到 candidates:[ 时进入恢复
    const errStr = e instanceof Error ? e.message : String(e)
    // V8 JSON 解析器在 EOF 时可能抛：
    //   "Unexpected end of JSON input" / "Unexpected end of input"
    //   "Unterminated string in JSON at position N"（字符串跑到 EOF）
    // 其他语法错（非法转义、逗号错误、引号错）一律全丢（S-010 §1.4 step 4）
    const isEof =
      errStr.includes('Unexpected end of JSON') ||
      errStr.includes('Unexpected end of input') ||
      errStr.includes('Unterminated string') ||
      errStr.includes('EOF') ||
      errStr.includes('end of data')

    if (!isEof) {
      // 其他语法错（非法转义、逗号错误、引号错）-> 全丢
      return { candidates: [], outcome: 'discarded', droppedCount: 0, outputChars }
    }

    const arrayStart = findCandidatesArrayStart(stripped)
    if (arrayStart < 0) {
      // 没有扫描到 candidates:[ -> 不恢复
      return { candidates: [], outcome: 'discarded', droppedCount: 0, outputChars }
    }

    // 5-6. 状态机扫描完整对象切片
    const { slices, reachedIncomplete } = scanCompleteObjects(stripped, arrayStart + 1)

    const raws: RawMemoryCandidate[] = []
    let dropped = 0
    for (const slice of slices) {
      try {
        const obj = JSON.parse(slice)
        if (isValidCandidateItem(obj)) {
          raws.push(obj as RawMemoryCandidate)
        } else {
          // 完整切片但 shape 非法 -> 丢弃
          dropped++
        }
      } catch {
        // 切片自身 JSON.parse 失败（不应发生，因为切片是完整对象）-> 丢弃
        dropped++
      }
    }

    // 7. 无完整合法对象 -> discarded
    if (raws.length === 0) {
      return { candidates: [], outcome: 'discarded', droppedCount: dropped, outputChars }
    }

    // 有完整前缀 -> recovered-prefix
    // droppedCount 包含已开始但未闭合的尾项（reachedIncomplete ? 1 : 0）+ 已解析但 shape 非法的
    const incompleteTail = reachedIncomplete ? 1 : 0
    return {
      candidates: assignIds(turnId, raws),
      outcome: 'recovered-prefix',
      droppedCount: dropped + incompleteTail,
      outputChars
    }
  }
}
