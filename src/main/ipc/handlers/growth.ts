// src/main/ipc/handlers/growth.ts
// P2-29/41: growth IPC handler（3 invoke）。
// 依据：S-003-补充 §3.1、S-022 §3.1（growth handler 依赖 P2-41 GrowthService）、F5-006 §3/§5。
//
// 任务边界（S-022 §3.1）：
//   growth 3 invoke + growth store 拆为 P2-29b/P2-30b，依赖 P2-41 的
//   GrowthService/Profile/Timeline/Trend 后交付。P2-41 已实现 GrowthService，
//   handler 接真实 service；services=null（memory.enabled=false）时返回初始态。
//
// memory.enabled=false 时：返回空 profile / 空数组（growth 是记忆的只读投影，记忆关则成长无数据）。
// 隐私纪律（F5-006 §5）：只返回白名单脱敏投影（GrowthProfileView），A/B/C 原始指标不外泄。

import type { Logger } from '@shared/observability/types'
import type { MemoryConfig } from '@shared/config/types'
import { registerValidatedHandler } from '../register'
import type {
  GrowthProfileView,
  GrowthTimelineEntryView,
  GrowthTrendPoint,
  GrowthTrendRequest
} from '@shared/memory/types'
import type { MemoryServices } from '../../memory/setup'
import { projectGrowthProfile, projectGrowthTimeline } from '../../memory/projections'

export interface GrowthHandlerDeps {
  logger: Logger
  getMemoryConfig: () => Readonly<MemoryConfig>
  /** P2-41: memory 基础设施服务（services=null 时返回空态）。growthService 在其中。 */
  services: MemoryServices | null
}

// F5-006 §5 白名单：MILESTONES_V1 id -> title 映射（只暴露 title，不暴露 raw defs）
// 由 projections.ts 消费。自定义 milestones.json 的 title 若不在 v1 表内回退 milestoneId。
import { MILESTONES_V1 } from '../../growth/types'

const MILESTONE_TITLES = new Map(MILESTONES_V1.map((m) => [m.id, m.title]))

/** 初始空投影（services=null / memory 关时用，F5-006 决策 2 白名单） */
const EMPTY_PROFILE: GrowthProfileView = {
  understanding: 0,
  stage: 'stranger',
  activeDays: 0,
  l2Total: 0,
  startedAt: 0,
  milestonesReached: []
}

/**
 * 注册全部 growth IPC handler（3 invoke）。
 */
export function registerGrowthHandlers(deps: GrowthHandlerDeps): void {
  const { logger, services } = deps
  void deps.getMemoryConfig

  function getView(): GrowthProfileView {
    const svc = services?.growthService
    if (!svc) return EMPTY_PROFILE
    return projectGrowthProfile(svc.getProfile(), MILESTONE_TITLES)
  }

  // === companion:growth:get-profile ===
  registerValidatedHandler('companion:growth:get-profile', async (): Promise<GrowthProfileView> => {
    return getView()
  })

  // === companion:growth:get-timeline ===
  registerValidatedHandler(
    'companion:growth:get-timeline',
    async (_ctx, input): Promise<GrowthTimelineEntryView[]> => {
      const limit = (input as { limit?: number } | undefined)?.limit
      const svc = services?.growthService
      if (!svc) return []
      return projectGrowthTimeline(svc.getTimeline(limit))
    }
  )

  // === companion:growth:get-trend ===
  registerValidatedHandler(
    'companion:growth:get-trend',
    async (_ctx, input): Promise<GrowthTrendPoint[]> => {
      const req = input as GrowthTrendRequest
      const svc = services?.growthService
      if (!svc) return []
      const points = svc.getTrend(req.metric, req.days)
      return points.map((p) => ({ date: p.date, value: p.value }))
    }
  )

  logger.debug('growth handlers registered (P2-41 real GrowthService)', { scope: 'ipc' })
}
