// src/main/compliance/gate.test.ts
// P3C1-03：observe 双缓冲直通 + 四门切段 + 降级表 + budget/fail-open + debugCaptureText 装甲。
// 覆盖：C1 验收⑧（裁定 1.1 observe 逐字节直通零持留）、CMP-S01/S02/S06/S10/S12/S15、
//      CFG-PER-13（observe 下 strip/block 全降级 flag）、CFG-PER-14（debugCaptureText 装甲）、
//      P3C1-01 遗留验收（scope='off' ≡ enabled=false，裁定 1.8）。

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { Logger, LogFields, MetricsRegistry } from '@shared/observability/types'
import { createMetrics } from '../observability/metrics'
import { createComplianceGate, type ComplianceGate, type ComplianceGateOptions } from './gate'
import { createComplianceCircuit } from './circuit'
import { compileComplianceRules, type CompiledComplianceRule } from './compile'
import { COMPLIANCE_RULES, type ComplianceRule } from './rules'

// === 测试辅助 ===

function noopLogger(): Logger {
  const l: Logger = {
    fatal() {
      /* noop */
    },
    error() {
      /* noop */
    },
    warn() {
      /* noop */
    },
    info() {
      /* noop */
    },
    debug() {
      /* noop */
    },
    child: () => l
  }
  return l
}

interface LogCall {
  readonly level: 'fatal' | 'error' | 'warn' | 'info' | 'debug'
  readonly msg: string
  readonly fields: LogFields
}

function spyLogger(): { logger: Logger; calls: LogCall[] } {
  const calls: LogCall[] = []
  const rec =
    (level: LogCall['level']) =>
    (msg: string, fields: LogFields): void => {
      calls.push({ level, msg, fields })
    }
  const logger: Logger = {
    fatal: rec('fatal'),
    error: rec('error'),
    warn: rec('warn'),
    info: rec('info'),
    debug: rec('debug'),
    child: () => logger
  }
  return { logger, calls }
}

const FACTORY_COMPILED = compileComplianceRules(COMPLIANCE_RULES).rules

function syntheticRules(
  ...overridesList: Partial<ComplianceRule>[]
): readonly CompiledComplianceRule[] {
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
  readonly logger?: Logger
  readonly metrics?: MetricsRegistry
  readonly now?: () => number
  readonly circuit?: ReturnType<typeof createComplianceCircuit>
}

function makeGate(args: MakeGateArgs = {}): { gate: ComplianceGate; metrics: MetricsRegistry } {
  const metrics = args.metrics ?? createMetrics()
  const gate = createComplianceGate({
    rules: args.rules ?? FACTORY_COMPILED,
    options: { scope: 'observe', ...args.options },
    circuit: args.circuit,
    logger: args.logger ?? noopLogger(),
    metrics,
    now: args.now
  })
  return { gate, metrics }
}

/** 可控墙钟：手动推进。 */
function manualClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms) => (t += ms) }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

// === A. observe 直通（C1 验收⑧ / CMP-S01）===

