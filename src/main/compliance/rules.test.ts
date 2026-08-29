// src/main/compliance/rules.test.ts
// P3C1-02：出厂规则集数据合同 + hit/miss 样本全量自校验（C1 验收① / CMP-D01）。
// F5-001 §3.3 硬约束 3 明文在单测里跑；裁定 1.10：验收按 rules.ts 实际落地条数执行。

import { describe, it, expect } from 'vitest'
import {
  COMPLIANCE_RULES,
  COMPLIANCE_FACTORY_RULES,
  COMPLIANCE_RULE_CANDIDATES,
  SHADOW_FIRST_SEGMENT_PARAMS,
  SHADOW_POLICY_VERSION,
  SHADOW_TARGET_ACTIONS,
  shadowTargetAction,
  type ComplianceRule
} from './rules'
import { compileComplianceRules, COMPLIANCE_RULE_ID_PATTERN } from './compile'

const byId = (id: string): ComplianceRule => {
  const rule = COMPLIANCE_RULES.find((r) => r.id === id)
  if (rule === undefined) throw new Error(`规则不存在：${id}`)
  return rule
}

describe('P3C1-02 出厂规则集：规模与构成', () => {
  it('24 条原厂 + 18 条反方候选 = 42 条', () => {
    expect(COMPLIANCE_FACTORY_RULES).toHaveLength(24)
    expect(COMPLIANCE_RULE_CANDIDATES).toHaveLength(18)
    expect(COMPLIANCE_RULES).toHaveLength(42)
    expect(COMPLIANCE_RULES).toEqual([...COMPLIANCE_FACTORY_RULES, ...COMPLIANCE_RULE_CANDIDATES])
  })

  it('id 全局唯一且格式合法（F5-001 §3.3 硬约束 2，数据层锁定）', () => {
    const ids = COMPLIANCE_RULES.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(COMPLIANCE_RULE_ID_PATTERN.test(id), id).toBe(true)
  })

  it('红线⑥：42 条 action 全部为 flag（R-AP-05 strip 安全化后无 block/strip）', () => {
    for (const rule of COMPLIANCE_RULES) {
      expect(rule.action, rule.id).toBe('flag')
    }
  })

  it('omniscience / topic-jump 两类零正则覆盖（F5-001 §3.3 明写的已知漏报）', () => {
    const types = new Set(COMPLIANCE_RULES.map((r) => r.type))
    expect(types.has('omniscience')).toBe(false)
    expect(types.has('topic-jump')).toBe(false)
  })
})

describe('P3C1-02 examples 全量自校验（C1 验收①：全部出厂规则 hit 全中、miss 全不中）', () => {
  it.each(COMPLIANCE_RULES.map((r) => [r.id, r] as const))('%s', (_id, rule) => {
    expect(rule.examples.hit.length, `${rule.id} 至少一条 hit 样本`).toBeGreaterThan(0)
    expect(rule.examples.miss.length, `${rule.id} 至少一条 miss 样本`).toBeGreaterThan(0)
    for (const sample of rule.examples.hit) {
      expect(
        rule.pattern.test(sample),
        `${rule.id} hit 样本未命中：${JSON.stringify(sample)}`
      ).toBe(true)
    }
    for (const sample of rule.examples.miss) {
      expect(
        rule.pattern.test(sample),
        `${rule.id} miss 样本误命中：${JSON.stringify(sample)}`
      ).toBe(false)
    }
  })
})

