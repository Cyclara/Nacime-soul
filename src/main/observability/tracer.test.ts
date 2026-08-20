// src/main/observability/tracer.test.ts
// P2-27: TurnTracer span 追踪 + 环形缓冲 + 败而不崩。
import { describe, it, expect } from 'vitest'
import { createTracer } from './tracer'
import { AppError } from '@shared/errors'

describe('P2-27 beginTurn/span/endTurn 完整流程', () => {
  it('span 记录 name/startMs/durationMs/ok', async () => {
    const t = createTracer()
    t.beginTurn('turn-1', 10)
    await t.span('prompt.build', () => {
      /* sync */
    })
    t.endTurn(20)
    const traces = t.snapshot()
    expect(traces).toHaveLength(1)
    const trace = traces[0]
    expect(trace.turnId).toBe('turn-1')
    expect(trace.inputLen).toBe(10)
    expect(trace.outputLen).toBe(20)
    expect(trace.spans).toHaveLength(1)
    expect(trace.spans[0].name).toBe('prompt.build')
    expect(trace.spans[0].ok).toBe(true)
    expect(trace.spans[0].durationMs).toBeGreaterThanOrEqual(0)
    expect(trace.spans[0].startMs).toBeGreaterThanOrEqual(0)
  })

  it('多个 span 按顺序记录，startMs 递增', async () => {
    const t = createTracer()
    t.beginTurn('turn-1', 5)
    await t.span('sanitize', async () => {
      await delay(2)
    })
    await t.span('prompt.build', () => {
      /* sync */
    })
    await t.span('llm.call', async () => {
      await delay(3)
    })
    t.endTurn(50)
    const trace = t.snapshot()[0]
    expect(trace.spans.map((s) => s.name)).toEqual(['sanitize', 'prompt.build', 'llm.call'])
    // startMs 递增（后开始的 span startMs 更大）
    expect(trace.spans[1].startMs).toBeGreaterThanOrEqual(trace.spans[0].startMs)
    expect(trace.spans[2].startMs).toBeGreaterThanOrEqual(trace.spans[1].startMs)
  })

  it('F5-011 §4 验收：span 耗时非零（异步 span）', async () => {
    const t = createTracer()
    t.beginTurn('turn-1', 5)
    await t.span('llm.call', async () => {
      await delay(5)
    })
    t.endTurn(10)
    const trace = t.snapshot()[0]
    expect(trace.spans[0].durationMs).toBeGreaterThan(0)
    expect(trace.totalMs).toBeGreaterThan(0)
  })
})

describe('P2-27 span 抛错记 ok=false + code + 重新抛', () => {
  it('AppError 记 code', async () => {
    const t = createTracer()
    t.beginTurn('turn-1', 5)
    await expect(
      t.span('llm.call', () => {
        throw new AppError({
          code: 'LLM_AUTH',
          severity: 'error',
          retryable: false
        })
      })
    ).rejects.toThrow()
    t.endTurn(0)
    const trace = t.snapshot()[0]
    expect(trace.spans[0].ok).toBe(false)
    expect(trace.spans[0].code).toBe('LLM_AUTH')
  })

  it('普通 Error 不记 code（code undefined）', async () => {
    const t = createTracer()
    t.beginTurn('turn-1', 5)
    await expect(
      t.span('llm.call', () => {
        throw new Error('network boom')
      })
    ).rejects.toThrow('network boom')
    t.endTurn(0)
    const trace = t.snapshot()[0]
    expect(trace.spans[0].ok).toBe(false)
    expect(trace.spans[0].code).toBeUndefined()
  })

  it('span 后续仍可继续记（不阻塞下一 span）', async () => {
    const t = createTracer()
    t.beginTurn('turn-1', 5)
    await expect(t.span('llm.call', () => Promise.reject(new Error('x')))).rejects.toThrow()
    await t.span('prompt.build', () => {
      /* ok */
    })
    t.endTurn(0)
    const trace = t.snapshot()[0]
    expect(trace.spans).toHaveLength(2)
    expect(trace.spans[0].ok).toBe(false)
    expect(trace.spans[1].ok).toBe(true)
  })
})

