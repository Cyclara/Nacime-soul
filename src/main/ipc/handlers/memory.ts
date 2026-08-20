// src/main/ipc/handlers/memory.ts
// P2-29: memory IPC handler（9 invoke）。业务逻辑在 Store/Service 层，handler 只做
// "取服务 -> 调方法 -> 投影脱敏"。依据 S-003-补充 §3.7、S-012 §1.4/§3.3。
//
// 边界条件（S-012 §3.3）：
//   - memory.enabled=false：query 返回空/disabled 信封；get-detail 与三写操作返回 MEM_DISABLED。
//   - get-detail：memoryId 不存在 -> MEM_NOT_FOUND。
//   - soft-delete：允许删 active 记忆（用户意志高于状态机），set lifecycleState='soft_deleted'。
//   - restore：set lifecycleState='archived'（F5-004 user 路径，S-006 §1.3）。
//
// 安全红线（S-003-补充 §4）：
//   - list-l2 的 LIKE 查询用参数绑定，禁止字符串拼接 SQL。
//   - handler 不直接 new Database 或访问 dmae-state.json--一律经单例服务。
//   - 投影函数集中在 projections.ts。

import type { Logger } from '@shared/observability/types'
import type { MemoryConfig } from '@shared/config/types'
import { AppError } from '@shared/errors'
import type { L0Store } from '../../memory/l0-store'
import type { L2Store, MemoryLifecycleState } from '../../memory/l2-store'
import type { DmaeEngineService } from '../../memory/dmae/service'
import type { DmaeDiagnosticsService } from '../../memory/dmae/diagnostics'
import type { MemoryRevisionClock } from '../../memory/revision-clock'
import type { MemoryEventBroadcaster } from '../../memory/event-broadcaster'
import {
  projectDmaeSnapshot,
  projectL0,
  projectL2Detail,
  projectL2View
} from '../../memory/projections'
import { registerValidatedHandler } from '../register'
import type {
  DmaeHistoryResponse,
  DmaeSnapshotView,
  L0ProfileView,
  L2MemoryDetail,
  MemoryListResponse,
  MemoryOverview
} from '@shared/memory/types'

/** memory 服务集合（memory.enabled=true 时由 setup.ts 创建注入） */
export interface MemoryServices {
  l0Store: L0Store
  l2Store: L2Store
  dmaeService: DmaeEngineService | null // null = dmae.enabled=false
  /** P2-32：DMAE 诊断服务（dmae.enabled=false 时为 null；get-dmae-history 真实实现委托给它） */
  dmaeDiagnostics: DmaeDiagnosticsService | null
  revisionClock: MemoryRevisionClock
  broadcaster: MemoryEventBroadcaster
}

export interface MemoryHandlerDeps {
  logger: Logger
  /** null = memory.enabled=false（setup 未创建基础设施） */
  services: MemoryServices | null
  getMemoryConfig: () => Readonly<MemoryConfig>
}

/** renderer 可见的 L2 状态；purged 在 SQL WHERE 层排除，永不占用 limit/total。 */
const VISIBLE_L2_STATES: MemoryLifecycleState[] = ['active', 'dormant', 'archived', 'soft_deleted']

/**
 * 注册全部 memory IPC handler（9 invoke）。
 * 在 main/index.ts 中调用，需在 configureIpcGuard 之后。
 */
