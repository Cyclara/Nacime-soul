// src/main/memory/extraction/judge.ts
// MemoryJudge 确定性判决状态机。依据 S-020 §1.6。
//
// Judge 保持同步纯函数：不做第二次 LLM 调用（模型已参与候选生成，同类模型自审会放大
// 一致性错误）。M-42 的 L0 归属语义判定以"预标注"形式随 ctx 传入——drain 在终审前
// 用独立模型批量判定一次（attribution-gate.ts），本文件只消费布尔结论；
// 预标注缺失（门未配置/失败/超时/malformed）时 fail-closed 回退现行正则表。
// 需要语义 resolver 的冲突由 P2-20 独立处理。
//
// 判决顺序（第一条命中即返回）：
//   1. shape/长度重新校验（不信任模型输出，不宽松 coercion）
//   2. 证据闭环：messageId === 当前 turn user message ID；role==='user'；
//      normalizeForEvidence(quote) 是 normalizeForEvidence(userContent) 的连续子串
//   3. 持久指令/污染：content 或 evidence 含指令目标组合 -> PERSISTENT_INSTRUCTION
//   4. 模型自报 overclaim：forbiddenOverclaims.length>0 -> FORBIDDEN_OVERCLAIM
//   5. 绝对化支持检查：content 命中词族但所有 evidence.quote 未命中同族 -> UNSUPPORTED_ABSOLUTE
//   6. 用户/角色归属与 L0 来源检查（L0 分支优先消费 M-42 预标注，缺省回退正则；L1/L2 仍正则）
//   7. 去重与持久幂等（同批次去重；跨轮由 extractionKey）
//   8. 其余接受；confidence 夹取
//
// 安全红线（F5-011 LogFields 白名单）：
//   - 日志不记 candidate content、quote、完整模型输出、user 正文

import type { MemoryCandidate } from './candidate'
import type { L0FieldKey } from '../l0-store'
import type { AttributionVerdict } from './attribution-gate'

export type JudgeAction = 'accept' | 'downgrade' | 'reject'

export type JudgeReasonCode =
  | 'ACCEPTED'
  | 'DOWNGRADED_TO_L2'
  | 'INVALID_SHAPE'
  | 'INVALID_LAYER_FIELDS'
  | 'VALUE_TOO_LONG'
  | 'EVIDENCE_MISSING'
  | 'EVIDENCE_NOT_CURRENT_TURN'
  | 'EVIDENCE_NOT_USER'
  | 'EVIDENCE_QUOTE_MISMATCH'
  | 'FORBIDDEN_OVERCLAIM'
  | 'UNSUPPORTED_ABSOLUTE'
  | 'L0_FIELD_NOT_ALLOWED'
  | 'L0_NOT_EXPLICIT'
  | 'L0_WRONG_ATTRIBUTION'
  | 'L0_SUBJECT_IS_ASSISTANT'
  | 'PERSISTENT_INSTRUCTION'
  | 'DUPLICATE_CANDIDATE'

/** reject 决策可用的 reason code（排除 ACCEPTED / DOWNGRADED_TO_L2） */
export type JudgeRejectReason = Exclude<JudgeReasonCode, 'ACCEPTED' | 'DOWNGRADED_TO_L2'>

export type JudgeDecision =
  | {
      candidateId: string
      action: 'accept'
      reason: 'ACCEPTED'
      accepted: MemoryCandidate
    }
  | {
      candidateId: string
      action: 'downgrade'
      reason: 'DOWNGRADED_TO_L2'
      accepted: MemoryCandidate & { targetLayer: 'l2' }
    }
  | {
      candidateId: string
      action: 'reject'
      reason: Exclude<JudgeReasonCode, 'ACCEPTED' | 'DOWNGRADED_TO_L2'>
    }

