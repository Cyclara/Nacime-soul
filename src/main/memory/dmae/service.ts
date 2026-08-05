// src/main/memory/dmae/service.ts
// P2-25: DMAE 引擎服务--编排 engine + stateFile + L2Store，提供 selectL2 + updateTurn。
// 依据：S-Phase2 P2-25、S-011 §1.2/§1.6（selectL2 + referencedMemoryIds）、F5-006（l2.referenced）、F5-011（日志白名单）。
//
// 设计要点：
//   1. selectL2(hits, memory, sessionId)：从 dmaeState 读 activation，过滤 Active 态（≥threshold），
//      按 activation 降序 + id 升序截 top maxActive。rankSource='dmae-activation'。
//      同时记录所有 hits 的 ID 到该 sessionId 的桶，作为本轮 userHitIds（检索命中=用户提及）。
//   2. updateTurn(sessionId, modelHitIds)：只消费并删除本 sessionId 的桶 +
//      engine.updateTurn(userHitIds, modelHitIds) + save。
//      modelHitIds 来自 TurnEndData.referencedMemoryIds（进 prompt 且回复完成）。
//   3. C-γ-2：userHitIds 按 sessionId 分桶（2026-08-03 审计裁定：隔离键=sessionId，不新增 turnId）。
//      旧实现用单一全局 Set，A/B 两个会话交错时 B 的 selectL2 会覆盖 A 的 userHitIds，
//      turn.end(A) 用 B 的命中集错误激活——跨会话串台。
//      孤儿桶兜底：selectL2 后 turn.end 永不触发时桶会泄漏，用 MAX_PENDING_HIT_SESSIONS
//      上限 + 插入序 LRU 淘汰强制有界（不只靠 happy path 的 updateTurn 删除）。
//   3. 不写 L2.lifecycleState/archivedAt（由写入/conflict/reject 维护，避免与 conflict supersede 冲突）。
//      DMAE activation 是独立的"记忆激活强度"，context-assembler 的 lifecycleState 过滤是第一道门，
//      DMAE activation 排序是第二道门。transitions 仅记日志（诊断）。
//   4. 每轮 updateTurn 前 reconcile（以 L2 DB 为准，清理孤儿 + 新增初始化）。
//
// 时序（S-011 §1.6）：
//   streamTurn 开始 -> contextAssembler.assemble -> selectL2（记录 userHitIds）
//   -> prompt build -> provider stream -> turn.end
//   -> DMAE hook（priority 300，extraction 250 之后）-> updateTurn(referencedMemoryIds)
//
// 隐私纪律（F5-011）：日志只记计数（hits/active/transitions），不记 memoryId 列表外的内容。

import type { Logger } from '@shared/observability/types'
import type { MemoryConfig } from '@shared/config/types'
import type { SessionId } from '@shared/chat/types'
import type { L2Store } from '../l2-store'
import type { DmaeStateStore } from './state-file'
import { reconcileStates } from './state-file'
import {
  updateTurn as runEngineTurn,
  countStates,
  type DmaeEntryState,
  type DmaeTurnResult
} from './engine'
import { dmaeParamsFromConfig } from './formulas'
import type { HydratedHit, PromptL2Item } from '../../prompts/builder'
import { getMetrics } from '../../observability/metrics'

