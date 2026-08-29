// src/main/compliance/circuit.test.ts
// P3C1-03：跨轮熔断器——滑窗计数、阈值熔断、冷却倒数、自动恢复、gauge 打点。

import { describe, it, expect, vi } from 'vitest'
import type { Logger } from '@shared/observability/types'
import { createMetrics } from '../observability/metrics'
import { createComplianceCircuit } from './circuit'
import type { ComplianceGateOutcome } from './gate'

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

function outcome(blocked: boolean): ComplianceGateOutcome {
  return {
    blocked,
    regenerations: blocked ? 1 : 0,
    degradedPass: false,
    ruleIds: [],
    checkedSegments: 1,
    totalMs: 1,
    degraded: false
  }
}

describe('compliance circuit（跨轮熔断）', () => {
  it('默认阈值：窗口内第 6 次真实阻断时熔断打开，gauge 置 1', () => {
    const metrics = createMetrics()
    const circuit = createComplianceCircuit({}, noopLogger(), metrics)
    for (let i = 0; i < 5; i++) {
      circuit.record(outcome(true))
      expect(circuit.isOpen()).toBe(false)
    }
    circuit.record(outcome(true))
    expect(circuit.isOpen()).toBe(true)
    expect(metrics.gauge('compliance.gate.circuitOpen').value()).toBe(1)
    expect(circuit.state()).toEqual({ open: true, blocksInWindow: 6, turnsUntilRecovery: 50 })
  })

  it('滑窗淘汰：旧阻断滚出窗口后不再计入阈值', () => {
    const circuit = createComplianceCircuit(
      { windowTurns: 4, blockThreshold: 2, cooldownTurns: 10 },
      noopLogger(),
      createMetrics()
    )
    circuit.record(outcome(true)) // [T]
    circuit.record(outcome(false)) // [T,F]
    circuit.record(outcome(false)) // [T,F,F]
    circuit.record(outcome(false)) // [T,F,F,F]
    circuit.record(outcome(false)) // [F,F,F,F]——旧的 T 滚出
    expect(circuit.isOpen()).toBe(false)
    expect(circuit.state().blocksInWindow).toBe(0)
    circuit.record(outcome(true)) // [F,F,F,T]
    expect(circuit.isOpen()).toBe(false)
    circuit.record(outcome(true)) // [F,F,T,T] → 2 ≥ 2
    expect(circuit.isOpen()).toBe(true)
  })

  it('熔断期间 record 只倒数恢复轮次，不累计阻断', () => {
    const circuit = createComplianceCircuit(
      { windowTurns: 20, blockThreshold: 2, cooldownTurns: 3 },
      noopLogger(),
      createMetrics()
    )
    circuit.record(outcome(true))
    circuit.record(outcome(true))
    expect(circuit.isOpen()).toBe(true)
    // 熔断期 gate 被强制 observe，本不会出现 blocked=true；即便喂入也只倒数
    circuit.record(outcome(true))
    expect(circuit.isOpen()).toBe(true)
    expect(circuit.state().turnsUntilRecovery).toBe(2)
    expect(circuit.state().blocksInWindow).toBe(2) // 窗口未被熔断期 record 改动
  })

  it('冷却期满自动恢复：窗口清空、gauge 归 0、重新计数', () => {
    const metrics = createMetrics()
    const circuit = createComplianceCircuit(
      { blockThreshold: 2, cooldownTurns: 3 },
      noopLogger(),
      metrics
    )
    circuit.record(outcome(true))
    circuit.record(outcome(true))
    expect(circuit.isOpen()).toBe(true)
    circuit.record(outcome(false))
    circuit.record(outcome(false))
    expect(circuit.isOpen()).toBe(true)
    circuit.record(outcome(false)) // 第 3 次冷却 record → 恢复
    expect(circuit.isOpen()).toBe(false)
    expect(circuit.state()).toEqual({ open: false, blocksInWindow: 0, turnsUntilRecovery: 0 })
    expect(metrics.gauge('compliance.gate.circuitOpen').value()).toBe(0)
    // 恢复后窗口已清空：单次阻断不再熔断
    circuit.record(outcome(true))
    expect(circuit.isOpen()).toBe(false)
    expect(circuit.state().blocksInWindow).toBe(1)
  })

  it('未达阈值时 gauge 保持 0', () => {
    const metrics = createMetrics()
    const circuit = createComplianceCircuit({}, noopLogger(), metrics)
    circuit.record(outcome(false))
    circuit.record(outcome(true))
    expect(metrics.gauge('compliance.gate.circuitOpen').value()).toBe(0)
  })

  it('logger/metrics 抛错不影响熔断语义（fail-open 内部吞错）', () => {
    const metrics = createMetrics()
    vi.spyOn(metrics, 'gauge').mockImplementation(() => {
      throw new Error('metrics exploded')
    })
    const logger = noopLogger()
    vi.spyOn(logger, 'warn').mockImplementation(() => {
      throw new Error('logger exploded')
    })
    const circuit = createComplianceCircuit({ blockThreshold: 1 }, logger, metrics)
    expect(() => circuit.record(outcome(true))).not.toThrow()
    expect(circuit.isOpen()).toBe(true)
  })
})
