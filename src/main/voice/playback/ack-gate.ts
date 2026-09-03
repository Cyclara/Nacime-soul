// src/main/voice/playback/ack-gate.ts
// P3B-08 / F5-007 §1.5 + S-Phase3 P3B-15A：ChatRenderAckGate 的 main 侧实现。
//
// 职责：跟踪 chat renderer「最高已绘制 sequence」。renderer 侧在 applyStream 后等一次
// rAF、经 `companion:chat:ack-rendered` 通道回报（P3B-15A 落地，payload
// {requestId, sequence}）；本模块只收 observeAck 喂进来的合法回报，供播放队列在
// 发声前等待「对应文字已绘制」（§1.5：绝不让声音跑在对应文字前面）。
//
// 本文件不含 IPC 通道注册（六处同步归 P3B-15A，含 sender/active-requestId 校验）；
// gate 自身只做：严格递增校验、有界跟踪（LRU）、挂起 waiter 的满足/释放。

import type { ChatRenderAck, ChatRenderAckGate } from './types'

/** 网络对面（renderer）不可信：sequence 必须是非负整数。 */
export function isValidAckSequence(sequence: unknown): sequence is number {
  return typeof sequence === 'number' && Number.isInteger(sequence) && sequence >= 0
}

export interface ChatRenderAckGateInternal extends ChatRenderAckGate {
  /**
   * 记录一条 renderer 回报。逆序（sequence 不大于已见最高值）返回 null，调用方按
   * 协议错误处置（P3B-15A 的「逆序 ack 拒绝」）。合法时返回带 paintedAt 的 ack 并
   * 顺手满足挂起的 waiter。
   */
  observeAck(requestId: string, sequence: number): ChatRenderAck | null
  /** turn/request 结束清理；该 requestId 的挂起 waiter 以 forgotten 错误释放。 */
  forget(requestId: string): void
  /** 当前跟踪中的 requestId 数（有界性测试用）。 */
  readonly trackedRequestCount: number
}

interface Waiter {
  readonly sequence: number
  readonly requestId: string
  resolve: (ack: ChatRenderAck) => void
  reject: (err: Error) => void
  onAbort: () => void
}

interface TrackedRequest {
  highestSequence: number
  paintedAt: number
  waiters: Waiter[]
}

export class AckGateForgottenError extends Error {
  constructor(requestId: string) {
    super(`ack-gate-forgotten:${requestId}`)
    this.name = 'AckGateForgottenError'
  }
}

export function createChatRenderAckGate(deps?: {
  now?: () => number
  /** 有界跟踪上限（LRU 淘汰最旧 request；默认 8，够当前轮 + 前后各几轮）。 */
  maxTrackedRequests?: number
}): ChatRenderAckGateInternal {
  const now = deps?.now ?? Date.now
  const maxTracked = deps?.maxTrackedRequests ?? 8
  const tracked = new Map<string, TrackedRequest>()

  function ackError(requestId: string, sequence: number, paintedAt: number): ChatRenderAck {
    return { requestId, sequence, paintedAt }
  }

  function resolveWaiters(requestId: string): void {
    const entry = tracked.get(requestId)
    if (entry === undefined) return
    const satisfied = entry.waiters.filter((w) => w.sequence <= entry.highestSequence)
    entry.waiters = entry.waiters.filter((w) => w.sequence > entry.highestSequence)
    for (const waiter of satisfied) {
      waiter.resolve(ackError(requestId, entry.highestSequence, entry.paintedAt))
    }
  }

  function rejectWaiters(requestId: string, err: Error): void {
    const entry = tracked.get(requestId)
    if (entry === undefined) return
    for (const waiter of entry.waiters) {
      waiter.onAbort = () => {} // 防止后续 abort 二次 reject
      waiter.reject(err)
    }
    entry.waiters = []
  }

  function track(requestId: string): TrackedRequest {
    let entry = tracked.get(requestId)
    if (entry === undefined) {
      entry = { highestSequence: -1, paintedAt: 0, waiters: [] }
      tracked.set(requestId, entry)
      // LRU：新 request 进来才淘汰；同一 request 重复 ack 不触发
      while (tracked.size > maxTracked) {
        const oldestKey = tracked.keys().next().value
        if (oldestKey === undefined) break
        rejectWaiters(oldestKey, new AckGateForgottenError(oldestKey))
        tracked.delete(oldestKey)
      }
    }
    return entry
  }

  return {
    get trackedRequestCount() {
      return tracked.size
    },

    observeAck(requestId, sequence) {
      if (requestId.length === 0 || requestId.length > 128) return null
      if (!isValidAckSequence(sequence)) return null
      const entry = track(requestId)
      if (sequence <= entry.highestSequence) return null // 逆序/重复拒绝
      entry.highestSequence = sequence
      entry.paintedAt = now()
      resolveWaiters(requestId)
      return ackError(requestId, sequence, entry.paintedAt)
    },

    waitForPainted(requestId, sequence, signal) {
      const entry = track(requestId)
      if (entry.highestSequence >= sequence) {
        return Promise.resolve(ackError(requestId, entry.highestSequence, entry.paintedAt))
      }
      if (signal.aborted) {
        return Promise.reject(new DOMException('Aborted', 'AbortError'))
      }
      return new Promise<ChatRenderAck>((resolve, reject) => {
        const waiter: Waiter = {
          requestId,
          sequence,
          resolve,
          reject,
          onAbort: () => {
            const current = tracked.get(requestId)
            if (current !== undefined) {
              current.waiters = current.waiters.filter((w) => w !== waiter)
            }
            reject(new DOMException('Aborted', 'AbortError'))
          }
        }
        entry.waiters.push(waiter)
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      })
    },

    forget(requestId) {
      rejectWaiters(requestId, new AckGateForgottenError(requestId))
      tracked.delete(requestId)
    }
  }
}

