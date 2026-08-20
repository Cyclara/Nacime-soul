// src/renderer/src/stores/dmae.ts
// P2-32: DMAE 面板 Pinia store -- 诊断数据的只读投影 + 面板交互编排。
// 依据：F5-002 §3.7（DmaeDiagnosticsService）、F5-002-补充 §1.7（建 domain store）、S-002-补充（store 铁律）。
//
// 设计要点：
//   1. 诊断数据不放 config store（F5-002-补充 §1.7：不能塞进 memory store，职责混合）
//   2. main 真源的只读投影：自身不计算指标，数字全部来自 main
//   3. 不订阅 memory-updated 事件：面板是按需拉取式（进入页面 hydrate + 手动刷新）
//      DMAE activation 变化频率低（每轮一次），且面板不是常驻界面，事件驱动反而浪费 IPC
//   4. densityMode / timeRange 是纯 UI 状态，不持久化（离开页面重置）

import { reactive, computed } from 'vue'
import { defineStore } from 'pinia'
import type { IpcError, PublicAppError } from '@shared/errors'
import type { DmaePanelSnapshot, DmaeTurnExplanation } from '../../../main/memory/dmae/diagnostics'
import type { DmaeDailyAggregate } from '../../../main/memory/dmae/history-types'
import type { DmaeBenchmarkReport } from '../../../main/memory/dmae/benchmark-types'
import type { DmaeBenchmarkRequest, DmaeQualitativeRequest } from '@shared/memory/types'

/** IpcError -> PublicAppError */
function toPublicAppError(e: IpcError): PublicAppError {
  return {
    code: e.code === 'IPC_UNAUTHORIZED' || e.code === 'IPC_INTERNAL' ? 'UNKNOWN' : e.code,
    message: e.message,
    severity: 'error',
    retryable: e.retryable
  }
}

export type DensityMode = 'narrative' | 'engineering'
export type TimeRange = 7 | 30 | 90

export interface DmaeState {
  /** 面板首屏快照（null = 未加载或 disabled） */
  snapshot: DmaePanelSnapshot | null
  /** 趋势图数据 */
  trend: DmaeDailyAggregate[]
  /** 工程档公式分解（单条记忆） */
  explanation: DmaeTurnExplanation | null
  /** P2-34：基准体检结果（main 进程内缓存；面板"参数体检"按钮触发） */
  benchmark: DmaeBenchmarkReport | null
  /** UI 状态 */
  densityMode: DensityMode
  timeRange: TimeRange
  /** 单条记忆详情抽屉选中的 memoryId */
  selectedMemoryId: string | null
  loading: boolean
  trendLoading: boolean
  explainLoading: boolean
  benchmarkLoading: boolean
  lastError: PublicAppError | null
}

