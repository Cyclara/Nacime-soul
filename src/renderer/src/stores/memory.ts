// src/renderer/src/stores/memory.ts
// P2-30: memory Pinia store -- L0 画像 + L2 记忆列表 + DMAE 快照的只读投影 + 用户操作编排。
// 依据：S-002-补充 §3.1、S-022 §1.4（hint 矩阵 + revision 规则）、S-006 §1.2（组件↔store）。
//
// 设计要点：
//   1. main 真源的只读投影：自身不计算指标、不做记忆判决，数字全部来自 main。
//   2. revision 比对：event.revision <= state.revision -> 丢弃；> -> 按 hint 拉取。
//   3. 写操作不乐观更新：main 落库 -> event 回流 -> 刷新（S-022 §1.4）。
//   4. l1 hint：忽略数据拉取但推进 seen revision（MemoryState 无 L1 投影）。
//   5. focus 兜底：窗口 focus 走 bulk 行为（overview + 当前列表），防 event 丢失。
//   6. single-flight：revalidate/hydrate 合并，防旧响应覆盖新投影。

import { reactive, computed } from 'vue'
import { defineStore } from 'pinia'
import type { IpcError, PublicAppError } from '@shared/errors'
import type { Unsubscribe } from '@shared/ipc/contracts'
import type {
  DmaeSnapshotView,
  L0ProfileView,
  L2MemoryDetail,
  L2MemoryView,
  MemoryOverview,
  MemoryUpdatedEvent,
  MemoryQuery
} from '@shared/memory/types'

/** IpcError -> PublicAppError（补 severity；IPC 错误默认 error 级）。 */
function toPublicAppError(e: IpcError): PublicAppError {
  return {
    code: e.code === 'IPC_UNAUTHORIZED' || e.code === 'IPC_INTERNAL' ? 'UNKNOWN' : e.code,
    message: e.message,
    severity: 'error',
    retryable: e.retryable
  }
}

export interface MemoryState {
  /** 已应用的最高 revision（事件去重 + 乱序保护） */
  revision: number
  /** memory.enabled=false 时为 null（引导态消费） */
  l0: L0ProfileView | null
  l2Items: L2MemoryView[]
  l2Total: number
  query: MemoryQuery
  dmae: DmaeSnapshotView | null
  selectedDetail: L2MemoryDetail | null
  loading: boolean
  lastError: PublicAppError | null
  /** memory 功能是否启用（getOverview 返回 enabled 字段） */
  enabled: boolean
}

