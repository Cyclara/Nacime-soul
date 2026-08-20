// src/renderer/src/stores/growth.ts
// P2-42: growth Pinia store -- U 值 + 阶段徽章 + 里程碑时间线 + 趋势的只读投影。
// 依据：S-002-补充 §3.2、S-012 §1.4（growth hint 矩阵 + revision 规则）、F5-006 决策 2。
//
// 设计要点：
//   1. main 真源的只读投影：自身不计算任何指标（U 值/填充率/activation），数字全部来自 main。
//   2. 复用 memory.onUpdated 事件源（growth 不注册独立订阅，S-002-补充 §3.2）：
//      hint==='growth' -> 拉 profile + timeline；bulk -> 同 hydrate。
//   3. trend 是用户选择的昂贵查询，不自动刷新（S-012 §1.4：标 stale，用户进入/切换时拉）。
//   4. revision 比对防乱序覆盖（拉取成功才推进）。
//   5. memory.enabled=false 时 hydrate 返回空投影不报错（S-002-补充 §4 边界条件）。
//
// 用户可见性约束（F5-006 决策 2 的 renderer 端执行）：GrowthProfileView 是白名单投影，
//   A/B/C 原始指标不出现在类型里（main IPC handler 也不返回它们）。

import { reactive, computed } from 'vue'
import { defineStore } from 'pinia'
import type { IpcError, PublicAppError } from '@shared/errors'
import type { Unsubscribe } from '@shared/ipc/contracts'
import type {
  GrowthProfileView,
  GrowthTimelineEntryView,
  GrowthTrendPoint,
  GrowthTrendRequest,
  MemoryUpdatedEvent
} from '@shared/memory/types'

/** 时间线默认条数（S-012 §3.3：growth store 固定 timeline limit） */
const TIMELINE_LIMIT = 50

/** IpcError -> PublicAppError（补 severity；IPC 错误默认 error 级）。 */
function toPublicAppError(e: IpcError): PublicAppError {
  return {
    code: e.code === 'IPC_UNAUTHORIZED' || e.code === 'IPC_INTERNAL' ? 'UNKNOWN' : e.code,
    message: e.message,
    severity: 'error',
    retryable: e.retryable
  }
}

export type GrowthTrendMetric = GrowthTrendRequest['metric']

export interface GrowthState {
  /** 已应用的最高 revision（事件去重 + 乱序保护） */
  revision: number
  profile: GrowthProfileView | null
  timeline: GrowthTimelineEntryView[]
  trend: GrowthTrendPoint[]
  trendMetric: GrowthTrendMetric
  trendDays: 7 | 30 | 90
  /** profile + timeline 首次加载。trend 有独立请求生命周期，不得互相取消。 */
  loading: boolean
  /** 趋势查询加载态（切换指标/天数时可局部反馈，不遮住 profile）。 */
  trendLoading: boolean
  lastError: PublicAppError | null
}

