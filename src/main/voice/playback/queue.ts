// src/main/voice/playback/queue.ts
// P3B-08 / F5-007 §1.13/§1.14/§1.15：turn 播放队列与失败回退。
//
// 消费 controller 的 onSegmentReady（ReadyTtsSegment，含 chatSequence 锚点与 gap 提示），
// 经 StageAudioPort 按绝对 credit 协议逐帧发给 stage，事件回报映射回
// reportPlaybackStarted/Ended/Degraded（组合根 P3B-18 做这层映射）。
//
// 顺序铁律（§1.5/§1.14，验收 C22）：
//   - segment 可以先合成，但 stage playback 必须等 ack.sequence >= segment.chatSequenceEnd；
//     ack 超时/renderer 不可用 -> 本轮 text-only，绝不让声音跑在对应文字前面。
//   - 新 segment 只在前一段 ended 后播放；gap 从上一段边界类型映射（§1.15），
//     自我纠正段用 controller 给的 suggestedGapMs（0-80ms）覆盖。
//   - started 才算 playing（PCM ready 不等于用户已听见）。
//
// 失败回退（§1.13，验收 P3B-08：连接断开/首段失败/余段失败/用户取消均有确定状态）：
//   - host 消失（port 关闭/credit 饿死/watchdog）-> playback-host-unavailable：
//     当前段失败、剩余取消、onHostUnavailable 通知组合根（后续 turn 也 text-only，
//     恢复只从下一 turn 发声，不补播旧回复）。
//   - stage error(unsupported-format) -> unsupported-format；其他 code -> host 级。
//   - PCM 超界（单段/单轮）-> queue-overflow 软停：停止继续合成，但已 ready 的继续播
//     （§1.10.2「不丢已 ready 音频」）。
//   - 用户取消/barge-in：cancel() 发 port cancel（stage 同步停 + 口型释放），幂等。
//
// 文字永远不受影响：本模块只处理声音通道，任何失败都退文字、绝不换音色。

import type { Logger } from '@shared/observability/types'
import type { PlaybackDegradedReason, ReadyTtsSegment } from '../tts/early-controller'
import type { SegmentBoundaryKind } from '../tts/segmenter'
import { pcmDurationMs } from './audio-port'
import type { StageToMainAudioMessage } from '@shared/voice/playback-types'
import type {
  ChatRenderAckGate,
  OutboundAudioFrame,
  PlaybackQueueCallbacks,
  StageAudioPort,
  TurnPlaybackQueue
} from './types'

export interface PlaybackQueuePolicy {
  /** 单帧 PCM 字节上限（发送侧切帧粒度；协议硬上限在 shared playback-types）。 */
  readonly maxFrameBytes: number
  /** 单段 PCM 字节上限（§1.10.2）。 */
  readonly maxSegmentPcmBytes: number
  /** 单轮累计 PCM 字节上限（§1.10.2 安全阀；超限余段纯文字）。 */
  readonly maxTurnPcmBytes: number
  /** paint ack 等待上限；超时本轮 text-only（C22）。 */
  readonly ackTimeoutMs: number
  /** credit 等待上限；饿死视作 host 故障。 */
  readonly creditWaitTimeoutMs: number
  /** watchdog：首个 frame 发出后等待 ended 的预算下限/上限/富余。 */
  readonly watchdogSlackMs: number
  readonly watchdogMinMs: number
  readonly watchdogMaxMs: number
}

/**
 * 内部冻结常量（F5-007 §3.2：实验参数不进 config，真实数据说话后再调）。
 * frame 24KB = 250ms@24kHz f32；段上限 15s、轮上限 120s 为 §1.10.2 示例量级的安全阀。
 */
export const PLAYBACK_QUEUE_POLICY_V1: Readonly<PlaybackQueuePolicy> = Object.freeze({
  maxFrameBytes: 24_000,
  maxSegmentPcmBytes: 1_440_000,
  maxTurnPcmBytes: 11_520_000,
  ackTimeoutMs: 2_500,
  creditWaitTimeoutMs: 15_000,
  watchdogSlackMs: 5_000,
  watchdogMinMs: 5_000,
  watchdogMaxMs: 30_000
})

