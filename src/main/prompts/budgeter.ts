// src/main/prompts/budgeter.ts
// P2-17: PromptBudgeter - 九层 item 级裁剪 + BudgetHistoryTurn 整轮裁剪
// 依据：S-021 §1.5、S-001 P1-21A（预算纪律延续）、S-004 §3.3.1 合同门禁 #2/#3
//
// 预算公式：
//   budget = contextWindow - maxOutputTokens - safetyMargin
//
// 裁剪顺序（S-021 §1.5，固定）：
//   1. L2 items：trimRank 升序（越低越先删），同分 id 升序
//   2. 旧历史：最旧 BudgetHistoryTurn 整体删除；当前 isCurrent turn 永不裁
//   3. L1 items：trimRank=updatedAt 升序（旧先裁），同分 category+id
//   4. relationship fragments：trimRank=index 升序（旧先裁）；baseline 保留
//   5. style 整层最后删除
//
// 不可裁（S-021 §1.5）：
//   - seed/system/identity/soul（loaded 且非空）-> 超预算 fatal CFG_INVALID
//   - L0 items（身份连续性资料）
//   - relationship baseline
//   - 当前 user turn
//
// 失败边界：
//   - budget<=0 或静态核心超限 -> CFG_INVALID fatal
//   - 核心+L0+relationship baseline+当前 user 仍超限 -> CHAT_CONTEXT_TOO_LARGE
//   - 正常返回必须 totalTokens<=budget，exceededHardLimit 恒为 false

import { AppError } from '@shared/errors'
import type { LlmMessage } from '../llm/types'
import type { PromptItem, PromptLayer } from './builder'
import { renderLayer } from './builder'
import { estimateTokens } from './token-estimator'
// === 类型 ===

const DEFAULT_SAFETY_MARGIN = 256

/** M-21：每条消息的 framing 开销（role 标记 + JSON 结构 + 分隔符，估算 ~4-8 token/条）。
 *  旧实现只按 content 字符估算，总 token 会低估；加这层让预算更贴近真实 usage。 */
const MESSAGE_FRAMING_TOKENS = 4

/**
 * 历史按 turn 分组。允许 [user] 或 [user,assistant]；不得 assistant 开头。
 * isCurrent turn 恰好一个，且含当前 user，永不裁。
 */
export interface BudgetHistoryTurn {
  turnId: string
  messages: readonly LlmMessage[]
  isCurrent: boolean
}

/** Budgeter 输入 */
export interface BudgetInput {
  /** 九层 Prompt（来自 buildPrompt） */
  layers: readonly PromptLayer[]
  /** 历史按 turn 分组 */
  historyTurns: readonly BudgetHistoryTurn[]
  /** 模型能力 */
  modelCapabilities: {
    contextWindow: number
    maxOutputTokens: number
  }
  /** 安全余量（token），默认 256 */
  safetyMargin?: number
}

/** 单次裁剪记录 */
export interface TrimRecord {
  target: 'l2' | 'history' | 'l1' | 'relationship' | 'style'
  reason: 'lower-rank' | 'old-history' | 'stale-l1' | 'old-fragment' | 'style-last'
  itemIds: readonly string[]
  tokensRemoved: number
}

/** Budgeter 产出报告 */
export interface BudgetReport {
  /** 最终消息数组（system + 历史消息） */
  messages: LlmMessage[]
  /** 最终 system prompt */
  systemPrompt: string
  /** 总 token 估算 */
  totalTokens: number
  /** 预算上限 */
  budget: number
  /** 裁剪记录（按裁剪顺序） */
  trimmed: readonly TrimRecord[]
  /** 最终保留的 L2 memoryId 列表（不含 l2: 前缀） */
  includedMemoryIds: readonly string[]
  /** 被裁掉的 L2 memoryId 列表 */
  droppedMemoryIds: readonly string[]
  /** style 是否被移除 */
  styleRemoved: boolean
  /** 被移除的历史 turn 数 */
  historyRemoved: number
  /** 函数正常返回时必须恒为 false；无法满足预算就 throw */
  exceededHardLimit: false
}

// === 内部辅助 ===

const STATIC_CRITICAL = new Set(['seed', 'system'])
const STATIC_NON_CRITICAL = new Set(['identity', 'soul'])

/** 可变工作层：items 可 splice（内部裁剪用） */
interface WorkingLayer extends Omit<PromptLayer, 'items'> {
  items: PromptItem[]
}

/** 不可裁的静态核心 token：seed+system+identity+soul（loaded 且非空） */
function calcStaticCoreTokens(layers: readonly (PromptLayer | WorkingLayer)[]): number {
  let sum = 0
  for (const layer of layers) {
    if (STATIC_CRITICAL.has(layer.name) || STATIC_NON_CRITICAL.has(layer.name)) {
      if (layer.status === 'loaded') sum += layer.tokenEstimate
    }
  }
  return sum
}

