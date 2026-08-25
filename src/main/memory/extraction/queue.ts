// src/main/memory/extraction/queue.ts
// 有界单消费者队列。依据 S-020 §1.5。
//
// 设计要点：
//   1. hook 只把任务放进队列后立即返回，不 await 网络调用
//   2. 队列有界（默认 24 turn），同 turnId 幂等去重
//   3. 满时丢最旧未开始任务并只记计数
//   4. app 退出时 abort in-flight，不开始新写入
//   5. 单消费者 FIFO，排序 (enqueueSequence, candidateId)
//
// 阈值常量 JUDGE_QUEUE_THRESHOLD=12（S-020 §1.5），P2-39 才用。
// P2-10/11/12 中每个 eligible turn 提取后立即 judge + write。

import type { Logger } from '@shared/observability/types'

export interface ExtractionTask {
  turnId: string
  sessionId: string
  userMessageId: string
  userContent: string
  enqueueSequence: number
}

export interface ExtractionQueueOptions {
  /** 最大队列长度（未开始任务）。默认 24 */
  maxPending?: number
  logger?: Logger
}

export interface ExtractionQueue {
  /** 入队一个任务。同 turnId 幂等去重。满时丢最旧。返回是否成功入队。 */
  enqueue(task: Omit<ExtractionTask, 'enqueueSequence'>): boolean
  /** 取下一个任务（FIFO）。无任务返回 null。 */
  dequeue(): ExtractionTask | null
  /** 当前待处理任务数 */
  pending(): number
  /** 标记关闭：不再接受新任务，已有任务可继续处理或被丢弃 */
  close(): void
  /** 是否已关闭 */
  isClosed(): boolean
  /** 因队列满被丢弃的任务计数（仅记计数，不记内容） */
  droppedOverflow(): number
}

/**
 * 创建有界单消费者队列。
 * 同 turnId 幂等：重复入队同一 turn 的任务被忽略。
 * 满时丢最旧未开始任务，只递增 droppedOverflow 计数。
 */
export function createExtractionQueue(opts: ExtractionQueueOptions = {}): ExtractionQueue {
  const maxPending = opts.maxPending ?? 24
  const logger = opts.logger
  let tasks: ExtractionTask[] = []
  let sequence = 0
  let closed = false
  let droppedOverflow = 0
  const seenTurnIds = new Set<string>()

  return {
    enqueue(task) {
      if (closed) return false
      // 同 turnId 幂等去重
      if (seenTurnIds.has(task.turnId)) return false
      // 满时丢最旧
      if (tasks.length >= maxPending) {
        const oldest = tasks.shift()
        if (oldest) {
          seenTurnIds.delete(oldest.turnId)
          droppedOverflow++
          logger?.warn('extraction queue overflow; dropped oldest task', {
            scope: 'memory',
            metrics: { droppedOverflow, pending: tasks.length }
          })
        }
      }
      const full: ExtractionTask = { ...task, enqueueSequence: sequence++ }
      tasks.push(full)
      seenTurnIds.add(task.turnId)
      return true
    },

    dequeue() {
      const next = tasks.shift()
      if (next) {
        seenTurnIds.delete(next.turnId)
      }
      return next ?? null
    },

    pending() {
      return tasks.length
    },

    close() {
      closed = true
      tasks = []
      seenTurnIds.clear()
    },

    isClosed() {
      return closed
    },

    droppedOverflow() {
      return droppedOverflow
    }
  }
}
