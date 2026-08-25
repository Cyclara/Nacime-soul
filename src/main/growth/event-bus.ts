// src/main/growth/event-bus.ts
// 成长事件总线：EventEmitter 'growth:event'。
// 依据：F5-006 §1/§3（事件溯源投影）、S-021 §1.6（growth bridge 发射 l2.referenced）。
//
// 设计（F5-006 §5 数据流）：
//   memory 写路径 -> emit 事件 -> ingest（同步、非事务性，失败只 warn）-> 每日快照 -> Prompt/UI 消费
//
// 依赖方向（F5-006 §5）：
//   - 记忆模块不 import 成长模块；成长模块订阅事件流
//   - 本模块是 EventBus，只依赖 node:events + 自身类型，不 import 任何记忆模块
//   - composition root（memory/setup.ts）负责把 L0/L1/L2/conflict 的事件转发到 EventBus
//
// 同步语义：EventEmitter.emit 是同步的--所有监听器同步执行完才返回。
//   因此 growth bridge hook 里 eventBus.emit(event) 返回时，GrowthService.ingest 已执行完。

import { EventEmitter } from 'node:events'
import type { GrowthEvent } from './types'

export const GROWTH_EVENT = 'growth:event'

export interface GrowthEventBus {
  /** 发射一个成长事件。同步调用所有监听器。 */
  emit(e: GrowthEvent): void
  /** 订阅成长事件。返回取消订阅函数。 */
  on(handler: (e: GrowthEvent) => void): () => void
  /** 移除所有监听器（测试/cleanup 用） */
  removeAllListeners(): void
}

export function createGrowthEventBus(): GrowthEventBus {
  const ee = new EventEmitter()
  // 成长事件频率低（每轮对话最多几条），不设上限；但防御性设一个合理上限避免泄漏
  ee.setMaxListeners(50)
  return {
    emit(e) {
      ee.emit(GROWTH_EVENT, e)
    },
    on(handler) {
      ee.on(GROWTH_EVENT, handler)
      return () => {
        ee.off(GROWTH_EVENT, handler)
      }
    },
    removeAllListeners() {
      ee.removeAllListeners(GROWTH_EVENT)
    }
  }
}
