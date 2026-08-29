// src/main/compliance/records.test.ts
// P3C1-04：无正文 DecisionRecord / 反事实字段通路（开工裁定 1.4/1.5）。
// 覆盖：takeRecords 单次移交幂等、记录字段构成与无正文红线、反事实八原因
// （action-not-candidate/observe 外的六值 + wouldBlock=true）、影子参数冻结
// （real config 调偏不影响影子时间线）、releasedCharsBefore、capComplianceRecords、
// C1 验收⑦（examples.hit 全量回放反事实字段确定预期）。

import { describe, it, expect } from 'vitest'
import type { Logger, MetricsRegistry } from '@shared/observability/types'
import type { ComplianceDecisionRecord } from '@shared/compliance/types'
import { createMetrics } from '../observability/metrics'
import {
  createComplianceGate,
  capComplianceRecords,
  COMPLIANCE_RECORDS_MAX_PER_TURN,
  type ComplianceGate,
  type ComplianceGateOptions,
  type ComplianceGateOutcome
} from './gate'
import { createComplianceCircuit } from './circuit'
import { compileComplianceRules, type CompiledComplianceRule } from './compile'
import {
  COMPLIANCE_RULES,
  SHADOW_POLICY_VERSION,
  SHADOW_TARGET_ACTIONS,
  type ComplianceRule
} from './rules'
import type { TurnEndData } from '../chat/service'

// === 测试辅助 ===

function noopLogger(): Logger {
  const l: Logger = {
    fatal() { /* noop */ },
    error() { /* noop */ },
    warn() { /* noop */ },
    info() { /* noop */ },
    debug() { /* noop */ },
    child: () => l
  }
  return l
}

const FACTORY_COMPILED = compileComplianceRules(COMPLIANCE_RULES).rules

function syntheticRules(...overridesList: Partial<ComplianceRule>[]): readonly CompiledComplianceRule[] {
  const raw: ComplianceRule[] = overridesList.map((overrides, i) => ({
    id: `R-XX-9${i}`,
    type: 'meta-reference',
    severity: 'critical',
    confidence: 0.99,
    pattern: /BLOCKME/,
    scope: 'anywhere',
    action: 'flag',
    description: '合成测试规则',
    knownFalsePositives: [],
    examples: { hit: ['BLOCKME'], miss: ['ok'] },
    ...overrides
  }))
  const { rules, rejected } = compileComplianceRules(raw)
  expect(rejected).toEqual([])
  return rules
}

interface MakeGateArgs {
  readonly rules?: readonly CompiledComplianceRule[]
  readonly options?: Partial<ComplianceGateOptions>
  readonly now?: () => number
  readonly circuit?: ReturnType<typeof createComplianceCircuit>
}

function makeGate(args: MakeGateArgs = {}): { gate: ComplianceGate; metrics: MetricsRegistry } {
  const metrics = createMetrics()
  const gate = createComplianceGate({
    rules: args.rules ?? FACTORY_COMPILED,
    options: { scope: 'observe', ...args.options },
    circuit: args.circuit,
    logger: noopLogger(),
    metrics,
    now: args.now
  })
  return { gate, metrics }
}

function manualClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms) => (t += ms) }
}

function fakeRecord(i: number): ComplianceDecisionRecord {
  return {
    candidateId: 'cand-fake',
    turnId: 'turn-fake',
    attemptIndex: 0,
    segmentIndex: 0,
    ruleId: `R-XX-${String(i).padStart(2, '0')}`,
    span: { start: 0, length: 1 },
    confidence: 0.9,
    declaredAction: 'flag',
    effectiveAction: 'flag',
    counterfactualAction: 'flag',
    wouldBlockUnderFirstSegmentPolicy: false,
    blockIneligibleReason: 'action-not-candidate',
    releasedCharsBefore: 0,
    shadowPolicyVersion: SHADOW_POLICY_VERSION
  }
}

