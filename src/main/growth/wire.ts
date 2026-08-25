// src/main/growth/wire.ts
// 把记忆模块的事件转发到 GrowthEventBus。
// 依据：F5-006 §3（10 种事件发射点）、F5-006 §5（依赖方向：growth 订阅 memory 事件）。
//
// 本文件是 composition root 的一部分，由 memory/setup.ts 调用。
// 只 import 类型（最小化订阅接口），不 import 记忆模块运行时实现。
//
// P2-40 接线 7 种事件（F5-006 §3 的 10 种中，本阶段能接的）：
//   l0.filled / l0.updated / l1.refreshed / l2.added / l2.referenced / conflict.resolved / session.daily_first
// 剩余 3 种（milestone.reached / l2.confirmed / l2.corrected）由 P2-41 接线
// （依赖里程碑引擎 + B 层引用->确认/纠正判定流）。

import { randomUUID } from 'node:crypto'
import type { GrowthEventBus } from './event-bus'
import type { GrowthEvent } from './types'

// === 最小化订阅接口（结构类型，不依赖 memory 模块具体实现）===

interface L0EventSource {
  on(event: 'l0.filled' | 'l0.updated', handler: (field: string) => void): () => void
}
interface L1EventSource {
  on(event: 'l1.refreshed', handler: () => void): () => void
}
interface L2EventSource {
  on(event: 'l2.added', handler: (mem: { id: string }) => void): () => void
}
interface ConflictEventSource {
  on(event: 'conflict.resolved', handler: (result: unknown) => void): () => void
}

export interface GrowthWireDeps {
  eventBus: GrowthEventBus
  l0: L0EventSource
  l1: L1EventSource
  l2: L2EventSource
  now?: () => number
  idGen?: () => string
}

/**
 * 把 L0/L1/L2 事件转发到 GrowthEventBus。
 * 必须在 Store 创建后、seed 加载前调用（seed 的 l2.added 也应被记录）。
 *
 * 事件映射（F5-006 §3）：
 *   l0.filled    -> GrowthEvent{type:'l0.filled', payload:{field}}
 *   l0.updated   -> GrowthEvent{type:'l0.updated', payload:{field}}
 *   l1.refreshed -> GrowthEvent{type:'l1.refreshed', payload:{}}
 *   l2.added     -> GrowthEvent{type:'l2.added', payload:{memoryId}}
 *
 * 返回取消订阅函数（cleanup 时调用）。
 */
export function wireGrowthEventSources(deps: GrowthWireDeps): () => void {
  const { eventBus, l0, l1, l2 } = deps
  const now = deps.now ?? ((): number => Date.now())
  const idGen = deps.idGen ?? randomUUID

  function emit(type: GrowthEvent['type'], payload: GrowthEvent['payload']): void {
    eventBus.emit({ id: idGen(), ts: now(), type, payload })
  }

  const unsubs: Array<() => void> = [
    l0.on('l0.filled', (field) => emit('l0.filled', { field })),
    l0.on('l0.updated', (field) => emit('l0.updated', { field })),
    l1.on('l1.refreshed', () => emit('l1.refreshed', {})),
    l2.on('l2.added', (mem) => emit('l2.added', { memoryId: mem.id }))
  ]

  return () => {
    for (const unsub of unsubs) {
      try {
        unsub()
      } catch {
        /* 取消订阅失败忽略 */
      }
    }
  }
}

/**
 * 把 conflict.resolved 事件转发到 GrowthEventBus。
 * 在 conflictService 创建后调用（无 API key 时 conflictService 不存在，不调用）。
 *
 * F5-006 §3：conflict.resolved = 冲突解决完成。
 * ConflictResolveResult 不含 conflictId；payload 留空（P2-41 可扩展）。
 */
export function wireConflictEventSource(deps: {
  eventBus: GrowthEventBus
  conflict: ConflictEventSource
  now?: () => number
  idGen?: () => string
}): () => void {
  const { eventBus, conflict } = deps
  const now = deps.now ?? ((): number => Date.now())
  const idGen = deps.idGen ?? randomUUID

  return conflict.on('conflict.resolved', () => {
    eventBus.emit({
      id: idGen(),
      ts: now(),
      type: 'conflict.resolved',
      payload: {}
    })
  })
}
