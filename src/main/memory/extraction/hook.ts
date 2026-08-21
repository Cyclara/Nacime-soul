// src/main/memory/extraction/hook.ts
// turn.end 提取 hook：fail-open 入有界队列，只取 memoryEligible turn。
// 依据 S-010 §1.1、§1.5。
//
// 硬门：
//   1. memory.enabled=false -> 不得读取 SessionStore、不得调用提取 provider/Judge/writer
//   2. memoryEligible=false（failed/cancelled/stopped）-> 不入队
//   3. hook 只把任务放进队列后立即返回，不 await 网络调用
//
// 队列消费者（processQueue）在后台异步运行：
//   P2-38（sync_turn 便宜提取）-> 候选入队积累 -> P2-39 批量终审（drain）
//   drain = 每轮各自 judge（evidence 校验需要该轮 ctx）-> 跨轮去重 -> 按组 dispatch
//   触发条件（S-010 §1.5）：
//     累计 6 个 eligible turn（SYNC_TURN_JUDGE_EVERY_TURNS）
//     或队列候选数 ≥12（JUDGE_QUEUE_THRESHOLD）
//     队列耗尽时 final drain（否则最后几轮候选永不写入，I-01「下轮 prompt 含名字」无法成立）
//   每一步失败只影响该 turn 的记忆写入，不影响聊天主流程。

import type { Logger } from '@shared/observability/types'
import type { HookFn, HookResult } from '../../hooks/types'
import type { TurnEndData } from '../../chat/service'
import type { SessionStore } from '../../chat/session-store'
import type { MemoryConfig } from '@shared/config/types'
import { createExtractionQueue, type ExtractionQueue, type ExtractionTask } from './queue'
import type { ExtractionService } from './service'
import type { MemoryCandidate } from './candidate'
import type { MemoryJudge, JudgeDecision } from './judge'
import type { MemoryDispatcher } from './dispatch'
import type { AttributionGate, AttributionGateItem, AttributionVerdict } from './attribution-gate'
import {
  SYNC_TURN_JUDGE_EVERY_TURNS,
  JUDGE_QUEUE_THRESHOLD,
  dedupeDecisionsForDrain
} from './sync-turn'
import { getMetrics } from '../../observability/metrics'

/** 待终审的 turn 组：提取出的候选按 turn 积累，drain 时统一 judge。 */
interface PendingGroup {
  task: ExtractionTask
  candidates: MemoryCandidate[]
}

export interface ExtractionHookDeps {
  logger: Logger
  sessionStore: SessionStore
  extractionService: ExtractionService
  judge: MemoryJudge
  dispatcher: MemoryDispatcher
  /** 配置获取器；hook 每次检查 memory.enabled */
  getMemoryConfig: () => Readonly<MemoryConfig>
  /**
   * M-42：L0 归属语义门（可选）。存在时 drain 在终审前对本批全部 L0 候选做一次
   * 批量语义判定（一次 API 调用），结论随 JudgeContext 预标注给 Judge step 6；
   * 缺省/门返回 null -> Judge 回退正则表（fail-closed）。
   */
  attributionGate?: AttributionGate | null
  /** 队列（测试可注入）；默认新建有界队列 */
  queue?: ExtractionQueue
}

/**
 * 创建 turn.end 提取 hook。
 *
 * hook 行为（S-010 §1.1）：
 *   1. 检查 memory.enabled && memoryEligible
 *   2. 通过 SessionStore.getTurnMessages 取当前 turn 的 user message
 *   3. 入队，立即返回（不 await 网络）
 *   4. 后台消费者：sync_turn 提取 -> 批量终审（P2-39）-> dispatch
 *
 * failOpen=true：hook 抛异常时继续执行后续 hook，不影响 turn.end 其他订阅者。
 */