const RECORD_KEYS = [
  'attemptIndex',
  'blockIneligibleReason',
  'candidateId',
  'confidence',
  'counterfactualAction',
  'declaredAction',
  'effectiveAction',
  'releasedCharsBefore',
  'ruleId',
  'segmentIndex',
  'shadowPolicyVersion',
  'span',
  'turnId',
  'wouldBlockUnderFirstSegmentPolicy'
]

// === 记录通路基础 ===

describe('takeRecords：逐命中记录通路（裁定 1.4）', () => {
  it('命中产生记录：字段构成完整、身份来自 options、键集合无正文通道', () => {
    const sample = '作为一个AI，我不能有感情。'
    const { gate } = makeGate({
      options: { scope: 'observe', turnId: 'turn-1', candidateId: 'cand-1' }
    })
    gate.push(sample)
    gate.flush()
    const records = gate.takeRecords()
    const own = records.filter((r) => r.ruleId === 'R-MR-01')
    expect(own).toHaveLength(1)
    const r = own[0]
    expect(r.turnId).toBe('turn-1')
    expect(r.candidateId).toBe('cand-1')
    expect(r.attemptIndex).toBe(0)
    expect(r.segmentIndex).toBe(0)
    expect(r.span).toEqual({ start: 0, length: '作为一个AI'.length })
    expect(r.confidence).toBeCloseTo(0.97)
    expect(r.declaredAction).toBe('flag') // C1 出厂全 flag（验收⑥）
    expect(r.effectiveAction).toBe('flag') // observe 下恒 flag（验收⑥）
    expect(r.releasedCharsBefore).toBe(sample.length) // observe：检测滞后于放行
    expect(r.shadowPolicyVersion).toBe('shadow-v1')
    // 无正文红线（§3.11）：键集合恰为合同键，且序列化不含输入文本
    expect(Object.keys(r).sort()).toEqual(RECORD_KEYS)
    expect(JSON.stringify(records)).not.toContain(sample)
    expect(JSON.stringify(records)).not.toContain('作为一个AI')
  })

  it('单次移交、取后清空、幂等：重复调用返回空数组（防双写），后续 push 也不复出', () => {
    const { gate } = makeGate({ options: { scope: 'observe' } })
    gate.push('作为一个AI，我不能有感情。')
    gate.flush()
    expect(gate.takeRecords().length).toBeGreaterThan(0)
    expect(gate.takeRecords()).toEqual([])
    gate.push('作为一个AI，又一次。')
    gate.flush()
    expect(gate.takeRecords()).toEqual([]) // recordsTaken 粘性：单实例单轮语义
  })

  it('未 flush 被取走（异常路径）：按 EOF 定格影子首段，已产出记录的反事实字段仍有确定值', () => {
    // real 参数调偏（minChars=8）使 real 在 push 时即切段产出记录，而影子（冻结 32）尚未决定
    const { gate } = makeGate({ options: { scope: 'observe', firstSegmentMinChars: 8 } })
    gate.push('作为一个AI，我不能有感情。') // real 边界 14≥8 切段记 R-MR-01；无 flush
    const records = gate.takeRecords()
    const own = records.filter((r) => r.ruleId === 'R-MR-01')
    expect(own).toHaveLength(1)
    // takeRecords 时影子按 EOF 定格：C=全文长 14，命中 [0,5) 完整 ⇒ wouldBlock=true
    expect(own[0].wouldBlockUnderFirstSegmentPolicy).toBe(true)
    expect(own[0].blockIneligibleReason).toBeUndefined()
  })

  it("scope='off'：无匹配无记录，takeRecords 返回空", () => {
    const { gate } = makeGate({ options: { scope: 'off' } })
    gate.push('作为一个AI，我不能有感情。')
    gate.flush()
    expect(gate.takeRecords()).toEqual([])
  })
})

// === 反事实字段（裁定 1.5）===