describe('observe scope：双缓冲直通（裁定 1.1 / C1 验收⑧）', () => {
  it('逐 delta 输入：每个 releaseText 恰好等于当次 delta、按序、恰好一次；abort 恒 false；拼接逐字节相等', () => {
    const { gate } = makeGate({ options: { scope: 'observe' } })
    const deltas = ['作为', '一个AI，我不能', '有感情。今天', '天气不错。']
    let assembled = ''
    for (const delta of deltas) {
      const emission = gate.push(delta)
      expect(emission.releaseText).toBe(delta) // 零持留：当次立即放行
      expect(emission.abort).toBe(false)
      assembled += emission.releaseText
    }
    expect(assembled).toBe(deltas.join('')) // 逐字节相等
    const flushEmission = gate.flush()
    expect(flushEmission.releaseText).toBe('')
    expect(flushEmission.abort).toBe(false)
    // 分析路径独立工作：命中记录齐全（R-MR-01）
    const allViolations = gate.outcome().ruleIds
    expect(allViolations).toContain('R-MR-01')
    const outcome = gate.outcome()
    expect(outcome.blocked).toBe(false)
    expect(outcome.degraded).toBe(false)
    expect(outcome.checkedSegments).toBeGreaterThanOrEqual(1)
  })

  it('出厂 42 条全 flag：喂入全部 hit 样本拼接文本，输出与输入恒等（observe 零干预构造保证）', () => {
    const { gate } = makeGate({ options: { scope: 'observe' } })
    const allHits = COMPLIANCE_RULES.flatMap((r) => [...r.examples.hit])
    // 分批喂入（含跨 delta 边界的违规短语）
    const text = allHits.join('下次再说。')
    const chunk = 37
    let assembled = ''
    for (let i = 0; i < text.length; i += chunk) {
      const emission = gate.push(text.slice(i, i + chunk))
      expect(emission.abort).toBe(false)
      assembled += emission.releaseText
    }
    assembled += gate.flush().releaseText
    expect(assembled).toBe(text)
    expect(gate.outcome().blocked).toBe(false)
  })

  it('observe 直通时 gateHold 构造为 0：非空 delta 的 releaseText 恒非空（无持留点）', () => {
    const { gate } = makeGate({ options: { scope: 'observe' } })
    for (const delta of ['嗯。', '我', '在', '想。']) {
      expect(gate.push(delta).releaseText).toBe(delta)
    }
  })
})

// === B. off（P3C1-01 遗留验收：scope='off' ≡ enabled=false，裁定 1.8）===

describe('off scope：运行时等价 enabled=false', () => {
  it("scope='off'：直通 + 零匹配 + 零段判定——与 kill switch 语义一致", () => {
    const deltas = ['作为一个AI，我不能有感情。', '希望这些对你有帮助！']
    const off = makeGate({ options: { scope: 'off' } })
    for (const delta of deltas) {
      const emission = off.gate.push(delta)
      expect(emission.releaseText).toBe(delta)
      expect(emission.violations).toEqual([])
    }
    expect(off.gate.flush().releaseText).toBe('')
    expect(off.gate.outcome().checkedSegments).toBe(0)
    expect(off.gate.outcome().ruleIds).toEqual([])

    // 对照：同样输入 observe 有命中记录——off 与 enabled=false 一样是"无数据"状态
    const observe = makeGate({ options: { scope: 'observe' } })
    for (const delta of deltas) observe.gate.push(delta)
    observe.gate.flush()
    expect(observe.gate.outcome().ruleIds.length).toBeGreaterThan(0)
  })
})

// === C. first-segment 持留与放行 ===

describe('first-segment scope：仅首段放行前持有输出（裁定 1.1 #1）', () => {
  it('未达首段判定条件时持留；达边界门后一次放行全部累积；此后逐字直通', () => {
    const { gate } = makeGate({ options: { scope: 'first-segment', firstSegmentMinChars: 8 } })
    expect(gate.push('你好。').releaseText).toBe('') // 边界长度 3 < 8，持留
    expect(gate.push('今天天气不错。').releaseText).toBe('你好。今天天气不错。') // 边界 9 ≥ 8 → 放行
    expect(gate.push('明天呢？').releaseText).toBe('明天呢？') // 首段已放行 → 直通
    expect(gate.flush().releaseText).toBe('')
    expect(gate.outcome().checkedSegments).toBeGreaterThanOrEqual(1)
  })

  it('all-segments scope 输出语义与 first-segment 相同（诊断用，非首段 block 降级 flag）', () => {
    const { gate } = makeGate({ options: { scope: 'all-segments', firstSegmentMinChars: 4 } })
    expect(gate.push('嗯。').releaseText).toBe('')
    expect(gate.push('好的。').releaseText).toBe('嗯。好的。')
    expect(gate.push('继续。').releaseText).toBe('继续。')
  })
})

// === D. 首段四门（裁定 1.2）===