/** DmaeEngineService：DMAE 引擎的有状态服务 */
export interface DmaeEngineService {
  /** 启动时加载 + 与 L2 DB 对齐（孤儿清理 + 新增初始化） */
  initialize(): void
  /**
   * P2-25 selectL2：从 dmaeState 读 activation 排序选 top maxActive。
   * 副作用：把所有 hits 的 ID 记入该 sessionId 的桶（供本 session 的 updateTurn 用）。
   */
  selectL2(
    hits: readonly HydratedHit[],
    memory: Readonly<MemoryConfig>,
    sessionId: SessionId
  ): readonly PromptL2Item[]
  /**
   * turn.end 时调用：只消费并删除本 sessionId 桶里的 userHitIds（selectL2 记录）+
   * modelHitIds（referencedMemoryIds），更新全部 L2 activation，save 到 dmae-state.json。
   * 返回 engine 结果（transitions + stats，诊断用）。
   */
  updateTurn(sessionId: SessionId, modelHitIds: readonly string[]): DmaeTurnResult
  /** 读单条 activation（无 state 则 0） */
  getActivation(id: string): number
  /** 各态计数（指标上报用） */
  getStats(): { active: number; dormant: number; archived: number }
  /** 待消费的 userHit 桶数（C-γ-2 诊断/泄漏测试用；只暴露计数，不暴露 sessionId） */
  readonly pendingUserHitSessions: number
  /** 内部 states（测试/诊断用） */
  readonly states: Map<string, DmaeEntryState>
}

export interface DmaeEngineServiceDeps {
  stateStore: DmaeStateStore
  l2Store: Pick<L2Store, 'list' | 'get' | 'count'>
  getMemoryConfig: () => Readonly<MemoryConfig>
  logger: Logger
}

/**
 * 待消费 userHit 桶上限（C-γ-2 孤儿桶兜底）。
 * 取值依据：并发活跃会话数的保守上界；真实场景中同一会话连续 selectL2 只占 1 桶，
 * 32 已远超合理并发，溢出即视为"turn.end 永不触发"的孤儿并淘汰。
 */
export const MAX_PENDING_HIT_SESSIONS = 32

