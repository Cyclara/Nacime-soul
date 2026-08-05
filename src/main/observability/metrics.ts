// src/main/observability/metrics.ts
// P2-26: MetricsRegistry 实现--counter/gauge/histogram 三类 + snapshot。
// 依据：F5-011 §3（MetricsRegistry 接口）、§2（~150 行自研，不引 prom-client）、§5（败而不崩：溢出丢弃）。
//
// 设计要点：
//   1. 三类指标：counter（单调递增计数）、gauge（可增可减当前值）、histogram（固定桶+精确分位数）
//   2. MetricName 联合类型禁止裸字符串（F5-011 §3 "新增指标=加一行"）
//   3. histogram 存最近 N 个观测值（环形缓冲 1024），p50/p95 从排序副本精确计算；
//      不用桶估算是因为~150 行预算下精确分位数更实用，且 1024 样本足够稳定。
//   4. snapshot() 输出扁平 Record<string, number>：counter/gauge 用原名，histogram 用 name.count/sum/p50/p95/max
//   5. 全局单例（configureMetrics/getMetrics），类似 logger 模式；测试用 createMetrics 独立实例
//   6. 败而不崩：所有操作不抛错，指标溢出丢弃最旧

import type { MetricsRegistry, MetricName } from '@shared/observability/types'

/** histogram 观测值环形缓冲容量。1024 样本足够算稳定 p50/p95，内存 ~8KB/指标 */
const HISTOGRAM_BUFFER_SIZE = 1024

interface HistogramState {
  count: number
  sum: number
  max: number
  /** 环形缓冲（最近 N 个观测值，用于算 p50/p95） */
  samples: number[]
  /** 下一个写入位置（环形） */
  head: number
  /** 是否已填满（满了之后 head 循环覆盖最旧） */
  full: boolean
}

interface CounterHandle {
  inc(n?: number): void
  value(): number
}

interface GaugeHandle {
  set(v: number): void
  value(): number
}

interface HistogramHandle {
  observe(v: number): void
}

class MetricsRegistryImpl implements MetricsRegistry {
  private readonly counters = new Map<MetricName, number>()
  private readonly gauges = new Map<MetricName, number>()
  private readonly histograms = new Map<MetricName, HistogramState>()

  counter(name: MetricName): CounterHandle {
    if (!this.counters.has(name)) this.counters.set(name, 0)
    // 箭头函数捕获 this，避免 no-this-alias
    const inc = (n = 1): void => {
      // 败而不崩：非数字/NaN 忽略
      if (!Number.isFinite(n)) return
      const cur = this.counters.get(name) ?? 0
      this.counters.set(name, cur + n)
    }
    const value = (): number => this.counters.get(name) ?? 0
    return { inc, value }
  }

  gauge(name: MetricName): GaugeHandle {
    if (!this.gauges.has(name)) this.gauges.set(name, 0)
    const set = (v: number): void => {
      if (!Number.isFinite(v)) return
      this.gauges.set(name, v)
    }
    const value = (): number => this.gauges.get(name) ?? 0
    return { set, value }
  }

  histogram(name: MetricName, bucketsMs?: number[]): HistogramHandle {
    // F5-011 接口要求 bucketsMs 参数；实现用环形缓冲精确算分位数（不用桶估算）
    void bucketsMs
    if (!this.histograms.has(name)) {
      this.histograms.set(name, {
        count: 0,
        sum: 0,
        max: 0,
        samples: new Array(HISTOGRAM_BUFFER_SIZE).fill(0),
        head: 0,
        full: false
      })
    }
    const observe = (v: number): void => {
      if (!Number.isFinite(v)) return
      const st = this.histograms.get(name)!
      st.count++
      st.sum += v
      if (v > st.max) st.max = v
      // 环形缓冲：覆盖最旧
      st.samples[st.head] = v
      st.head = (st.head + 1) % HISTOGRAM_BUFFER_SIZE
      if (st.head === 0) st.full = true
    }
    return { observe }
  }

  snapshot(): Record<string, number> {
    const result: Record<string, number> = {}
    for (const [name, v] of this.counters) {
      result[name] = v
    }
    for (const [name, v] of this.gauges) {
      result[name] = v
    }
    for (const [name, st] of this.histograms) {
      result[`${name}.count`] = st.count
      result[`${name}.sum`] = st.sum
      result[`${name}.max`] = st.max
      const { p50, p95 } = computePercentiles(st)
      result[`${name}.p50`] = p50
      result[`${name}.p95`] = p95
    }
    return result
  }
}

/**
 * 从环形缓冲算 p50/p95（nearest rank 方法）。
 * 有效样本数 = full ? SIZE : head。排序后取第 ceil(p*n) 个（index = ceil(p*n)-1）。
 * n=10 时 p50=第5个(index4)、p95=第10个(index9)；符合直觉。
 */
function computePercentiles(st: HistogramState): { p50: number; p95: number } {
  const n = st.full ? HISTOGRAM_BUFFER_SIZE : st.head
  if (n === 0) return { p50: 0, p95: 0 }
  const valid = st.samples.slice(0, n).sort((a, b) => a - b)
  const p50Idx = Math.max(0, Math.ceil(n * 0.5) - 1)
  const p95Idx = Math.max(0, Math.ceil(n * 0.95) - 1)
  return {
    p50: valid[p50Idx] ?? 0,
    p95: valid[Math.min(n - 1, p95Idx)] ?? 0
  }
}

/** 创建独立 MetricsRegistry 实例（测试用） */
export function createMetrics(): MetricsRegistry {
  return new MetricsRegistryImpl()
}

// === 全局单例（类似 logger 的 configure/get 模式）===

let globalMetrics: MetricsRegistry | null = null

/** 配置全局 MetricsRegistry 单例。生产环境在 main 入口调用 */
export function configureMetrics(registry: MetricsRegistry): void {
  globalMetrics = registry
}

/** 获取全局 MetricsRegistry 单例。未配置时返回一个惰性创建的实例（败而不崩） */
export function getMetrics(): MetricsRegistry {
  if (!globalMetrics) {
    globalMetrics = new MetricsRegistryImpl()
  }
  return globalMetrics
}