describe('首段四门切段', () => {
  it('边界门 + span 全文绝对坐标（S-C14）：跨段命中记录全文偏移，不是段局部', () => {
    const { gate } = makeGate({ options: { scope: 'observe', firstSegmentMinChars: 2 } })
    gate.push('好的。')
    gate.push('作为一个AI，x。')
    const flushEmission = gate.flush()
    const hits = flushEmission.violations.filter((v) => v.ruleId === 'R-MR-01')
    expect(hits).toHaveLength(1)
    expect(hits[0].span).toEqual({ start: 3, length: '作为一个AI'.length })
  })

  it('时限门（CMP-S02）：短句后长无标点 → maxHoldMs 到期在最早边界切，不等 hard max', () => {
    const clock = manualClock()
    const { gate } = makeGate({
      options: { scope: 'first-segment', maxHoldMs: 400 },
      now: clock.now
    })
    expect(gate.push('嗯。').releaseText).toBe('') // 短句 < 32，边界门不切
    clock.advance(450)
    // 到期：有最早边界（'嗯。'）→ 在最早边界切首段，持有全部放行
    expect(gate.push('我在想事情').releaseText).toBe('嗯。我在想事情')
    expect(gate.flush().releaseText).toBe('')
  })

  it('时限门：无边界时整缓冲作一段', () => {
    const clock = manualClock()
    const { gate } = makeGate({
      options: { scope: 'first-segment', maxHoldMs: 400 },
      now: clock.now
    })
    gate.push('嗯')
    clock.advance(400)
    expect(gate.push('想').releaseText).toBe('嗯想')
  })

  it('时限门未到期前不动：墙钟求值点语义', () => {
    const clock = manualClock()
    const { gate } = makeGate({
      options: { scope: 'first-segment', maxHoldMs: 400 },
      now: clock.now
    })
    gate.push('嗯。')
    clock.advance(399)
    expect(gate.push('还在想').releaseText).toBe('')
    clock.advance(1)
    expect(gate.push('呢').releaseText).toBe('嗯。还在想呢')
  })

  it('长度门：无边界累积 ≥512 强制切；切点不拆 surrogate pair（S-C14 / CMP-S10）', () => {
    const { gate } = makeGate({ options: { scope: 'observe' } })
    // 511 个 a + emoji（2 code unit）+ 尾巴——切点 512 恰落在 emoji 高低位之间
    const text = 'a'.repeat(511) + '😀' + 'b'.repeat(88)
    gate.push(text)
    gate.flush()
    const outcome = gate.outcome()
    expect(outcome.checkedSegments).toBeGreaterThanOrEqual(2)
    // 若 emoji 被拆，合成规则 /😀/ 不会命中；span.start=511 证明完整保留且绝对坐标正确
    const { gate: gate2 } = makeGate({
      rules: syntheticRules({ pattern: /😀/ }),
      options: { scope: 'observe' }
    })
    gate2.push(text)
    const f = gate2.flush()
    expect(f.violations[0]?.span).toEqual({ start: 511, length: 2 })
  })

  it('EOF 门：flush 剩余缓冲作末段，且动作一律降级 flag（合成 block 也不 abort）', () => {
    const { gate } = makeGate({
      rules: syntheticRules({ action: 'block' }),
      options: { scope: 'first-segment', attemptIndex: 0 }
    })
    expect(gate.push('BLOCKME').releaseText).toBe('') // 无边界，持留
    const f = gate.flush()
    expect(f.releaseText).toBe('BLOCKME') // EOF 降级 flag → 放行
    expect(f.abort).toBe(false)
    expect(gate.outcome().blocked).toBe(false)
  })
})

// === E. 降级表（裁定 1.1 #3 + F5-001 §3.4）===

