// src/main/compliance/circuit.ts
// 跨轮熔断器（F5-001 §3.4）——熔断语义反过来用：触发 = **停止拦截**（强制降级 observe），
// 不是中止 turn。连续高频拦截说明规则集在跟当前人设打架，不是模型在作恶；
// 此时继续拦只会让每一轮都重生成，用户感知到的是"她越来越卡"。
//
// 与 ComplianceGateOptions.budgetMs 的区别：那个是单轮 CPU 预算（防 ReDoS），
// 这个是跨轮策略保险丝（防规则集与人设不匹配）。两者都会导致降级，原因和恢复方式不同。
//
// 熔断器实例是进程级单例、跨轮存活（与每轮新建的 ComplianceGate 相反）。
// 状态只存内存——重启后从零开始计数是可接受的，熔断本身是短期保护而非长期结论。

import type { Logger, MetricsRegistry } from '@shared/observability/types'
import type { ComplianceGateOutcome } from './gate'

export interface ComplianceCircuitOptions {
  /** 滑动窗口轮数。默认 20。 */
  readonly windowTurns?: number
  /** 窗口内达到多少次真实阻断即熔断。默认 6（即 30%）。 */
  readonly blockThreshold?: number
  /** 熔断后经过多少轮自动恢复。默认 50。恢复后窗口清空重新计数。 */
  readonly cooldownTurns?: number
}

export interface ComplianceCircuitState {
  readonly open: boolean
  readonly blocksInWindow: number
  readonly turnsUntilRecovery: number
}

export interface ComplianceCircuit {
  /** 创建 gate 前查询。为 true 时 gate 的 scope 被强制改写为 'observe'。 */
  isOpen(): boolean
  /** 每轮 finally 中喂入本轮结论。 */
  record(outcome: ComplianceGateOutcome): void
  state(): ComplianceCircuitState
}

export function createComplianceCircuit(
  opts: ComplianceCircuitOptions,
  logger: Logger,
  metrics: MetricsRegistry
): ComplianceCircuit {
  const windowTurns = opts.windowTurns ?? 20
  const blockThreshold = opts.blockThreshold ?? 6
  const cooldownTurns = opts.cooldownTurns ?? 50

  /** 每轮真实阻断标记的滑窗（新→旧）。 */
  const window: boolean[] = []
  let open = false
  let cooldownLeft = 0

  function blocksInWindow(): number {
    let n = 0
    for (const b of window) if (b) n++
    return n
  }

  function setGauge(v: number): void {
    try {
      metrics.gauge('compliance.gate.circuitOpen').set(v)
    } catch {
      /* 指标失败不影响熔断语义 */
    }
  }

  function isOpen(): boolean {
    return open
  }

  function record(outcome: ComplianceGateOutcome): void {
    if (open) {
      // 熔断期间 gate 全被强制 observe，blocked 恒 false；这里只数恢复轮次
      cooldownLeft--
      if (cooldownLeft <= 0) {
        open = false
        window.length = 0
        setGauge(0)
        try {
          logger.info('compliance circuit recovered', { scope: 'compliance' })
        } catch {
          /* 日志失败不影响熔断语义 */
        }
      }
      return
    }
    window.push(outcome.blocked)
    if (window.length > windowTurns) window.shift()
    if (blocksInWindow() >= blockThreshold) {
      open = true
      cooldownLeft = cooldownTurns
      setGauge(1)
      try {
        logger.warn('compliance circuit open: too many blocks in window', {
          scope: 'compliance',
          metrics: { blocksInWindow: blocksInWindow(), windowTurns, cooldownTurns }
        })
      } catch {
        /* 日志失败不影响熔断语义 */
      }
    }
  }

  function state(): ComplianceCircuitState {
    return {
      open,
      blocksInWindow: blocksInWindow(),
      turnsUntilRecovery: open ? cooldownLeft : 0
    }
  }

  return { isOpen, record, state }
}
