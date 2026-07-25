// src/main/prompts/budgeter.test.ts
// P1-21A 测试：PromptBudgeter
// 依据：S-001 P1-21A 验收"小窗口 fixture 下按 L2->旧历史->L1 次序裁剪；
//       Seed/system/identity/soul 不裁剪；无半 token/半字符静默截断"
//       S-004 §3.3.1 合同门禁 #2（小 context 裁剪）#3（静态层 fail-closed）

import { describe, it, expect } from 'vitest'
import { applyBudget } from './budgeter'
import type { PromptLayer } from './builder'
import type { LlmMessage } from '../llm/types'
import { AppError, isAppError } from '@shared/errors'

// === 测试辅助 ===

function makeLayer(
  name: 'seed' | 'system' | 'identity' | 'soul' | 'style',
  content: string,
  critical = false
): PromptLayer {
  return {
    name,
    content,
    critical,
    loaded: true,
    file: `${name}.md`
  }
}

function makeLayers(
  opts: Partial<Record<'seed' | 'system' | 'identity' | 'soul' | 'style', string>> = {}
): PromptLayer[] {
  const layers: PromptLayer[] = []
  if (opts.seed) layers.push(makeLayer('seed', opts.seed, true))
  if (opts.system) layers.push(makeLayer('system', opts.system, true))
  if (opts.identity) layers.push(makeLayer('identity', opts.identity))
  if (opts.soul) layers.push(makeLayer('soul', opts.soul))
  if (opts.style) layers.push(makeLayer('style', opts.style))
  return layers
}

function makeHistory(messages: Array<[string, string]>): LlmMessage[] {
  return messages.map(([role, content]) => ({
    role: role as 'user' | 'assistant',
    content
  }))
}

const LARGE_CONTEXT = { contextWindow: 128000, maxOutputTokens: 2048 }
const SMALL_CONTEXT = { contextWindow: 200, maxOutputTokens: 50 }

// === 测试 ===