export interface JudgeContext {
  turnId: string
  /** 当前 turn 的 user message ID（evidence 必须指向它） */
  userMessageId: string
  /** 当前 turn 的 user message 正文（已 sanitize，用于 quote 子串校验） */
  userContent: string
  /**
   * M-42：drain 预标注的 L0 归属语义判定（candidateId -> verdict）。
   * 只影响 step 6 的 L0 分支：命中标注时用语义结论替代正则表；
   * null/缺省/查无此 candidateId 时回退正则表（fail-closed，语义门失败路径）。
   * L1/L2 归属检查不消费本标注（仍走正则，最小爆炸半径）。
   */
  attribution?: ReadonlyMap<string, AttributionVerdict> | null
}

export interface MemoryJudge {
  /**
   * 对一批候选逐一判决。每个已解析候选恰好产生一条 decision。
   * ACCEPTED 不是日志推断，而是显式结果。
   * 同批次去重：targetLayer + field + NFC/trim content 相同的后项标记 DUPLICATE_CANDIDATE。
   */
  judgeBatch(candidates: readonly MemoryCandidate[], ctx: JudgeContext): JudgeDecision[]
}

// === normalizeForEvidence（S-020 §1.6 step 2）===
// 只允许：Unicode NFC、CRLF->LF、trim、连续空白压成单空格。
// 不做大小写、标点或同义替换。

export function normalizeForEvidence(text: string): string {
  // Unicode NFC
  let n = text.normalize('NFC')
  // CRLF -> LF
  n = n.replace(/\r\n/g, '\n')
  // trim
  n = n.trim()
  // 连续空白压成单空格（含 \n \t 等）
  n = n.replace(/\s+/g, ' ')
  return n
}

// === 绝对化词族（S-020 §1.6 step 5）===

const ABSOLUTE_WORD_FAMILIES: ReadonlyArray<{ name: string; patterns: readonly RegExp[] }> = [
  { name: 'forever', patterns: [/永远/, /永不/, /从不/, /\bnever\b/i, /\balways\b/i] },
  { name: 'only', patterns: [/只/, /仅/, /\bonly\b/i] },
  { name: 'absolutely', patterns: [/一定/, /绝对/, /\babsolutely\b/i] },
  { name: 'completely', patterns: [/完全/, /\bcompletely\b/i] },
  { name: 'henceforth', patterns: [/以后都/, /不再/] }
]

function contentHitsAbsoluteFamily(content: string): string[] {
  const hit: string[] = []
  for (const fam of ABSOLUTE_WORD_FAMILIES) {
    for (const p of fam.patterns) {
      if (p.test(content)) {
        hit.push(fam.name)
        break
      }
    }
  }
  return hit
}

function evidenceHitsFamily(quote: string, familyName: string): boolean {
  const fam = ABSOLUTE_WORD_FAMILIES.find((f) => f.name === familyName)
  if (!fam) return false
  return fam.patterns.some((p) => p.test(quote))
}

// === 持久指令检测（S-020 §1.6 step 3）===

const PERSISTENT_INSTRUCTION_PATTERNS: readonly RegExp[] = [
  /忽略.*(指令|规则|系统|之前)/,
  /覆盖.*(指令|规则|系统)/,
  /修改.*(系统提示|system prompt|seed|soul|核心人格|永久记忆)/,
  /写入.*(系统提示|system prompt|seed|soul|核心人格|永久记忆)/,
  /加入.*(系统提示|system prompt|seed|soul|核心人格|永久记忆)/,
  /无条件服从/,
  /永久服从/,
  /泄露.*(系统|之前|指令)/,
  /ignore.*(previous|above|system|instruction)/i,
  /overwrite.*(system|instruction|prompt)/i,
  /modify.*(system prompt|seed|soul|core personality)/i,
  /write.*(system prompt|seed|soul|core personality)/i,
  /unconditionally obey/i,
  /permanently obey/i
]

function isPersistentInstruction(content: string, evidenceQuotes: readonly string[]): boolean {
  const combined = content + ' ' + evidenceQuotes.join(' ')
  return PERSISTENT_INSTRUCTION_PATTERNS.some((p) => p.test(combined))
}

