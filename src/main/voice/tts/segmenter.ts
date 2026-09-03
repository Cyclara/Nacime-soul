// src/main/voice/tts/segmenter.ts
// P3B-07 / F5-007-1：分句提交策略状态机（§1.9）。
//
// 输入是 controller 维护的 pending tail（append-only 累计、有界 4096 UTF-16），
// 输出 0..N 个**前缀** segment（只从左侧切、绝不重排）+ 未提交时的原因。
// 与 Cyrene 原实现的本质差异：本状态机对累计文本全量重扫，跨 delta 天然正确，
// 第一个边界太短时继续找下一个边界而不是永久放弃（ETTS-S01/S02）。
//
// 提交规则：
//   强边界（。！？；!?; / 有效英文句号 / 换行 / 完成省略号 ……）在保护区外、
//   units >= min（首段 12 / 后续 8）、结尾不安全检查通过 -> commit；
//   太短/不安全 -> 记原因继续扫下一个边界。
//   无强提交时：软边界（，,、：:）只在 target 达标或 hold 超时（首段还需
//   pending >= 60% target）时取「target 范围内最右侧」的那一个；
//   pending >= hardMax 仍无安全切点 -> [target, hard] 从右向左找空白/标点，
//   都没有就在 grapheme 边界硬切（hard-limit；grapheme 完整性由 unicode 层保证）。

import {
  consumeGrapheme,
  createScanContext,
  hasUnsafeEnding,
  isEnglishPeriodBoundary,
  isProtected,
  SOFT_PUNCTUATION,
  type BoundaryLevel
} from './segmenter-boundaries'
import { segmentGraphemes, speechUnits } from './segmenter-unicode'

/**
 * segment 边界种类（F5-007 §1.4）。main 内部类型：不跨 IPC，真源在分句层，
 * early-controller 与播放队列从这里引用。
 */
export type SegmentBoundaryKind =
  'strong-punctuation' | 'ellipsis' | 'newline' | 'soft-timeout' | 'hard-limit' | 'stream-end'

export interface SegmenterConfig {
  readonly firstMinUnits: number
  readonly nextMinUnits: number
  readonly targetMaxGraphemes: number
  readonly hardMaxGraphemes: number
}

export interface ScanSegmentsInput {
  readonly pending: string
  readonly config: SegmenterConfig
  /** 本轮是否还没提交过任何 segment（首段更保守）。 */
  readonly isFirstSegment: boolean
  /** maxHoldMs 是否已过（从 pending 第一个非空字符起算，由 controller 计时）。 */
  readonly holdExpired: boolean
  /** 文本流是否已结束：尾部无法正常切分时整段作为 stream-end 提交（§1.8.4/§1.9）。 */
  readonly streamEnd?: boolean
}

export interface ExtractedSegment {
  /** 提交的 segment 文本（含边界标点与尾吸收的闭引号/空白）。 */
  readonly text: string
  /** 在 pending 内的 UTF-16 结束偏移（exclusive）。 */
  readonly endOffset: number
  readonly boundary: SegmentBoundaryKind
}

export type SegmentNoCommitReason =
  | 'too-short'
  | 'protected-region'
  | 'unsafe-ending'
  | 'need-more-text'
  | 'segmenter-error'
  | 'stream-end'

export interface ScanSegmentsResult {
  readonly segments: readonly ExtractedSegment[]
  /** segments 为空时的主因（观测/测试用）。 */
  readonly reason: SegmentNoCommitReason
}

interface Candidate {
  /** grapheme 序号（inclusive，即边界标点本身的下标）。 */
  readonly graphemeIndex: number
  /** 该 grapheme 的 UTF-16 起点偏移。 */
  readonly utf16Start: number
  readonly level: BoundaryLevel
}

/** 边界级别 -> segment 的 boundary 种类。 */
function boundaryKind(level: BoundaryLevel): SegmentBoundaryKind {
  switch (level) {
    case 'strong':
    case 'period':
      return 'strong-punctuation'
    case 'ellipsis':
      return 'ellipsis'
    case 'newline':
      return 'newline'
    case 'soft':
      return 'soft-timeout'
  }
}

/** 软边界可用性（§1.8.2 + §1.9 首段保守）。 */
function softBoundaryAllowed(input: ScanSegmentsInput, totalGraphemes: number): boolean {
  const { config, isFirstSegment, holdExpired } = input
  if (totalGraphemes >= config.targetMaxGraphemes) return true // target max 触发
  if (!holdExpired) return false
  if (isFirstSegment) {
    return totalGraphemes >= Math.ceil(config.targetMaxGraphemes * 0.6)
  }
  return true
}