describe('P3C1-02 裁定 1.10 三处修正', () => {
  it('R-MR-01：`作为(?:一个)?` 可选组——S-C16 回归，三样本全对', () => {
    const rule = byId('R-MR-01')
    // 修正形态：可选非捕获组；不得回退成「一个?」（表达"一个或一"，hit2 不命中）
    expect(rule.pattern.source).toContain('(?:一个)?')
    expect(rule.pattern.source).not.toContain('一个?')
    // 原 hit2（曾不命中的已确认样本错误）
    expect(rule.pattern.test('作为人工智能助手我需要提醒你')).toBe(true)
    // 修正版新增形态：零「一个」与完整「一个」均可命中
    expect(rule.pattern.test('作为AI，我不能有感情。')).toBe(true)
    expect(rule.pattern.test('作为一个AI，我不能有感情。')).toBe(true)
    expect(rule.pattern.test('作为一个喜欢猫的人，我懂你。')).toBe(false)
  })

  it('R-PD-01：拆分掉「该…」分支，只匹配「本」自指', () => {
    const rule = byId('R-PD-01')
    expect(rule.pattern.source).toBe('本(?:AI|助手|系统|模型|程序)')
    expect(rule.pattern.test('本助手认为……')).toBe(true)
    // 反方 §3.1 分诊：「该系统/该模型/该程序」通常指别的对象，不得再命中
    expect(rule.pattern.test('该系统由运维团队维护，与她无关。')).toBe(false)
    expect(rule.pattern.test('这个系统有点慢。')).toBe(false)
    // 分诊要求 KFP 非空（原 KFP 为空不成立）
    expect(rule.knownFalsePositives.length).toBeGreaterThan(0)
  })

  it('R-AP-05：strip 安全化——action 已整体改 flag', () => {
    const rule = byId('R-AP-05')
    expect(rule.action).toBe('flag')
    expect(rule.scope).toBe('prefix')
  })
})

describe('P3C1-02 影子策略常量集（裁定 1.5 #3）', () => {
  it('版本号非空且与首段参数冻结（含裁定 1.2 的 maxHoldMs=400）', () => {
    expect(SHADOW_POLICY_VERSION).toBe('shadow-v1')
    expect(SHADOW_FIRST_SEGMENT_PARAMS).toEqual({
      firstSegmentMinChars: 32,
      segmentMaxChars: 512,
      maxHoldMs: 400
    })
  })

  it('目标动作表 42 条全覆盖，且与推导式逐条一致', () => {
    expect(Object.keys(SHADOW_TARGET_ACTIONS)).toHaveLength(42)
    for (const rule of COMPLIANCE_RULES) {
      expect(SHADOW_TARGET_ACTIONS[rule.id], rule.id).toBe(shadowTargetAction(rule))
    }
  })

  it('影子 block 候选恰为 §3.3 约束推出的 15 条（显式名单，防公式漂移）', () => {
    const blocked = Object.entries(SHADOW_TARGET_ACTIONS)
      .filter(([, action]) => action === 'block')
      .map(([id]) => id)
      .sort()
    expect(blocked).toEqual([
      'R-AP-01',
      'R-AP-02',
      'R-AP-03',
      'R-AP-04',
      'R-DC-01',
      'R-DC-02',
      'R-DC-03',
      'R-DC-04',
      'R-DC-07',
      'R-MR-01',
      'R-MR-02',
      'R-MR-03',
      'R-MR-04',
      'R-MR-05',
      'R-PD-01'
    ])
    // 反方 18 条候选全部影子 flag（均 confidence<0.95——不得提前 block）
    for (const rule of COMPLIANCE_RULE_CANDIDATES) {
      expect(SHADOW_TARGET_ACTIONS[rule.id], rule.id).toBe('flag')
    }
  })

  it('推导式边界：confidence=0.95 恰好入候选，0.94 不入；非适格类型不入', () => {
    // R-MR-05（critical/0.95）入、R-AP-05（critical/0.94）不入、R-DC-05（warning/0.88）不入
    expect(shadowTargetAction(byId('R-MR-05'))).toBe('block')
    expect(shadowTargetAction(byId('R-AP-05'))).toBe('flag')
    expect(shadowTargetAction(byId('R-DC-05'))).toBe('flag')
    // lecturing 永不 block（§3.2 类型级资格）：即使数值达标也不入
    const lecturingMax: ComplianceRule = {
      ...byId('R-LC-01'),
      severity: 'critical',
      confidence: 0.99
    }
    expect(shadowTargetAction(lecturingMax)).toBe('flag')
  })
})

describe('P3C1-02 出厂规则集经编译器零拒绝（应用启动路径合同）', () => {
  it('compileComplianceRules(COMPLIANCE_RULES)：42 条全编译、零拒绝、顺序保持', () => {
    const { rules, rejected } = compileComplianceRules(COMPLIANCE_RULES)
    expect(rejected).toEqual([])
    expect(rules.map((r) => r.rule.id)).toEqual(COMPLIANCE_RULES.map((r) => r.id))
  })
})