/** 计算当前 system prompt 总 token（基于各层最终 content） */
function calcSystemTokens(layers: readonly (PromptLayer | WorkingLayer)[]): number {
  let sum = 0
  for (const layer of layers) {
    if (layer.status === 'loaded') sum += layer.tokenEstimate
  }
  return sum
}

/** 计算历史 turns 总 token（M-21：每条消息含 framing 开销） */
function calcHistoryTokens(turns: readonly BudgetHistoryTurn[]): number {
  let sum = 0
  for (const turn of turns) {
    for (const msg of turn.messages) {
      sum += estimateTokens(msg.content) + MESSAGE_FRAMING_TOKENS
    }
  }
  return sum
}

/** L2 item id -> memoryId（去 l2: 前缀） */
function l2ItemIdToMemoryId(itemId: string): string {
  return itemId.startsWith('l2:') ? itemId.slice(3) : itemId
}

/**
 * 重算指定动态层的 content + tokenEstimate（裁剪后调用）。
 * items 为空时 status 变 'empty'，content 清空。
 */
function recomputeLayer(layer: WorkingLayer): void {
  if (layer.status !== 'loaded' && layer.status !== 'empty') return
  if (layer.items.length === 0) {
    layer.status = 'empty'
    layer.content = ''
    layer.tokenEstimate = 0
    layer.loaded = false
    return
  }
  layer.content = renderLayer(layer.prefix, layer.items)
  layer.tokenEstimate = estimateTokens(layer.content)
  layer.status = 'loaded'
  layer.loaded = true
}

// === Budgeter ===