/**
 * 强边界点后的尾吸收：闭引号/闭括号/空白并入本 segment，不留给下一段开头。
 * 返回吸收后的 grapheme 结束下标（exclusive）。
 */
function absorbTrailingClosers(graphemes: readonly string[], fromIndex: number): number {
  let end = fromIndex + 1
  while (end < graphemes.length) {
    const g = graphemes[end]!
    // 只吸收闭引号/闭括号与水平空白；换行不吸收（段落间距留给下一段开头，
    // 对 TTS 无害，也避免 segment 文本以换行结尾）
    const horizontalSpace = g.length === 1 && (g === ' ' || g.charCodeAt(0) === 9)
    const closer = /^[）”"’']$/.test(g) || /^[\]）】]$/.test(g)
    if (horizontalSpace || closer) {
      end++
      continue
    }
    break
  }
  return end
}

/** [from, to) grapheme 拼成文本（grapheme 切分保证 surrogate/ZWJ 完整）。 */
function joinGraphemes(graphemes: readonly string[], from: number, to: number): string {
  let out = ''
  for (let i = from; i < to; i++) out += graphemes[i]
  return out
}

export function scanSegments(input: ScanSegmentsInput): ScanSegmentsResult {
  const { pending, config } = input
  if (pending.length === 0) {
    return { segments: [], reason: 'need-more-text' }
  }

  let graphemes: string[]
  try {
    graphemes = segmentGraphemes(pending)
  } catch (err) {
    // Intl.Segmenter 不可用：整轮降级由 controller 决定，这里只报 segmenter-error
    void err
    return { segments: [], reason: 'segmenter-error' }
  }
  if (graphemes.length === 0) {
    return { segments: [], reason: 'need-more-text' }
  }

  // 每个 grapheme 的 UTF-16 起点偏移（切点换算用）
  const utf16Starts: number[] = new Array(graphemes.length + 1)
  utf16Starts[0] = 0
  for (let i = 0; i < graphemes.length; i++) {
    utf16Starts[i + 1] = utf16Starts[i]! + graphemes[i]!.length
  }

  const segments: ExtractedSegment[] = []
  let noCommitReason: SegmentNoCommitReason = 'need-more-text'

  // 首段门槛（§1.9「最小 12 speech units」）：累计 pending 达到 firstMinUnits 才允许
  // 首次提交；此后每个 segment 自身只需 nextMinUnits。这样 §3.3 例 1 的
  // `今天辛苦啦，我们慢慢来。`（10 单位）能在累计 16 单位后作为首段提交，
  // 而例 2 `好。后面我再慢慢说。`（累计 8 单位）继续等。
  const firstGateOk = !input.isFirstSegment || speechUnits(pending) >= config.firstMinUnits
  if (!firstGateOk) {
    noCommitReason = 'too-short'
  }

  // ── 主扫描：从左向右找强边界提交 0..N 个前缀 segment ──
  let context = createScanContext()
  let segmentStartGrapheme = 0
  let candidates: Candidate[] = []
  let scanIndex = 0

  const tryCommitCandidate = (candidate: Candidate): boolean => {
    const endGrapheme = absorbTrailingClosers(graphemes, candidate.graphemeIndex)
    const text = joinGraphemes(graphemes, segmentStartGrapheme, endGrapheme)
    if (speechUnits(text) < config.nextMinUnits) {
      noCommitReason = 'too-short'
      return false
    }
    if (hasUnsafeEnding(text)) {
      noCommitReason = 'unsafe-ending'
      return false
    }
    segments.push({
      text,
      endOffset: utf16Starts[endGrapheme]!,
      boundary: boundaryKind(candidate.level)
    })
    segmentStartGrapheme = endGrapheme
    candidates = []
    context = createScanContext() // 提交点必在保护区全闭合处，重置等价于续扫
    noCommitReason = 'need-more-text'
    return true
  }

  while (scanIndex < graphemes.length) {
    const g = graphemes[scanIndex]!
    const prev = scanIndex > 0 ? graphemes[scanIndex - 1] : undefined
    const level = consumeGrapheme(context, g, prev)
    const start = utf16Starts[scanIndex]!

    if (level !== null && firstGateOk && !isProtected(context)) {
      if (level === 'period') {
        // 英文句号：取前后 token 做排除判定
        const beforeToken = tokenBefore(graphemes, scanIndex)
        const afterToken = tokenAfter(graphemes, scanIndex)
        const nextG = graphemes[scanIndex + 1]
        if (
          isEnglishPeriodBoundary({
            prevGrapheme: prev,
            nextGrapheme: nextG,
            beforeToken,
            afterToken
          })
        ) {
          if (
            tryCommitCandidate({ graphemeIndex: scanIndex, utf16Start: start, level: 'strong' })
          ) {
            scanIndex = segmentStartGrapheme // 从新 segment 起点重扫（continue 跳过底部 ++）
            continue
          }
        }
      } else if (level === 'strong' || level === 'ellipsis' || level === 'newline') {
        if (tryCommitCandidate({ graphemeIndex: scanIndex, utf16Start: start, level })) {
          scanIndex = segmentStartGrapheme
          continue
        }
      } else if (level === 'soft') {
        candidates.push({ graphemeIndex: scanIndex, utf16Start: start, level: 'soft' })
      }
    }
    scanIndex++
  }

  if (segments.length > 0) {
    return { segments, reason: 'need-more-text' }
  }

  // ── 无强提交：软边界 / hard-limit 判定（作用于整个 pending）──
  const totalGraphemes = graphemes.length

  if (firstGateOk && softBoundaryAllowed(input, totalGraphemes) && candidates.length > 0) {
    // target 范围内最右侧、且 units 达标的软边界
    for (let i = candidates.length - 1; i >= 0; i--) {
      const candidate = candidates[i]!
      if (candidate.graphemeIndex + 1 > config.targetMaxGraphemes) continue
      const endGrapheme = absorbTrailingClosers(graphemes, candidate.graphemeIndex)
      const text = joinGraphemes(graphemes, 0, endGrapheme)
      if (speechUnits(text) < config.nextMinUnits) {
        noCommitReason = 'too-short'
        continue
      }
      if (hasUnsafeEnding(text)) {
        noCommitReason = 'unsafe-ending'
        continue
      }
      segments.push({
        text,
        endOffset: utf16Starts[endGrapheme]!,
        boundary: 'soft-timeout'
      })
      // 软边界一次只切一段：剩余交给下一轮 append 后的重扫
      return { segments, reason: 'need-more-text' }
    }
  }

  // hard-limit：pending 达 hardMax 仍无安全切点
  if (totalGraphemes >= config.hardMaxGraphemes) {
    const ceiling = Math.min(totalGraphemes, config.hardMaxGraphemes)
    // [target, hard] 从右向左找空白/标点（任意级别；不用保护区判定，
    // 因为整段没有安全点本身就是 hard-limit 语义）
    let cut = -1
    for (let i = ceiling - 1; i >= config.targetMaxGraphemes && i > 0; i--) {
      const g = graphemes[i]!
      if (/^\s$/u.test(g) || SOFT_PUNCTUATION.has(g) || /[。，、！？；]/.test(g)) {
        cut = i + 1 // 切点含该标点
        break
      }
    }
    if (cut < 0) cut = ceiling // 无安全点：grapheme 边界硬切
    const text = joinGraphemes(graphemes, 0, cut)
    if (text.trim().length > 0) {
      segments.push({
        text,
        endOffset: utf16Starts[cut]!,
        boundary: 'hard-limit'
      })
    }
    return { segments, reason: 'need-more-text' }
  }

  // stream-end：流已结束，无法正常切分的尾部整段提交（§1.4 stream-end 边界；
  // minUnits/不安全结尾都是「等更多文本」的条件，流结束即解除）
  if (input.streamEnd === true && segments.length === 0 && pending.trim().length > 0) {
    return {
      segments: [{ text: pending, endOffset: pending.length, boundary: 'stream-end' }],
      reason: 'stream-end'
    }
  }

  if (noCommitReason === 'need-more-text' && candidates.length > 0) {
    noCommitReason = 'need-more-text' // 有软边界候选但时机未到
  }
  return { segments, reason: noCommitReason }
}

/** 句点前同一 token：向左收集字母/数字/点。 */
function tokenBefore(graphemes: readonly string[], periodIndex: number): string {
  let out = ''
  for (let i = periodIndex - 1; i >= 0; i--) {
    const g = graphemes[i]!
    if (/[\p{L}\p{N}@]/u.test(g) || g === '.') {
      out = g + out
      if (out.length > 64) break
    } else break
  }
  return out
}

/** 句点后的第一个词：跳过空白后收集字母数字（遇点/空白/其他即停--词尾句点不属于本词）。 */
function tokenAfter(graphemes: readonly string[], periodIndex: number): string {
  let out = ''
  let started = false
  for (let i = periodIndex + 1; i < graphemes.length; i++) {
    const g = graphemes[i]!
    if (!started && /^\s$/u.test(g)) continue // 前导空白跳过
    started = true
    if (/[\p{L}\p{N}]/u.test(g)) {
      out += g
      if (out.length > 64) break
    } else break
  }
  return out
}
