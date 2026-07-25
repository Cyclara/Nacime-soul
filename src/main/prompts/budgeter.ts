// src/main/prompts/budgeter.ts
// P1-21A: PromptBudgeter - 按模型能力分配预算，按层级裁剪
// 依据：S-001 P1-21A、技术分析 §2.7（预算纪律）、S-004 §3.3.1 合同门禁 #2/#3
//
// 预算公式：
//   budget = contextWindow - maxOutputTokens - safetyMargin
//
// 裁剪优先级（从先到后）：
//   1. L2（长期记忆，Phase 2+）
//   2. 旧历史（最老的对话消息先移除）
//   3. L1（用户近期状态，Phase 2+）
//   4. style（语气风格）
//
// 不可裁剪（S-004 §3.3.1 #3）：
//   seed / system / identity / soul -> 超过硬上限时 fail-closed（抛 AppError）
//
// 禁止静默截断（S-001 P1-21A 验收"无半 token/半字符静默截断"）：
//   裁剪只移除整条消息或整个层，不在字符串中间截断。

import { AppError } from '@shared/errors'
import type { LlmMessage } from '../llm/types'
import type { PromptLayer } from './builder'
import { estimateTokens } from './token-estimator'

// === 类型 ===

/** 默认安全余量（token） */
const DEFAULT_SAFETY_MARGIN = 256

/** 动态层（Phase 2+ 预留，Phase 1 传入 undefined） */
export interface DynamicLayers {
  /** L0：用户核心画像。Phase 1 不裁剪（仅保留显式高置信字段） */
  l0?: string
  /** L1：用户近期状态。裁剪优先级 3（在旧历史之后） */
  l1?: string
  /** L2：长期记忆/共同经历。裁剪优先级 1（最先裁剪） */
  l2?: string
}

/** Budgeter 输入 */
export interface BudgetInput {
  /** 静态 prompt 层（来自 buildPrompt） */
  layers: PromptLayer[]
  /** 对话历史（user + assistant 消息，最老在前） */
  history: LlmMessage[]
  /** 动态层（Phase 2+，Phase 1 传 undefined） */
  dynamicLayers?: DynamicLayers
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
  /** 被裁剪的目标 */
  target: 'l2' | 'history' | 'l1' | 'style'
  /** 描述 */
  description: string
  /** 移除的 token 数（估算） */
  tokensRemoved: number
  /** 移除的消息/项目数 */
  itemsRemoved: number
}

/** Budgeter 产出报告 */
export interface BudgetReport {
  /** 最终消息数组（可直接用于 LlmRequest.messages） */
  messages: LlmMessage[]
  /** 最终 system prompt */
  systemPrompt: string
  /** 总 token 估算 */
  totalTokens: number
  /** 预算上限 */
  budget: number
  /** 是否超出硬上限（静态层 > 预算） */
  exceededHardLimit: boolean
  /** 裁剪记录（按裁剪顺序） */
  trimmed: TrimRecord[]
  /** style 是否被移除 */
  styleRemoved: boolean
  /** 被移除的历史消息数 */
  historyRemoved: number
}

// === 内部辅助 ===

/** 不可裁剪的层名称 */
const NON_TRIMMABLE_LAYERS = new Set(['seed', 'system', 'identity', 'soul'])

/**
 * 计算不可裁剪层的 token 总数。
 * 只统计 loaded=true 且属于 seed/system/identity/soul 的层。
 */
function calcStaticTokens(layers: PromptLayer[]): number {
  return layers
    .filter((l) => NON_TRIMMABLE_LAYERS.has(l.name) && l.loaded)
    .reduce((sum, l) => sum + estimateTokens(l.content), 0)
}

/**
 * 构建系统 prompt，可选择排除特定层。
 */
function buildSystemPrompt(
  layers: PromptLayer[],
  opts: { includeStyle: boolean; l0?: string; l1?: string | null; l2?: string | null }
): string {
  const parts: string[] = []

  // 静态层（始终包含）
  for (const layer of layers) {
    if (!layer.loaded) continue
    if (layer.name === 'style' && !opts.includeStyle) continue
    parts.push(layer.content)
  }

  // 动态层（Phase 2+）
  if (opts.l0) parts.push(opts.l0)
  if (opts.l1) parts.push(opts.l1)
  if (opts.l2) parts.push(opts.l2)

  return parts.join('\n\n')
}

// === Budgeter ===