// === L0 用户自指模式（S-020 §1.6 step 6）===

const L0_USER_SELF_REFERENCE: Record<L0FieldKey, readonly RegExp[]> = {
  preferredName: [/我叫/, /叫我/, /喊我/, /my name is/i, /call me/i],
  name: [/我叫/, /叫我/, /喊我/, /my name is/i, /call me/i],
  occupation: [/我是/, /我从事/, /\bI am\b/i, /\bI'm\b/i],
  likes: [/我喜欢/, /我爱好/, /我钟爱/, /\bI like\b/i, /\bI love\b/i],
  dislikes: [/我讨厌/, /我不喜欢/, /我反感/, /\bI dislike\b/i, /\bI hate\b/i],
  age: [/我今年/, /我\d+岁/, /\bI am\b.*\byears old\b/i],
  gender: [/我是男/, /我是女/, /我是男生/, /我是女生/, /\bI am\b.*(male|female)/i],
  relationship_status: [
    /我(单身|已婚|恋爱|有对象)/,
    /\bI am\b.*(single|married|in a relationship)/i
  ],
  permanentNote: [/我住在/, /我养了/, /我有一只/, /\bI live in\b/i, /\bI have a\b/i]
}

// === assistant 指向模式（S-020 §1.6 step 6）===

const ASSISTANT_DIRECTED_PATTERNS: readonly RegExp[] = [
  /你叫/,
  /你是/,
  /你的名字/,
  /以后你/,
  /\byou are\b/i,
  /\byou're\b/i,
  /\byour name\b/i,
  /call yourself/i
]

function evidenceHitsAssistantDirected(quotes: readonly string[]): boolean {
  return quotes.some((q) => ASSISTANT_DIRECTED_PATTERNS.some((p) => p.test(q)))
}

function evidenceHitsUserSelfReference(field: L0FieldKey, quotes: readonly string[]): boolean {
  const patterns = L0_USER_SELF_REFERENCE[field]
  return quotes.some((q) => patterns.some((p) => p.test(q)))
}

/**
 * L1/L2 通用用户自指判定。合并 L0 全部字段的自指模式（去重），
 * 任一命中即视为"引用含用户对自己身份的陈述"。
 *
 * 用途：L1/L2 的 assistant 指向检查（S-020 §1.6 step 6"对所有层"）——
 *   引用同时含 assistant 指向词与用户自指时（如"你叫我小明"），是用户在表达
 *   自己的名字，不是给 assistant 设身份，应放行；仅含 assistant 指向（"你叫小明"）
 *   才是给 assistant 设身份，拒绝。与 L0 分支的 `evidenceHitsUserSelfReference`
 *   语义对齐（J-07"叫我优先"），避免 L1/L2 用粗糙的"不含 assistant 词"误拒合法事实。
 */
function evidenceHitsGeneralUserSelfReference(quotes: readonly string[]): boolean {
  return quotes.some((q) => L0_GENERAL_SELF_REFERENCE.some((p) => p.test(q)))
}

/** L0 全部字段自指模式的合并去重（evidenceHitsGeneralUserSelfReference 用） */
const L0_GENERAL_SELF_REFERENCE: readonly RegExp[] = (() => {
  const all = new Set<RegExp>()
  for (const patterns of Object.values(L0_USER_SELF_REFERENCE)) {
    for (const p of patterns) all.add(p)
  }
  return [...all]
})()

// === confidence 夹取（S-020 §1.6 step 8）===

function clampConfidence(candidate: MemoryCandidate): number {
  const cap =
    candidate.certainty === 'explicit' ? 0.95 : candidate.certainty === 'inferred' ? 0.7 : 0.45
  return Math.min(candidate.confidence, cap)
}

// === 长度校验（S-020 §1.2）===

function checkContentLength(candidate: MemoryCandidate): JudgeRejectReason | null {
  const content = candidate.content.trim()
  if (content.length < 1 || content.length > 500) return 'VALUE_TOO_LONG'
  if (candidate.targetLayer === 'l0' && content.length > 120) return 'VALUE_TOO_LONG'
  if (candidate.targetLayer === 'l1' && content.length > 240) return 'VALUE_TOO_LONG'
  if (candidate.targetLayer === 'l2' && content.length > 500) return 'VALUE_TOO_LONG'
  return null
}

// === Judge 实现 ===

export function createMemoryJudge(): MemoryJudge {
  function judgeSingle(candidate: MemoryCandidate, ctx: JudgeContext): JudgeDecision {
    const { candidateId } = candidate

    // 1. shape/长度重新校验
    const lengthErr = checkContentLength(candidate)
    if (lengthErr) {
      return { candidateId, action: 'reject', reason: lengthErr }
    }

    // 层专属字段检查
    if (candidate.targetLayer === 'l0') {
      if (!candidate.field) {
        return { candidateId, action: 'reject', reason: 'L0_FIELD_NOT_ALLOWED' }
      }
      if (candidate.certainty !== 'explicit') {
        return { candidateId, action: 'reject', reason: 'L0_NOT_EXPLICIT' }
      }
      if (candidate.attribution !== 'user_explicit') {
        return { candidateId, action: 'reject', reason: 'L0_WRONG_ATTRIBUTION' }
      }
    } else {
      if (candidate.field) {
        return { candidateId, action: 'reject', reason: 'INVALID_LAYER_FIELDS' }
      }
    }
    if (candidate.targetLayer !== 'l2') {
      if (candidate.memoryType || candidate.importance) {
        return { candidateId, action: 'reject', reason: 'INVALID_LAYER_FIELDS' }
      }
    } else {
      if (!candidate.memoryType) {
        return { candidateId, action: 'reject', reason: 'INVALID_LAYER_FIELDS' }
      }
    }

    // 2. 证据闭环
    if (!candidate.evidence || candidate.evidence.length < 1) {
      return { candidateId, action: 'reject', reason: 'EVIDENCE_MISSING' }
    }
    const normalizedUserContent = normalizeForEvidence(ctx.userContent)
    for (const ev of candidate.evidence) {
      if (ev.messageId !== ctx.userMessageId) {
        return { candidateId, action: 'reject', reason: 'EVIDENCE_NOT_CURRENT_TURN' }
      }
      if (ev.role !== 'user') {
        return { candidateId, action: 'reject', reason: 'EVIDENCE_NOT_USER' }
      }
      const normalizedQuote = normalizeForEvidence(ev.quote)
      if (!normalizedUserContent.includes(normalizedQuote)) {
        return { candidateId, action: 'reject', reason: 'EVIDENCE_QUOTE_MISMATCH' }
      }
    }

    const evidenceQuotes = candidate.evidence.map((e) => e.quote)

    // 3. 持久指令/污染
    if (isPersistentInstruction(candidate.content, evidenceQuotes)) {
      return { candidateId, action: 'reject', reason: 'PERSISTENT_INSTRUCTION' }
    }

    // 4. 模型自报 overclaim
    if (candidate.forbiddenOverclaims.length > 0) {
      return { candidateId, action: 'reject', reason: 'FORBIDDEN_OVERCLAIM' }
    }

    // 5. 绝对化支持检查
    const hitFamilies = contentHitsAbsoluteFamily(candidate.content)
    for (const fam of hitFamilies) {
      const supported = evidenceQuotes.some((q) => evidenceHitsFamily(q, fam))
      if (!supported) {
        return { candidateId, action: 'reject', reason: 'UNSUPPORTED_ABSOLUTE' }
      }
    }

    // 6. 用户/角色归属与 L0 来源
    if (candidate.targetLayer === 'l0' && candidate.field) {
      // 先对所有层拒绝"给 assistant 设定身份/人格/永久行为"
      // M-42：drain 预标注（独立模型语义判定）优先；无标注时回退正则表（fail-closed）。
      // 语义门覆盖正则够不着的自然说法（"你可以称我为伙伴"/"对…失望"/"在读大学"），
      // 也能拦下正则漏掉的 assistant 指向（"你应该叫小灵"）。
      const annotation = ctx.attribution?.get(candidate.candidateId) ?? null
      const assistantHit = annotation
        ? annotation.assistantDirected
        : evidenceHitsAssistantDirected(evidenceQuotes)
      const userSelfHit = annotation
        ? annotation.userSelfStatement
        : evidenceHitsUserSelfReference(candidate.field, evidenceQuotes)

      if (assistantHit && !userSelfHit) {
        return { candidateId, action: 'reject', reason: 'L0_SUBJECT_IS_ASSISTANT' }
      }
      if (!userSelfHit) {
        // 主语不明确时 fail-closed：不写 L0
        // 但 "你叫我小明" 由 "叫我" 命中用户自指 -> 可进 preferredName
        // 如果事实仍有价值且是稳定/情境信息，可降级 L2
        return downgradeToL2(candidate, ctx)
      }
    } else {
      // L1/L2 也要拦截"给 assistant 设定身份"的候选（不能绕过 L0 门改存 L1/L2）。
      // S-020 §1.6 step 6："先对所有层拒绝"——L1 近期状态写入"你叫X"同样污染角色自我认知。
      // 判定只看 evidence 原文：命中 assistant 指向词（你叫/你是/以后你…）且无用户自指时拒绝。
      // 引用同时含用户自指（"你叫我小明"命中"叫我"）= 用户在说自己的名字，放行（J-07 语义）。
      const assistantHit = evidenceHitsAssistantDirected(evidenceQuotes)
      const userSelfHit = evidenceHitsGeneralUserSelfReference(evidenceQuotes)
      if (assistantHit && !userSelfHit) {
        return { candidateId, action: 'reject', reason: 'L0_SUBJECT_IS_ASSISTANT' }
      }
    }

    // 7. 跨轮幂等由 extractionKey 承担（P2-12 writer 层 UNIQUE）
    // 同批次去重在 judgeBatch 中处理

    // 8. 接受；confidence 夹取
    const clamped = clampConfidence(candidate)
    const accepted: MemoryCandidate = { ...candidate, confidence: clamped }
    return { candidateId, action: 'accept', reason: 'ACCEPTED', accepted }
  }

  /**
   * 降级到 L2。S-020 §1.6 step 6：
   * 移除 field，targetLayer='l2'，confidence 按来源夹取，memoryType 按原声明
   * （缺失时只允许 situational），importance 默认 medium，然后从第 1 步重新过全部 L2 不变量。
   * 原 candidate 不原地改写。
   */
  function downgradeToL2(candidate: MemoryCandidate, ctx: JudgeContext): JudgeDecision {
    const downgraded: MemoryCandidate = {
      candidateId: candidate.candidateId,
      targetLayer: 'l2',
      content: candidate.content,
      confidence: clampConfidence(candidate),
      certainty: candidate.certainty,
      attribution: candidate.attribution,
      evidence: candidate.evidence,
      memoryType: candidate.memoryType ?? 'situational',
      importance: candidate.importance ?? 'medium',
      forbiddenOverclaims: candidate.forbiddenOverclaims
    }
    // 重新过 L2 不变量：只接受或拒绝，不再降级
    const recheck = judgeSingleL2(downgraded, ctx)
    if (recheck.action === 'reject') {
      return recheck
    }
    return {
      candidateId: candidate.candidateId,
      action: 'downgrade',
      reason: 'DOWNGRADED_TO_L2',
      accepted: downgraded as MemoryCandidate & { targetLayer: 'l2' }
    }
  }

  /**
   * L2 不变量重新校验（降级路径专用，不再递归降级）。
   * 只做 shape/长度/证据/污染/绝对化/归属检查，不做 L0 字段检查。
   */
  function judgeSingleL2(candidate: MemoryCandidate, ctx: JudgeContext): JudgeDecision {
    const { candidateId } = candidate

    // 1. 长度
    const lengthErr = checkContentLength(candidate)
    if (lengthErr) {
      return { candidateId, action: 'reject', reason: lengthErr }
    }

    // L2 必须有 memoryType，不能有 field
    if (candidate.field) {
      return { candidateId, action: 'reject', reason: 'INVALID_LAYER_FIELDS' }
    }
    if (!candidate.memoryType) {
      return { candidateId, action: 'reject', reason: 'INVALID_LAYER_FIELDS' }
    }

    // 2. 证据闭环
    if (!candidate.evidence || candidate.evidence.length < 1) {
      return { candidateId, action: 'reject', reason: 'EVIDENCE_MISSING' }
    }
    const normalizedUserContent = normalizeForEvidence(ctx.userContent)
    for (const ev of candidate.evidence) {
      if (ev.messageId !== ctx.userMessageId) {
        return { candidateId, action: 'reject', reason: 'EVIDENCE_NOT_CURRENT_TURN' }
      }
      if (ev.role !== 'user') {
        return { candidateId, action: 'reject', reason: 'EVIDENCE_NOT_USER' }
      }
      const normalizedQuote = normalizeForEvidence(ev.quote)
      if (!normalizedUserContent.includes(normalizedQuote)) {
        return { candidateId, action: 'reject', reason: 'EVIDENCE_QUOTE_MISMATCH' }
      }
    }

    const evidenceQuotes = candidate.evidence.map((e) => e.quote)

    // 3. 持久指令/污染
    if (isPersistentInstruction(candidate.content, evidenceQuotes)) {
      return { candidateId, action: 'reject', reason: 'PERSISTENT_INSTRUCTION' }
    }

    // 4. 模型自报 overclaim
    if (candidate.forbiddenOverclaims.length > 0) {
      return { candidateId, action: 'reject', reason: 'FORBIDDEN_OVERCLAIM' }
    }

    // 5. 绝对化支持检查
    const hitFamilies = contentHitsAbsoluteFamily(candidate.content)
    for (const fam of hitFamilies) {
      const supported = evidenceQuotes.some((q) => evidenceHitsFamily(q, fam))
      if (!supported) {
        return { candidateId, action: 'reject', reason: 'UNSUPPORTED_ABSOLUTE' }
      }
    }

    // 6. L2 也要拦截"给 assistant 设定身份"
    const assistantHit = evidenceHitsAssistantDirected(evidenceQuotes)
    const userSelfHit = evidenceHitsGeneralUserSelfReference(evidenceQuotes)
    if (assistantHit && !userSelfHit) {
      return { candidateId, action: 'reject', reason: 'L0_SUBJECT_IS_ASSISTANT' }
    }

    // 8. 接受
    return { candidateId, action: 'accept', reason: 'ACCEPTED', accepted: candidate }
  }

  function judgeBatch(candidates: readonly MemoryCandidate[], ctx: JudgeContext): JudgeDecision[] {
    const decisions: JudgeDecision[] = []
    const seen = new Set<string>()

    for (const candidate of candidates) {
      const decision = judgeSingle(candidate, ctx)

      // 同批次去重：targetLayer + field + NFC/trim content
      if (decision.action === 'accept' || decision.action === 'downgrade') {
        const accepted = decision.accepted
        const key = `${accepted.targetLayer}|${accepted.field ?? ''}|${accepted.content.trim().normalize('NFC')}`
        if (seen.has(key)) {
          decisions.push({
            candidateId: candidate.candidateId,
            action: 'reject',
            reason: 'DUPLICATE_CANDIDATE'
          })
          continue
        }
        seen.add(key)
      }

      decisions.push(decision)
    }

    return decisions
  }

  return { judgeBatch }
}
