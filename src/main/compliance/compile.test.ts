// src/main/compliance/compile.test.ts
// P3C1-02：编译器合同——三条硬约束 + g/y + ReDoS 静态防线。
// 验收口径：不安全规则被**拒绝**（进 rejected，硬失败不降级为警告），
// 但整批编译永不抛出、有效规则照常可用（「拒绝但应用可启动」）。

import { describe, it, expect } from 'vitest'
import {
  compileComplianceRules,
  hasNestedUnboundedQuantifier,
  COMPLIANCE_RULE_ID_PATTERN
} from './compile'
import { COMPLIANCE_RULES, type ComplianceRule } from './rules'

function makeRule(overrides: Partial<ComplianceRule> = {}): ComplianceRule {
  return {
    id: 'R-XX-99',
    type: 'meta-reference',
    severity: 'critical',
    confidence: 0.95,
    pattern: /测试/,
    scope: 'anywhere',
    action: 'flag',
    description: '合成测试规则',
    knownFalsePositives: [],
    examples: { hit: ['测试'], miss: ['不相关'] },
    ...overrides
  }
}

describe('compileComplianceRules：出厂集与基线', () => {
  it('出厂 42 条全量编译零拒绝（应用可启动 + 出厂规则全合法）', () => {
    const { rules, rejected } = compileComplianceRules(COMPLIANCE_RULES)
    expect(rejected).toEqual([])
    expect(rules).toHaveLength(42)
    // 编译产物复用原 RegExp（无 g/y 状态下无 lastIndex 风险）
    expect(rules[0].regex).toBe(COMPLIANCE_RULES[0].pattern)
  })

  it('空输入返回空结果，不抛错', () => {
    expect(compileComplianceRules([])).toEqual({ rules: [], rejected: [] })
  })

  it('编译产物无 g/y 状态位，重复 test 结果确定（CMP-S11）', () => {
    const { rules } = compileComplianceRules(COMPLIANCE_RULES)
    for (const { regex, rule } of rules) {
      expect(regex.global, rule.id).toBe(false)
      expect(regex.sticky, rule.id).toBe(false)
    }
    const mr01 = rules.find((r) => r.rule.id === 'R-MR-01')
    expect(mr01).toBeDefined()
    const sample = mr01!.rule.examples.hit[1]
    expect(mr01!.regex.test(sample)).toBe(true)
    expect(mr01!.regex.test(sample)).toBe(true)
    expect(mr01!.regex.lastIndex).toBe(0)
  })
})

describe('compileComplianceRules：硬约束拒绝（单条硬失败，整批不抛）', () => {
  it("action 'block' + 非 critical → 拒绝", () => {
    const { rules, rejected } = compileComplianceRules([
      makeRule({ action: 'block', severity: 'warning', confidence: 0.99 })
    ])
    expect(rules).toEqual([])
    expect(rejected).toHaveLength(1)
    expect(rejected[0].ruleId).toBe('R-XX-99')
    expect(rejected[0].reasons.join()).toContain("action 'block'")
  })

  it("action 'block' + confidence<0.95 → 拒绝；critical+0.95 的 block → 放行", () => {
    const bad = makeRule({ id: 'R-XX-98', action: 'block', confidence: 0.94 })
    const good = makeRule({
      id: 'R-XX-99',
      action: 'block',
      severity: 'critical',
      confidence: 0.95
    })
    const { rules, rejected } = compileComplianceRules([bad, good])
    expect(rejected.map((r) => r.ruleId)).toEqual(['R-XX-98'])
    expect(rules.map((r) => r.rule.id)).toEqual(['R-XX-99'])
  })

  it('id 格式非法 → 拒绝（四种典型坏形）', () => {
    const badIds = ['r-mr-01', 'R-M1-01', 'R-ABC-01', 'R-MR-1']
    for (const id of badIds) {
      expect(COMPLIANCE_RULE_ID_PATTERN.test(id), id).toBe(false)
      const { rejected } = compileComplianceRules([makeRule({ id })])
      expect(rejected, id).toHaveLength(1)
    }
  })

  it('id 重复 → 保留首条、拒绝后续', () => {
    const first = makeRule({ description: '首条' })
    const dup = makeRule({ description: '重复条' })
    const { rules, rejected } = compileComplianceRules([first, dup])
    expect(rules.map((r) => r.rule.description)).toEqual(['首条'])
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reasons.join()).toContain('id 重复')
  })

  it('混批：好规则照常编译、坏规则进 rejected，永不抛出', () => {
    const batch = [
      makeRule({ id: 'R-XX-01' }),
      makeRule({ id: 'BAD', pattern: /x/g }),
      makeRule({ id: 'R-XX-02' })
    ]
    let result: ReturnType<typeof compileComplianceRules> | undefined
    expect(() => {
      result = compileComplianceRules(batch)
    }).not.toThrow()
    expect(result!.rules.map((r) => r.rule.id)).toEqual(['R-XX-01', 'R-XX-02'])
    expect(result!.rejected).toHaveLength(1)
    // 单条规则可携带多条拒绝原因
    expect(result!.rejected[0].reasons.length).toBeGreaterThanOrEqual(2)
  })
})