describe('降级表', () => {
  const blockRule = (): readonly CompiledComplianceRule[] => syntheticRules({ action: 'block' })
  const stripRule = (): readonly CompiledComplianceRule[] =>
    syntheticRules({ action: 'strip', pattern: /^好的，/, scope: 'prefix' })

  it('真 block：首段 + attempt 0 + 执法 scope → abort，持有文本不放行（CMP-S03 前置）', () => {
    const { gate, metrics } = makeGate({
      rules: blockRule(),
      options: { scope: 'first-segment', firstSegmentMinChars: 4 }
    })
    const emission = gate.push('BLOCKME。')
    expect(emission.abort).toBe(true)
    expect(emission.releaseText).toBe('')
    expect(gate.outcome().blocked).toBe(true)
    expect(metrics.counter('compliance.gate.blocks').value()).toBe(1)
    // CMP-S06：abort 后后续 delta 一律不放行
    expect(gate.push('后续内容。')).toEqual({ releaseText: '', abort: true, violations: [] })
    expect(gate.flush().abort).toBe(true)
  })

  it('CFG-PER-13 上半：observe 下声明 block 的规则 effective 均为 flag（直通 + blocks 计数为 0）', () => {
    const { gate, metrics } = makeGate({
      rules: blockRule(),
      options: { scope: 'observe', firstSegmentMinChars: 4 }
    })
    const emission = gate.push('BLOCKME。')
    expect(emission.releaseText).toBe('BLOCKME。')
    expect(emission.abort).toBe(false)
    expect(emission.violations.map((v) => v.ruleId)).toContain('R-XX-90')
    gate.flush()
    expect(gate.outcome().blocked).toBe(false)
    expect(metrics.counter('compliance.gate.blocks').value()).toBe(0)
    expect(metrics.counter('compliance.gate.flags').value()).toBeGreaterThan(0)
  })

  it('block + attempt 1 → 降级 flag（retry-attempt 行；即便 scope 是 first-segment）', () => {
    const { gate } = makeGate({
      rules: blockRule(),
      options: { scope: 'first-segment', attemptIndex: 1, firstSegmentMinChars: 4 }
    })
    const emission = gate.push('BLOCKME。')
    expect(emission.abort).toBe(false)
    expect(emission.releaseText).toBe('BLOCKME。')
    expect(gate.outcome().blocked).toBe(false)
  })

  it('block + 熔断打开 → scope 强制 observe + degraded=true（createComplianceGate 合同）', () => {
    const circuit = createComplianceCircuit({}, noopLogger(), createMetrics())
    // 直接把熔断喂开
    for (let i = 0; i < 6; i++) {
      circuit.record({
        blocked: true,
        regenerations: 1,
        degradedPass: false,
        ruleIds: [],
        checkedSegments: 1,
        totalMs: 1,
        degraded: false
      })
    }
    expect(circuit.isOpen()).toBe(true)
    const { gate } = makeGate({
      rules: blockRule(),
      options: { scope: 'first-segment', firstSegmentMinChars: 4 },
      circuit
    })
    const emission = gate.push('BLOCKME。')
    expect(emission.releaseText).toBe('BLOCKME。') // 强制 observe 直通
    expect(emission.abort).toBe(false)
    expect(gate.outcome().degraded).toBe(true)
    expect(gate.outcome().blocked).toBe(false)
  })

  it('block + 非首段命中 → 降级 flag（首段已放行，不可撤回）', () => {
    const { gate } = makeGate({
      rules: blockRule(),
      options: { scope: 'first-segment', firstSegmentMinChars: 3 }
    })
    expect(gate.push('好的。').releaseText).toBe('好的。') // 首段放行（边界 3 ≥ 3）
    const secondText = 'BLOCKME然后继续说很多话凑够十六个字以上。'
    const emission = gate.push(secondText)
    expect(emission.releaseText).toBe(secondText) // 已放行 → 直通
    expect(emission.abort).toBe(false)
    // 第二段由边界门（≥16）非 EOF 切出，命中 block 声明 → 降级 flag，violations 仍保留
    expect(emission.violations.map((v) => v.ruleId)).toContain('R-XX-90')
    expect(gate.outcome().blocked).toBe(false)
  })

  it('strip 真剥离：命中全文 start===0 且剩余非空 + 执法 scope + attempt 0', () => {
    const { gate, metrics } = makeGate({
      rules: stripRule(),
      options: { scope: 'first-segment', firstSegmentMinChars: 4 }
    })
    const emission = gate.push('好的，今天很开心。')
    expect(emission.releaseText).toBe('今天很开心。')
    expect(metrics.counter('compliance.gate.strips').value()).toBe(1)
  })

  it('CFG-PER-13 下半：observe 下声明 strip 的规则 effective 均为 flag（不剥离）', () => {
    const { gate, metrics } = makeGate({ rules: stripRule(), options: { scope: 'observe' } })
    const emission = gate.push('好的，今天很开心。')
    expect(emission.releaseText).toBe('好的，今天很开心。')
    expect(metrics.counter('compliance.gate.strips').value()).toBe(0)
  })

  it('strip + 剥离后为空 → 降级 flag（整段释放）', () => {
    const clock = manualClock()
    const { gate } = makeGate({
      rules: stripRule(),
      options: { scope: 'first-segment', maxHoldMs: 400 },
      now: clock.now
    })
    gate.push('好的，')
    clock.advance(450)
    const emission = gate.push('')
    expect(emission.releaseText).toBe('好的，')
  })

  it('多规则同段：block > strip > flag（CMP-S12：abort 优先，violations 全保留）', () => {
    const rules = syntheticRules(
      { id: 'R-XX-90', action: 'block', confidence: 0.97 },
      { id: 'R-XX-91', action: 'strip', confidence: 0.96 },
      { id: 'R-XX-92', action: 'flag', confidence: 0.9 }
    )
    const { gate } = makeGate({
      rules,
      options: { scope: 'first-segment', firstSegmentMinChars: 4 }
    })
    const emission = gate.push('BLOCKME。')
    expect(emission.abort).toBe(true)
    expect(emission.violations.map((v) => v.ruleId).sort()).toEqual([
      'R-XX-90',
      'R-XX-91',
      'R-XX-92'
    ])
  })

  it('prefix 规则只在全文开头评估：非首段的同形开头不命中（S-C14 local 0 防线）', () => {
    const { gate } = makeGate({
      rules: stripRule(), // /^好的，/ prefix
      options: { scope: 'observe', firstSegmentMinChars: 4 }
    })
    gate.push('先说话。')
    gate.push('好的，第二段。')
    gate.flush()
    // '好的，' 在第二段开头，绝对 start≠0 → 不命中
    expect(gate.outcome().ruleIds).toEqual([])
  })
})