export function createExtractionHook(deps: ExtractionHookDeps): {
  hook: { name: string; event: string; priority: number; fn: HookFn; failOpen: true }
  queue: ExtractionQueue
  /** 启动后台消费者（返回 stop 函数）。测试可手动驱动。 */
  startConsumer: () => void
  stopConsumer: () => void
  /** 测试辅助：等待消费者处理完当前队列（含后台运行中的批次）后 resolve */
  flush: () => Promise<void>
} {
  const { logger, sessionStore, extractionService, judge, dispatcher, getMemoryConfig } = deps
  const attributionGate = deps.attributionGate ?? null
  const queue = deps.queue ?? createExtractionQueue({ logger })
  let consumerRunning = false
  let consumerStopRequested = false
  let currentRun: Promise<void> | null = null

  /**
   * P2-39 批量终审：对一组 pending turn 统一执行 judge -> 跨轮去重 -> 按组 dispatch。
   *   - M-42：终审前对本批全部 L0 候选做一次批量语义归因判定（一次 API 调用），
   *     结论随每轮 ctx 预标注给 Judge step 6；门缺失/失败/超时 -> null -> 正则表
   *   - 每轮候选各自 judge（evidence 校验必须用该轮 ctx，S-010 §1.6 step 2）
   *   - dedupeDecisionsForDrain 跨轮合并同事实候选（confidence 取高），输入输出 1:1 保序
   *   - 按组回填 dispatch（保持每轮 sessionId/turnId 正确）
   */
  async function drain(groups: PendingGroup[]): Promise<void> {
    // 0. M-42 语义归因预标注：本批全部 L0 候选打包一次调用（跨组只调一次，控制成本）
    let attribution: ReadonlyMap<string, AttributionVerdict> | null = null
    if (attributionGate) {
      const items: AttributionGateItem[] = []
      for (const g of groups) {
        for (const c of g.candidates) {
          if (c.targetLayer === 'l0' && c.field) {
            items.push({
              candidateId: c.candidateId,
              field: c.field,
              content: c.content,
              quotes: c.evidence.map((e) => e.quote)
            })
          }
        }
      }
      if (items.length > 0) {
        try {
          attribution = await attributionGate.judgeL0Batch(items)
        } catch (e) {
          // AttributionGate 契约是不 throw（内部已 fail-closed）；此处防御性兜底——
          // 门异常等同于门失败，丢标注不丢整批（S-010 §1.1 败而不崩语义细化）
          logger.warn('attribution gate threw; falling back to regex', {
            scope: 'memory',
            metrics: { items: items.length },
            tags: { reason: e instanceof Error ? e.name : 'unknown' }
          })
          attribution = null
        }
      }
    }

    // 1. 每轮各自 judge（attribution 预标注随 ctx 传入；仅 step 6 L0 分支消费）
    const judged: Array<{ task: ExtractionTask; decisions: JudgeDecision[] }> = []
    for (const g of groups) {
      if (g.candidates.length === 0) continue
      const decisions = judge.judgeBatch(g.candidates, {
        turnId: g.task.turnId,
        userMessageId: g.task.userMessageId,
        userContent: g.task.userContent,
        attribution
      })
      judged.push({ task: g.task, decisions })
    }
    if (judged.length === 0) return

    // 2. 跨轮去重（P2-39：同事实候选合并 confidence 取高）
    const flat = judged.flatMap((j) => j.decisions)
    const deduped = dedupeDecisionsForDrain(flat)

    // 3. 按组回填 dispatch（dedup 1:1 保序，可按原组长度切回）
    let offset = 0
    for (const j of judged) {
      const slice = deduped.slice(offset, offset + j.decisions.length)
      offset += j.decisions.length
      if (slice.length === 0) continue
      await dispatcher.dispatchBatch(slice, {
        sessionId: j.task.sessionId,
        turnId: j.task.turnId
      })
    }
  }

  async function processQueue(): Promise<void> {
    if (consumerRunning) return
    consumerRunning = true
    try {
      const pending: PendingGroup[] = []
      let turnsSinceDrain = 0
      let pendingCandidates = 0

      while (!consumerStopRequested && !queue.isClosed()) {
        const task = queue.dequeue()
        if (!task) break

        try {
          // 1. sync_turn 便宜提取（P2-38）
          const { candidates } = await extractionService.extract({
            turnId: task.turnId,
            userMessageId: task.userMessageId,
            userContent: task.userContent
          })

          // P2-26: memory.extract.candidates 指标（累计候选数，供调试面板）
          getMetrics().counter('memory.extract.candidates').inc(candidates.length)

          if (candidates.length > 0) {
            pending.push({ task, candidates })
            pendingCandidates += candidates.length
          }
        } catch (e) {
          // 单 turn 提取失败不影响后续；只记元数据
          logger.warn('extraction pipeline failed for turn', {
            scope: 'memory',
            turnId: task.turnId,
            metrics: { pending: queue.pending() },
            tags: { reason: e instanceof Error ? e.name : 'unknown' }
          })
        }

        // 2. P2-39：累计 6 个 eligible turn 或队列候选 ≥12 时批量终审（S-010 §1.5）
        turnsSinceDrain++
        if (
          turnsSinceDrain >= SYNC_TURN_JUDGE_EVERY_TURNS ||
          pendingCandidates >= JUDGE_QUEUE_THRESHOLD
        ) {
          await safeDrain(pending)
          pending.length = 0
          turnsSinceDrain = 0
          pendingCandidates = 0
        }
      }

      // 3. 队列耗尽 -> final drain：最后几轮候选也要终审，
      //    否则单轮对话的候选永远不写（I-01「下轮 prompt 层 4 含名字」无法成立）
      if (pending.length > 0) {
        await safeDrain(pending)
        pending.length = 0
      }
    } finally {
      consumerRunning = false
    }
  }

  /**
   * fail-open 兜底：drain 失败（judge/dispatch 抛错）只丢弃该批，
   * 消费者继续处理剩余队列，不影响聊天主流程（S-010 §1.1 败而不崩）。
   * 不重试：extractionKey 幂等只保护「已写入」，重试同批有重复写入风险；
   * 丢弃等价于旧实现「单 turn 失败只影响该 turn 的记忆写入」。
   */
  async function safeDrain(groups: PendingGroup[]): Promise<void> {
    try {
      await drain(groups)
    } catch (e) {
      logger.warn('extraction drain failed; dropping batch', {
        scope: 'memory',
        metrics: { groups: groups.length },
        tags: { reason: e instanceof Error ? e.name : 'unknown' }
      })
    }
  }

  function startConsumer(): void {
    consumerStopRequested = false
    if (!currentRun) {
      currentRun = processQueue().finally(() => {
        currentRun = null
      })
    }
  }

  function stopConsumer(): void {
    consumerStopRequested = true
    queue.close()
  }

  /** 等待消费者处理完当前队列（含后台运行中的批次）。测试用；生产中不调用。 */
  async function flush(): Promise<void> {
    for (;;) {
      startConsumer()
      const run = currentRun
      if (run) await run
      if (queue.pending() === 0) break
    }
  }

  const hookFn: HookFn = (_ctx, data): HookResult => {
    const turnEnd = data as TurnEndData
    const config = getMemoryConfig()

    // 硬门 1：memory.enabled=false -> 全旁路
    if (!config.enabled) return { data }

    // 硬门 2：memoryEligible=false -> 不入队
    if (!turnEnd.memoryEligible) return { data }

    // 通过 SessionStore 取当前 turn 的 user message（不传正文给 hook context）
    const pair = sessionStore.getTurnMessages(turnEnd.sessionId, turnEnd.turnId)
    if (!pair) {
      logger.debug('extraction hook: turn messages not found', {
        scope: 'memory',
        turnId: turnEnd.turnId
      })
      return { data }
    }

    // 入队，立即返回（不 await 网络）
    const enqueued = queue.enqueue({
      turnId: turnEnd.turnId,
      sessionId: turnEnd.sessionId,
      userMessageId: pair.user.id,
      userContent: pair.user.content
    })

    if (enqueued) {
      // 启动后台消费者（如果未运行）
      startConsumer()
    }

    return { data }
  }

  return {
    hook: {
      name: 'extraction',
      event: 'turn.end',
      priority: 250, // S-011 §1.6：growth bridge（220）之后；dmae（300）之前
      fn: hookFn,
      failOpen: true
    },
    queue,
    startConsumer,
    stopConsumer,
    flush
  }
}
