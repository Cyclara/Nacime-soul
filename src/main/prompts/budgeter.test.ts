// src/main/prompts/budgeter.test.ts
// P2-17 测试：PromptBudgeter（九层 item 级裁剪 + BudgetHistoryTurn 整轮裁剪）
// 依据：S-021 §1.5、§3.2 测试矩阵
//       S-001 P1-21A 验收（按 L2->旧历史->L1 次序裁剪；不可裁层 fail-closed；无半 token 截断）
//       S-004 §3.3.1 合同门禁 #2（小 context 裁剪）#3（静态层 fail-closed）

import { describe, it, expect } from 'vitest'
import { applyBudget, type BudgetHistoryTurn } from './budgeter'
import type { PromptItem, PromptLayer } from './builder'
import { renderLayer } from './builder'
import { estimateTokens } from './token-estimator'
import { AppError, isAppError } from '@shared/errors'

// === 测试辅助 ===

function makeStaticLayer(
  name: 'seed' | 'system' | 'identity' | 'soul' | 'style',
  content: string,
  opts: { critical?: boolean; trimmable?: boolean } = {}
): PromptLayer {
  const item: PromptItem = {
    id: `static:${name}`,
    kind: 'static',
    content,
    tokenEstimate: estimateTokens(content),
    trimmable: opts.trimmable ?? false
  }
  return {
    name,
    priority:
      name === 'seed'
        ? 0
        : name === 'system'
          ? 1
          : name === 'identity'
            ? 2
            : name === 'soul'
              ? 3
              : 8,
    critical: opts.critical ?? false,
    trimmable: opts.trimmable ?? false,
    status: 'loaded',
    prefix: '',
    content,
    tokenEstimate: item.tokenEstimate,
    items: [item],
    file: `${name}.md`,
    loaded: true
  }
}

function makeDynamicLayer(
  name: 'l0' | 'l1' | 'l2' | 'relationship',
  priority: 4 | 5 | 6 | 7,
  items: PromptItem[],
  trimmable: boolean
): PromptLayer {
  const prefix =
    name === 'l0' ? '## L0' : name === 'l1' ? '## L1' : name === 'l2' ? '## L2' : '## REL'
  const content = renderLayer(prefix, items)
  return {
    name,
    priority,
    critical: false,
    trimmable,
    status: items.length > 0 ? 'loaded' : 'empty',
    prefix,
    content,
    tokenEstimate: estimateTokens(content),
    items,
    file: 'runtime',
    loaded: items.length > 0
  }
}

function makeL2Item(memoryId: string, content: string, score: number): PromptItem {
  const text = `- ${content}`
  return {
    id: `l2:${memoryId}`,
    kind: 'l2-memory',
    content: text,
    tokenEstimate: estimateTokens(text),
    trimmable: true,
    trimRank: score
  }
}

function makeL1Item(
  text: string,
  updatedAt: number,
  category: 'recentGoal' | 'recentPreference'
): PromptItem {
  const content = `- ${text}`
  return {
    id: `l1:${category}:${updatedAt}`,
    kind: 'l1-entry',
    content,
    tokenEstimate: estimateTokens(content),
    trimmable: true,
    trimRank: updatedAt,
    updatedAt,
    category
  }
}

function makeRelFragment(index: number, text: string): PromptItem {
  const content = `- ${text}`
  return {
    id: `relationship:fragment:${index}`,
    kind: 'relationship-fragment',
    content,
    tokenEstimate: estimateTokens(content),
    trimmable: true,
    trimRank: index,
    category: 'milestone'
  }
}

function makeRelBaseline(): PromptItem {
  const text = '你们仍在逐步相互了解；不要声称拥有不存在的共同经历。'
  return {
    id: 'relationship:baseline',
    kind: 'relationship-baseline',
    content: text,
    tokenEstimate: estimateTokens(text),
    trimmable: false
  }
}