// === F. budget 降级 ===

describe('budgetMs 单轮 CPU 预算（ReDoS 兜底）', () => {
  it('匹配累计超预算 → 降级直通：持有立即放行、后续不再匹配、记 degraded 指标', () => {
    let t = 0
    const now = (): number => (t += 10) // 每次 now() 推进 10ms
    const metrics = createMetrics()
    const { gate } = makeGate({
      rules: syntheticRules({ action: 'flag' }),
      options: { scope: 'first-segment', firstSegmentMinChars: 2, budgetMs: 0 },
      metrics,
      now
    })
    const first = gate.push('BLOCKME。')
    expect(first.releaseText).toBe('BLOCKME。') // 降级即放行
    expect(gate.outcome().degraded).toBe(true)
    expect(metrics.counter('compliance.gate.degraded').value()).toBe(1)
    // 后续不再匹配（ruleIds 虽有首段命中，但第二段不再新增；用新规则文本验证）
    const before = gate.outcome().ruleIds
    const second = gate.push('BLOCKME again。')
    expect(second.releaseText).toBe('BLOCKME again。') // 直通
    expect(second.violations).toEqual([]) // 不再匹配
    expect(gate.outcome().ruleIds).toEqual(before)
  })
})

// === G. fail-open（CMP-S15）===

describe('fail-open：内部异常一律吞掉并降级直通', () => {
  it('metrics 抛错：push 不抛、releaseText 逐字直通、degraded=true、后续直通', () => {
    const metrics = createMetrics()
    vi.spyOn(metrics, 'counter').mockImplementation(() => {
      throw new Error('metrics exploded')
    })
    const { gate } = makeGate({ options: { scope: 'observe', firstSegmentMinChars: 2 }, metrics })
    const emission = gate.push('作为一个AI。')
    expect(emission.releaseText).toBe('作为一个AI。')
    expect(emission.abort).toBe(false)
    expect(gate.outcome().degraded).toBe(true)
    expect(gate.push('后续。').releaseText).toBe('后续。')
  })

  it('now() 抛错：同上语义', () => {
    const { gate } = makeGate({
      options: { scope: 'observe' },
      now: () => {
        throw new Error('clock exploded')
      }
    })
    expect(gate.push('文本。').releaseText).toBe('文本。')
    expect(gate.outcome().degraded).toBe(true)
  })

  it('logger 在 block 决策时抛错：abort 被异常吞掉 → fail-open 全放行（红线方向）', () => {
    const logger = noopLogger()
    vi.spyOn(logger, 'warn').mockImplementation(() => {
      throw new Error('logger exploded')
    })
    const { gate } = makeGate({
      rules: syntheticRules({ action: 'block' }),
      options: { scope: 'first-segment', firstSegmentMinChars: 4 },
      logger
    })
    const emission = gate.push('BLOCKME。')
    expect(emission.releaseText).toBe('BLOCKME。')
    expect(emission.abort).toBe(false)
    expect(gate.outcome().degraded).toBe(true)
    expect(gate.outcome().blocked).toBe(false)
  })
})

