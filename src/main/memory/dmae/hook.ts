// src/main/memory/dmae/hook.ts
// P2-25: DMAE turn.end hook--更新全部 L2 activation。
// 依据：S-Phase2 P2-25、S-011 §1.6（referencedMemoryIds）、S-010 §1.1（memoryEligible 门）。
//
// 时序：extraction hook（priority 250）之后。extraction 写入的新 L2 在 DMAE reconcile 时加入 states。
//
// 硬门：
//   1. memory.enabled=false -> 旁路（不 updateTurn）
//   2. dmae.enabled=false -> 旁路（context-assembler 已只读 L0/L1，selectL2 未记录 userHits）
//   3. 始终 updateTurn（即使 memoryEligible=false）：userHitIds（检索命中）仍需触发 Floor 复活/Decay；
//      memoryEligible=false 时 referencedMemoryIds=[]，modelHitIds 空，只处理 userHit + 沉默衰减。
//
// C-γ-2 问题 B：updateTurn 后必须 revisionClock.next() + broadcaster.notify('dmae')，
//   否则 activation 变化不触发 renderer 刷新（违反 S-012 doc:81 要求 hint='dmae'）。
//   broadcaster 已有 250ms 节流合并，每轮 notify 安全。
//
// failOpen=true：DMAE 更新失败不阻塞 turn.end 其他订阅者（败而不崩）。

import type { Logger } from '@shared/observability/types'
import type { HookFn, HookResult } from '../../hooks/types'
import type { TurnEndData } from '../../chat/service'
import type { MemoryConfig } from '@shared/config/types'
import type { DmaeEngineService } from './service'
import type { MemoryRevisionClock } from '../revision-clock'
import type { MemoryEventBroadcaster } from '../event-broadcaster'
import { getMetrics } from '../../observability/metrics'

export interface DmaeHookDeps {
  logger: Logger
  dmaeService: DmaeEngineService
  getMemoryConfig: () => Readonly<MemoryConfig>
  revisionClock: MemoryRevisionClock
  broadcaster: MemoryEventBroadcaster
}

export function createDmaeHook(deps: DmaeHookDeps): {
  hook: { name: string; event: string; priority: number; fn: HookFn; failOpen: true }
} {
  const { logger, dmaeService, getMemoryConfig, revisionClock, broadcaster } = deps

  const hookFn: HookFn = (_ctx, data): HookResult => {
    const turnEnd = data as TurnEndData
    const config = getMemoryConfig()

    // 硬门：memory.enabled=false 或 dmae.enabled=false -> 旁路
    if (!config.enabled || !config.dmae.enabled) return { data }

    try {
      // C-γ-2 问题 A：按 sessionId 隔离 userHitIds，消除跨会话串线
      const result = dmaeService.updateTurn(turnEnd.sessionId, turnEnd.referencedMemoryIds)
      // 接入 MetricsRegistry gauges（P2-26 + P2-28 面板 DMAE 分布）
      const metrics = getMetrics()
      metrics.gauge('dmae.active').set(result.stats.active)
      metrics.gauge('dmae.dormant').set(result.stats.dormant)
      metrics.gauge('dmae.archived').set(result.stats.archived)

      // C-γ-2 问题 B：activation 变化时广播，让 renderer 记忆面板刷新。
      // 触发条件：有状态迁移，或本轮处理了 userHit/modelHit/floorRevival（activation 值实际变化）。
      // 纯沉默衰减（三者皆 0 且无 transition）不广播--那只是数值缓降，无用户可感知变化。
      const hasActivationChange =
        result.transitions.length > 0 ||
        result.stats.userHits > 0 ||
        result.stats.modelHits > 0 ||
        result.stats.floorRevivals > 0
      if (hasActivationChange) {
        revisionClock.next()
        broadcaster.notify('dmae')
      }

      // 记日志（含 gauges，供 P2-26 MetricsRegistry 接入 + 调试可见；不记 memoryId，F5-011 白名单）
      logger.debug('dmae turn updated', {
        scope: 'memory',
        turnId: turnEnd.turnId,
        metrics: {
          userHits: result.stats.userHits,
          modelHits: result.stats.modelHits,
          floorRevivals: result.stats.floorRevivals,
          transitions: result.transitions.length,
          totalDecay: Math.round(result.stats.totalDecay * 100) / 100,
          activeGauge: result.stats.active,
          dormantGauge: result.stats.dormant,
          archivedGauge: result.stats.archived
        }
      })
    } catch (e) {
      // 败而不崩：DMAE 更新失败不影响 turn.end 其他订阅者
      logger.warn('dmae turn update failed', {
        scope: 'memory',
        turnId: turnEnd.turnId,
        code: 'UNKNOWN',
        detail: e instanceof Error ? e.message : String(e)
      })
    }

    return { data }
  }

  return {
    hook: {
      name: 'dmae',
      event: 'turn.end',
      priority: 300, // extraction（250）之后
      fn: hookFn,
      failOpen: true
    }
  }
}