export function applyBudget(input: BudgetInput): BudgetReport {
  const { layers, historyTurns, modelCapabilities, safetyMargin = DEFAULT_SAFETY_MARGIN } = input

  const budget = modelCapabilities.contextWindow - modelCapabilities.maxOutputTokens - safetyMargin

  // === 1. budget<=0 -> CFG_INVALID ===
  if (budget <= 0) {
    throw new AppError({
      code: 'CFG_INVALID',
      userMessage: `模型上下文窗口过小：budget=${budget}（contextWindow=${modelCapabilities.contextWindow} - maxOutput=${modelCapabilities.maxOutputTokens} - safety=${safetyMargin}）`,
      severity: 'fatal',
      retryable: false
    })
  }

  // === 2. 静态核心超限 -> CFG_INVALID fatal ===
  const staticCoreTokens = calcStaticCoreTokens(layers)
  if (staticCoreTokens > budget) {
    throw new AppError({
      code: 'CFG_INVALID',
      userMessage: `Prompt 静态层（seed+system+identity+soul）token 估算 ${staticCoreTokens} 超出预算 ${budget}`,
      severity: 'fatal',
      retryable: false
    })
  }

  // === 3. 准备可变状态 ===
  // 深拷贝 layers（可变 items 数组），不动原 BuiltPrompt
  const workingLayers: WorkingLayer[] = layers.map((l) => ({
    ...l,
    items: [...l.items]
  }))
  const workingTurns: BudgetHistoryTurn[] = [...historyTurns]
  const trimmed: TrimRecord[] = []
  let styleRemoved = false
  let historyRemoved = 0

  /** 当前总 token */
  function total(): number {
    return calcSystemTokens(workingLayers) + calcHistoryTokens(workingTurns)
  }

  // === 4. 裁剪顺序 1: L2 items（trimRank 升序，同分 id 升序） ===
  if (total() > budget) {
    const l2Layer = workingLayers.find((l) => l.name === 'l2')
    if (l2Layer && l2Layer.status === 'loaded' && l2Layer.items.length > 0) {
      // 按 trimRank 升序，同分 id 升序（越低越先删）
      const sorted = [...l2Layer.items].sort((a, b) => {
        const ra = a.trimRank ?? 0
        const rb = b.trimRank ?? 0
        if (ra !== rb) return ra - rb
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })
      const removedIds: string[] = []
      let removedTokens = 0
      for (const item of sorted) {
        if (total() <= budget) break
        const idx = l2Layer.items.indexOf(item)
        if (idx < 0) continue
        l2Layer.items.splice(idx, 1)
        removedIds.push(item.id)
        removedTokens += item.tokenEstimate
        // 每次裁剪后立即重算，避免 total() 用过期 tokenEstimate
        recomputeLayer(l2Layer)
      }
      if (removedIds.length > 0) {
        trimmed.push({
          target: 'l2',
          reason: 'lower-rank',
          itemIds: removedIds,
          tokensRemoved: removedTokens
        })
      }
    }
  }

  // === 5. 裁剪顺序 2: 旧历史 turns（最旧先删，整 turn，当前永不裁） ===
  if (total() > budget) {
    while (total() > budget && workingTurns.length > 1) {
      // 找最旧非当前 turn（historyTurns 按时间升序，第一个非 current 即最旧）
      const oldestIdx = workingTurns.findIndex((t) => !t.isCurrent)
      if (oldestIdx < 0) break
      const removed = workingTurns.splice(oldestIdx, 1)[0]
      const removedTokens = removed.messages.reduce(
        (s, m) => s + estimateTokens(m.content) + MESSAGE_FRAMING_TOKENS,
        0
      )
      historyRemoved++
      trimmed.push({
        target: 'history',
        reason: 'old-history',
        itemIds: [removed.turnId],
        tokensRemoved: removedTokens
      })
    }
  }

  // === 6. 裁剪顺序 3: L1 items（trimRank=updatedAt 升序，同分 category+id） ===
  if (total() > budget) {
    const l1Layer = workingLayers.find((l) => l.name === 'l1')
    if (l1Layer && l1Layer.status === 'loaded' && l1Layer.items.length > 0) {
      const sorted = [...l1Layer.items].sort((a, b) => {
        const ra = a.trimRank ?? 0
        const rb = b.trimRank ?? 0
        if (ra !== rb) return ra - rb
        const ca = a.category ?? ''
        const cb = b.category ?? ''
        if (ca !== cb) return ca < cb ? -1 : 1
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })
      const removedIds: string[] = []
      let removedTokens = 0
      for (const item of sorted) {
        if (total() <= budget) break
        const idx = l1Layer.items.indexOf(item)
        if (idx < 0) continue
        l1Layer.items.splice(idx, 1)
        removedIds.push(item.id)
        removedTokens += item.tokenEstimate
        recomputeLayer(l1Layer)
      }
      if (removedIds.length > 0) {
        trimmed.push({
          target: 'l1',
          reason: 'stale-l1',
          itemIds: removedIds,
          tokensRemoved: removedTokens
        })
      }
    }
  }

  // === 7. 裁剪顺序 4: relationship fragments（trimRank=index 升序，baseline 保留） ===
  if (total() > budget) {
    const relLayer = workingLayers.find((l) => l.name === 'relationship')
    if (relLayer && relLayer.status === 'loaded' && relLayer.items.length > 0) {
      // 只裁 fragments（trimmable=true），baseline 保留
      const fragments = relLayer.items.filter((i) => i.trimmable)
      fragments.sort((a, b) => {
        const ra = a.trimRank ?? 0
        const rb = b.trimRank ?? 0
        return ra - rb
      })
      const removedIds: string[] = []
      let removedTokens = 0
      for (const item of fragments) {
        if (total() <= budget) break
        const idx = relLayer.items.indexOf(item)
        if (idx < 0) continue
        relLayer.items.splice(idx, 1)
        removedIds.push(item.id)
        removedTokens += item.tokenEstimate
        recomputeLayer(relLayer)
      }
      if (removedIds.length > 0) {
        trimmed.push({
          target: 'relationship',
          reason: 'old-fragment',
          itemIds: removedIds,
          tokensRemoved: removedTokens
        })
      }
    }
  }

  // === 8. 裁剪顺序 5: style 整层最后删除 ===
  if (total() > budget) {
    const styleLayer = workingLayers.find((l) => l.name === 'style')
    if (styleLayer && styleLayer.status === 'loaded' && styleLayer.items.length > 0) {
      const styleTokens = styleLayer.tokenEstimate
      const removedIds = styleLayer.items.map((i) => i.id)
      styleLayer.items = []
      recomputeLayer(styleLayer)
      styleRemoved = true
      trimmed.push({
        target: 'style',
        reason: 'style-last',
        itemIds: removedIds,
        tokensRemoved: styleTokens
      })
    }
  }

  // === 9. 仍超预算 -> 核心+L0+relationship baseline+当前 user 超限 -> CHAT_CONTEXT_TOO_LARGE ===
  if (total() > budget) {
    throw new AppError({
      code: 'CHAT_CONTEXT_TOO_LARGE',
      userMessage: '当前消息和必要上下文超过模型窗口，请缩短消息或选择更大上下文模型',
      severity: 'error',
      retryable: false
    })
  }

  // === 10. 构建最终输出 ===
  const systemPrompt = workingLayers
    .filter((l) => l.status === 'loaded' && l.content)
    .map((l) => l.content)
    .join('\n\n')

  const messages: LlmMessage[] = []
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt })
  }
  for (const turn of workingTurns) {
    messages.push(...turn.messages)
  }

  // 计算 included/dropped L2 memoryIds
  const finalL2Layer = workingLayers.find((l) => l.name === 'l2')
  const includedMemoryIds: string[] = []
  if (finalL2Layer) {
    for (const item of finalL2Layer.items) {
      if (item.kind === 'l2-memory') {
        includedMemoryIds.push(l2ItemIdToMemoryId(item.id))
      }
    }
  }
  const droppedMemoryIds: string[] = []
  for (const rec of trimmed) {
    if (rec.target === 'l2') {
      for (const id of rec.itemIds) {
        droppedMemoryIds.push(l2ItemIdToMemoryId(id))
      }
    }
  }

  return {
    messages,
    systemPrompt,
    totalTokens: total(),
    budget,
    trimmed,
    includedMemoryIds,
    droppedMemoryIds,
    styleRemoved,
    historyRemoved,
    exceededHardLimit: false
  }
}