// === H. CFG-PER-14 debugCaptureText ===

describe('debugCaptureText 运行时装甲（CFG-PER-14）', () => {
  it('开发构建 + 开关开：命中窗口写 debug 日志，内容过 scrub（≤20 字符上下文）', () => {
    const { logger, calls } = spyLogger()
    const { gate } = makeGate({
      options: { scope: 'observe', firstSegmentMinChars: 2, debugCaptureText: true },
      logger
    })
    gate.push('作为一个AI，我不能有感情。')
    gate.flush()
    const debugCalls = calls.filter(
      (c) => c.level === 'debug' && c.msg.includes('debugCaptureText')
    )
    expect(debugCalls.length).toBeGreaterThan(0)
    expect(debugCalls[0].fields.tags?.ruleId).toBe('R-MR-01')
    expect(debugCalls[0].fields.detail).toContain('作为一个AI')
  })

  it('生产构建（DEV=false）手改 true 仍不采集', () => {
    vi.stubEnv('DEV', false)
    const { logger, calls } = spyLogger()
    const { gate } = makeGate({
      options: { scope: 'observe', firstSegmentMinChars: 2, debugCaptureText: true },
      logger
    })
    gate.push('作为一个AI，我不能有感情。')
    gate.flush()
    expect(calls.filter((c) => c.level === 'debug')).toEqual([])
  })

  it('开关关（默认）：开发构建也不采集', () => {
    const { logger, calls } = spyLogger()
    const { gate } = makeGate({
      options: { scope: 'observe', firstSegmentMinChars: 2 },
      logger
    })
    gate.push('作为一个AI，我不能有感情。')
    gate.flush()
    expect(calls.filter((c) => c.level === 'debug')).toEqual([])
  })
})

// === I. outcome 汇总 ===

describe('outcome 汇总', () => {
  it('ruleIds 去重；checkedSegments/totalMs 累计；regenerations/degradedPass 由调用方合成的字段恒 0/false', () => {
    let t = 0
    const { gate } = makeGate({
      options: { scope: 'observe', firstSegmentMinChars: 2 },
      now: () => (t += 5)
    })
    gate.push('作为一个AI，好。希望这些对你有帮助！')
    gate.flush()
    const outcome = gate.outcome()
    expect(outcome.ruleIds).toContain('R-MR-01')
    expect(outcome.ruleIds).toContain('R-AP-03')
    expect(new Set(outcome.ruleIds).size).toBe(outcome.ruleIds.length)
    expect(outcome.checkedSegments).toBeGreaterThanOrEqual(1)
    expect(outcome.totalMs).toBeGreaterThan(0)
    expect(outcome.regenerations).toBe(0)
    expect(outcome.degradedPass).toBe(false)
    expect(outcome.degraded).toBe(false)
  })

  it('disabledRuleIds：命中规则被整类禁用时不参与匹配', () => {
    const { gate } = makeGate({
      options: { scope: 'observe', firstSegmentMinChars: 2, disabledRuleIds: ['R-MR-01'] }
    })
    gate.push('作为一个AI，我不能有感情。')
    gate.flush()
    expect(gate.outcome().ruleIds).not.toContain('R-MR-01')
  })

  it('resetForRetry：清空缓冲并切 observe（F5-001 接口完整性；C3 应新建实例）', () => {
    const { gate } = makeGate({
      rules: syntheticRules({ action: 'block' }),
      options: { scope: 'first-segment', firstSegmentMinChars: 4 }
    })
    gate.push('BLOCKME。')
    expect(gate.outcome().blocked).toBe(true)
    gate.resetForRetry()
    expect(gate.push('BLOCKME。').releaseText).toBe('BLOCKME。')
  })
})