describe('反事实字段组：影子首段策略下的拦截机会', () => {
  it('wouldBlock=true：影子门触发时已完整命中（裁定 1.5 #2 不取 flush 类值）', () => {
    const { gate } = makeGate({ options: { scope: 'observe' } })
    gate.push('作为一个AI，我不能有感情。')
    gate.flush()
    const r = gate.takeRecords().find((x) => x.ruleId === 'R-MR-01')!
    expect(r.counterfactualAction).toBe('block') // R-MR-01 在 15 条影子 block 候选名单
    expect(r.wouldBlockUnderFirstSegmentPolicy).toBe(true)
    expect(r.blockIneligibleReason).toBeUndefined()
  })

  it('action-not-candidate：影子目标动作非 block 的规则恒不可介入', () => {
    const rule = COMPLIANCE_RULES.find((r) => r.id === 'R-LC-04')! // lecturing 类型不适格
    expect(SHADOW_TARGET_ACTIONS[rule.id]).toBe('flag')
    const { gate } = makeGate({ options: { scope: 'observe' } })
    gate.push(rule.examples.hit[0])
    gate.flush()
    const own = gate.takeRecords().filter((r) => r.ruleId === 'R-LC-04')
    expect(own.length).toBeGreaterThanOrEqual(1)
    for (const r of own) {
      expect(r.counterfactualAction).toBe('flag')
      expect(r.wouldBlockUnderFirstSegmentPolicy).toBe(false)
      expect(r.blockIneligibleReason).toBe('action-not-candidate')
    }
  })

  it('deadline-flush：影子时限门切出时模式跨放行点才完成；且影子用冻结 maxHoldMs=400 而非 config 值', () => {
    const clock = manualClock()
    const rules = [...FACTORY_COMPILED, ...syntheticRules({ pattern: /感情。好的/ })]
    const { gate } = makeGate({
      rules,
      options: { scope: 'observe', maxHoldMs: 100_000 }, // real config 故意调偏
      now: clock.now
    })
    clock.advance(0)
    gate.push('作为一个AI，我不能有感情。')
    clock.advance(500) // 超影子 400ms：影子在最早边界（。at 13 → C=14）切出
    gate.push('好的。')
    gate.flush()
    const records = gate.takeRecords()
    const mr = records.find((r) => r.ruleId === 'R-MR-01')!
    expect(mr.wouldBlockUnderFirstSegmentPolicy).toBe(true) // [0,5) 完整在影子 C=14 内
    const syn = records.find((r) => r.ruleId === 'R-XX-90')!
    expect(syn.span).toEqual({ start: 11, length: 5 }) // '感情。好的' 跨影子切点
    expect(syn.counterfactualAction).toBe('block') // 合成 critical 0.99 → 公式 block
    expect(syn.wouldBlockUnderFirstSegmentPolicy).toBe(false)
    expect(syn.blockIneligibleReason).toBe('deadline-flush')
  })

  it('length-flush：影子长度门（冻结 512）切出时模式跨放行点才完成', () => {
    const rules = syntheticRules({ pattern: /感情/ })
    const { gate } = makeGate({
      rules,
      options: { scope: 'observe', segmentMaxChars: 1024, firstSegmentMinChars: 32 },
      now: () => 0 // 时钟不动：排除 deadline 干扰
    })
    // '感情' 位于 [511,513)，跨影子冻结 512 切点；real 1024 窗口能看到完整模式
    gate.push('a'.repeat(511) + '感情' + 'b'.repeat(600))
    gate.flush()
    const r = gate.takeRecords().find((x) => x.ruleId === 'R-XX-90')!
    expect(r.span).toEqual({ start: 511, length: 2 })
    expect(r.wouldBlockUnderFirstSegmentPolicy).toBe(false)
    expect(r.blockIneligibleReason).toBe('length-flush')
  })

  it('already-released / after-first-segment：边界门切出的跨点与后段命中；影子用冻结 minChars=32', () => {
    const rules = syntheticRules({ pattern: /感情。好的/ }, { id: 'R-XX-91', pattern: /好的/ })
    const { gate } = makeGate({
      rules,
      options: { scope: 'observe', firstSegmentMinChars: 64 }, // real config 调偏：不切 34
      now: () => 0
    })
    // 。at 33：影子 34≥32 切出（boundary C=34）；real 34<64 不切
    gate.push('a'.repeat(31) + '感情。好的')
    gate.flush()
    const records = gate.takeRecords()
    const straddle = records.find((r) => r.ruleId === 'R-XX-90')!
    expect(straddle.span).toEqual({ start: 31, length: 5 })
    expect(straddle.blockIneligibleReason).toBe('already-released')
    expect(straddle.wouldBlockUnderFirstSegmentPolicy).toBe(false)
    const after = records.find((r) => r.ruleId === 'R-XX-91')!
    expect(after.span).toEqual({ start: 34, length: 2 }) // 完全在影子切点之后
    expect(after.blockIneligibleReason).toBe('after-first-segment')
    expect(after.wouldBlockUnderFirstSegmentPolicy).toBe(false)
  })

  it('retry-attempt：attempt 1 恒不可介入（即便影子目标动作是 block）', () => {
    const { gate } = makeGate({
      rules: syntheticRules({ action: 'block' }),
      options: { scope: 'observe', attemptIndex: 1, firstSegmentMinChars: 4 }
    })
    gate.push('BLOCKME。')
    gate.flush()
    const r = gate.takeRecords().find((x) => x.ruleId === 'R-XX-90')!
    expect(r.attemptIndex).toBe(1)
    expect(r.counterfactualAction).toBe('block')
    expect(r.wouldBlockUnderFirstSegmentPolicy).toBe(false)
    expect(r.blockIneligibleReason).toBe('retry-attempt')
  })

  it('circuit-open：熔断打开轮恒不可介入（优先于位置判断）', () => {
    const circuit = createComplianceCircuit({}, noopLogger(), createMetrics())
    const blockedOutcome: ComplianceGateOutcome = {
      blocked: true,
      regenerations: 1,
      degradedPass: false,
      ruleIds: [],
      checkedSegments: 1,
      totalMs: 1,
      degraded: false
    }
    for (let i = 0; i < 6; i++) circuit.record(blockedOutcome)
    expect(circuit.isOpen()).toBe(true)
    const { gate } = makeGate({
      options: { scope: 'first-segment', firstSegmentMinChars: 4 },
      circuit
    })
    gate.push('作为一个AI，我不能有感情。')
    gate.flush()
    const r = gate.takeRecords().find((x) => x.ruleId === 'R-MR-01')!
    expect(r.wouldBlockUnderFirstSegmentPolicy).toBe(false)
    expect(r.blockIneligibleReason).toBe('circuit-open')
  })
})

