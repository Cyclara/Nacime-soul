// src/main/growth/reference-tracker.ts
// B 层引用->确认/纠正判定流。
// 依据 F5-006 §3（l2.confirmed / l2.corrected 事件 + refAccuracy7d 公式）。
//
// 判定流（F5-006 §3）：
//   回复生成时：记录本轮进入 prompt 的 DMAE active 记忆 ids（turn context）
//        ↓ 下一轮用户消息
//   correctionIntent 检测
//     ├─ 命中且指向上述 ids 之一 -> emit 'l2.corrected' {memoryId}
//     └─ 未命中               -> 对上述全部 ids emit 'l2.confirmed'
//
// P2-41 实现简化：
//   - 上一轮 referencedMemoryIds 从 growth_events 表查最近一批 l2.referenced（跨重启可靠）
//   - correctionIntent 检测复用冲突系统能力（F5-006 §3"复用冲突系统已有能力"）：
//     correctionDetector 由 composition root 注入（setup.ts 传 conflict/resolver.ts 的
//     hasCorrectionIntent）。growth 不 import memory 模块（F5-006 §5），单一 patterns 真源。
//   - 命中纠正 -> 对上一轮全部 referenced ids emit l2.corrected
//     （F5-006 说"指向上述 ids 之一"，但当前无法精确判断纠正指向哪条记忆；
//      简化为：一旦命中纠正模式，上一轮全部 referenced 视为被纠正。
//      这是 F5-006 §3 的保守实现：宁可多记 corrected，也不漏记）
//   - 未命中 -> 对上一轮全部 referenced ids emit l2.confirmed
//
// Hook 时序：chat.message（用户发消息时）执行，priority 150（业务预处理）。

import { randomUUID } from 'node:crypto'
import type { Logger } from '@shared/observability/types'
import type { HookRegistration } from '../hooks/types'
import type { GrowthEventBus } from './event-bus'
import type { GrowthStore } from './service'
import type { GrowthEvent } from './types'

export interface ReferenceTrackerDeps {
  eventBus: GrowthEventBus
  store: GrowthStore
  logger: Logger
  now?: () => number
  idGen?: () => string
  /**
   * correctionIntent 检测（F5-006 §3：复用冲突系统已有能力）。
   * 由 composition root 注入 conflict/resolver.ts 的 hasCorrectionIntent，
   * 单一 patterns 真源，避免 growth 复制一份（双份正则有漂移风险）。
   */
  correctionDetector: (text: string) => boolean
}

/**
 * 创建 reference-tracker hook（注册到 chat.message）。
 *
 * chat.message hook 接收 sanitized user text（HookContext.userText 或 data.text）。
 * 检测 correctionIntent，对上一轮 referencedMemoryIds 发射 l2.confirmed/corrected。
 *
 * 注意：同一轮的 referenced 事件在上一轮 turn.end 已记录。
 * 本 hook 在本轮 chat.message（用户发消息）执行，检查上一轮 referenced 的命运。
 */
export function createReferenceTrackerHook(deps: ReferenceTrackerDeps): HookRegistration {
  const { eventBus, store, logger } = deps
  const now = deps.now ?? ((): number => Date.now())
  const idGen = deps.idGen ?? randomUUID

  const fn: HookRegistration['fn'] = (_ctx, data) => {
    // chat.message hook 的 data 是 sanitized user text
    const userText = typeof data === 'string' ? data : ((data as { text?: string })?.text ?? '')
    if (!userText) return { data }

    // 查上一轮的 referencedMemoryIds：从 growth_events 表查最近一批 l2.referenced
    // （按 ts 降序，取最近的连续一批；用"最后一个 l2.referenced 之前的 l2.referenced 连续段"）
    // 简化：查最近的 l2.referenced 事件（同 ts 或连续的），作为"上一轮 referenced"
    const recentReferenced = getLastTurnReferencedIds(store)
    if (recentReferenced.length === 0) {
      return { data } // 上一轮无引用记忆，无需 confirmed/corrected
    }

    const ts = now()
    const corrected = deps.correctionDetector(userText)
    const type: GrowthEvent['type'] = corrected ? 'l2.corrected' : 'l2.confirmed'

    try {
      for (const memoryId of recentReferenced) {
        eventBus.emit({
          id: idGen(),
          ts,
          type,
          payload: { memoryId }
        })
      }
    } catch (e) {
      // 败而不崩：reference tracker 失败不影响聊天
      logger.warn('growth reference-tracker emit failed', {
        scope: 'growth',
        detail: e instanceof Error ? e.message : String(e)
      })
    }

    return { data }
  }

  return {
    name: 'growth-reference-tracker',
    event: 'chat.message',
    priority: 150, // 业务预处理（sanitize 100 之后）
    fn,
    failOpen: true
  }
}

/**
 * 从 growth_events 表查"上一轮"的 referencedMemoryIds。
 *
 * 策略：用 store.lastTs('l2.referenced') 定位最近一批（同 ts 的视为同一轮 turn.end fan-out）。
 * 这些是最近一轮 turn.end 时 fan-out 的 referenced ids。
 *
 * 性能：growth_events 是 append-only 会无限增长（Phase 5 才 GC）。用 lastTs + sinceTs 走
 *   ts 索引只查最近一批，避免每次 chat.message 全表扫 l2.referenced。
 *
 * 跨重启可靠：事件持久化在 growth_events 表。
 */
function getLastTurnReferencedIds(store: GrowthStore): string[] {
  const lastTs = store.lastTs('l2.referenced')
  if (lastTs === null) return []
  // 取同 ts 的所有 referenced（同一轮 turn.end fan-out 的），保持原升序
  const events = store.list({ type: 'l2.referenced', sinceTs: lastTs })
  const ids: string[] = []
  for (const e of events) {
    const mid = e.payload.memoryId
    if (mid) ids.push(mid)
  }
  return ids
}
