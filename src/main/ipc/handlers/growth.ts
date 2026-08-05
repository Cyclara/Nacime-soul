// src/main/ipc/handlers/growth.ts
// P2-29: growth IPC handler（3 invoke）。
// 依据：S-003-补充 §3.1、S-012 §3.1（growth handler 依赖 P2-41 GrowthService）。
//
// 任务边界（S-012 §3.1）：
//   growth 3 invoke + growth store 拆为 P2-29b/P2-30b，依赖 P2-41 的
//   GrowthService/Profile/Timeline/Trend 后交付。在此之前 preload 有类型占位，
//   但 handler 不伪造业务数据。本文件返回空/初始态（诚实的"无数据"），不伪造指标。
//
// memory.enabled=false 时：返回空 profile / 空数组（growth 是记忆的只读投影，记忆关则成长无数据）。

import type { Logger } from '@shared/observability/types'
import type { MemoryConfig } from '@shared/config/types'
import { registerValidatedHandler } from '../register'
import type {
  GrowthProfileView,
  GrowthTimelineEntryView,
  GrowthTrendPoint
} from '@shared/memory/types'

export interface GrowthHandlerDeps {
  logger: Logger
  getMemoryConfig: () => Readonly<MemoryConfig>
}

/**
 * 注册全部 growth IPC handler（3 invoke）。
 * 在 main/index.ts 中调用。P2-41 GrowthService 实现后替换为真实数据。
 */
export function registerGrowthHandlers(deps: GrowthHandlerDeps): void {
  const { logger, getMemoryConfig } = deps

  // === companion:growth:get-profile ===
  registerValidatedHandler('companion:growth:get-profile', async (): Promise<GrowthProfileView> => {
    // GrowthService 未实现（P2-40/41）；返回初始态（不伪造指标，F5-006 决策 2 白名单投影）
    // memory.enabled=false 时同样返回初始态（成长是记忆只读投影，无数据）
    void getMemoryConfig
    return {
      understanding: 0,
      stage: 'stranger',
      activeDays: 0,
      l2Total: 0,
      startedAt: 0,
      milestonesReached: []
    }
  })

  // === companion:growth:get-timeline ===
  registerValidatedHandler(
    'companion:growth:get-timeline',
    async (): Promise<GrowthTimelineEntryView[]> => {
      // 里程碑时间线 P2-41 实现；当前返回空
      return []
    }
  )

  // === companion:growth:get-trend ===
  registerValidatedHandler('companion:growth:get-trend', async (): Promise<GrowthTrendPoint[]> => {
    // 快照趋势 P2-41 实现；当前返回空
    return []
  })

  logger.debug('growth handlers registered (P2-29 stub; real data in P2-41)', { scope: 'ipc' })
}
