// src/main/compliance/audit-queue.test.ts
// P3C1-06：审计有界队列——容量 16 / 在队幂等 / 完成后可再入队（补审语义）/ 丢最旧 + dropped 指标。

import { describe, it, expect } from 'vitest'
import type { Logger, LogFields } from '@shared/observability/types'
import { createMetrics } from '../observability/metrics'
import {
  createComplianceAuditQueue,
  type ComplianceAuditTask,
  type ComplianceAuditEnqueueReason
} from './audit-queue'
import type { ComplianceAuditInput } from './auditor'

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
  readonly level: string
  readonly msg: string
  readonly fields: LogFields
}

function spyLogger(): { logger: Logger; calls: LogCall[] } {
  const calls: LogCall[] = []
  const rec =
    (level: string) =>
    (msg: string, fields: LogFields): void => {
      calls.push({ level, msg, fields })
    }
  const l: Logger = {
    fatal: rec('fatal'),
    error: rec('error'),
    warn: rec('warn'),
    info: rec('info'),
    debug: rec('debug'),
    child: () => l
  }
  return { logger: l, calls }
}

function makeInput(turnId: string): ComplianceAuditInput {
  return {
    turnId,
    sessionId: 's1',
    personaSummary: 'p',
    recentTurns: [],
    userText: `user-${turnId}`,
    candidateText: `candidate-${turnId}`,
    knownFactKeys: []
  }
}

function makeTask(
  turnId: string,
  reason: ComplianceAuditEnqueueReason = 'sampled'
): Omit<ComplianceAuditTask, 'enqueueSequence'> {
  return { turnId, sessionId: 's1', input: makeInput(turnId), reason }
}

describe('P3C1-06 audit-queue：有界与幂等', () => {
  it('默认容量 16：前 16 个全部入队成功', () => {
    const q = createComplianceAuditQueue({ logger: noopLogger() })
    for (let i = 0; i < 16; i++) {
      expect(q.enqueue(makeTask(`t${i}`))).toBe(true)
    }
    expect(q.pending()).toBe(16)
    expect(q.droppedOverflow()).toBe(0)
  })

  it('满时丢最旧：第 17 个挤掉 t0，droppedOverflow=1，并发 compliance.audit.dropped 指标与 warn（无正文）', () => {
    const metrics = createMetrics()
    const { logger, calls } = spyLogger()
    const q = createComplianceAuditQueue({ logger, metrics })
    for (let i = 0; i < 16; i++) q.enqueue(makeTask(`t${i}`))
    expect(q.enqueue(makeTask('t16'))).toBe(true)
    expect(q.pending()).toBe(16)
    expect(q.droppedOverflow()).toBe(1)
    expect(metrics.counter('compliance.audit.dropped').value()).toBe(1)
    // t0 已被挤掉（FIFO 队头现在是 t1）
    expect(q.dequeue()?.turnId).toBe('t1')
    const warn = calls.find((c) => c.level === 'warn')
    expect(warn).toBeDefined()
    expect(warn!.fields.turnId).toBe('t0')
    // 日志红线：warn 不携带任务正文
    expect(JSON.stringify(calls)).not.toContain('candidate-t0')
    expect(JSON.stringify(calls)).not.toContain('user-t0')
  })

  it('仍在队列中的同 turnId 幂等去重：重复入队返回 false，pending 不变', () => {
    const q = createComplianceAuditQueue({ logger: noopLogger() })
    expect(q.enqueue(makeTask('t1'))).toBe(true)
    expect(q.enqueue(makeTask('t1', 'would-block'))).toBe(false)
    expect(q.pending()).toBe(1)
  })

  it('dequeue 后同 turnId 可再入队（dislike 补审语义：完成后允许再次送审）', () => {
    const q = createComplianceAuditQueue({ logger: noopLogger() })
    q.enqueue(makeTask('t1'))
    expect(q.dequeue()?.turnId).toBe('t1')
    expect(q.enqueue(makeTask('t1', 'dislike'))).toBe(true)
    expect(q.pending()).toBe(1)
    expect(q.dequeue()?.reason).toBe('dislike')
  })

  it('FIFO 顺序 + enqueueSequence 单调递增', () => {
    const q = createComplianceAuditQueue({ logger: noopLogger() })
    q.enqueue(makeTask('a'))
    q.enqueue(makeTask('b'))
    q.enqueue(makeTask('c'))
    const first = q.dequeue()
    const second = q.dequeue()
    const third = q.dequeue()
    expect([first?.turnId, second?.turnId, third?.turnId]).toEqual(['a', 'b', 'c'])
    expect(first!.enqueueSequence).toBeLessThan(second!.enqueueSequence)
    expect(second!.enqueueSequence).toBeLessThan(third!.enqueueSequence)
    expect(q.dequeue()).toBeNull()
  })

  it('任务原样携带 input 与 reason', () => {
    const q = createComplianceAuditQueue({ logger: noopLogger() })
    const task = makeTask('t1', 'would-block')
    q.enqueue(task)
    const got = q.dequeue()
    expect(got?.input.candidateText).toBe('candidate-t1')
    expect(got?.reason).toBe('would-block')
    expect(got?.sessionId).toBe('s1')
  })

  it('maxPending 可配（测试用小容量）', () => {
    const q = createComplianceAuditQueue({ maxPending: 2, logger: noopLogger() })
    q.enqueue(makeTask('a'))
    q.enqueue(makeTask('b'))
    q.enqueue(makeTask('c'))
    expect(q.droppedOverflow()).toBe(1)
    expect(q.dequeue()?.turnId).toBe('b')
  })

  it('clearPending 丢弃待审正文但不关闭队列；重新启用后可继续 enqueue（动态撤销）', () => {
    const q = createComplianceAuditQueue({ logger: noopLogger() })
    q.enqueue(makeTask('a'))
    q.enqueue(makeTask('b'))
    expect(q.clearPending()).toBe(2)
    expect(q.pending()).toBe(0)
    expect(q.isClosed()).toBe(false)
    expect(q.enqueue(makeTask('c'))).toBe(true)
    expect(q.dequeue()?.turnId).toBe('c')
  })

  it('close 后拒绝入队、清空待处理、isClosed=true', () => {
    const q = createComplianceAuditQueue({ logger: noopLogger() })
    q.enqueue(makeTask('a'))
    q.close()
    expect(q.isClosed()).toBe(true)
    expect(q.pending()).toBe(0)
    expect(q.enqueue(makeTask('b'))).toBe(false)
  })
})