/** 构建 turns：每个 turn 是 [turnId, [[role, content]], isCurrent] */
function makeHistoryTurns(
  turns: Array<{ turnId: string; messages: Array<[string, string]>; isCurrent?: boolean }>
): BudgetHistoryTurn[] {
  return turns.map((t) => ({
    turnId: t.turnId,
    messages: t.messages.map(([role, content]) => ({
      role: role as 'user' | 'assistant',
      content
    })),
    isCurrent: t.isCurrent ?? false
  }))
}

const LARGE_CONTEXT = { contextWindow: 128000, maxOutputTokens: 2048 }

function buildLayers(opts: {
  seed?: string
  system?: string
  identity?: string
  soul?: string
  style?: string
  l0?: PromptItem[]
  l1?: PromptItem[]
  l2?: PromptItem[]
  relationship?: PromptItem[]
}): PromptLayer[] {
  const layers: PromptLayer[] = []
  if (opts.seed !== undefined) layers.push(makeStaticLayer('seed', opts.seed, { critical: true }))
  if (opts.system !== undefined)
    layers.push(makeStaticLayer('system', opts.system, { critical: true }))
  if (opts.identity !== undefined) layers.push(makeStaticLayer('identity', opts.identity))
  if (opts.soul !== undefined) layers.push(makeStaticLayer('soul', opts.soul))
  if (opts.l0 !== undefined) layers.push(makeDynamicLayer('l0', 4, opts.l0, false))
  if (opts.l1 !== undefined) layers.push(makeDynamicLayer('l1', 5, opts.l1, true))
  if (opts.l2 !== undefined) layers.push(makeDynamicLayer('l2', 6, opts.l2, true))
  if (opts.relationship !== undefined)
    layers.push(makeDynamicLayer('relationship', 7, opts.relationship, true))
  if (opts.style !== undefined)
    layers.push(makeStaticLayer('style', opts.style, { trimmable: true }))
  return layers
}

// === 测试 ===

