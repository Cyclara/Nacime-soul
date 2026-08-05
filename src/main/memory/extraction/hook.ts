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
//   extract -> judge -> dispatch -> write
//   每一步失败只影响该 turn 的记忆写入，不影响聊天主流程。

import type { Logger } from '@shared/observability/types'
import type { HookFn, HookResult } from '../../hooks/types'
import type { TurnEndData } from '../../chat/service'
import type { SessionStore } from '../../chat/session-store'
import type { MemoryConfig } from '@shared/config/types'
import { createExtractionQueue, type ExtractionQueue } from './queue'
import type { ExtractionService } from './service'
import type { MemoryJudge } from './judge'
import type { MemoryDispatcher } from './dispatch'
import { getMetrics } from '../../observability/metrics'
export interface ExtractionHookDeps {
  logger: Logger
  sessionStore: SessionStore
  extractionService: ExtractionService
  judge: MemoryJudge
  dispatcher: MemoryDispatcher
  /** 配置获取器；hook 每次检查 memory.enabled */
  getMemoryConfig: () => Readonly<MemoryConfig>
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
 *   4. 后台消费者：extract -> judge -> dispatch -> write
 *
 * failOpen=true：hook 抛异常时继续执行后续 hook，不影响 turn.end 其他订阅者。
 */
export function createExtractionHook(deps: ExtractionHookDeps): {
  hook: { name: string; event: string; priority: number; fn: HookFn; failOpen: true }
  queue: ExtractionQueue
  /** 启动后台消费者（返回 stop 函数）。测试可手动驱动。 */
  startConsumer: () => void
  stopConsumer: () => void
} {
  const { logger, sessionStore, extractionService, judge, dispatcher, getMemoryConfig } = deps
  const queue = deps.queue ?? createExtractionQueue({ logger })
  let consumerRunning = false
  let consumerStopRequested = false

  async function processQueue(): Promise<void> {
    if (consumerRunning) return
    consumerRunning = true
    try {
      while (!consumerStopRequested && !queue.isClosed()) {
        const task = queue.dequeue()
        if (!task) break

        try {
          // 1. 提取候选
          const { candidates } = await extractionService.extract({
            turnId: task.turnId,
            userMessageId: task.userMessageId,
            userContent: task.userContent
          })

          // P2-26: memory.extract.candidates 指标（累计候选数，供调试面板）
          getMetrics().counter('memory.extract.candidates').inc(candidates.length)

          if (candidates.length === 0) continue

          // 2. 判决
          const decisions = judge.judgeBatch(candidates, {
            turnId: task.turnId,
            userMessageId: task.userMessageId,
            userContent: task.userContent
          })

          // 3. 分发写入
          await dispatcher.dispatchBatch(decisions, {
            sessionId: task.sessionId,
            turnId: task.turnId
          })
        } catch (e) {
          // 单 turn 失败不影响后续；只记元数据
          logger.warn('extraction pipeline failed for turn', {
            scope: 'memory',
            turnId: task.turnId,
            metrics: { pending: queue.pending() },
            tags: { reason: e instanceof Error ? e.name : 'unknown' }
          })
        }
      }
    } finally {
      consumerRunning = false
    }
  }

  function startConsumer(): void {
    consumerStopRequested = false
    void processQueue()
  }

  function stopConsumer(): void {
    consumerStopRequested = true
    queue.close()
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
      priority: 250, // 在 growth bridge（可观测性 300+）之前
      fn: hookFn,
      failOpen: true
    },
    queue,
    startConsumer,
    stopConsumer
  }
}