export const useMemoryStore = defineStore('memory', () => {
  const state = reactive<MemoryState>({
    revision: 0,
    l0: null,
    l2Items: [],
    l2Total: 0,
    // M-12：初始 query 带 state='active'，与 L2MemoryList 默认"活跃"标签一致。
    // 修复前 query 无 state 过滤 -> 首屏 hydrate 拉全状态列表，但 UI 高亮"活跃"，
    // 且再次点击"活跃"值未变不触发 watch，无法就地修正。
    query: { limit: 50, offset: 0, state: 'active' },
    dmae: null,
    selectedDetail: null,
    loading: false,
    lastError: null,
    enabled: true
  })

  const isEmpty = computed(() => state.l2Total === 0)
  const fillRateLabel = computed(() =>
    state.l0 ? `${state.l0.filledCount}/${state.l0.totalCount}` : '-'
  )

  /** 异步请求 epoch：防旧响应覆盖新投影（S-022 §1.4） */
  let requestEpoch = 0

  function setLastError(e: PublicAppError | null): void {
    state.lastError = e
  }

  /** 进入记忆页时调用：拉 overview（l0 + dmae + revision）+ 首页 l2 列表 */
  async function hydrate(): Promise<void> {
    state.loading = true
    setLastError(null)
    const epoch = ++requestEpoch
    const requestQuery = { ...state.query }
    try {
      if (!window.companion) return
      const [overviewRes, listRes] = await Promise.all([
        window.companion.memory.getOverview(),
        window.companion.memory.listL2(buildListRequest(requestQuery))
      ])
      if (epoch !== requestEpoch) return // 旧响应丢弃
      if (overviewRes.ok) {
        applyOverview(overviewRes.data)
      } else {
        setLastError(toPublicAppError(overviewRes.error))
      }
      if (listRes.ok) {
        applyListResponse(listRes.data, requestQuery.offset)
      } else if (!overviewRes.ok) {
        // overview 已失败才记 list 错误（避免覆盖）
        setLastError(toPublicAppError(listRes.error))
      }
    } catch (err) {
      setLastError({
        code: 'UNKNOWN',
        message: err instanceof Error ? err.message : '加载记忆失败',
        severity: 'error',
        retryable: false
      })
    } finally {
      if (epoch === requestEpoch) state.loading = false
    }
  }

  /** 切换查询条件（状态筛选/搜索/分页）并重新拉取列表 */
  async function loadL2(query?: Partial<MemoryQuery>): Promise<void> {
    if (query) {
      state.query = { ...state.query, ...query }
    }
    const epoch = ++requestEpoch
    const requestQuery = { ...state.query }
    try {
      if (!window.companion) return
      const res = await window.companion.memory.listL2(buildListRequest(requestQuery))
      if (epoch !== requestEpoch) return
      if (res.ok) {
        applyListResponse(res.data, requestQuery.offset)
        setLastError(null)
      } else {
        setLastError(toPublicAppError(res.error))
      }
    } catch (err) {
      setLastError({
        code: 'UNKNOWN',
        message: err instanceof Error ? err.message : '加载列表失败',
        severity: 'error',
        retryable: false
      })
    }
  }

  /** 打开记忆详情抽屉 */
  async function openDetail(memoryId: string): Promise<void> {
    try {
      if (!window.companion) return
      const res = await window.companion.memory.getDetail({ memoryId })
      if (res.ok) {
        state.selectedDetail = res.data
        setLastError(null)
      } else {
        setLastError(toPublicAppError(res.error))
      }
    } catch (err) {
      setLastError({
        code: 'UNKNOWN',
        message: err instanceof Error ? err.message : '加载详情失败',
        severity: 'error',
        retryable: false
      })
    }
  }

  function closeDetail(): void {
    state.selectedDetail = null
  }

  /** 用户操作：pin 切换。不乐观更新，等 event 回流刷新（S-022 §1.4） */
  async function setPinned(memoryId: string, pinned: boolean): Promise<boolean> {
    if (!window.companion) return false
    const res = await window.companion.memory.setPinned({ memoryId, pinned })
    if (!res.ok) setLastError(toPublicAppError(res.error))
    return res.ok
  }

  /** 用户操作：软删除。组件需先确认。不乐观更新。 */
  async function softDelete(memoryId: string): Promise<boolean> {
    if (!window.companion) return false
    const res = await window.companion.memory.softDelete({ memoryId, confirm: true })
    if (!res.ok) setLastError(toPublicAppError(res.error))
    return res.ok
  }

  /** 用户操作：恢复已删除记忆。不乐观更新。 */
  async function restore(memoryId: string): Promise<boolean> {
    if (!window.companion) return false
    const res = await window.companion.memory.restore({ memoryId })
    if (!res.ok) setLastError(toPublicAppError(res.error))
    return res.ok
  }

  /** M-44 用户操作：编辑 L2 记忆内容。不乐观更新，等 event 回流刷新（S-022 §1.4） */
  async function updateContent(memoryId: string, content: string): Promise<boolean> {
    if (!window.companion) return false
    const res = await window.companion.memory.updateContent({ memoryId, content })
    if (!res.ok) setLastError(toPublicAppError(res.error))
    return res.ok
  }

  /** M-44 用户操作：设定/清空 L0 画像字段（空串 = 清空）。不乐观更新。 */
  async function setL0Field(field: string, value: string): Promise<boolean> {
    if (!window.companion) return false
    const res = await window.companion.memory.setL0Field({ field, value })
    if (!res.ok) setLastError(toPublicAppError(res.error))
    return res.ok
  }

  /**
   * memory-updated 事件入口。S-022 §1.4 hint 矩阵：
   *   l0 -> get-l0；l1 -> 忽略拉取但推进 revision；l2 -> list-l2 + get-dmae-snapshot；
   *   dmae -> get-dmae-snapshot；growth -> 忽略（growth store 处理）；bulk -> overview + list-l2。
   * revision <= state.revision -> 丢弃（幂等/乱序保护）。
   */
  function applyUpdate(e: MemoryUpdatedEvent): void {
    // revision 比对：旧事件丢弃
    if (e.revision <= state.revision) return
    // growth hint 不属于 memory 域（S-022 §1.4：交给 growth store），但也不推进 memory revision
    if (e.hint === 'growth') return
    // 按命中拉取（异步，失败不推进 revision）
    void pullForHint(e.hint, e.revision)
  }

  /** 按 hint 拉取对应切片。拉取成功才推进 revision（S-022 §1.4） */
  async function pullForHint(
    hint: MemoryUpdatedEvent['hint'],
    eventRevision: number
  ): Promise<void> {
    if (!window.companion) return
    const epoch = ++requestEpoch
    const requestQuery = { ...state.query }
    try {
      switch (hint) {
        case 'l0': {
          const res = await window.companion.memory.getL0()
          if (epoch !== requestEpoch) return
          if (res.ok) {
            state.l0 = res.data
            // getL0 响应无 revision 字段（L0ProfileView 不带 revision），用 eventRevision（Math.max 防回退）
            state.revision = Math.max(state.revision, eventRevision)
          }
          break
        }
        case 'l1': {
          // L1 无 renderer 投影：忽略数据拉取，但推进 seen revision（S-022 §1.4）
          if (epoch === requestEpoch) state.revision = Math.max(state.revision, eventRevision)
          break
        }
        case 'l2': {
          const [listRes, dmaeRes] = await Promise.all([
            window.companion.memory.listL2(buildListRequest(requestQuery)),
            window.companion.memory.getDmaeSnapshot()
          ])
          if (epoch !== requestEpoch) return
          // S-022 §1.4：拉取返回 revision 的接口以响应 revision 为准。
          // applyListResponse 用 Math.max 防回退（响应 revision < state.revision 时不减）。
          if (listRes.ok) applyListResponse(listRes.data, requestQuery.offset)
          if (dmaeRes.ok) state.dmae = dmaeRes.data
          break
        }
        case 'dmae': {
          const res = await window.companion.memory.getDmaeSnapshot()
          if (epoch !== requestEpoch) return
          if (res.ok) {
            state.dmae = res.data
            // getDmaeSnapshot 响应无 revision 字段，用 eventRevision（Math.max 防回退）
            state.revision = Math.max(state.revision, eventRevision)
          }
          break
        }
        case 'bulk': {
          const [overviewRes, listRes] = await Promise.all([
            window.companion.memory.getOverview(),
            window.companion.memory.listL2(buildListRequest(requestQuery))
          ])
          if (epoch !== requestEpoch) return
          // applyOverview/applyListResponse 内部用 Math.max 防回退
          if (overviewRes.ok) applyOverview(overviewRes.data)
          if (listRes.ok) applyListResponse(listRes.data, requestQuery.offset)
          break
        }
        default:
          // 未知 hint：防御性回退同 bulk（S-022 §1.4）
          break
      }
    } catch {
      /* 拉取失败不推进 revision，下次 event/focus 可重试（S-022 §1.4） */
    }
  }

  /**
   * 窗口 focus/visibility 兜底：event 丢失时按 bulk 刷新 overview + 当前列表。
   * single-flight 合并：与 hydrate/pullForHint 共用 requestEpoch。
   */
  async function revalidate(): Promise<void> {
    if (!window.companion) return
    const epoch = ++requestEpoch
    const requestQuery = { ...state.query }
    try {
      const overviewRes = await window.companion.memory.getOverview()
      if (epoch !== requestEpoch) return
      if (overviewRes.ok) {
        // revision 未变 -> 无需刷新列表（减少 IPC）
        if (overviewRes.data.revision <= state.revision) {
          applyOverview(overviewRes.data)
          return
        }
        applyOverview(overviewRes.data)
        const listRes = await window.companion.memory.listL2(buildListRequest(requestQuery))
        if (epoch !== requestEpoch) return
        // applyListResponse 内部用 Math.max 防回退
        if (listRes.ok) applyListResponse(listRes.data, requestQuery.offset)
      }
    } catch {
      /* best-effort */
    }
  }

  function applyOverview(overview: MemoryOverview): void {
    state.enabled = overview.enabled
    state.revision = Math.max(state.revision, overview.revision)
    state.l0 = overview.l0
    state.dmae = overview.dmae
  }

  function applyListResponse(
    data: { items: L2MemoryView[]; total: number; revision: number },
    offset: number
  ): void {
    if (offset === 0) {
      state.l2Items = data.items
    } else {
      // C-β：加载更多追加；revision 变化可能让页边界重叠，按 id 去重并用新投影覆盖旧值。
      const merged = new Map(state.l2Items.map((item) => [item.id, item]))
      for (const item of data.items) merged.set(item.id, item)
      state.l2Items = [...merged.values()]
    }
    state.l2Total = data.total
    state.revision = Math.max(state.revision, data.revision)
    // 详情打开时该记忆被 soft-delete：基于合并后的完整列表判断，不能只看当前页。
    if (state.selectedDetail) {
      const stillVisible = state.l2Items.some((m) => m.id === state.selectedDetail!.id)
      if (!stillVisible && state.query.state !== 'soft_deleted') {
        state.selectedDetail = null
      }
    }
  }

  /** 订阅 memory-updated 事件 + 窗口 focus 兜底。返回 unsubscribe。 */
  function subscribe(): Unsubscribe {
    const unsubs: Unsubscribe[] = []
    if (window.companion) {
      unsubs.push(window.companion.memory.onUpdated(applyUpdate))
    }
    // 窗口 focus 兜底（event 丢失时 revision 比对刷新）
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
    state.l0 = null
    state.l2Items = []
    state.l2Total = 0
    state.query = { limit: 50, offset: 0 }
    state.dmae = null
    state.selectedDetail = null
    state.loading = false
    state.lastError = null
    state.enabled = true
    // C-β：只递增使在途响应失效，绝不归零，避免旧/新请求 epoch 撞号。
    requestEpoch++
  }

  return {
    state,
    isEmpty,
    fillRateLabel,
    hydrate,
    loadL2,
    openDetail,
    closeDetail,
    setPinned,
    softDelete,
    restore,
    updateContent,
    setL0Field,
    applyUpdate,
    revalidate,
    subscribe,
    reset
  }
})

/** MemoryQuery -> MemoryListRequest（补默认值 + 范围裁剪） */
function buildListRequest(query: MemoryQuery): import('@shared/memory/types').MemoryListRequest {
  return {
    state: query.state,
    search: query.search?.trim() || undefined,
    limit: Math.max(1, Math.min(200, query.limit)),
    offset: Math.max(0, Math.min(100_000, query.offset))
  }
}
