// src/main/growth/bridge.ts
// growth bridge hook：turn.end 时 fan-out l2.referenced 事件 + session.daily_first。
// 依据：S-011 §1.6（growth bridge 位于 extraction 之前，memoryEligible=true 时 fan-out
//       referencedMemoryIds）、F5-006 §3（l2.referenced / session.daily_first 事件定义）。
//
// 职责（P2-40/41）：
//   1. memoryEligible=true 时，把 referencedMemoryIds 逐个 fan-out 为 l2.referenced 事件
//   2. 当天首次对话时，发射 session.daily_first 事件（同日幂等，查 growth_events 表）
//   3. 当天首次对话时触发 snapshotToday()（F5-006 §3：每日快照"当天首轮 turn.end 后触发、同日幂等"；
//      快照内含里程碑检查，新达成里程碑 emit milestone.reached + promptFragments 进 relationship 层）
//   4. 若实际发射了事件，推进 revision 并广播 growth hint（让 renderer growth store 刷新）
//
// 时序（S-011 §1.6 红线）：
//   priority 220（位于 extraction 250 之前）。growth bridge 不依赖 extraction 结果--
//   referencedMemoryIds 来自 ChatService prompt build 阶段，turn.end 触发时已就绪。
//   放在 extraction 之前确保 l2.referenced 事件即使 extraction fail-open 抛错也能记录。
//
// 依赖方向（F5-006 §5）：
//   本文件只 import 类型（HookRegistration/TurnEndData/MemoryRevisionClock/MemoryEventBroadcaster），
//   不 import 记忆模块的运行时实现。实际依赖由 composition root（memory/setup.ts）注入。

import { randomUUID } from 'node:crypto'
import type { Logger } from '@shared/observability/types'
import type { TurnEndData } from '../chat/service'
import type { HookRegistration } from '../hooks/types'
import type { GrowthEventBus } from './event-bus'
import type { GrowthStore } from './service'
import type { MemoryRevisionClock } from '../memory/revision-clock'
import type { MemoryEventBroadcaster } from '../memory/event-broadcaster'

export interface GrowthBridgeDeps {
  eventBus: GrowthEventBus
  store: GrowthStore
  revisionClock: MemoryRevisionClock
  broadcaster: MemoryEventBroadcaster
  logger: Logger
  now?: () => number
  /** id 生成（测试可注入） */
  idGen?: () => string
  /**
   * P2-41: 每日快照触发器（当天首轮 turn.end 后调用，同日幂等）。
   * 由 setup.ts 注入 `() => growthService.snapshotToday()`。
   * 触发快照落盘 + 里程碑检查（F5-006 §3）。可选：无依赖时（测试）跳过。
   */
  snapshotToday?: () => void
}

/** 将 epoch ms 转为本地时区 'YYYY-MM-DD' */
export function toLocalDate(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 创建 growth bridge hook（注册到 turn.end，priority 220）。
 * S-011 §1.6：GrowthService 尚未实现（P2-40 前）时 bridge 不注册；
 *   P2-40 实现后由 setup.ts 注册本 hook。
 */
export function createGrowthBridgeHook(deps: GrowthBridgeDeps): HookRegistration {
  const { eventBus, store, revisionClock, broadcaster, logger } = deps
  const now = deps.now ?? ((): number => Date.now())
  const idGen = deps.idGen ?? randomUUID

  const fn: HookRegistration['fn'] = (_ctx, data) => {
    const turnEnd = data as TurnEndData
    // 只处理 memoryEligible=true 的 turn（S-011 §1.6 红线：failed/cancelled/stopped 不发事件）
    if (!turnEnd || !turnEnd.memoryEligible) {
      return { data }
    }

    const ts = now()
    const today = toLocalDate(ts)
    let emitted = false

    // 1. l2.referenced：fan-out referencedMemoryIds（去重，保持顺序）
    //    F5-006 §3：l2.referenced = 一条 L2 记忆进入了 prompt 且回复完成
    //    S-011 §1.6：referencedMemoryIds 语义=最终预算保留且 provider 正常完成的 L2 ID
    const seen = new Set<string>()
    for (const memoryId of turnEnd.referencedMemoryIds) {
      if (seen.has(memoryId)) continue
      seen.add(memoryId)
      eventBus.emit({
        id: idGen(),
        ts,
        type: 'l2.referenced',
        payload: { memoryId }
      })
      emitted = true
    }

    // 2. session.daily_first：当天首次对话（同日幂等）
    //    F5-006 §3：session.daily_first = 当天首次对话（activeDays 计数源）
    //    当天首次对话也是每日快照触发时机：先 emit daily_first（computeSnapshot 会数 activeDays），
    //    再调 snapshotToday()（落盘快照 + 里程碑检查）。同日幂等：当天已有快照则 snapshotToday 直接返回。
    try {
      if (!store.hasTypeOnDate('session.daily_first', today)) {
        eventBus.emit({
          id: idGen(),
          ts,
          type: 'session.daily_first',
          payload: {}
        })
        emitted = true
        // F5-006 §3：当天首轮 turn.end 后触发每日快照（同日幂等）
        try {
          deps.snapshotToday?.()
        } catch (e) {
          // 快照失败不阻塞主流程（败而不崩）
          logger.warn('growth snapshotToday trigger failed', {
            scope: 'growth',
            detail: e instanceof Error ? e.message : String(e)
          })
        }
      }
    } catch (e) {
      // 幂等检查失败不阻塞主流程（败而不崩）
      logger.warn('growth session.daily_first check failed', {
        scope: 'growth',
        detail: e instanceof Error ? e.message : String(e)
      })
    }

    // 3. 若实际发射了事件，推进 revision 并广播 growth hint
    //    F5-006 §5：growth 数据变更需通知 UI（renderer growth store 刷新 profile + timeline）
    //    S-012 §1.4：growth hint -> growth store 拉 profile + timeline
    if (emitted) {
      revisionClock.next()
      broadcaster.notify('growth')
    }

    return { data }
  }

  return {
    name: 'growth-bridge',
    event: 'turn.end',
    priority: 220, // S-011 §1.6：位于 extraction(250) 之前
    fn,
    failOpen: true
  }
}