export const useGrowthStore = defineStore('growth', () => {
  const state = reactive<GrowthState>({
    revision: 0,
    profile: null,
    timeline: [],
    trend: [],
    trendMetric: 'understanding',
    trendDays: 30,
    loading: false,
    trendLoading: false,
    lastError: null
  })

  /** 阶段中文标签（S-002-补充 §3.2 stageLabel） */
  const stageLabel = computed(
    () =>
      (
        ({
          stranger: '初识',
          acquaintance: '相识',
          familiar: '熟悉',
          close: '亲近'
        }) as const
      )[state.profile?.stage ?? 'stranger']
  )

  /** profile/timeline 与 trend 必须独立防乱序；共享 epoch 会让并发首屏请求互相作废。 */
  let profileRequestEpoch = 0
  let trendRequestEpoch = 0

  function setLastError(e: PublicAppError | null): void {
    state.lastError = e
  }

  /** 进入成长页时调用：拉 profile + timeline（S-012 §3.3 growth store hydrate） */
  async function hydrate(): Promise<void> {
    state.loading = true
    setLastError(null)
    const epoch = ++profileRequestEpoch
    try {
      if (!window.companion) return
      const [profileRes, timelineRes] = await Promise.all([
        window.companion.growth.getProfile(),
        window.companion.growth.getTimeline({ limit: TIMELINE_LIMIT })
      ])
      if (epoch !== profileRequestEpoch) return
      if (profileRes.ok) {
        state.profile = profileRes.data
      } else {
        setLastError(toPublicAppError(profileRes.error))
      }
      if (timelineRes.ok) {
        state.timeline = timelineRes.data
      } else if (!profileRes.ok) {
        setLastError(toPublicAppError(timelineRes.error))
      }
    } catch (err) {
      setLastError({
        code: 'UNKNOWN',
        message: err instanceof Error ? err.message : '加载成长数据失败',
        severity: 'error',
        retryable: false
      })
    } finally {
      if (epoch === profileRequestEpoch) state.loading = false
    }
  }

  /** 用户选择指标 + 天数，拉趋势（昂贵查询，不随事件自动刷新） */
  async function loadTrend(metric: GrowthTrendMetric, days: 7 | 30 | 90): Promise<void> {
    state.trendMetric = metric
    state.trendDays = days
    state.trendLoading = true
    const epoch = ++trendRequestEpoch
    try {
      if (!window.companion) return
      const res = await window.companion.growth.getTrend({ metric, days })
      if (epoch !== trendRequestEpoch) return
      if (res.ok) {
        state.trend = res.data
        setLastError(null)
      } else {
        setLastError(toPublicAppError(res.error))
      }
    } catch (err) {
      setLastError({
        code: 'UNKNOWN',
        message: err instanceof Error ? err.message : '加载趋势失败',
        severity: 'error',
        retryable: false
      })
    } finally {
      if (epoch === trendRequestEpoch) state.trendLoading = false
    }
  }

  /**
   * memory-updated 事件入口。S-012 §1.4 growth store hint 矩阵：
   *   growth -> get-profile + 当前 limit 的 get-timeline
   *   bulk   -> 同 hydrate：profile + timeline；已有 trend 标 stale（不自动拉）
   *   其他 hint -> 忽略
   * revision <= state.revision -> 丢弃（幂等/乱序保护）
   */
  function applyUpdate(e: MemoryUpdatedEvent): void {
    if (e.revision <= state.revision) return
    if (e.hint !== 'growth' && e.hint !== 'bulk') return
    // 异步拉取（失败不推进 revision，下次 event/focus 可重试）
    void refreshForHint(e.hint, e.revision)
  }

  async function refreshForHint(
    hint: MemoryUpdatedEvent['hint'],
    eventRevision: number
  ): Promise<void> {
    if (!window.companion) return
    const epoch = ++profileRequestEpoch
    try {
      if (hint === 'growth') {
        const [profileRes, timelineRes] = await Promise.all([
          window.companion.growth.getProfile(),
          window.companion.growth.getTimeline({ limit: TIMELINE_LIMIT })
        ])
        if (epoch !== profileRequestEpoch) return
        if (profileRes.ok) state.profile = profileRes.data
        if (timelineRes.ok) state.timeline = timelineRes.data
        // 拉取成功才推进 revision（S-012 §1.4）
        state.revision = Math.max(state.revision, eventRevision)
      } else {
        // bulk：同 hydrate（profile + timeline），不自动拉 trend
        const [profileRes, timelineRes] = await Promise.all([
          window.companion.growth.getProfile(),
          window.companion.growth.getTimeline({ limit: TIMELINE_LIMIT })
        ])
        if (epoch !== profileRequestEpoch) return
        if (profileRes.ok) state.profile = profileRes.data
        if (timelineRes.ok) state.timeline = timelineRes.data
        state.revision = Math.max(state.revision, eventRevision)
      }
    } catch {
      /* 拉取失败不推进 revision，下次 event/focus 可重试（S-012 §1.4） */
    }
  }

  /** 窗口 focus 兜底：event 丢失时按 growth 行为刷新 profile + timeline（不自动拉 trend） */
  async function revalidate(): Promise<void> {
    if (!window.companion) return
    const epoch = ++profileRequestEpoch
    try {
      const profileRes = await window.companion.growth.getProfile()
      if (epoch !== profileRequestEpoch) return
      if (profileRes.ok) state.profile = profileRes.data
      const timelineRes = await window.companion.growth.getTimeline({ limit: TIMELINE_LIMIT })
      if (epoch !== profileRequestEpoch) return
      if (timelineRes.ok) state.timeline = timelineRes.data
    } catch {
      /* best-effort */
    }
  }

  /** 订阅 memory-updated 事件 + 窗口 focus 兜底。返回 unsubscribe。 */
  function subscribe(): Unsubscribe {
    const unsubs: Unsubscribe[] = []
    if (window.companion) {
      unsubs.push(window.companion.memory.onUpdated(applyUpdate))
    }
    const onFocus = (): void => {
      void revalidate()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      for (const unsub of unsubs) unsub()
      window.removeEventListener('focus', onFocus)
    }
  }

  function reset(): void {
    state.revision = 0
    state.profile = null
    state.timeline = []
    state.trend = []
    state.trendMetric = 'understanding'
    state.trendDays = 30
    state.loading = false
    state.trendLoading = false
    state.lastError = null
    profileRequestEpoch++
    trendRequestEpoch++
  }

  return {
    state,
    stageLabel,
    hydrate,
    loadTrend,
    applyUpdate,
    revalidate,
    subscribe,
    reset
  }
})