describe('compileComplianceRules：g/y 标志拒绝', () => {
  it.each([
    ['g', /测试/g],
    ['y', /测试/y],
    ['gy', /测试/gy]
  ] as const)('标志 %s → 拒绝并注明', (flags, pattern) => {
    const { rules, rejected } = compileComplianceRules([makeRule({ pattern })])
    expect(rules).toEqual([])
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reasons.join()).toContain('g/y')
    expect(rejected[0].reasons.join()).toContain(flags)
  })

  it('i/m/s/u 等无状态标志不影响编译', () => {
    const { rules, rejected } = compileComplianceRules([makeRule({ pattern: /测试/im })])
    expect(rejected).toEqual([])
    expect(rules).toHaveLength(1)
  })
})

describe('hasNestedUnboundedQuantifier：ReDoS 静态防线', () => {
  it.each([
    '(a+)+',
    '(\\w*)*',
    '(a?)+',
    '(x+){2,}',
    '((ab)+)+',
    '(?:(a+)x)+', // star height ≥2（传播语义）
    '(?:[\\s　]*\\S)+'
  ])('检出嵌套无界量词：%s', (source) => {
    expect(hasNestedUnboundedQuantifier(source)).toBe(true)
  })

  it.each([
    '(a+)?', // 可选组，非无界重复
    '(a+){2}', // 定宽重复
    '(a+){2,4}', // 有界重复
    '(?:ab|cd)+', // 组内无量词（star height 1）
    '(?:首先|第一)[，,][^\\n]{0,200}?(?:其次|总之)[，,]',
    '^[\\s　]*(?:作为|以下是)',
    "(?:I(?:'m|\\s+am)\\s+)?AI",
    '(?<=foo)bar+', // 后顾 + 顶层量词
    '\\d[.、)]',
    'a{2}', // 顶层定宽
    '(?:\\w+\\d){3}' // 组内量词 + 定宽外层
  ])('不误杀安全形态：%s', (source) => {
    expect(hasNestedUnboundedQuantifier(source)).toBe(false)
  })

  it('出厂 42 条 pattern 无一触发 ReDoS 拒绝', () => {
    for (const rule of COMPLIANCE_RULES) {
      expect(hasNestedUnboundedQuantifier(rule.pattern.source), rule.id).toBe(false)
    }
  })

  it('ReDoS 规则经编译器拒绝但同批好规则不受影响', () => {
    const evil = makeRule({ id: 'R-XX-01', pattern: /(a+)+$/ })
    const good = makeRule({ id: 'R-XX-02' })
    const { rules, rejected } = compileComplianceRules([evil, good])
    expect(rejected.map((r) => r.ruleId)).toEqual(['R-XX-01'])
    expect(rejected[0].reasons.join()).toContain('嵌套无界量词')
    expect(rules.map((r) => r.rule.id)).toEqual(['R-XX-02'])
  })
})