describe('P2-27 环形缓冲 20 条', () => {
  it('超过 20 条丢弃最旧', async () => {
    const t = createTracer()
    for (let i = 0; i < 25; i++) {
      t.beginTurn(`turn-${i}`, 1)
      await t.span('prompt.build', () => {
        /* sync */
      })
      t.endTurn(1)
    }
    const traces = t.snapshot()
    expect(traces).toHaveLength(20)
    // 保留最近 20 条（turn-5..turn-24）
    expect(traces[0].turnId).toBe('turn-5')
    expect(traces[19].turnId).toBe('turn-24')
  })
})

describe('P2-27 snapshot 副本', () => {
  it('snapshot 返回副本，不改原数据', async () => {
    const t = createTracer()
    t.beginTurn('turn-1', 5)
    await t.span('prompt.build', () => {
      /* sync */
    })
    t.endTurn(10)
    const snap1 = t.snapshot()
    snap1[0].spans.push({
      name: 'sanitize',
      startMs: 0,
      durationMs: 0,
      ok: true
    })
    snap1[0].turnId = 'tampered'
    // 原 trace 不受影响
    const snap2 = t.snapshot()
    expect(snap2[0].turnId).toBe('turn-1')
    expect(snap2[0].spans).toHaveLength(1)
  })
})

describe('P2-27 未 beginTurn 就 span / endTurn', () => {
  it('endTurn 未 beginTurn 时 no-op（败而不崩）', () => {
    const t = createTracer()
    t.endTurn(10)
    expect(t.snapshot()).toHaveLength(0)
  })
  it('未 beginTurn 就 span 仍记（诊断，turnId 为 null）', async () => {
    const t = createTracer()
    await t.span('prompt.build', () => {
      /* sync */
    })
    t.endTurn(0)
    // 未 beginTurn -> endTurn no-op，span 不入 buffer
    expect(t.snapshot()).toHaveLength(0)
  })
})

describe('P2（2026-08-10 审计）：跨会话并发 streaming 互不覆盖', () => {
  it('A/B 交错 begin+span，各自 endTurn 归属自己的 trace', async () => {
    const t = createTracer()
    // A 开始
    t.beginTurn('turn-A', 10)
    const spanA1 = t.startSpan('prompt.build', 'turn-A')
    // B 开始（旧实现会顶掉 A 的 current）
    t.beginTurn('turn-B', 5)
    const spanB1 = t.startSpan('llm.call', 'turn-B')
    // A 继续加 span（旧实现会记进 B）
    const spanA2 = t.startSpan('llm.call', 'turn-A')
    spanA1.end()
    spanA2.end()
    spanB1.end()
    // A 先收尾
    t.endTurn(20, 'turn-A')
    // B 后收尾
    t.endTurn(30, 'turn-B')

    const traces = t.snapshot()
    expect(traces).toHaveLength(2)
    const traceA = traces.find((tr) => tr.turnId === 'turn-A')!
    const traceB = traces.find((tr) => tr.turnId === 'turn-B')!
    expect(traceA.inputLen).toBe(10)
    expect(traceA.outputLen).toBe(20)
    expect(traceB.inputLen).toBe(5)
    expect(traceB.outputLen).toBe(30)
    // A 的 trace 只有 A 的 span（prompt.build + llm.call）
    expect(traceA.spans.map((s) => s.name)).toEqual(['prompt.build', 'llm.call'])
    // B 的 trace 只有 B 的 span（llm.call）
    expect(traceB.spans.map((s) => s.name)).toEqual(['llm.call'])
  })

  it('无参 endTurn 收尾最近 begin 的 turn（单会话兼容）', async () => {
    const t = createTracer()
    t.beginTurn('turn-1', 5)
    await t.span('prompt.build', () => {
      /* sync */
    })
    t.endTurn(7) // 无 turnId
    const traces = t.snapshot()
    expect(traces).toHaveLength(1)
    expect(traces[0].turnId).toBe('turn-1')
  })
})

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
