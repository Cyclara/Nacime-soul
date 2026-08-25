// src/main/observability/metrics.test.ts
// P2-26: MetricsRegistry 三类指标 + snapshot + 败而不崩。
import { describe, it, expect, beforeEach } from 'vitest'
import { createMetrics, configureMetrics, getMetrics } from './metrics'

describe('P2-26 counter', () => {
  it('inc 默认 +1', () => {
    const m = createMetrics()
    const c = m.counter('llm.calls')
    c.inc()
    expect(c.value()).toBe(1)
    c.inc()
    expect(c.value()).toBe(2)
  })
  it('inc(n) 累加', () => {
    const m = createMetrics()
    const c = m.counter('llm.tokens.in')
    c.inc(100)
    c.inc(50)
    expect(c.value()).toBe(150)
  })
  it('非数字/NaN 忽略（败而不崩）', () => {
    const m = createMetrics()
    const c = m.counter('llm.calls')
    c.inc(NaN)
    c.inc(Infinity as unknown as number)
    c.inc('bad' as unknown as number)
    expect(c.value()).toBe(0)
  })
  it('同名 counter 共享状态', () => {
    const m = createMetrics()
    m.counter('llm.calls').inc()
    m.counter('llm.calls').inc()
    expect(m.counter('llm.calls').value()).toBe(2)
  })
})

describe('P2-26 gauge', () => {
  it('set/value', () => {
    const m = createMetrics()
    const g = m.gauge('dmae.active')
    g.set(15)
    expect(g.value()).toBe(15)
    g.set(20)
    expect(g.value()).toBe(20)
  })
  it('非数字忽略', () => {
    const m = createMetrics()
    const g = m.gauge('dmae.active')
    g.set(NaN)
    expect(g.value()).toBe(0)
  })
})

describe('P2-26 histogram', () => {
  it('count/sum/max', () => {
    const m = createMetrics()
    const h = m.histogram('llm.latencyMs')
    h.observe(100)
    h.observe(200)
    h.observe(50)
    const snap = m.snapshot()
    expect(snap['llm.latencyMs.count']).toBe(3)
    expect(snap['llm.latencyMs.sum']).toBe(350)
    expect(snap['llm.latencyMs.max']).toBe(200)
  })
  it('p50/p95 精确计算', () => {
    const m = createMetrics()
    const h = m.histogram('llm.latencyMs')
    // 1..10，p50=5（第 50%），p95=10（第 95%）
    for (let i = 1; i <= 10; i++) h.observe(i)
    const snap = m.snapshot()
    expect(snap['llm.latencyMs.p50']).toBe(5)
    expect(snap['llm.latencyMs.p95']).toBe(10)
  })
  it('空 histogram p50/p95=0', () => {
    const m = createMetrics()
    m.histogram('llm.latencyMs')
    const snap = m.snapshot()
    expect(snap['llm.latencyMs.count']).toBe(0)
    expect(snap['llm.latencyMs.p50']).toBe(0)
    expect(snap['llm.latencyMs.p95']).toBe(0)
  })
  it('非数字忽略', () => {
    const m = createMetrics()
    const h = m.histogram('llm.latencyMs')
    h.observe(NaN)
    h.observe(100)
    const snap = m.snapshot()
    expect(snap['llm.latencyMs.count']).toBe(1)
  })
  it('环形缓冲：超过 1024 样本仍稳定（不崩）', () => {
    const m = createMetrics()
    const h = m.histogram('llm.latencyMs')
    for (let i = 0; i < 2000; i++) h.observe(i)
    const snap = m.snapshot()
    expect(snap['llm.latencyMs.count']).toBe(2000)
    expect(snap['llm.latencyMs.max']).toBe(1999)
    // p50/p95 从最近 1024 样本算（976..1999），p50 ≈ 1488
    expect(snap['llm.latencyMs.p50']).toBeGreaterThan(900)
    expect(snap['llm.latencyMs.p50']).toBeLessThan(2000)
  })
})

describe('P2-26 snapshot 扁平输出', () => {
  it('counter/gauge/histogram 混合', () => {
    const m = createMetrics()
    m.counter('llm.calls').inc(5)
    m.gauge('dmae.active').set(12)
    m.histogram('llm.latencyMs').observe(100)
    const snap = m.snapshot()
    expect(snap['llm.calls']).toBe(5)
    expect(snap['dmae.active']).toBe(12)
    expect(snap['llm.latencyMs.count']).toBe(1)
    expect(snap['llm.latencyMs.sum']).toBe(100)
  })
})

describe('P2-26 全局单例', () => {
  beforeEach(() => {
    // 重置全局状态
    configureMetrics(createMetrics())
  })
  it('configure/get 共享同一实例', () => {
    const m = createMetrics()
    configureMetrics(m)
    expect(getMetrics()).toBe(m)
  })
  it('未配置时惰性创建（败而不崩）', () => {
    // getMetrics 不抛错
    const m = getMetrics()
    expect(m).toBeDefined()
    m.counter('llm.calls').inc()
    expect(m.snapshot()['llm.calls']).toBe(1)
  })
})