// === releasedCharsBefore ===

describe('releasedCharsBefore：命中发生前已放行字符数', () => {
  it('observe：检测滞后于放行，flush 时命中记全量已放行', () => {
    const { gate } = makeGate({ options: { scope: 'observe' } })
    gate.push('作为一个AI，') // 7
    gate.push('我不能有感情。') // 7
    gate.flush()
    const r = gate.takeRecords().find((x) => x.ruleId === 'R-MR-01')!
    expect(r.releasedCharsBefore).toBe(14)
  })

  it('first-segment：首段内命中记 0（用户还没看到任何字），后段命中记已放行量', () => {
    const { gate } = makeGate({
      rules: [...FACTORY_COMPILED, ...syntheticRules({ id: 'R-XX-90', pattern: /好的/ })],
      options: { scope: 'first-segment', firstSegmentMinChars: 3 }
    })
    gate.push('好的。') // 边界 3≥3 切首段：R-XX-90 命中时 releasedChars=0；随后放行 3 字符
    gate.push('作为一个AI，我不能有感情。继续说。') // 直通；边界 18≥16 切第二段（段内 R-MR-01）
    gate.flush()
    const records = gate.takeRecords()
    const first = records.find((r) => r.ruleId === 'R-XX-90')!
    expect(first.segmentIndex).toBe(0)
    expect(first.releasedCharsBefore).toBe(0)
    const second = records.find((r) => r.ruleId === 'R-MR-01')!
    expect(second.segmentIndex).toBe(1)
    expect(second.span.start).toBe(3)
    expect(second.releasedCharsBefore).toBe(3) // 第二段处理时仅首段 3 字符已放行
  })
})