/**
 * 应用 token 预算，按优先级裁剪。
 *
 * 流程：
 *   1. 计算预算 = contextWindow - maxOutputTokens - safetyMargin
 *   2. 计算静态层 token（seed+system+identity+soul）
 *   3. 静态层 > 预算 -> fail-closed（S-004 §3.3.1 #3）
 *   4. 计算总 token，若超预算则按 L2 -> 旧历史 -> L1 -> style 顺序裁剪
 *   5. 裁剪只移除整条消息/整个层，不截断字符串（S-001 P1-21A "无半 token/半字符"）
 *   6. 返回 BudgetReport
 */
export function applyBudget(input: BudgetInput): BudgetReport {
  const {
    layers,
    history,
    dynamicLayers,
    modelCapabilities,
    safetyMargin = DEFAULT_SAFETY_MARGIN
  } = input

  const budget = modelCapabilities.contextWindow - modelCapabilities.maxOutputTokens - safetyMargin

  // === 1. 检查静态层是否超出硬上限 ===
  const staticTokens = calcStaticTokens(layers)
  if (staticTokens > budget) {
    // S-004 §3.3.1 #3: fail-closed，不静默截断核心合同
    throw new AppError({
      code: 'CFG_INVALID',
      userMessage: `Prompt 静态层（seed+system+identity+soul）token 估算 ${staticTokens} 超出预算 ${budget}`,
      severity: 'fatal',
      retryable: false
    })
  }

  // === 2. 初始化裁剪状态 ===
  const trimmed: TrimRecord[] = []
  let includeStyle = true
  let l1Content: string | null = dynamicLayers?.l1 ?? null
  let l2Content: string | null = dynamicLayers?.l2 ?? null
  const workingHistory = [...history]
  let historyRemoved = 0

  // === 3. 计算总 token 并按需裁剪 ===
  function calcTotal(): number {
    const systemPrompt = buildSystemPrompt(layers, {
      includeStyle,
      l0: dynamicLayers?.l0,
      l1: l1Content,
      l2: l2Content
    })
    const systemTokens = estimateTokens(systemPrompt)
    const historyTokens = workingHistory.reduce((sum, msg) => sum + estimateTokens(msg.content), 0)
    return systemTokens + historyTokens
  }

  let total = calcTotal()

  // 裁剪优先级 1: L2
  if (total > budget && l2Content !== null) {
    const l2Tokens = estimateTokens(l2Content)
    l2Content = null
    total = calcTotal()
    trimmed.push({
      target: 'l2',
      description: '移除 L2 长期记忆层',
      tokensRemoved: l2Tokens,
      itemsRemoved: 1
    })
  }

  // 裁剪优先级 2: 旧历史（最老先移除）
  if (total > budget && workingHistory.length > 0) {
    // 保留至少最后一条消息（当前用户消息）
    while (total > budget && workingHistory.length > 1) {
      const removed = workingHistory.shift()!
      const removedTokens = estimateTokens(removed.content)
      historyRemoved++
      total = calcTotal()
      trimmed.push({
        target: 'history',
        description: `移除历史消息（role=${removed.role}）`,
        tokensRemoved: removedTokens,
        itemsRemoved: 1
      })
    }
  }

  // 裁剪优先级 3: L1
  if (total > budget && l1Content !== null) {
    const l1Tokens = estimateTokens(l1Content)
    l1Content = null
    total = calcTotal()
    trimmed.push({
      target: 'l1',
      description: '移除 L1 近期状态层',
      tokensRemoved: l1Tokens,
      itemsRemoved: 1
    })
  }

  // 裁剪优先级 4: style
  if (total > budget && includeStyle) {
    const styleLayer = layers.find((l) => l.name === 'style')
    if (styleLayer?.loaded) {
      const styleTokens = estimateTokens(styleLayer.content)
      includeStyle = false
      total = calcTotal()
      trimmed.push({
        target: 'style',
        description: '移除 style 语气风格层',
        tokensRemoved: styleTokens,
        itemsRemoved: 1
      })
    }
  }

  // === 4. 构建最终输出 ===
  const systemPrompt = buildSystemPrompt(layers, {
    includeStyle,
    l0: dynamicLayers?.l0,
    l1: l1Content,
    l2: l2Content
  })

  const messages: LlmMessage[] = []
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt })
  }
  messages.push(...workingHistory)

  return {
    messages,
    systemPrompt,
    totalTokens: total,
    budget,
    exceededHardLimit: false,
    trimmed,
    styleRemoved: !includeStyle,
    historyRemoved
  }
}