export function registerMemoryHandlers(deps: MemoryHandlerDeps): void {
  const { logger, services, getMemoryConfig } = deps

  function disabled(): boolean {
    return services === null || !getMemoryConfig().enabled
  }

  // === companion:memory:get-overview ===
  registerValidatedHandler('companion:memory:get-overview', async (): Promise<MemoryOverview> => {
    if (disabled()) {
      return { revision: 0, enabled: false, l0: null, dmae: null }
    }
    const cfg = getMemoryConfig()
    const { l0Store, dmaeService, revisionClock } = services!
    return {
      revision: revisionClock.current(),
      enabled: true,
      l0: projectL0(l0Store),
      dmae: projectDmaeSnapshot(dmaeService, cfg)
    }
  })

  // === companion:memory:get-l0 ===
  registerValidatedHandler('companion:memory:get-l0', async (): Promise<L0ProfileView> => {
    if (disabled()) {
      // disabled 时返回全"未知"空画像（不抛错，S-012 §3.3 query 返回空 data）
      return { fields: [], filledCount: 0, totalCount: 0 }
    }
    return projectL0(services!.l0Store)
  })

  // === companion:memory:list-l2 ===
  registerValidatedHandler(
    'companion:memory:list-l2',
    async (_ctx, input): Promise<MemoryListResponse> => {
      if (disabled()) {
        return { items: [], total: 0, revision: 0 }
      }
      const { l2Store, dmaeService, revisionClock } = services!
      const search = input.search?.trim() || undefined
      const lifecycleState = input.state ?? VISIBLE_L2_STATES
      // C-β：search/offset/purged 排除全部下推 SQL；items 与 total 共用同一 WHERE。
      const items = l2Store
        .list({
          lifecycleState,
          search,
          limit: input.limit,
          offset: input.offset
        })
        .map((m) => projectL2View(m, dmaeService?.getActivation(m.id) ?? 0))
      const total = l2Store.count({ lifecycleState, search })
      return { items, total, revision: revisionClock.current() }
    }
  )

  // === companion:memory:get-detail ===
  registerValidatedHandler(
    'companion:memory:get-detail',
    async (_ctx, input): Promise<L2MemoryDetail> => {
      if (disabled()) {
        throw new AppError({
          code: 'MEM_DISABLED',
          userMessage: '记忆功能未开启',
          severity: 'error',
          retryable: false
        })
      }
      const { l2Store, dmaeService } = services!
      const mem = l2Store.get(input.memoryId)
      if (!mem || mem.lifecycleState === 'purged') {
        throw new AppError({
          code: 'MEM_NOT_FOUND',
          userMessage: '这条记忆不存在或已被清理',
          severity: 'error',
          retryable: false
        })
      }
      return projectL2Detail(mem, dmaeService?.getActivation(mem.id) ?? 0)
    }
  )

  // === companion:memory:set-pinned ===
  registerValidatedHandler('companion:memory:set-pinned', async (_ctx, input): Promise<void> => {
    if (disabled()) throw memDisabled()
    const { l2Store, revisionClock, broadcaster } = services!
    const mem = l2Store.get(input.memoryId)
    if (!mem || mem.lifecycleState === 'purged') throw memNotFound()
    l2Store.update(input.memoryId, { isPinned: input.pinned })
    // S-012 §1.4：用户写操作 revision++ + hint='l2'
    revisionClock.next()
    broadcaster.notify('l2')
    logger.debug('memory pinned', {
      scope: 'memory-ipc',
      tags: { memoryId: input.memoryId, pinned: String(input.pinned) }
    })
  })

  // === companion:memory:soft-delete ===
  registerValidatedHandler('companion:memory:soft-delete', async (_ctx, input): Promise<void> => {
    if (disabled()) throw memDisabled()
    const { l2Store, revisionClock, broadcaster } = services!
    const mem = l2Store.get(input.memoryId)
    if (!mem || mem.lifecycleState === 'purged') throw memNotFound()
    // 用户意志高于状态机建议；soft_deleted 由 GC（Phase 3+）或 user 写入（F5-004 TRANSITIONS）
    // S-06 修复：软删时写入 archivedAt 作为删除时间戳，供 GC 判定保留期（F5-004 softDeleteToPurgeDays）。
    // restore 路径同样写 archivedAt=Date.now()，语义一致。
    l2Store.update(input.memoryId, { lifecycleState: 'soft_deleted', archivedAt: Date.now() })
    revisionClock.next()
    broadcaster.notify('l2')
    logger.debug('memory soft-deleted', {
      scope: 'memory-ipc',
      tags: { memoryId: input.memoryId }
    })
  })

  // === companion:memory:restore ===
  registerValidatedHandler('companion:memory:restore', async (_ctx, input): Promise<void> => {
    if (disabled()) throw memDisabled()
    const { l2Store, revisionClock, broadcaster } = services!
    const mem = l2Store.get(input.memoryId)
    if (!mem || mem.lifecycleState === 'purged') throw memNotFound()
    // F5-004 user 路径：soft_deleted -> archived（S-006 §1.3 恢复回 archived 态）
    l2Store.update(input.memoryId, { lifecycleState: 'archived', archivedAt: Date.now() })
    revisionClock.next()
    broadcaster.notify('l2')
    logger.debug('memory restored', {
      scope: 'memory-ipc',
      tags: { memoryId: input.memoryId }
    })
  })

  // === companion:memory:get-dmae-snapshot ===
  registerValidatedHandler(
    'companion:memory:get-dmae-snapshot',
    async (): Promise<DmaeSnapshotView> => {
      if (disabled()) {
        // disabled 时返回 enabled=false 的空快照
        const cfg = getMemoryConfig()
        return projectDmaeSnapshot(null, cfg)
      }
      return projectDmaeSnapshot(services!.dmaeService, getMemoryConfig())
    }
  )

  // === companion:memory:get-dmae-history ===
  // P2-32: 真实实现--委托给 DmaeDiagnosticsService.getMemoryHistory（读 dmae_samples）。
  // dmaeDiagnostics=null（dmae 关闭）时返回空 points（诚实无历史）。
  // memory.enabled=false 同样返回空 points（S-012 §3.3：query 返回空 data，不抛 MEM_DISABLED）。
  registerValidatedHandler(
    'companion:memory:get-dmae-history',
    async (_ctx, input): Promise<DmaeHistoryResponse> => {
      if (disabled()) {
        return { memoryId: input.memoryId, points: [] }
      }
      const { dmaeDiagnostics } = services!
      if (!dmaeDiagnostics) {
        // dmae.enabled=false：返回空 points（不伪造历史）
        return { memoryId: input.memoryId, points: [] }
      }
      const result = dmaeDiagnostics.getMemoryHistory(input.memoryId, input.days)
      return {
        memoryId: result.memoryId,
        points: result.points.map((p) => ({
          ts: p.ts,
          activation: p.activation,
          state: p.state
        }))
      }
    }
  )

  logger.debug('memory handlers registered', { scope: 'ipc' })
}

function memDisabled(): AppError {
  return new AppError({
    code: 'MEM_DISABLED',
    userMessage: '记忆功能未开启',
    severity: 'error',
    retryable: false
  })
}

function memNotFound(): AppError {
  return new AppError({
    code: 'MEM_NOT_FOUND',
    userMessage: '这条记忆不存在或已被清理',
    severity: 'error',
    retryable: false
  })
}