describe('P2-17 PromptBudgeter (item-level + BudgetHistoryTurn)', () => {
  it('总 token 未超预算时不裁剪', () => {
    const layers = buildLayers({ seed: 'seed', system: 'system' })
    const turns = makeHistoryTurns([
      { turnId: 't1', messages: [['user', 'hello']], isCurrent: true }
    ])

    const report = applyBudget({
      layers,
      historyTurns: turns,
      modelCapabilities: LARGE_CONTEXT,
      safetyMargin: 100
    })

    expect(report.trimmed).toHaveLength(0)
    expect(report.styleRemoved).toBe(false)
    expect(report.historyRemoved).toBe(0)
    expect(report.exceededHardLimit).toBe(false)
    expect(report.messages[0]!.role).toBe('system')
    expect(report.messages[1]!.role).toBe('user')
    expect(report.messages[1]!.content).toBe('hello')
  })

  it('S-004 §3.3.1 #3: 静态核心超出硬上限时 CFG_INVALID fatal', () => {
    // CJK：1 字符 = 1 token，便于精确控制
    const longSeed = '种'.repeat(300) // 300 tokens
    const layers = buildLayers({ seed: longSeed })

    expect(() =>
      applyBudget({
        layers,
        historyTurns: [],
        modelCapabilities: { contextWindow: 200, maxOutputTokens: 50 },
        safetyMargin: 10
      })
    ).toThrow(AppError)

    try {
      applyBudget({
        layers,
        historyTurns: [],
        modelCapabilities: { contextWindow: 100, maxOutputTokens: 10 },
        safetyMargin: 5
      })
    } catch (e) {
      expect(isAppError(e)).toBe(true)
      expect((e as InstanceType<typeof AppError>).code).toBe('CFG_INVALID')
      expect((e as InstanceType<typeof AppError>).severity).toBe('fatal')
    }
  })

  it('budget<=0 时 CFG_INVALID', () => {
    const layers = buildLayers({ seed: 's' })
    expect(() =>
      applyBudget({
        layers,
        historyTurns: [],
        modelCapabilities: { contextWindow: 100, maxOutputTokens: 200 },
        safetyMargin: 50
      })
    ).toThrow(AppError)
  })

  it('S-001 验收: 按 L2->旧历史->L1 次序裁剪', () => {
    // CJK：1 字符 = 1 token，便于精确控制
    const layers = buildLayers({
      seed: '种子', // 2 tokens
      system: '系统', // 2 tokens
      l1: [makeL1Item('近期状态内容', 1000, 'recentGoal')], // ~8 tokens
      l2: [makeL2Item('m1', '长期记忆内容', 0.5)] // ~8 tokens
    })

    const turns = makeHistoryTurns([
      {
        turnId: 't1',
        messages: [
          ['user', '旧消息内容'],
          ['assistant', '旧回复内容']
        ]
      }, // ~10 tokens
      { turnId: 't2', messages: [['user', '当前消息']], isCurrent: true } // ~4 tokens
    ])

    // budget = 35 - 5 - 0 = 30
    // total ≈ static(4) + l1(8) + l2(8) + history(14) = 34 > 30
    // 裁 L2(8) -> 26 < 30 ✓
    const report = applyBudget({
      layers,
      historyTurns: turns,
      modelCapabilities: { contextWindow: 35, maxOutputTokens: 5 },
      safetyMargin: 0
    })

    // 应该先裁 L2
    const l2Trim = report.trimmed.find((t) => t.target === 'l2')
    expect(l2Trim).toBeDefined()
    // 当前 user 保留
    const lastMsg = report.messages[report.messages.length - 1]
    expect(lastMsg!.content).toBe('当前消息')
  })

  it('Seed/system/identity/soul 不裁剪', () => {
    const layers = buildLayers({
      seed: '种子内容',
      system: '系统内容',
      identity: '身份内容',
      soul: '灵魂内容'
    })

    const turns = makeHistoryTurns([
      {
        turnId: 't1',
        messages: [
          ['user', '历史消息'.repeat(20)],
          ['assistant', '历史回复'.repeat(20)]
        ]
      },
      { turnId: 't2', messages: [['user', '当前']], isCurrent: true }
    ])

    // budget = 100 - 5 - 0 = 95
    // static = 16 tokens; history = 160+160 = 320 tokens -> 裁历史
    const report = applyBudget({
      layers,
      historyTurns: turns,
      modelCapabilities: { contextWindow: 100, maxOutputTokens: 5 },
      safetyMargin: 0
    })

    expect(report.systemPrompt).toContain('种子内容')
    expect(report.systemPrompt).toContain('系统内容')
    expect(report.systemPrompt).toContain('身份内容')
    expect(report.systemPrompt).toContain('灵魂内容')
    expect(report.historyRemoved).toBeGreaterThan(0)
  })

  it('L0 不可裁（身份连续性资料）', () => {
    const l0Item: PromptItem = {
      id: 'l0:preferredName',
      kind: 'l0-field',
      content: '- [名字] 小明',
      tokenEstimate: 20,
      trimmable: false
    }
    const layers = buildLayers({
      seed: 's',
      system: 'sys',
      l0: [l0Item]
    })

    const turns = makeHistoryTurns([
      { turnId: 't1', messages: [['user', 'old'.repeat(50)]], isCurrent: false },
      { turnId: 't2', messages: [['user', 'cur']], isCurrent: true }
    ])

    const report = applyBudget({
      layers,
      historyTurns: turns,
      modelCapabilities: { contextWindow: 120, maxOutputTokens: 10 },
      safetyMargin: 5
    })

    expect(report.systemPrompt).toContain('小明')
  })

  it('BudgetHistoryTurn 整轮删除，不拆 turn', () => {
    const layers = buildLayers({ seed: 's', system: 'sys' })
    const turns = makeHistoryTurns([
      {
        turnId: 't1',
        messages: [
          ['user', 'msg1'],
          ['assistant', 'reply1']
        ],
        isCurrent: false
      },
      {
        turnId: 't2',
        messages: [
          ['user', 'msg2'],
          ['assistant', 'reply2']
        ],
        isCurrent: false
      },
      { turnId: 't3', messages: [['user', 'cur']], isCurrent: true }
    ])

    const report = applyBudget({
      layers,
      historyTurns: turns,
      modelCapabilities: { contextWindow: 60, maxOutputTokens: 10 },
      safetyMargin: 5
    })

    // 裁剪的 history 是整 turn（itemIds 是 turnId）
    const historyTrims = report.trimmed.filter((t) => t.target === 'history')
    for (const ht of historyTrims) {
      expect(ht.itemIds.length).toBe(1) // 整 turn 作为一个 ID
    }
    // 当前 turn 保留
    expect(report.messages.some((m) => m.content === 'cur')).toBe(true)
  })

  it('当前 isCurrent turn 永不裁剪', () => {
    const layers = buildLayers({ seed: 's', system: 'sys' })
    const turns = makeHistoryTurns([
      { turnId: 't1', messages: [['user', 'old'.repeat(100)]], isCurrent: false },
      { turnId: 't2', messages: [['user', 'curmsg']], isCurrent: true }
    ])

    const report = applyBudget({
      layers,
      historyTurns: turns,
      modelCapabilities: { contextWindow: 50, maxOutputTokens: 10 },
      safetyMargin: 5
    })

    expect(report.messages.some((m) => m.content === 'curmsg')).toBe(true)
  })

  it('L2 items 按 trimRank 升序裁（低分先裁）', () => {
    const layers = buildLayers({
      seed: '种',
      system: '系',
      l2: [
        makeL2Item('low', '低分记忆内容甲', 0.3), // 低分，先裁
        makeL2Item('high', '高分记忆内容乙', 0.9) // 高分，保留
      ]
    })

    const turns = makeHistoryTurns([
      { turnId: 't1', messages: [['user', '当前']], isCurrent: true }
    ])

    // budget = 25 - 5 - 0 = 20
    // total ≈ static(2) + l2(约 20: prefix 4 + 2 items 各 8) + history(2) = 24 > 20
    // 裁 low(8) -> 16 < 20 ✓
    const report = applyBudget({
      layers,
      historyTurns: turns,
      modelCapabilities: { contextWindow: 25, maxOutputTokens: 5 },
      safetyMargin: 0
    })

    expect(report.droppedMemoryIds).toContain('low')
    expect(report.includedMemoryIds).toContain('high')
  })

  it('includedMemoryIds/droppedMemoryIds 正确', () => {
    const layers = buildLayers({
      seed: 's',
      system: 'sys',
      l2: [makeL2Item('m1', 'content-1', 0.3), makeL2Item('m2', 'content-2', 0.9)]
    })

    const turns = makeHistoryTurns([{ turnId: 't1', messages: [['user', 'cur']], isCurrent: true }])

    const report = applyBudget({
      layers,
      historyTurns: turns,
      modelCapabilities: { contextWindow: 70, maxOutputTokens: 10 },
      safetyMargin: 5
    })

    // m1 和 m2 不会同时在 included（预算小）；要么 m1 裁 m2 留，要么都裁
    expect(report.includedMemoryIds.length + report.droppedMemoryIds.length).toBe(2)
    // 若有 included，必不含 dropped
    for (const id of report.includedMemoryIds) {
      expect(report.droppedMemoryIds).not.toContain(id)
    }
  })

  it('L1 items 按 updatedAt 升序裁（旧先裁）', () => {
    const layers = buildLayers({
      seed: 's',
      system: 'sys',
      l1: [
        makeL1Item('old-goal', 1000, 'recentGoal'), // 旧，先裁
        makeL1Item('new-pref', 9000, 'recentPreference') // 新，保留
      ]
    })

    const turns = makeHistoryTurns([{ turnId: 't1', messages: [['user', 'cur']], isCurrent: true }])

    const report = applyBudget({
      layers,
      historyTurns: turns,
      modelCapabilities: { contextWindow: 80, maxOutputTokens: 10 },
      safetyMargin: 5
    })

    const l1Trim = report.trimmed.find((t) => t.target === 'l1')
    if (l1Trim) {
      // 旧 goal 应先被裁
      expect(l1Trim.itemIds).toContain('l1:recentGoal:1000')
    }
  })

  it('relationship fragments 按 index 升序裁（旧先裁），baseline 保留', () => {
    const layers = buildLayers({
      seed: 's',
      system: 'sys',
      relationship: [
        makeRelBaseline(),
        makeRelFragment(0, 'old-fragment-content-aaaa'),
        makeRelFragment(1, 'new-fragment-content-bbbb')
      ]
    })

    const turns = makeHistoryTurns([{ turnId: 't1', messages: [['user', 'cur']], isCurrent: true }])

    const report = applyBudget({
      layers,
      historyTurns: turns,
      modelCapabilities: { contextWindow: 100, maxOutputTokens: 10 },
      safetyMargin: 5
    })

    // baseline 始终保留
    expect(report.systemPrompt).toContain('逐步相互了解')
    // 旧 fragment 先裁
    const relTrim = report.trimmed.find((t) => t.target === 'relationship')
    if (relTrim) {
      expect(relTrim.itemIds[0]).toBe('relationship:fragment:0')
    }
  })

  it('style 整层最后裁剪', () => {
    const layers = buildLayers({
      seed: 's',
      system: 'sys',
      l2: [makeL2Item('m1', 'l2-content-aaaa', 0.5)],
      l1: [makeL1Item('l1-content-aaaa', 1000, 'recentGoal')],
      style: 'style-content-aaaa'
    })

    const turns = makeHistoryTurns([
      { turnId: 't1', messages: [['user', 'old-msg-aaaa']], isCurrent: false },
      { turnId: 't2', messages: [['user', 'cur']], isCurrent: true }
    ])

    const report = applyBudget({
      layers,
      historyTurns: turns,
      modelCapabilities: { contextWindow: 80, maxOutputTokens: 10 },
      safetyMargin: 5
    })

    // L2 应先于 style 裁
    const l2TrimIdx = report.trimmed.findIndex((t) => t.target === 'l2')
    const styleTrimIdx = report.trimmed.findIndex((t) => t.target === 'style')
    if (styleTrimIdx >= 0) {
      expect(l2TrimIdx).toBeLessThan(styleTrimIdx)
      expect(report.styleRemoved).toBe(true)
      expect(report.systemPrompt).not.toContain('style-content')
    }
  })

  it('核心+L0+relationship baseline+当前 user 超限 -> CHAT_CONTEXT_TOO_LARGE', () => {
    // CJK：1 字符 = 1 token
    // 静态核心 < budget，但加上不可裁的当前 user 后超限
    const layers = buildLayers({
      seed: '种'.repeat(20), // 20 tokens
      system: '系'.repeat(20) // 20 tokens
    })
    // static core = 40; budget = 100 - 5 - 0 = 95; 40 < 95 -> 通过静态检查
    // 当前 user 消息 100 tokens，加核心 40 = 140 > 95 -> 超限
    const longCurrent = '长'.repeat(100)
    const turns = makeHistoryTurns([
      { turnId: 't1', messages: [['user', longCurrent]], isCurrent: true }
    ])

    expect(() =>
      applyBudget({
        layers,
        historyTurns: turns,
        modelCapabilities: { contextWindow: 100, maxOutputTokens: 5 },
        safetyMargin: 0
      })
    ).toThrow(AppError)

    try {
      applyBudget({
        layers,
        historyTurns: turns,
        modelCapabilities: { contextWindow: 100, maxOutputTokens: 5 },
        safetyMargin: 0
      })
    } catch (e) {
      expect(isAppError(e)).toBe(true)
      expect((e as InstanceType<typeof AppError>).code).toBe('CHAT_CONTEXT_TOO_LARGE')
      expect((e as InstanceType<typeof AppError>).retryable).toBe(false)
    }
  })

  it('budget 计算 = contextWindow - maxOutput - safetyMargin', () => {
    const layers = buildLayers({ seed: 's' })
    const report = applyBudget({
      layers,
      historyTurns: [],
      modelCapabilities: { contextWindow: 1000, maxOutputTokens: 200 },
      safetyMargin: 50
    })

    expect(report.budget).toBe(750)
  })

  it('默认安全余量为 256', () => {
    const layers = buildLayers({ seed: 's' })
    const report = applyBudget({
      layers,
      historyTurns: [],
      modelCapabilities: { contextWindow: 1000, maxOutputTokens: 200 }
    })

    expect(report.budget).toBe(1000 - 200 - 256)
  })

  it('正常返回时 exceededHardLimit 恒为 false', () => {
    const layers = buildLayers({ seed: 's', system: 'sys' })
    const turns = makeHistoryTurns([{ turnId: 't1', messages: [['user', 'hi']], isCurrent: true }])

    const report = applyBudget({
      layers,
      historyTurns: turns,
      modelCapabilities: LARGE_CONTEXT
    })

    expect(report.exceededHardLimit).toBe(false)
    expect(report.totalTokens).toBeLessThanOrEqual(report.budget)
  })

  it('messages[0] 是 system role', () => {
    const layers = buildLayers({ seed: 's', system: 'sys' })
    const turns = makeHistoryTurns([{ turnId: 't1', messages: [['user', 'hi']], isCurrent: true }])

    const report = applyBudget({
      layers,
      historyTurns: turns,
      modelCapabilities: LARGE_CONTEXT
    })

    expect(report.messages[0]!.role).toBe('system')
    expect(report.messages.length).toBe(2) // system + user
  })

  it('裁剪只移除整 item / 整 turn，不截断字符串', () => {
    const layers = buildLayers({
      seed: 's',
      system: 'sys',
      l2: [makeL2Item('m1', '完整内容一', 0.3), makeL2Item('m2', '完整内容二', 0.9)]
    })

    const turns = makeHistoryTurns([{ turnId: 't1', messages: [['user', 'cur']], isCurrent: true }])

    const report = applyBudget({
      layers,
      historyTurns: turns,
      modelCapabilities: { contextWindow: 70, maxOutputTokens: 10 },
      safetyMargin: 5
    })

    // systemPrompt 中保留的 L2 内容是完整的（不截断）
    if (report.includedMemoryIds.includes('m2')) {
      expect(report.systemPrompt).toContain('完整内容二')
    }
    // 裁掉的 m1 不出现
    if (report.droppedMemoryIds.includes('m1')) {
      expect(report.systemPrompt).not.toContain('完整内容一')
    }
  })

  it('无 style 层时正常工作', () => {
    const layers = buildLayers({ seed: 'seed', system: 'system' })
    const turns = makeHistoryTurns([{ turnId: 't1', messages: [['user', 'hi']], isCurrent: true }])

    const report = applyBudget({
      layers,
      historyTurns: turns,
      modelCapabilities: LARGE_CONTEXT
    })

    expect(report.styleRemoved).toBe(false)
    expect(report.systemPrompt).toContain('seed')
    expect(report.systemPrompt).toContain('system')
  })

  it('合法单 user failed turn 可整轮删除', () => {
    // S-021 §1.5：合法单 user failed turn 可删（不拆 turn）
    const layers = buildLayers({ seed: '种', system: '系' })
    const turns = makeHistoryTurns([
      { turnId: 't1', messages: [['user', '失败轮次的较长内容']], isCurrent: false }, // ~10 tokens
      { turnId: 't2', messages: [['user', '当前']], isCurrent: true } // ~2 tokens
    ])

    // budget = 15 - 5 - 0 = 10
    // total ≈ static(2) + t1(10) + t2(2) = 14 > 10 -> 裁 t1 -> 4 < 10 ✓
    const report = applyBudget({
      layers,
      historyTurns: turns,
      modelCapabilities: { contextWindow: 15, maxOutputTokens: 5 },
      safetyMargin: 0
    })

    expect(report.historyRemoved).toBeGreaterThanOrEqual(1)
    expect(report.messages.some((m) => m.content === '当前')).toBe(true)
  })
})