// === C1 验收⑦：examples.hit 全量回放 ===

describe('C1 验收⑦：出厂 42 条规则 examples.hit 回放，反事实字段全部命中确定预期', () => {
  it.each(COMPLIANCE_RULES.map((r) => [r.id, r] as const))('%s', (_id, rule) => {
    for (const sample of rule.examples.hit) {
      const { gate } = makeGate({
        options: { scope: 'observe', turnId: 'turn-replay', candidateId: 'cand-replay' }
      })
      gate.push(sample)
      gate.flush()
      const own = gate.takeRecords().filter((r) => r.ruleId === rule.id)
      // 样本经门控（EOF 段）必须命中本规则
      expect(own.length, `rule ${rule.id} sample ${JSON.stringify(sample)}`).toBeGreaterThanOrEqual(1)
      const expectedAction = SHADOW_TARGET_ACTIONS[rule.id]
      for (const r of own) {
        expect(r.counterfactualAction).toBe(expectedAction)
        expect(r.declaredAction).toBe(rule.action)
        expect(r.effectiveAction).toBe('flag') // C1 observe 恒 flag（验收⑥）
        expect(r.shadowPolicyVersion).toBe(SHADOW_POLICY_VERSION)
        if (expectedAction === 'block') {
          // 单样本 + flush：影子 EOF 定格 C=全文长，命中完整 ⇒ 必可拦
          expect(r.wouldBlockUnderFirstSegmentPolicy).toBe(true)
          expect(r.blockIneligibleReason).toBeUndefined()
        } else {
          expect(r.wouldBlockUnderFirstSegmentPolicy).toBe(false)
          expect(r.blockIneligibleReason).toBe('action-not-candidate')
        }
      }
    }
  })
})

// === capComplianceRecords（裁定 1.4 #3：上限 64 + 截断计数）===

describe('capComplianceRecords：TurnEndData 单轮上限', () => {
  it('上限常量 = 64（裁定 1.4 #3）', () => {
    expect(COMPLIANCE_RECORDS_MAX_PER_TURN).toBe(64)
  })

  it('超上限截断并计数；未超原样返回；恰上限不截', () => {
    const many = Array.from({ length: 70 }, (_, i) => fakeRecord(i))
    const capped = capComplianceRecords(many)
    expect(capped.records).toHaveLength(64)
    expect(capped.truncated).toBe(6)
    expect(many).toHaveLength(70) // 纯函数不改入参

    const exact = Array.from({ length: 64 }, (_, i) => fakeRecord(i))
    expect(capComplianceRecords(exact)).toEqual({ records: exact, truncated: 0 })

    const few = [fakeRecord(0)]
    expect(capComplianceRecords(few).truncated).toBe(0)
  })

  it('TurnEndData 并列字段形状（编译期钉死；运行时装配随 P3C1-08 ChatService 集成）', () => {
    const capped = capComplianceRecords(Array.from({ length: 70 }, (_, i) => fakeRecord(i)))
    const records: TurnEndData['complianceRecords'] = capped.records
    const truncated: TurnEndData['complianceRecordsTruncated'] = capped.truncated
    expect(records).toHaveLength(64)
    expect(truncated).toBe(6)
  })
})