describe('P1-21A PromptBudgeter', () => {
  it('总 token 未超预算时不裁剪', () => {
    const layers = makeLayers({
      seed: '你是测试角色。',
      system: '你在对话。'
    })
    const history = makeHistory([['user', '你好']])

    const report = applyBudget({
      layers,
      history,
      modelCapabilities: LARGE_CONTEXT,
      safetyMargin: 100
    })

    expect(report.trimmed).toHaveLength(0)
    expect(report.styleRemoved).toBe(false)
    expect(report.historyRemoved).toBe(0)
    expect(report.exceededHardLimit).toBe(false)
    expect(report.messages[0]!.role).toBe('system')
    expect(report.messages[1]!.role).toBe('user')
    expect(report.messages[1]!.content).toBe('你好')
  })

  it('S-004 §3.3.1 #3: 静态层超出硬上限时 fail-closed', () => {
    const longSeed = '种'.repeat(200) // 200 CJK tokens
    const layers = makeLayers({ seed: longSeed })

    expect(() =>
      applyBudget({
        layers,
        history: [],
        modelCapabilities: SMALL_CONTEXT, // budget = 200 - 50 - 256 < 0
        safetyMargin: 10
      })
    ).toThrow(AppError)

    try {
      applyBudget({
        layers,
        history: [],
        modelCapabilities: { contextWindow: 100, maxOutputTokens: 10 },
        safetyMargin: 5
      })
    } catch (e) {
      expect(isAppError(e)).toBe(true)
      expect((e as InstanceType<typeof AppError>).severity).toBe('fatal')
      expect((e as InstanceType<typeof AppError>).userMessage).toContain('超出预算')
    }
  })

  it('S-001 验收: 按 L2->旧历史->L1 次序裁剪', () => {
    // 小窗口：seed+system 刚好放下，但加 L2+历史+L1 后超预算
    const layers = makeLayers({
      seed: '种子', // 2 tokens
      system: '系统' // 2 tokens
    })

    const history = makeHistory([
      ['user', '第一条消息很长很长'], // 9 tokens
      ['assistant', '回复也很长很长'], // 7 tokens
      ['user', '当前消息'] // 4 tokens
    ])

    // budget = 55 - 10 - 5 = 40
    // 初始 total = static(4) + L1(20) + L2(20) + history(20) + joins(~6) ≈ 70
    // 裁剪 L2(20) 后 ≈ 50 > 40 -> 继续裁剪历史
    // 裁剪历史 msg1(9) 后 ≈ 41 > 40 -> 继续裁剪历史
    // 裁剪历史 msg2(7) 后 ≈ 34 <= 40 -> 停止
    const report = applyBudget({
      layers,
      history,
      dynamicLayers: {
        l1: '近期状态'.repeat(5), // 20 tokens
        l2: '长期记忆'.repeat(5) // 20 tokens
      },
      modelCapabilities: { contextWindow: 55, maxOutputTokens: 10 },
      safetyMargin: 5
    })

    // 应该先裁剪 L2
    const l2Trim = report.trimmed.find((t) => t.target === 'l2')
    expect(l2Trim).toBeDefined()

    // 然后裁剪旧历史
    const historyTrim = report.trimmed.find((t) => t.target === 'history')
    expect(historyTrim).toBeDefined()
    expect(report.historyRemoved).toBeGreaterThanOrEqual(1)

    // 保留最后一条用户消息
    const lastMessage = report.messages[report.messages.length - 1]
    expect(lastMessage!.role).toBe('user')
    expect(lastMessage!.content).toBe('当前消息')
  })

  it('Seed/system/identity/soul 不裁剪', () => {
    const layers = makeLayers({
      seed: '种子内容',
      system: '系统内容',
      identity: '身份内容',
      soul: '灵魂内容'
    })

    const longHistory = makeHistory([
      ['user', '历史消息'.repeat(20)],
      ['assistant', '历史回复'.repeat(20)],
      ['user', '当前']
    ])

    const report = applyBudget({
      layers,
      history: longHistory,
      modelCapabilities: { contextWindow: 100, maxOutputTokens: 10 },
      safetyMargin: 5
    })

    // 所有静态层内容都应该在 systemPrompt 中
    expect(report.systemPrompt).toContain('种子内容')
    expect(report.systemPrompt).toContain('系统内容')
    expect(report.systemPrompt).toContain('身份内容')
    expect(report.systemPrompt).toContain('灵魂内容')

    // 历史被裁剪
    expect(report.historyRemoved).toBeGreaterThan(0)
  })

  it('裁剪只移除整条消息，不截断字符串', () => {
    const layers = makeLayers({
      seed: '种子',
      system: '系统'
    })

    const history = makeHistory([
      ['user', '完整消息一'],
      ['assistant', '完整回复一'],
      ['user', '完整消息二'],
      ['assistant', '完整回复二'],
      ['user', '当前消息']
    ])

    const report = applyBudget({
      layers,
      history,
      modelCapabilities: { contextWindow: 50, maxOutputTokens: 10 },
      safetyMargin: 5
    })

    // 每条保留的消息应该是完整的（不被截断）
    for (const msg of report.messages) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        // 消息内容应该是原始的完整内容，不是截断的
        const originalContents = [
          '完整消息一',
          '完整回复一',
          '完整消息二',
          '完整回复二',
          '当前消息'
        ]
        expect(originalContents).toContain(msg.content)
      }
    }
  })

  it('style 在 L1 之后被裁剪', () => {
    // 设计：L2 + 旧历史 + L1 全部裁剪后，static + style + 当前消息 仍超预算
    const layers = makeLayers({
      seed: '种子', // 2 tokens
      system: '系统', // 2 tokens
      style: '风格描述'.repeat(5) // 20 tokens
    })

    const history = makeHistory([
      ['user', '历史消息'.repeat(5)], // 20 tokens
      ['user', '当前'] // 2 tokens
    ])

    // budget = 40 - 10 - 5 = 25
    // 裁剪 L2(40) -> 裁剪历史(20) -> 裁剪 L1(40) 后：
    // static(4) + style(20) + 当前(2) = 26 > 25 -> 裁剪 style
    const report = applyBudget({
      layers,
      history,
      dynamicLayers: {
        l1: '近期状态'.repeat(10), // 40 tokens
        l2: '长期记忆'.repeat(10) // 40 tokens
      },
      modelCapabilities: { contextWindow: 40, maxOutputTokens: 10 },
      safetyMargin: 5
    })

    // L2 应该先被裁剪
    expect(report.trimmed.find((t) => t.target === 'l2')).toBeDefined()
    // L1 应该也被裁剪
    expect(report.trimmed.find((t) => t.target === 'l1')).toBeDefined()
    // style 应该也被裁剪（在 L1 之后）
    expect(report.styleRemoved).toBe(true)
    expect(report.systemPrompt).not.toContain('风格描述')
  })

  it('budget 计算 = contextWindow - maxOutput - safetyMargin', () => {
    const layers = makeLayers({ seed: '种子' })
    const report = applyBudget({
      layers,
      history: [],
      modelCapabilities: { contextWindow: 1000, maxOutputTokens: 200 },
      safetyMargin: 50
    })

    expect(report.budget).toBe(750)
  })

  it('默认安全余量为 256', () => {
    const layers = makeLayers({ seed: '种子' })
    const report = applyBudget({
      layers,
      history: [],
      modelCapabilities: { contextWindow: 1000, maxOutputTokens: 200 }
      // 不传 safetyMargin
    })

    expect(report.budget).toBe(1000 - 200 - 256)
  })

  it('L0 不被裁剪（Phase 1 保留）', () => {
    const layers = makeLayers({
      seed: '种子',
      system: '系统'
    })

    const l0Content = '用户画像'.repeat(10)

    const report = applyBudget({
      layers,
      history: makeHistory([['user', '当前消息']]),
      dynamicLayers: { l0: l0Content },
      modelCapabilities: { contextWindow: 100, maxOutputTokens: 10 },
      safetyMargin: 5
    })

    // L0 应该保留在 systemPrompt 中
    expect(report.systemPrompt).toContain(l0Content)
  })

  it('保留至少最后一条历史消息', () => {
    const layers = makeLayers({
      seed: '种子',
      system: '系统'
    })

    const history = makeHistory([
      ['user', '旧消息'.repeat(30)],
      ['assistant', '旧回复'.repeat(30)],
      ['user', '当前消息']
    ])

    const report = applyBudget({
      layers,
      history,
      modelCapabilities: { contextWindow: 50, maxOutputTokens: 10 },
      safetyMargin: 5
    })

    // 最后一条消息（当前用户消息）必须保留
    const lastMsg = report.messages[report.messages.length - 1]
    expect(lastMsg).toBeDefined()
    expect(lastMsg!.content).toBe('当前消息')
  })

  it('裁剪记录包含 tokensRemoved 和 itemsRemoved', () => {
    const layers = makeLayers({
      seed: '种子',
      system: '系统'
    })

    const history = makeHistory([
      ['user', '历史消息一'.repeat(20)],
      ['user', '当前']
    ])

    const report = applyBudget({
      layers,
      history,
      modelCapabilities: { contextWindow: 60, maxOutputTokens: 10 },
      safetyMargin: 5
    })

    for (const trim of report.trimmed) {
      expect(trim.tokensRemoved).toBeGreaterThan(0)
      expect(trim.itemsRemoved).toBeGreaterThanOrEqual(1)
      expect(trim.description).toBeTruthy()
    }
  })

  it('messages[0] 是 system role', () => {
    const layers = makeLayers({ seed: '种子', system: '系统' })
    const report = applyBudget({
      layers,
      history: makeHistory([['user', '你好']]),
      modelCapabilities: LARGE_CONTEXT
    })

    expect(report.messages[0]!.role).toBe('system')
    expect(report.messages.length).toBe(2) // system + user
  })

  it('无 style 层时正常工作', () => {
    const layers = makeLayers({ seed: '种子', system: '系统' }) // 无 style
    const report = applyBudget({
      layers,
      history: makeHistory([['user', '你好']]),
      modelCapabilities: LARGE_CONTEXT
    })

    expect(report.styleRemoved).toBe(false)
    expect(report.systemPrompt).toContain('种子')
    expect(report.systemPrompt).toContain('系统')
  })
})