export function createDmaeEngineService(deps: DmaeEngineServiceDeps): DmaeEngineService {
  const { stateStore, l2Store, getMemoryConfig, logger } = deps
  const states = new Map<string, DmaeEntryState>()
  // C-γ-2：userHitIds 按 sessionId 分桶。Map 插入序 = 淘汰序（selectL2 先 delete 再 set 刷新次序）。
  const turnUserHits = new Map<SessionId, Set<string>>()
  let initialized = false

  /**
   * 孤儿桶兜底清理（强制有界，不只靠 happy path）：selectL2 后 turn.end 永不触发
   * （进程崩溃/异常路径）时桶会泄漏。超出上限时按插入序淘汰最老的桶。
   */
  function evictOrphanBuckets(): void {
    let evicted = 0
    while (turnUserHits.size > MAX_PENDING_HIT_SESSIONS) {
      const oldest = turnUserHits.keys().next().value
      if (oldest === undefined) break
      turnUserHits.delete(oldest)
      evicted++
    }
    if (evicted > 0) {
      // F5-011 白名单：只记计数，不记 sessionId
      logger.warn('dmae pending user-hit buckets evicted (turn.end never consumed)', {
        scope: 'memory',
        metrics: { evicted, pending: turnUserHits.size }
      })
    }
  }

  function initialize(): void {
    const loaded = stateStore.load()
    states.clear()
    for (const [id, st] of loaded) {
      states.set(id, { ...st })
    }
    reconcileWithL2()
    initialized = true
    logger.info('dmae engine initialized', {
      scope: 'memory',
      metrics: { entries: states.size }
    })
  }

  /**
   * 与 L2 DB 对齐：清理孤儿（stateFile 有但 L2 已删）+ 新增初始化（L2 有但 stateFile 没有）。
   * 返回 importanceMap（id -> importance），供 updateTurn 复用，避免 15k 次逐条 l2Store.get。
   */
  function reconcileWithL2(): Map<string, number> {
    const l2List = l2Store.list({
      lifecycleState: ['active', 'dormant', 'archived']
    })
    const l2Ids = l2List.map((m) => m.id)
    const res = reconcileStates(states, l2Ids)
    if (res.removed > 0 || res.added > 0) {
      logger.info('dmae state reconciled with L2 DB', {
        scope: 'memory',
        metrics: { removed: res.removed, added: res.added, total: states.size }
      })
    }
    return new Map(l2List.map((m) => [m.id, m.importance]))
  }

  function getActivation(id: string): number {
    return states.get(id)?.activation ?? 0
  }

  function selectL2(
    hits: readonly HydratedHit[],
    memory: Readonly<MemoryConfig>,
    sessionId: SessionId
  ): readonly PromptL2Item[] {
    const threshold = memory.dmae.promptThreshold
    const maxActive = Math.max(0, memory.maxActive)

    // 记录本轮检索命中到本 sessionId 的桶（不管是否进 prompt；用户提及=检索命中）。
    // 先 delete 再 set：同一会话连续多轮 selectL2 只占 1 桶且刷新插入序（淘汰序）。
    turnUserHits.delete(sessionId)
    turnUserHits.set(sessionId, new Set(hits.map((h) => h.memory.id)))
    evictOrphanBuckets()

    // 对每个 hit 读 activation，过滤 Active 态（≥threshold），按 activation 降序 + id 升序
    const candidates = hits
      .map((h) => ({ hit: h, activation: getActivation(h.memory.id) }))
      .filter((c) => c.activation >= threshold)
    candidates.sort(
      (a, b) =>
        b.activation - a.activation ||
        (a.hit.memory.id < b.hit.memory.id ? -1 : a.hit.memory.id > b.hit.memory.id ? 1 : 0)
    )
    const top = candidates.slice(0, maxActive)

    return top.map((c) => ({
      id: `l2:${c.hit.memory.id}`,
      provenance: 'judge-approved-l2',
      content: c.hit.memory.content,
      selectionRank: c.activation,
      rankSource: 'dmae-activation' as const,
      retrievalScore: c.hit.retrievalScore
    }))
  }

  function updateTurn(sessionId: SessionId, modelHitIds: readonly string[]): DmaeTurnResult {
    if (!initialized) {
      logger.warn('dmae updateTurn called before initialize; skipping', { scope: 'memory' })
      return {
        transitions: [],
        stats: {
          userHits: 0,
          modelHits: 0,
          floorRevivals: 0,
          totalDecay: 0,
          active: 0,
          dormant: 0,
          archived: 0
        }
      }
    }

    // 每轮 reconcile（新写入的 L2 加入 states；孤儿清理）；复用 list 结果构造 importanceMap
    const importanceMap = reconcileWithL2()

    // P2-26: memory.l2.count gauge（L2 总数，供调试面板）
    getMetrics().gauge('memory.l2.count').set(l2Store.count())

    const cfg = getMemoryConfig()
    const params = dmaeParamsFromConfig(cfg)

    // importance lookup（从 reconcile 的 list 结果读，避免 15k 次逐条 get）
    const getImportance = (id: string): number => importanceMap.get(id) ?? 5

    // C-γ-2：只消费本 sessionId 桶的 userHitIds（selectL2 记录）。
    // 先取后删：若 runEngineTurn/save 抛错，桶已删除，避免下一轮用残留旧 userHitIds 错误激活。
    // 桶不存在（selectL2 未调用 / 已被消费 / 被 LRU 淘汰）-> 空集，只处理 modelHit + 沉默衰减。
    const userHitIds = turnUserHits.get(sessionId) ?? new Set<string>()
    turnUserHits.delete(sessionId)

    const input = {
      userHitIds,
      modelHitIds: new Set(modelHitIds)
    }

    const result = runEngineTurn(states, input, params, getImportance)

    // 持久化（save 内部 try/catch，失败只 warn 不抛错）
    stateStore.save(states)

    return result
  }

  function getStats(): { active: number; dormant: number; archived: number } {
    const cfg = getMemoryConfig()
    return countStates(states, cfg.dmae.promptThreshold)
  }

  return {
    initialize,
    selectL2,
    updateTurn,
    getActivation,
    getStats,
    get pendingUserHitSessions() {
      return turnUserHits.size
    },
    get states() {
      return states
    }
  }
}
