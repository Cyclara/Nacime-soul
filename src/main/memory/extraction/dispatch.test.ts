// src/main/memory/extraction/dispatch.test.ts
// dispatch 日志可观测性回归（2026-08-20 事件）：
//   FORBIDDEN_OVERCLAIM 三连拒在日志里只有 rejected=3，与「模型零候选」无法区分，
//   被迫用探针重放 Judge 才定位。F5-011 白名单本就允许 reason code 计数——
//   dispatch batch 日志必须带 reasons 明细。
import { describe, it, expect, vi } from 'vitest'
import type { Logger } from '@shared/observability/types'
import { createMemoryDispatcher } from './dispatch'
import type { JudgeDecision } from './judge'
import type { L0Store } from '../l0-store'
import type { L1Store } from '../l1-store'
import type { L2Store } from '../l2-store'
import type { MemoryWriter } from '../writer'

function makeCapturingLogger(): { logger: Logger; infos: Array<{ message: string; meta?: unknown }> } {
  const infos: Array<{ message: string; meta?: unknown }> = []
  const logger = {
    debug: vi.fn(),
    info: (message: string, meta?: unknown) => {
      infos.push({ message, meta })
    },
    warn: vi.fn(),
    error: vi.fn()
  } as unknown as Logger
  return { logger, infos }
}

describe('extraction dispatch batch 日志含 reason code 计数（2026-08-20 修复）', () => {
  it('全拒批次：info 日志 metrics.reasons 逐 code 计数，且不触碰任何 store', async () => {
    const { logger, infos } = makeCapturingLogger()
    const stores = {
      l0Store: { set: vi.fn() } as unknown as L0Store,
      l1Store: { record: vi.fn() } as unknown as L1Store,
      l2Store: { get: vi.fn() } as unknown as L2Store,
      writer: { writeL2: vi.fn() } as unknown as MemoryWriter
    }
    const dispatcher = createMemoryDispatcher({ ...stores, logger })

    const decisions: JudgeDecision[] = [
      { candidateId: 't:0', action: 'reject', reason: 'FORBIDDEN_OVERCLAIM' },
      { candidateId: 't:1', action: 'reject', reason: 'FORBIDDEN_OVERCLAIM' },
      { candidateId: 't:2', action: 'reject', reason: 'EVIDENCE_MISSING' }
    ]
    const result = await dispatcher.dispatchBatch(decisions, { sessionId: 's', turnId: 't' })

    expect(result.rejected).toBe(3)
    expect(result.reasonCounts).toEqual({ FORBIDDEN_OVERCLAIM: 2, EVIDENCE_MISSING: 1 })
    expect(stores.l0Store.set).not.toHaveBeenCalled()
    expect(stores.writer.writeL2).not.toHaveBeenCalled()

    const batchLog = infos.find((i) => i.message === 'extraction dispatch batch')
    expect(batchLog).toBeTruthy()
    const metrics = (batchLog?.meta as { metrics?: Record<string, unknown> })?.metrics ?? {}
    expect(metrics['rejected']).toBe(3)
    // LogFields.metrics 值只允许 number/boolean，reason 计数展平为 reason_<CODE> 前缀键
    expect(metrics['reason_FORBIDDEN_OVERCLAIM']).toBe(2)
    expect(metrics['reason_EVIDENCE_MISSING']).toBe(1)
  })
})