export const useDmaeStore = defineStore('dmae', () => {
  // M-17：请求序号——防旧响应覆盖新数据/已 reset 的 store。
  // 与 memory/growth store 的 requestEpoch 机制对齐；此前 dmae store 无守卫，
  // 快速切换时间范围/离开页面时在途响应会写回过期数据。
  let requestEpoch = 0

  const state = reactive<DmaeState>({
    snapshot: null,
    trend: [],
    explanation: null,
    benchmark: null,
    densityMode: 'narrative',
    timeRange: 7,
    selectedMemoryId: null,
    loading: false,
    trendLoading: false,
    explainLoading: false,
    benchmarkLoading: false,
    lastError: null
  })

  /** 面板是否启用（memory.enabled && dmae.enabled） */
  const isEnabled = computed(() => state.snapshot?.enabled ?? false)

  /** 有资格进入的条目（全局 activation ≥ threshold 的 top maxActive） */
  const activeSet = computed(() => state.snapshot?.activeSet ?? [])

  /** 上一轮真实占位（S-F03：区分 eligibleActive 与 promptSelected） */
  const selection = computed(() => state.snapshot?.selection ?? null)

  /** 进入 DMAE 面板时调用：拉首屏快照 + 趋势 */
  async function hydrate(): Promise<void> {
    const epoch = ++requestEpoch
    state.loading = true
    state.lastError = null
    try {
      if (!window.companion) return
      const [panelRes, trendRes] = await Promise.all([
        window.companion.dmae.getPanel(),
        window.companion.dmae.getTrend({ days: state.timeRange })
      ])
      if (epoch !== requestEpoch) return // 旧响应丢弃
      if (panelRes.ok) {
        state.snapshot = panelRes.data
      } else {
        state.lastError = toPublicAppError(panelRes.error)
      }
      if (trendRes.ok) {
        state.trend = [...trendRes.data]
      }
    } catch (err) {
      if (epoch !== requestEpoch) return
      state.lastError = {
        code: 'UNKNOWN',
        message: err instanceof Error ? err.message : '加载 DMAE 面板失败',
        severity: 'error',
        retryable: false
      }
    } finally {
      if (epoch === requestEpoch) state.loading = false
    }
  }

  /** 刷新首屏快照（手动刷新按钮 / focus 兜底） */
  async function refresh(): Promise<void> {
    if (!window.companion) return
    const epoch = ++requestEpoch
    try {
      const res = await window.companion.dmae.getPanel()
      if (epoch !== requestEpoch) return
      if (res.ok) {
        state.snapshot = res.data
        state.lastError = null
      } else {
        state.lastError = toPublicAppError(res.error)
      }
    } catch (err) {
      if (epoch !== requestEpoch) return
      state.lastError = {
        code: 'UNKNOWN',
        message: err instanceof Error ? err.message : '刷新失败',
        severity: 'error',
        retryable: false
      }
    }
  }

  /** 切换时间范围并重新拉取趋势 */
  async function setTimeRange(days: TimeRange): Promise<void> {
    state.timeRange = days
    state.trendLoading = true
    const epoch = ++requestEpoch
    try {
      if (!window.companion) return
      const res = await window.companion.dmae.getTrend({ days })
      if (epoch !== requestEpoch) return
      if (res.ok) {
        state.trend = [...res.data]
        state.lastError = null
      }
    } catch {
      /* best-effort */
    } finally {
      if (epoch === requestEpoch) state.trendLoading = false
    }
  }

  /** 切换密度档（叙事/工程） */
  function setDensityMode(mode: DensityMode): void {
    state.densityMode = mode
  }

  /** 打开单条记忆详情抽屉（工程档公式分解） */
  async function openEntry(memoryId: string): Promise<void> {
    state.selectedMemoryId = memoryId
    state.explainLoading = true
    const epoch = ++requestEpoch
    try {
      if (!window.companion) return
      const res = await window.companion.dmae.explain({ memoryId })
      if (epoch !== requestEpoch) return
      if (res.ok) {
        state.explanation = res.data
      } else {
        state.lastError = toPublicAppError(res.error)
      }
    } catch (err) {
      if (epoch !== requestEpoch) return
      state.lastError = {
        code: 'UNKNOWN',
        message: err instanceof Error ? err.message : '加载公式分解失败',
        severity: 'error',
        retryable: false
      }
    } finally {
      if (epoch === requestEpoch) state.explainLoading = false
    }
  }

  /** 关闭单条记忆详情抽屉 */
  function closeEntry(): void {
    state.selectedMemoryId = null
    state.explanation = null
  }

  /** P2-34：运行参数基准体检（M1~M6），结果展示在面板体检区 */
  async function runBenchmark(days: 7 | 30 | 90): Promise<void> {
    state.benchmarkLoading = true
    state.lastError = null
    try {
      if (!window.companion) return
      const req: DmaeBenchmarkRequest = { windowDays: days }
      const res = await window.companion.dmae.runBenchmark(req)
      if (res.ok) {
        state.benchmark = res.data
        // 同步面板快照里的 lastBenchmark（main 也缓存了）
        if (state.snapshot) state.snapshot = { ...state.snapshot, lastBenchmark: res.data }
      } else {
        state.lastError = toPublicAppError(res.error)
      }
    } catch (err) {
      state.lastError = {
        code: 'UNKNOWN',
        message: err instanceof Error ? err.message : '运行基准体检失败',
        severity: 'error',
        retryable: false
      }
    } finally {
      state.benchmarkLoading = false
    }
  }

  /** P2-34：记录定性评分（Q1~Q3 人工判断） */
  async function recordQualitative(input: DmaeQualitativeRequest): Promise<void> {
    if (!window.companion) return
    const res = await window.companion.dmae.recordQualitative(input)
    if (!res.ok) state.lastError = toPublicAppError(res.error)
  }

  function reset(): void {
    // M-17：递增 epoch，作废在途响应（避免导航离开后旧响应写入已 reset 的 store）
    requestEpoch++
    state.snapshot = null
    state.trend = []
    state.explanation = null
    state.benchmark = null
    state.densityMode = 'narrative'
    state.timeRange = 7
    state.selectedMemoryId = null
    state.loading = false
    state.trendLoading = false
    state.explainLoading = false
    state.benchmarkLoading = false
    state.lastError = null
  }

  return {
    state,
    isEnabled,
    activeSet,
    selection,
    hydrate,
    refresh,
    setTimeRange,
    setDensityMode,
    openEntry,
    closeEntry,
    runBenchmark,
    recordQualitative,
    reset
  }
})