// ── P3B-15A：IPC 喂入层的组合件（已知 requestId LRU + gate）──

/**
 * `companion:chat:ack-rendered` 的 main 侧入口。三层校验（台账 §3 冻结语义）：
 *   1. capability=chat 由 IPC guard 保证（stage 无权调用，负例在 register.ts 拦）；
 *   2. requestId 必须是 main 近期发出的（noteRequestIssued 记录；未知/过旧请求拒绝——
 *      防旧窗口/旧会话的迟到 ack 污染语义。LRU 有界，被淘汰的请求同时从 gate 遗忘）；
 *   3. 同 request 内 sequence 严格递增由 gate.observeAck 保证（重复/逆序返回 null）。
 */
export interface ChatRenderAckTracker {
  /** chat:send / chat:retry 发出 requestId 后恰调用一次（幂等）。 */
  noteRequestIssued(requestId: string): void
  /** handler 收到 ack 时的喂入口；非法（未知请求/逆序/坏形状）返回 null 不喂 gate。 */
  acceptAck(requestId: string, sequence: number): ChatRenderAck | null
  /** 播放队列消费（P3B-18 组合根注入 queue）。 */
  readonly gate: ChatRenderAckGateInternal
  /** 有界性：当前已发出且仍被跟踪的 request 数。 */
  readonly issuedRequestCount: number
}

export function createChatRenderAckTracker(deps?: {
  /** 有界发出请求 LRU 上限（默认 8：当前轮 + 前后各几轮，覆盖终局后迟到的尾段 ack）。 */
  maxIssuedRequests?: number
  gate?: ChatRenderAckGateInternal
}): ChatRenderAckTracker {
  const maxIssued = deps?.maxIssuedRequests ?? 8
  const gate = deps?.gate ?? createChatRenderAckGate({ maxTrackedRequests: maxIssued })
  const issued = new Set<string>()

  function forgetIssued(requestId: string): void {
    issued.delete(requestId)
    gate.forget(requestId)
  }

  return {
    gate,
    get issuedRequestCount() {
      return issued.size
    },
    noteRequestIssued(requestId) {
      if (requestId.length === 0 || requestId.length > 128) return
      if (issued.has(requestId)) return
      issued.add(requestId)
      while (issued.size > maxIssued) {
        const oldest = issued.keys().next().value
        if (oldest === undefined) break
        forgetIssued(oldest)
      }
    },
    acceptAck(requestId, sequence) {
      if (!issued.has(requestId)) return null // 未知/已被 LRU 淘汰的旧请求
      return gate.observeAck(requestId, sequence) // 逆序/重复/坏形状 → null
    }
  }
}
