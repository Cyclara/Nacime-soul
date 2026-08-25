// src/main/prompts/dynamic-renderers.ts
// P2-16C: 动态层原子 item 构造器。依据 S-021 §1.2-§1.4。
//
// 设计要点：
//   1. 每个 renderer 返回 { items, status }；空数据 -> status='empty'，不输出标题/占位句
//   2. L0 按 L0_FIELD_DESCRIPTIONS 固定 key 顺序，不按对象插入顺序
//   3. L1 按 updatedAt 新->旧排序（trimRank=updatedAt，旧->新裁剪）
//   4. L2 每条独立 item，不泄露 activation/confidence 给模型
//   5. relationship 总是注入 stage baseline（非裁），fragments 可裁（按达成顺序旧->新裁）
//
// 安全红线：
//   - L2 content 只能来自已持久化且经 MemoryJudge 接受的 L2 行
//   - raw 当前 user text 不直接进入动态层

import { estimateTokens } from './token-estimator'
import { L0_FIELD_DESCRIPTIONS, type L0FieldKey, type L0Profile } from '../memory/l0-store'
import type { L1State } from '../memory/l1-store'
import type {
  PromptItem,
  PromptLayerStatus,
  PromptL2Item,
  PromptRelationshipInput
} from './builder'

export interface RenderResult {
  items: PromptItem[]
  status: PromptLayerStatus
}

// === L0 ===

/**
 * 渲染 L0 层 items。按 L0_FIELD_DESCRIPTIONS 固定 key 顺序，每字段一条 item。
 * L0 不可裁（trimmable=false），是身份连续性资料。
 */
export function renderL0Items(profile: Readonly<L0Profile>): RenderResult {
  const items: PromptItem[] = []
  const keys = Object.keys(L0_FIELD_DESCRIPTIONS) as L0FieldKey[]
  for (const key of keys) {
    const field = profile.fields[key]
    if (field && field.value && field.value.trim().length > 0) {
      const label = L0_FIELD_DESCRIPTIONS[key]
      const content = `- [${label}] ${field.value}`
      items.push({
        id: `l0:${key}`,
        kind: 'l0-field',
        content,
        tokenEstimate: estimateTokens(content),
        trimmable: false
      })
    }
  }
  return { items, status: items.length > 0 ? 'loaded' : 'empty' }
}

// === L1 ===

/**
 * 渲染 L1 层 items。goals + preferences 合并，按 updatedAt 新->旧排序。
 * trimRank=updatedAt（epoch 越小越先裁），同分以 category+id 稳定排序。
 */
export function renderL1Items(state: Readonly<L1State>): RenderResult {
  const items: PromptItem[] = []
  type Entry = { text: string; updatedAt: number; category: 'recentGoal' | 'recentPreference' }
  const all: Entry[] = [
    ...state.recentGoals.map((e) => ({ ...e, category: 'recentGoal' as const })),
    ...state.recentPreferences.map((e) => ({ ...e, category: 'recentPreference' as const }))
  ]
  // 新->旧排序（展示顺序）
  all.sort((a, b) => b.updatedAt - a.updatedAt)
  for (const entry of all) {
    const content = `- ${entry.text}`
    items.push({
      id: `l1:${entry.category}:${entry.updatedAt}`,
      kind: 'l1-entry',
      content,
      tokenEstimate: estimateTokens(content),
      trimmable: true,
      trimRank: entry.updatedAt, // 旧（小 epoch）先裁
      updatedAt: entry.updatedAt,
      category: entry.category
    })
  }
  return { items, status: items.length > 0 ? 'loaded' : 'empty' }
}

// === L2 ===

/**
 * 渲染 L2 层 items。每条独立 item，id=`l2:${memoryId}`。
 * 不泄露 activation/confidence/retrievalScore 给模型，只输出 content。
 * trimRank=selectionRank（P2-25 前=retrievalScore，P2-25 后=activation；越小越先裁）。
 */
export function renderL2Items(l2Items: readonly PromptL2Item[]): RenderResult {
  const items: PromptItem[] = []
  for (const item of l2Items) {
    const content = `- ${item.content}`
    items.push({
      id: item.id, // l2:${memoryId}
      kind: 'l2-memory',
      content,
      tokenEstimate: estimateTokens(content),
      trimmable: true,
      trimRank: item.selectionRank // 越小越先裁
    })
  }
  return { items, status: items.length > 0 ? 'loaded' : 'empty' }
}

// === relationship ===

/**
 * 各 stage 的保守 baseline（非裁）。stranger 文案来自 S-021 §1.3；
 * 其余 stage 为合理的阶段感知扩展（P2-41 前 relationship 始终 skipped，不会实际使用）。
 */
export const RELATIONSHIP_BASELINE: Record<PromptRelationshipInput['stage'], string> = {
  stranger:
    '你们仍在逐步相互了解；只根据当前对话和明确提供的事实表达熟悉感，不要声称拥有不存在的共同经历。',
  acquaintance: '你们已经初步认识；可以提及已确认的共同事实，但不要编造不存在的共同经历。',
  familiar: '你们已经比较熟悉；可以自然地引用过去的对话内容，但仍以已确认的事实为准。',
  close: '你们关系亲密；可以自然地表达关心并回忆共同经历，但仍以事实为准。'
}

export type RelationshipBaseline = PromptRelationshipInput['stage']

/**
 * 渲染 relationship 层 items。
 * - baseline（非裁）：stage 对应的保守约束
 * - fragments（可裁）：按达成顺序，trimRank=index（旧先裁）
 */
export function renderRelationshipItems(input: PromptRelationshipInput): RenderResult {
  const items: PromptItem[] = []
  const baselineText = RELATIONSHIP_BASELINE[input.stage]
  items.push({
    id: 'relationship:baseline',
    kind: 'relationship-baseline',
    content: baselineText,
    tokenEstimate: estimateTokens(baselineText),
    trimmable: false
  })
  for (let i = 0; i < input.promptFragments.length; i++) {
    const frag = input.promptFragments[i]
    const content = `- ${frag}`
    items.push({
      id: `relationship:fragment:${i}`,
      kind: 'relationship-fragment',
      content,
      tokenEstimate: estimateTokens(content),
      trimmable: true,
      trimRank: i, // 旧（小 index）先裁
      category: 'milestone'
    })
  }
  return { items, status: 'loaded' }
}