/**
 * §1.15 标点到停顿映射（文档只给区间，这里取区间内固定值）：
 * 上一段以何种边界结束，决定下一段开始前的停顿。
 */
export function gapMsForBoundary(boundary: SegmentBoundaryKind): number {
  switch (boundary) {
    case 'strong-punctuation':
      return 140 // 。/！/？/；通用：100-180 / 120-220 / 80-150 的公共区间
    case 'ellipsis':
      return 250 // ……/...：180-320
    case 'newline':
      return 170 // 换行：120-220
    case 'soft-timeout':
      return 60 // ，/、软切：40-90
    case 'hard-limit':
      return 40 // 非语义切点：20-60
    case 'stream-end':
      return 140 // 文档未列；尾段后按句末处理
  }
}

type QueueState = 'running' | 'draining' | 'degraded' | 'cancelled' | 'disposed'

type SegmentCause =
  | 'ended'
  | 'stage-error'
  | 'watchdog'
  | 'port-closed'
  | 'credit-timeout'
  | 'frame-too-large'
  | 'stage-cancelled'
  | 'aborted'

interface SegmentResult {
  readonly cause: SegmentCause
  readonly code?: string
}

class AckWaitTimeoutError extends Error {
  constructor() {
    super('playback-queue-ack-timeout')
    this.name = 'AckWaitTimeoutError'
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

function isForgottenAck(err: unknown): boolean {
  return err instanceof Error && err.name === 'AckGateForgottenError'
}

export function createTurnPlaybackQueue(deps: {
  turnId: string
  requestId: string
  /** 播放侧音量（F5-007 §1.14：volume 归播放侧，PCM 不预乘）。 */
  volume: number
  port: StageAudioPort
  ackGate: ChatRenderAckGate
  callbacks: PlaybackQueueCallbacks
  logger: Logger
  now?: () => number
  policy?: PlaybackQueuePolicy
}): TurnPlaybackQueue {
  const { turnId, requestId, volume, port, ackGate, callbacks, logger } = deps
  const now = deps.now ?? Date.now
  const policy = deps.policy ?? PLAYBACK_QUEUE_POLICY_V1

  let queueState: QueueState = 'running'
  const pending: ReadyTtsSegment[] = []
  const takeWaiters: Array<(segment: ReadyTtsSegment | null) => void> = []
  const creditWakers: Array<() => void> = []
  const abortController = new AbortController()

  let current: {
    segment: ReadyTtsSegment
    paintedAt: number
    startedReported: boolean
    resolve: ((result: SegmentResult) => void) | null
    promise: Promise<SegmentResult>
  } | null = null

  let watchdogTimer: ReturnType<typeof setTimeout> | null = null
  let watchdogArmed = false
  let prevEndedAt: number | null = null
  let prevBoundary: SegmentBoundaryKind | null = null
  let turnBytesAccepted = 0
  let lastEnqueuedSequence: number | null = null
  let queuedSegments = 0
  let queueHighWater = 0
  let degradedNotified = false
  let hostNotified = false

  function logWarn(msg: string, fields: Record<string, unknown>): void {
    try {
      logger.warn(msg, { scope: 'tts', turnId, ...fields })
    } catch {
      /* logger 抛错不影响播放队列（C15） */
    }
  }

  function observeEnqueuedSegment(): void {
    // 先计数再交给等待中的 consumer，避免同一 tick 连续 enqueue 时被 Promise 微任务窗口低估。
    queuedSegments += 1
    queueHighWater = Math.max(queueHighWater, queuedSegments)
  }

  // ── take/credit 等待与唤醒 ──

  function takeNext(): Promise<ReadyTtsSegment | null> {
    if (pending.length > 0) return Promise.resolve(pending.shift()!)
    return new Promise((resolve) => takeWaiters.push(resolve))
  }

  function wakeTaker(): void {
    const waiter = takeWaiters.shift()
    if (waiter === undefined) return
    waiter(pending.shift() ?? null)
  }

  function flushTakers(): void {
    for (const waiter of takeWaiters.splice(0)) waiter(null)
  }

  function waitForCredit(bytes: number, deadline: number): Promise<'ok' | 'timeout' | 'aborted'> {
    if (port.capacityBytes !== null && port.availableBytes >= bytes) {
      return Promise.resolve('ok')
    }
    return new Promise((resolve) => {
      let settled = false
      const waker = (): void => {
        if (settled) return
        if (port.capacityBytes !== null && port.availableBytes >= bytes) finish('ok')
      }
      const onAbort = (): void => finish('aborted')
      const timer = setTimeout(() => finish('timeout'), Math.max(0, deadline - now()))
      function finish(value: 'ok' | 'timeout' | 'aborted'): void {
        if (settled) return
        settled = true
        clearTimeout(timer)
        abortController.signal.removeEventListener('abort', onAbort)
        const index = creditWakers.indexOf(waker)
        if (index >= 0) creditWakers.splice(index, 1)
        resolve(value)
      }
      creditWakers.push(waker)
      if (abortController.signal.aborted) {
        finish('aborted')
        return
      }
      abortController.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  function wakeCreditWakers(): void {
    for (const waker of [...creditWakers]) waker()
  }

  // ── 当前段 deferred / watchdog ──

  function beginCurrent(segment: ReadyTtsSegment, paintedAt: number): void {
    let resolveRef!: (result: SegmentResult) => void
    const promise = new Promise<SegmentResult>((resolve) => {
      resolveRef = resolve
    })
    current = { segment, paintedAt, startedReported: false, resolve: resolveRef, promise }
  }

  /** 幂等：一个段恰好一个终态；迟到事件（重复 ended 等）自然丢弃。 */
  function resolveCurrent(result: SegmentResult): void {
    if (current === null || current.resolve === null) return
    const resolve = current.resolve
    current.resolve = null
    resolve(result)
  }

  function isCurrentResolved(): boolean {
    return current === null || current.resolve === null
  }

  function clearWatchdog(): void {
    if (watchdogTimer !== null) {
      clearTimeout(watchdogTimer)
      watchdogTimer = null
    }
  }

  function armWatchdog(segment: ReadyTtsSegment): void {
    if (watchdogArmed) return
    watchdogArmed = true
    const expectedMs = pcmDurationMs(segment.pcm, segment.format)
    const ms = Math.min(
      Math.max(expectedMs + policy.watchdogSlackMs, policy.watchdogMinMs),
      policy.watchdogMaxMs
    )
    watchdogTimer = setTimeout(() => {
      watchdogTimer = null
      resolveCurrent({ cause: 'watchdog' })
    }, ms)
  }

  // ── 降级 ──

  /**
   * 降级通知（onTurnDegraded 恰好一次）。
   * queue-overflow 走软停：停止接新段（controller 软停后最多还有 in-flight 一个），
   * 已 pending 的继续播（§1.10.2 不丢已 ready 音频）。
   * 其余原因硬停：剩余取消；playback-host-unavailable 额外通知 onHostUnavailable
   * （§1.14：后续 turn 也 text-only，直到 host 恢复）。
   */
  function notifyDegraded(reason: PlaybackDegradedReason): void {
    if (queueState === 'cancelled' || queueState === 'disposed') return
    if (reason === 'queue-overflow') {
      if (queueState === 'running') queueState = 'draining'
      if (!degradedNotified) {
        degradedNotified = true
        callbacks.onTurnDegraded(reason)
      }
      return
    }
    hardStop(reason, reason === 'playback-host-unavailable')
  }

  /** 硬停：本地全停（当前段的终态回报由调用侧先 resolveCurrent 完成）。幂等。 */
  function hardStop(reason: PlaybackDegradedReason, hostLevel: boolean): void {
    if (queueState !== 'running' && queueState !== 'draining') return
    queueState = 'degraded'
    abortController.abort()
    resolveCurrent({ cause: 'aborted' }) // 防御：未收尾的段立刻释放等待
    clearWatchdog()
    pending.length = 0
    flushTakers()
    wakeCreditWakers()
    if (!degradedNotified) {
      degradedNotified = true
      callbacks.onTurnDegraded(reason)
    }
    if (hostLevel && !hostNotified) {
      hostNotified = true
      callbacks.onHostUnavailable?.()
    }
  }

  // ── port 入站路由 ──

  function handlePortMessage(message: StageToMainAudioMessage): void {
    if (message.type === 'credit') {
      wakeCreditWakers()
      return
    }
    if (queueState === 'cancelled' || queueState === 'disposed') return
    const cur = current
    switch (message.type) {
      case 'started': {
        if (cur !== null && message.segmentId === cur.segment.segmentId && !cur.startedReported) {
          cur.startedReported = true
          callbacks.onSegmentStarted(message.segmentId)
          callbacks.onPaintToAudioOffset?.(message.audioStartAt - cur.paintedAt)
        }
        return
      }
      case 'ended': {
        if (cur !== null && message.segmentId === cur.segment.segmentId) {
          resolveCurrent({ cause: 'ended' })
        }
        return
      }
      case 'error': {
        if (message.segmentId === undefined) {
          // host 级错误：当前段一并失败（否则 frame 循环会挂着等 ended）
          if (cur !== null) resolveCurrent({ cause: 'stage-error', code: message.code })
          hardStop('playback-host-unavailable', true)
          return
        }
        if (cur !== null && message.segmentId === cur.segment.segmentId) {
          resolveCurrent({ cause: 'stage-error', code: message.code })
        }
        return // 迟到/未知 segment 的错误：丢弃
      }
      case 'cancelled': {
        // 自发取消（设备切换/AudioContext suspended 等）：当前轮 text-only（§边界条件）
        if (
          cur !== null &&
          (message.segmentId === undefined || message.segmentId === cur.segment.segmentId)
        ) {
          resolveCurrent({ cause: 'stage-cancelled' })
          return
        }
        if (cur !== null) resolveCurrent({ cause: 'stage-cancelled' })
        hardStop('playback-host-unavailable', true)
      }
    }
  }

  function handlePortClosed(): void {
    if (queueState === 'cancelled' || queueState === 'disposed') {
      flushTakers()
      wakeCreditWakers()
      return
    }
    resolveCurrent({ cause: 'port-closed' })
    hardStop('playback-host-unavailable', true)
  }

  // ── 发送 ──

  async function sendFrameWithCredit(
    segment: ReadyTtsSegment,
    frameIndex: number,
    pcm: ArrayBuffer,
    finalFrame: boolean
  ): Promise<boolean> {
    const frame: OutboundAudioFrame = {
      turnId,
      segmentId: segment.segmentId,
      sequence: segment.sequence,
      frameIndex,
      format: segment.format,
      pcm,
      finalFrame,
      volume
    }
    const deadline = now() + policy.creditWaitTimeoutMs
    for (;;) {
      const result = port.sendFrame(frame)
      if (result === 'sent') {
        armWatchdog(segment)
        return true
      }
      if (result === 'closed') {
        // onClosed 已走 hardStop；此处保证本段尽快收尾
        resolveCurrent({ cause: 'port-closed' })
        return false
      }
      if (result === 'frame-too-large') {
        resolveCurrent({ cause: 'frame-too-large' })
        return false
      }
      if (queueState !== 'running' && queueState !== 'draining') return false
      // 'no-credit'：等 stage 真正释放容量后重试（C20 无 credit 不发送）
      const wait = await waitForCredit(pcm.byteLength, deadline)
      if (wait === 'timeout') {
        resolveCurrent({ cause: 'credit-timeout' })
        return false
      }
      if (wait === 'aborted') return false
    }
  }

  // ── 单段播放 ──

  async function playSegment(segment: ReadyTtsSegment): Promise<boolean> {
    const segBytes = segment.pcm.byteLength

    // 单段超界：这段不播（它本身就是超界的体现），软停其余合成
    if (segBytes > policy.maxSegmentPcmBytes) {
      callbacks.onSegmentEnded(segment.segmentId, false)
      notifyDegraded('queue-overflow')
      return true
    }
    // 单轮累计超界：软停合成；本段已 ready，照播（§1.10.2 不丢已 ready 音频）
    if (turnBytesAccepted + segBytes > policy.maxTurnPcmBytes) {
      notifyDegraded('queue-overflow')
    }
    turnBytesAccepted += segBytes

    // paint ack：声音绝不先于对应文字（C22）
    const ackPromise = Promise.resolve(
      ackGate.waitForPainted(requestId, segment.chatSequenceEnd, abortController.signal)
    )
    void ackPromise.catch(() => {}) // 输掉竞速后的迟到拒绝不许变 unhandled
    let ackTimer: ReturnType<typeof setTimeout> | null = null
    const ackTimeoutPromise = new Promise<never>((_, reject) => {
      ackTimer = setTimeout(() => reject(new AckWaitTimeoutError()), policy.ackTimeoutMs)
    })
    void ackTimeoutPromise.catch(() => {})
    let paintedAt: number
    try {
      const ack = await Promise.race([ackPromise, ackTimeoutPromise])
      paintedAt = ack.paintedAt
    } catch (err) {
      if (isAbortError(err) || isForgottenAck(err)) return false // 取消/请求已遗忘：静默退出
      logWarn('playback queue: paint ack not observed in time; turn text-only', {
        metrics: { ackTimeoutMs: policy.ackTimeoutMs, chatSequenceEnd: segment.chatSequenceEnd }
      })
      notifyDegraded('chat-render-ack-timeout')
      return false
    } finally {
      if (ackTimer !== null) clearTimeout(ackTimer)
    }
    if (queueState !== 'running' && queueState !== 'draining') return false

    // gap 调度：上一段结束后按其边界停顿；自我纠正段用 suggestedGapMs（§1.14/§1.15）
    const gapMs =
      segment.correctionRole === 'self-correction' && segment.suggestedGapMs > 0
        ? segment.suggestedGapMs
        : prevBoundary === null
          ? 0
          : gapMsForBoundary(prevBoundary)
    if (gapMs > 0 && prevEndedAt !== null) {
      const delay = prevEndedAt + gapMs - now()
      if (delay > 0 && !(await sleepAbortable(delay, abortController.signal))) return false
    }

    watchdogArmed = false
    beginCurrent(segment, paintedAt)
    const active = current
    if (active === null) return false // 仅满足 TS：beginCurrent 必然赋值
    const frames = chunkFrames(segment.pcm, policy.maxFrameBytes)
    for (const frame of frames) {
      if (isCurrentResolved()) break // 终态已到（ended/error 提前到）
      const sent = await sendFrameWithCredit(segment, frame.frameIndex, frame.pcm, frame.finalFrame)
      if (!sent) break
    }

    const result = await active.promise
    current = null
    clearWatchdog()
    const segmentId = segment.segmentId

    switch (result.cause) {
      case 'ended': {
        callbacks.onSegmentEnded(segmentId, true)
        prevEndedAt = now()
        prevBoundary = segment.boundary
        return true
      }
      case 'stage-error': {
        callbacks.onSegmentEnded(segmentId, false)
        notifyDegraded(
          result.code === 'unsupported-format' ? 'unsupported-format' : 'playback-host-unavailable'
        )
        return false
      }
      case 'watchdog':
      case 'credit-timeout': {
        callbacks.onSegmentEnded(segmentId, false)
        notifyDegraded('playback-host-unavailable')
        return false
      }
      case 'port-closed': {
        callbacks.onSegmentEnded(segmentId, false)
        return false // hardStop 已通知降级与 host 不可用
      }
      case 'frame-too-large': {
        callbacks.onSegmentEnded(segmentId, false)
        notifyDegraded('queue-overflow')
        return true // 软停：已 ready 的其余段继续
      }
      case 'stage-cancelled': {
        callbacks.onSegmentEnded(segmentId, false)
        notifyDegraded('playback-host-unavailable')
        return false
      }
      case 'aborted': {
        return false // cancel/dispose/hardStop：controller 侧已置终态，不重复回报
      }
    }
  }

  // ── 主循环 ──

  async function runLoop(): Promise<void> {
    for (;;) {
      if (queueState !== 'running' && queueState !== 'draining') return
      const segment = await takeNext()
      if (segment === null) return
      let keepGoing: boolean
      try {
        keepGoing = await playSegment(segment)
      } catch (err) {
        // 内部异常防御：声音通道整体退文字，异常不得逃逸成 unhandled
        logWarn('playback queue internal error; audio off for remainder', {
          detail: err instanceof Error ? err.message : String(err)
        })
        resolveCurrent({ cause: 'aborted' })
        notifyDegraded('playback-host-unavailable')
        return
      } finally {
        queuedSegments = Math.max(0, queuedSegments - 1)
      }
      if (!keepGoing) return
    }
  }

  const unsubscribeMessage = port.onMessage(handlePortMessage)
  const unsubscribeClosed = port.onClosed(handlePortClosed)
  void runLoop()

  return {
    enqueue(segment) {
      if (queueState === 'cancelled' || queueState === 'disposed') return
      if (queueState === 'degraded') {
        // 硬降级后到达（防御：controller 降级后不应再送）；按失败封账
        callbacks.onSegmentEnded(segment.segmentId, false)
        return
      }
      if (lastEnqueuedSequence !== null && segment.sequence !== lastEnqueuedSequence + 1) {
        // controller 是唯一 writer 且合成并发 1，乱序=内部 bug：拒收该段并记录，
        // 不中断整轮（文字流不受影响；后续段按各自到达顺序继续）
        logWarn('playback queue: out-of-order segment rejected', {
          metrics: { expected: lastEnqueuedSequence + 1, got: segment.sequence }
        })
        callbacks.onSegmentEnded(segment.segmentId, false)
        return
      }
      lastEnqueuedSequence = segment.sequence
      observeEnqueuedSegment()
      pending.push(segment)
      wakeTaker()
    },

    highWaterMark: () => queueHighWater,

    cancel(reason) {
      if (queueState === 'cancelled' || queueState === 'disposed') return
      queueState = 'cancelled'
      abortController.abort()
      resolveCurrent({ cause: 'aborted' })
      clearWatchdog()
      pending.length = 0
      flushTakers()
      wakeCreditWakers()
      unsubscribeMessage()
      unsubscribeClosed()
      // stage 必须同步停 source、清队列、触发口型释放（§1.14）
      if (port.isAlive) port.sendCancel(reason)
    },

    dispose() {
      if (queueState === 'disposed') return
      const stillActive = !isCurrentResolved()
      queueState = 'disposed'
      abortController.abort()
      resolveCurrent({ cause: 'aborted' })
      clearWatchdog()
      pending.length = 0
      flushTakers()
      wakeCreditWakers()
      unsubscribeMessage()
      unsubscribeClosed()
      // 正常 teardown 不发 cancel（§1.16 dispose 只清资源）；防御：异常收尾时仍在播则停声
      if (stillActive && port.isAlive) port.sendCancel('app-quit')
    }
  }
}

/** f32 PCM 切有界帧；pcm.slice 保证每帧独立 buffer（端口传输不共享底层）。 */
function chunkFrames(
  pcm: Float32Array,
  maxFrameBytes: number
): Array<{ frameIndex: number; pcm: ArrayBuffer; finalFrame: boolean }> {
  const samplesPerFrame = Math.max(1, Math.floor(maxFrameBytes / 4))
  const count = Math.ceil(pcm.length / samplesPerFrame)
  const frames: Array<{ frameIndex: number; pcm: ArrayBuffer; finalFrame: boolean }> = []
  for (let i = 0; i < count; i++) {
    const start = i * samplesPerFrame
    const end = Math.min(pcm.length, start + samplesPerFrame)
    const copy = pcm.slice(start, end)
    frames.push({ frameIndex: i, pcm: copy.buffer, finalFrame: i === count - 1 })
  }
  return frames
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false)
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
