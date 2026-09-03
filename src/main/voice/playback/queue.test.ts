// src/main/voice/playback/queue.test.ts
// P3B-08：turn 播放队列合同。
// 验收映射：C09（用户取消全链取消）/ C20（credit 背压经 audio-port.test 另测）/
// C22（audio 等 chat paint ack，超时 text-only）/ P3B-08 行（连接断开/首段失败/余段
// 失败/用户取消均有确定状态）。S-004：静音 buffer mock，不真发声。

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { Logger } from '@shared/observability/types'
import type {
  BoundTtsProvider,
  TtsCancelReason,
  TtsSynthesisOptions
} from '@shared/voice/tts-types'
import { createEarlyTtsController, type ReadyTtsSegment } from '../tts/early-controller'
import type { StageToMainAudioMessage } from '@shared/voice/playback-types'
import { createTurnPlaybackQueue, gapMsForBoundary, type PlaybackQueuePolicy } from './queue'
import type {
  ChatRenderAck,
  ChatRenderAckGate,
  OutboundAudioFrame,
  SendFrameResult,
  StageAudioPort,
  TurnPlaybackQueue
} from './types'

function noopLogger(): Logger {
  const l: Logger = {
    fatal() {
      /* noop */
    },
    error() {
      /* noop */
    },
    warn() {
      /* noop */
    },
    info() {
      /* noop */
    },
    debug() {
      /* noop */
    },
    child: () => l
  }
  return l
}

const TINY_POLICY: PlaybackQueuePolicy = {
  maxFrameBytes: 400,
  maxSegmentPcmBytes: 4_000,
  maxTurnPcmBytes: 8_000,
  ackTimeoutMs: 80,
  creditWaitTimeoutMs: 90,
  watchdogSlackMs: 20,
  watchdogMinMs: 60,
  watchdogMaxMs: 120
}

// ── 假 stage port（协议细节由 audio-port.test 覆盖；这里只做可控行为） ──

interface FakeStagePort {
  port: StageAudioPort
  sentFrames: OutboundAudioFrame[]
  sentCancels: TtsCancelReason[]
  disposeSent: boolean
  emitCredit(sequence: number, availableBytes: number, capacityBytes?: number): void
  emitStarted(segmentId: string, audioStartAt?: number): void
  emitEnded(segmentId: string): void
  emitError(code: string, segmentId?: string): void
  emitCancelled(reason: TtsCancelReason, segmentId?: string): void
  closePort(): void
}

function makeFakeStagePort(options?: { autoStage?: boolean }): FakeStagePort {
  const sentFrames: OutboundAudioFrame[] = []
  const sentCancels: TtsCancelReason[] = []
  const state = {
    capacity: null as number | null,
    available: 0,
    closed: false,
    disposeSent: false
  }
  const messageHandlers: Array<(message: StageToMainAudioMessage) => void> = []
  const closedHandlers: Array<() => void> = []
  let generationSeq = 0

  function emit(message: StageToMainAudioMessage): void {
    for (const handler of [...messageHandlers]) handler(message)
  }

  const port: StageAudioPort = {
    generation: 'g1',
    get isAlive() {
      return !state.closed
    },
    get capacityBytes() {
      return state.capacity
    },
    get availableBytes() {
      return state.available
    },
    get protocolErrors() {
      return 0
    },
    sendFrame(frame): SendFrameResult {
      if (state.closed) return 'closed'
      const capacity = state.capacity
      const bytes = frame.pcm.byteLength
      if (capacity !== null && bytes > capacity) return 'frame-too-large'
      if (capacity === null || state.available < bytes) return 'no-credit'
      state.available -= bytes
      sentFrames.push(frame)
      if (options?.autoStage === true) {
        if (frame.frameIndex === 0)
          emit({ type: 'started', generation: 'g1', segmentId: frame.segmentId, audioStartAt: 1 })
        if (frame.finalFrame) {
          emit({ type: 'ended', generation: 'g1', segmentId: frame.segmentId, playedMs: 10 })
          // stage 释放全部 frame 容量：绝对 credit 回满
          generationSeq += 1
          state.available = capacity
          emit({
            type: 'credit',
            generation: 'g1',
            capacityBytes: capacity,
            availableBytes: state.available,
            creditSequence: generationSeq
          })
        }
      }
      return 'sent'
    },
    sendCancel(reason) {
      if (!state.closed) sentCancels.push(reason)
    },
    sendDispose() {
      state.disposeSent = true
    },
    close() {
      if (!state.closed) {
        state.closed = true
        for (const handler of [...closedHandlers]) handler()
      }
    },
    onMessage(handler) {
      messageHandlers.push(handler)
      return () => {
        const index = messageHandlers.indexOf(handler)
        if (index >= 0) messageHandlers.splice(index, 1)
      }
    },
    onClosed(handler) {
      closedHandlers.push(handler)
      return () => {
        const index = closedHandlers.indexOf(handler)
        if (index >= 0) closedHandlers.splice(index, 1)
      }
    }
  }

  return {
    port,
    sentFrames,
    sentCancels,
    get disposeSent() {
      return state.disposeSent
    },
    emitCredit(sequence, availableBytes, capacityBytes) {
      const capacity = capacityBytes ?? state.capacity ?? 100_000
      state.capacity = capacity
      state.available = Math.min(availableBytes, capacity)
      emit({
        type: 'credit',
        generation: 'g1',
        capacityBytes: capacity,
        availableBytes: state.available,
        creditSequence: sequence
      })
    },
    emitStarted(segmentId, audioStartAt = 1) {
      emit({ type: 'started', generation: 'g1', segmentId, audioStartAt })
    },
    emitEnded(segmentId) {
      emit({ type: 'ended', generation: 'g1', segmentId, playedMs: 10 })
      const capacity = state.capacity
      if (capacity !== null) {
        state.available = capacity
        generationSeq += 1
        emit({
          type: 'credit',
          generation: 'g1',
          capacityBytes: capacity,
          availableBytes: state.available,
          creditSequence: generationSeq
        })
      }
    },
    emitError(code, segmentId) {
      emit(
        segmentId === undefined
          ? { type: 'error', generation: 'g1', code }
          : { type: 'error', generation: 'g1', segmentId, code }
      )
    },
    emitCancelled(reason, segmentId) {
      emit(
        segmentId === undefined
          ? { type: 'cancelled', generation: 'g1', reason }
          : { type: 'cancelled', generation: 'g1', segmentId, reason }
      )
    },
    closePort() {
      port.close()
    }
  }
}

// ── 假 ack gate ──

interface FakeAckGate {
  gate: ChatRenderAckGate
  paint(requestId: string, sequence: number): void
  waits: Array<{ requestId: string; sequence: number }>
}

function makeFakeAckGate(): FakeAckGate {
  const painted = new Map<string, number>()
  const pendingWaiters: Array<{
    requestId: string
    sequence: number
    resolve: (ack: ChatRenderAck) => void
    reject: (err: Error) => void
    onAbort: () => void
  }> = []
  const waits: Array<{ requestId: string; sequence: number }> = []
  const gate: ChatRenderAckGate = {
    waitForPainted(requestId, sequence, signal) {
      const current = painted.get(requestId)
      if (current !== undefined && current >= sequence) {
        return Promise.resolve({ requestId, sequence: current, paintedAt: 1 })
      }
      if (signal.aborted) {
        return Promise.reject(new DOMException('Aborted', 'AbortError'))
      }
      waits.push({ requestId, sequence })
      return new Promise<ChatRenderAck>((resolve, reject) => {
        const waiter = {
          requestId,
          sequence,
          resolve,
          reject,
          onAbort: () => reject(new DOMException('Aborted', 'AbortError'))
        }
        pendingWaiters.push(waiter)
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      })
    }
  }
  function paint(requestId: string, sequence: number): void {
    painted.set(requestId, sequence)
    for (const waiter of [...pendingWaiters]) {
      if (waiter.requestId === requestId && sequence >= waiter.sequence) {
        pendingWaiters.splice(pendingWaiters.indexOf(waiter), 1)
        const index = waits.findIndex(
          (w) => w.requestId === requestId && w.sequence === waiter.sequence
        )
        if (index >= 0) waits.splice(index, 1)
        waiter.resolve({ requestId, sequence, paintedAt: 1 })
      }
    }
  }
  return { gate, paint, waits }
}

// ── harness ──

interface QueueHarness {
  queue: TurnPlaybackQueue
  port: FakeStagePort
  ack: FakeAckGate
  started: string[]
  paintToAudioOffsets: number[]
  ended: Array<{ segmentId: string; ok: boolean }>
  degraded: string[]
  hostUnavailable: number
}

function makeQueue(opts?: {
  policy?: Partial<PlaybackQueuePolicy>
  autoStage?: boolean
  prePaint?: boolean
}): QueueHarness {
  const port = makeFakeStagePort({ autoStage: opts?.autoStage })
  const ack = makeFakeAckGate()
  if (opts?.prePaint !== false) ack.paint('req-1', 100)
  const started: string[] = []
  const paintToAudioOffsets: number[] = []
  const ended: Array<{ segmentId: string; ok: boolean }> = []
  const degraded: string[] = []
  const hostUnavailable = { count: 0 }
  const queue = createTurnPlaybackQueue({
    turnId: 'turn-1',
    requestId: 'req-1',
    volume: 1,
    port: port.port,
    ackGate: ack.gate,
    logger: noopLogger(),
    policy: { ...TINY_POLICY, ...opts?.policy },
    callbacks: {
      onSegmentStarted: (id) => started.push(id),
      onPaintToAudioOffset: (offsetMs) => paintToAudioOffsets.push(offsetMs),
      onSegmentEnded: (id, ok) => ended.push({ segmentId: id, ok }),
      onTurnDegraded: (reason) => degraded.push(reason),
      onHostUnavailable: () => {
        hostUnavailable.count += 1
      }
    }
  })
  return {
    queue,
    port,
    ack,
    started,
    paintToAudioOffsets,
    ended,
    degraded,
    get hostUnavailable() {
      return hostUnavailable.count
    }
  }
}

function makeSegment(
  sequence: number,
  opts?: {
    samples?: number
    boundary?: ReadyTtsSegment['boundary']
    chatSequenceEnd?: number
    correctionRole?: 'none' | 'self-correction'
    suggestedGapMs?: number
  }
): ReadyTtsSegment {
  return {
    segmentId: `turn-1:tts:${sequence}`,
    sequence,
    pcm: new Float32Array(opts?.samples ?? 100), // 100 samples = 400 bytes f32
    format: { sampleRate: 24_000, channels: 1, sampleFormat: 'f32le', interleaved: true },
    boundary: opts?.boundary ?? 'strong-punctuation',
    chatSequenceStart: 1,
    chatSequenceEnd: opts?.chatSequenceEnd ?? 1,
    correctionRole: opts?.correctionRole ?? 'none',
    suggestedGapMs: opts?.suggestedGapMs ?? 0
  }
}

const flush = (ticks = 4): Promise<void> =>
  new Promise<void>((resolve) => {
    void (async () => {
      for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 0))
      resolve()
    })()
  })

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout')
    await sleep(5)
  }
}

// ── gap 纯函数 ──

describe('gapMsForBoundary（§1.15 区间内取值）', () => {
  it('各边界落在文档区间', () => {
    expect(gapMsForBoundary('strong-punctuation')).toBeGreaterThanOrEqual(80)
    expect(gapMsForBoundary('strong-punctuation')).toBeLessThanOrEqual(180)
    expect(gapMsForBoundary('ellipsis')).toBeGreaterThanOrEqual(180)
    expect(gapMsForBoundary('ellipsis')).toBeLessThanOrEqual(320)
    expect(gapMsForBoundary('newline')).toBeGreaterThanOrEqual(120)
    expect(gapMsForBoundary('newline')).toBeLessThanOrEqual(220)
    expect(gapMsForBoundary('soft-timeout')).toBeGreaterThanOrEqual(40)
    expect(gapMsForBoundary('soft-timeout')).toBeLessThanOrEqual(90)
    expect(gapMsForBoundary('hard-limit')).toBeGreaterThanOrEqual(20)
    expect(gapMsForBoundary('hard-limit')).toBeLessThanOrEqual(60)
  })
})

// ── 队列行为 ──

describe('P3B-08 播放队列：正常链路', () => {
  it('单段经 credit 发帧；started/ended 回报；线格式 frame 递增', async () => {
    const h = makeQueue({ autoStage: true })
    h.port.emitCredit(0, 100_000)
    h.queue.enqueue(makeSegment(0))
    await waitFor(() => h.ended.length === 1)

    expect(h.port.sentFrames).toHaveLength(1)
    expect(h.port.sentFrames[0]!.frameIndex).toBe(0)
    expect(h.port.sentFrames[0]!.finalFrame).toBe(true)
    expect(h.port.sentFrames[0]!.segmentId).toBe('turn-1:tts:0')
    expect(h.port.sentFrames[0]!.volume).toBe(1)
    expect(h.started).toEqual(['turn-1:tts:0'])
    expect(h.ended).toEqual([{ segmentId: 'turn-1:tts:0', ok: true }])
    expect(h.degraded).toEqual([])
  })

  it('超帧 PCM 切多帧：frameIndex 连续、仅末帧 finalFrame', async () => {
    const h = makeQueue({ autoStage: true })
    h.port.emitCredit(0, 100_000)
    h.queue.enqueue(makeSegment(0, { samples: 250 })) // 1000 bytes / 400 = 3 帧
    await waitFor(() => h.ended.length === 1)
    expect(h.port.sentFrames.map((f) => f.frameIndex)).toEqual([0, 1, 2])
    expect(h.port.sentFrames.map((f) => f.finalFrame)).toEqual([false, false, true])
    expect(h.port.sentFrames.map((f) => f.pcm.byteLength)).toEqual([400, 400, 200])
  })

  it('多段顺序播放：等上一段 ended 后才发下一段帧', async () => {
    const h = makeQueue() // 手动 stage
    h.port.emitCredit(0, 100_000)
    h.queue.enqueue(makeSegment(0))
    h.queue.enqueue(makeSegment(1))
    await flush()
    expect(h.port.sentFrames.map((f) => f.segmentId)).toEqual(['turn-1:tts:0'])

    h.port.emitStarted('turn-1:tts:0')
    h.port.emitEnded('turn-1:tts:0')
    await waitFor(() => h.port.sentFrames.length === 2) // gap 140ms 后第二段帧才发
    expect(h.port.sentFrames.map((f) => f.segmentId)).toEqual(['turn-1:tts:0', 'turn-1:tts:1'])
    h.port.emitEnded('turn-1:tts:1')
    await waitFor(() => h.ended.length === 2)
    expect(h.ended).toEqual([
      { segmentId: 'turn-1:tts:0', ok: true },
      { segmentId: 'turn-1:tts:1', ok: true }
    ])
  })

  it('P3B-21：高水位统计当前段与 pending，且同 tick 连续 enqueue 不低估', async () => {
    const h = makeQueue()
    h.port.emitCredit(0, 100_000)
    expect(h.queue.highWaterMark()).toBe(0)

    h.queue.enqueue(makeSegment(0))
    h.queue.enqueue(makeSegment(1))
    h.queue.enqueue(makeSegment(2))
    expect(h.queue.highWaterMark()).toBe(3)

    await flush()
    h.port.emitEnded('turn-1:tts:0')
    await waitFor(() => h.port.sentFrames.length === 2)
    expect(h.queue.highWaterMark()).toBe(3)
    h.queue.cancel('user-cancel')
  })

  it('P3B-21：回报 chat painted→audio started 的有符号偏差', async () => {
    const h = makeQueue() // fake ack paintedAt=1
    h.port.emitCredit(0, 100_000)
    h.queue.enqueue(makeSegment(0))
    await waitFor(() => h.port.sentFrames.length === 1)

    h.port.emitStarted('turn-1:tts:0', 26)
    expect(h.paintToAudioOffsets).toEqual([25])
    h.port.emitEnded('turn-1:tts:0')
    await waitFor(() => h.ended.length === 1)
  })
})

describe('P3B-08 播放队列：C22 声音不先于文字', () => {
  it('未 paint 的 segment 不发帧；paint 到达后立即发', async () => {
    const h = makeQueue({ prePaint: false })
    h.port.emitCredit(0, 100_000)
    h.queue.enqueue(makeSegment(0, { chatSequenceEnd: 7 }))
    await flush()
    expect(h.port.sentFrames).toHaveLength(0)
    expect(h.ack.waits).toHaveLength(1)
    expect(h.ack.waits[0]!.sequence).toBe(7)

    h.ack.paint('req-1', 7)
    await waitFor(() => h.port.sentFrames.length === 1)
    expect(h.degraded).toEqual([])
  })

  it('ack 超时：本轮 text-only，零帧发出', async () => {
    const h = makeQueue({ prePaint: false })
    h.port.emitCredit(0, 100_000)
    h.queue.enqueue(makeSegment(0, { chatSequenceEnd: 7 }))
    await sleep(150) // policy.ackTimeoutMs = 80
    expect(h.degraded).toEqual(['chat-render-ack-timeout'])
    expect(h.port.sentFrames).toHaveLength(0)
    expect(h.ended).toEqual([]) // 段未开播：由 controller 侧降级取消，不经 ended 回报
    // 降级后到达的新段按失败封账，不再尝试
    h.queue.enqueue(makeSegment(1))
    await flush()
    expect(h.ended).toEqual([{ segmentId: 'turn-1:tts:1', ok: false }])
  })
})

describe('P3B-08 播放队列：C09 取消', () => {
  it('用户取消：发 port cancel、清 pending、幂等、后续 enqueue 忽略', async () => {
    const h = makeQueue()
    h.port.emitCredit(0, 100_000)
    h.queue.enqueue(makeSegment(0))
    h.queue.enqueue(makeSegment(1))
    await flush()
    expect(h.port.sentFrames).toHaveLength(1)

    h.queue.cancel('user-cancel')
    h.queue.cancel('barge-in') // 幂等
    await flush()
    expect(h.port.sentCancels).toEqual(['user-cancel'])
    expect(h.port.sentFrames).toHaveLength(1) // 第二段从未发出
    expect(h.ended).toEqual([]) // 取消路径由 controller.cancel 置终态，队列不重复回报

    h.queue.enqueue(makeSegment(2))
    await flush()
    expect(h.port.sentFrames).toHaveLength(1)
  })
})

describe('P3B-08 播放队列：失败回退（§1.13）', () => {
  it('port 中途关闭：当前段失败、剩余取消、host 通知（连接断开确定状态）', async () => {
    const h = makeQueue()
    h.port.emitCredit(0, 100_000)
    h.queue.enqueue(makeSegment(0))
    h.queue.enqueue(makeSegment(1))
    await flush()
    h.port.closePort()
    await flush()

    expect(h.ended).toEqual([{ segmentId: 'turn-1:tts:0', ok: false }])
    expect(h.degraded).toEqual(['playback-host-unavailable'])
    expect(h.hostUnavailable).toBe(1)
    expect(h.port.sentFrames).toHaveLength(1) // 第二段不再发
  })

  it('stage 报 unsupported-format：该段失败、降级 unsupported-format、不算 host 级', async () => {
    const h = makeQueue()
    h.port.emitCredit(0, 100_000)
    h.queue.enqueue(makeSegment(0))
    await flush()
    h.port.emitError('unsupported-format', 'turn-1:tts:0')
    await waitFor(() => h.degraded.length === 1)

    expect(h.ended).toEqual([{ segmentId: 'turn-1:tts:0', ok: false }])
    expect(h.degraded).toEqual(['unsupported-format'])
    expect(h.hostUnavailable).toBe(0)
  })

  it('stage 报其他错误码：按 host 级处理', async () => {
    const h = makeQueue()
    h.port.emitCredit(0, 100_000)
    h.queue.enqueue(makeSegment(0))
    await flush()
    h.port.emitError('audio-device-gone', 'turn-1:tts:0')
    await waitFor(() => h.degraded.length === 1)

    expect(h.ended).toEqual([{ segmentId: 'turn-1:tts:0', ok: false }])
    expect(h.degraded).toEqual(['playback-host-unavailable'])
    expect(h.hostUnavailable).toBe(1)
  })

  it('stage 无 segmentId 的 host 级错误：当前段一并失败', async () => {
    const h = makeQueue()
    h.port.emitCredit(0, 100_000)
    h.queue.enqueue(makeSegment(0))
    await flush()
    h.port.emitError('stage-crashed')
    await waitFor(() => h.degraded.length === 1)
    expect(h.ended).toEqual([{ segmentId: 'turn-1:tts:0', ok: false }])
    expect(h.degraded).toEqual(['playback-host-unavailable'])
    expect(h.hostUnavailable).toBe(1)
  })

  it('credit 饿死超时：视作 host 故障', async () => {
    const h = makeQueue() // 从不发 credit
    h.queue.enqueue(makeSegment(0))
    await sleep(160) // policy.creditWaitTimeoutMs = 90
    expect(h.port.sentFrames).toHaveLength(0)
    expect(h.degraded).toEqual(['playback-host-unavailable'])
    expect(h.hostUnavailable).toBe(1)
    expect(h.ended).toEqual([{ segmentId: 'turn-1:tts:0', ok: false }])
  })

  it('watchdog：帧已发但 ended 永不到达 -> 有界失败', async () => {
    const h = makeQueue()
    h.port.emitCredit(0, 100_000)
    h.queue.enqueue(makeSegment(0))
    await sleep(140) // watchdogMinMs = 60
    expect(h.degraded).toEqual(['playback-host-unavailable'])
    expect(h.ended).toEqual([{ segmentId: 'turn-1:tts:0', ok: false }])
  })

  it('单段超界：该段不播、软停；已 ready 的后续段照播（不丢已 ready 音频）', async () => {
    const h = makeQueue({ autoStage: true })
    h.port.emitCredit(0, 1_000_000)
    h.queue.enqueue(makeSegment(0, { samples: 1_100 })) // 4400 bytes > maxSegmentPcmBytes
    h.queue.enqueue(makeSegment(1)) // 正常段
    await waitFor(() => h.ended.length === 2)

    expect(h.ended).toEqual([
      { segmentId: 'turn-1:tts:0', ok: false },
      { segmentId: 'turn-1:tts:1', ok: true }
    ])
    expect(h.degraded).toEqual(['queue-overflow'])
    expect(h.port.sentFrames.map((f) => f.segmentId)).toEqual(['turn-1:tts:1'])
  })

  it('单轮累计超界：软停后当前 ready 段仍播完', async () => {
    const h = makeQueue({ autoStage: true, policy: { maxTurnPcmBytes: 700 } })
    h.port.emitCredit(0, 1_000_000)
    h.queue.enqueue(makeSegment(0, { samples: 125 })) // 500 bytes
    h.queue.enqueue(makeSegment(1, { samples: 125 })) // 500+500 > 700 -> 软停但照播
    await waitFor(() => h.ended.length === 2)

    expect(h.ended).toEqual([
      { segmentId: 'turn-1:tts:0', ok: true },
      { segmentId: 'turn-1:tts:1', ok: true }
    ])
    expect(h.degraded).toEqual(['queue-overflow'])
    expect(h.hostUnavailable).toBe(0)
  })

  it('乱序 enqueue（内部 bug 防御）：拒收该段、不中断整轮', async () => {
    const h = makeQueue({ autoStage: true })
    h.port.emitCredit(0, 100_000)
    h.queue.enqueue(makeSegment(0))
    await waitFor(() => h.ended.length === 1)
    h.queue.enqueue(makeSegment(2)) // 跳号
    await flush()
    expect(h.ended).toContainEqual({ segmentId: 'turn-1:tts:2', ok: false })
    h.queue.enqueue(makeSegment(1)) // 补上缺号仍被接受
    await waitFor(() => h.ended.some((e) => e.segmentId === 'turn-1:tts:1' && e.ok))
    expect(h.port.sentFrames.map((f) => f.segmentId)).toEqual(['turn-1:tts:0', 'turn-1:tts:1'])
  })
})

describe('P3B-08 播放队列：gap 调度（§1.15）', () => {
  it('上一段 ended 后按边界 gap 停顿（hard-limit 40ms）', async () => {
    const h = makeQueue()
    h.port.emitCredit(0, 100_000)
    h.queue.enqueue(makeSegment(0, { boundary: 'hard-limit' }))
    h.queue.enqueue(makeSegment(1))
    await flush()
    h.port.emitEnded('turn-1:tts:0')
    const endedAt = Date.now()
    await waitFor(() => h.port.sentFrames.length === 2)
    expect(Date.now() - endedAt).toBeGreaterThanOrEqual(35)
  })

  it('自我纠正段用 suggestedGapMs 覆盖边界 gap', async () => {
    const h = makeQueue()
    h.port.emitCredit(0, 100_000)
    h.queue.enqueue(makeSegment(0, { boundary: 'ellipsis' })) // 常规 gap 250ms
    h.queue.enqueue(makeSegment(1, { correctionRole: 'self-correction', suggestedGapMs: 50 }))
    await flush()
    h.port.emitEnded('turn-1:tts:0')
    // 若按 ellipsis 的 250ms，150ms 时第二段帧不应出现；50ms gap 则已出现
    await sleep(150)
    await flush()
    expect(h.port.sentFrames.map((f) => f.segmentId)).toContain('turn-1:tts:1')
  })
})

describe('P3B-08 播放队列：dispose', () => {
  it('正常收尾不发 cancel；仍在播时防御性停声', async () => {
    const h = makeQueue()
    h.port.emitCredit(0, 100_000)
    h.queue.enqueue(makeSegment(0))
    await flush()
    expect(h.port.sentFrames).toHaveLength(1)

    h.queue.dispose()
    h.queue.dispose() // 幂等
    expect(h.port.sentCancels).toEqual(['app-quit']) // 仍在播（无 ended）：防御停声
    h.queue.enqueue(makeSegment(1))
    await flush()
    expect(h.port.sentFrames).toHaveLength(1)
  })

  it('全部播完后 dispose 不发 cancel', async () => {
    const h = makeQueue({ autoStage: true })
    h.port.emitCredit(0, 100_000)
    h.queue.enqueue(makeSegment(0))
    await waitFor(() => h.ended.length === 1)
    h.queue.dispose()
    expect(h.port.sentCancels).toEqual([])
  })
})

// ── 与真 controller 的接线合同（组合根 P3B-18 的映射方式） ──

describe('P3B-08 集成：controller + queue 全链', () => {
  const OPTIONS: TtsSynthesisOptions = {
    voiceId: 'nacime',
    speed: 1,
    pitch: 0,
    volume: 1,
    requestedSampleRate: 24_000
  }

  function makeProvider(): {
    provider: BoundTtsProvider
    resolveNext: () => boolean
  } {
    const pending: Array<(pcm: Float32Array) => void> = []
    const provider: BoundTtsProvider = {
      id: 'fake-local',
      capabilities: {
        streamingText: false,
        streamingAudio: false,
        supportsCancel: true,
        devTestOnly: false,
        segmentCorrelation: false
      },
      format: { sampleRate: 24_000, channels: 1, sampleFormat: 'f32le', interleaved: true },
      synthesize: () =>
        new Promise<Float32Array>((resolve) => {
          pending.push(resolve)
        }),
      health: async () => ({ healthy: true, checkedAt: 0 }),
      cancel: () => {},
      dispose: () => {}
    }
    return {
      provider,
      resolveNext: () => {
        const resolve = pending.shift()
        if (resolve === undefined) return false
        resolve(new Float32Array(100).fill(0.3)) // 静音幅值，不真发声
        return true
      }
    }
  }

  it('两段文本：合成 -> 队列 -> 播放 -> settle，全程无降级', async () => {
    const { provider, resolveNext } = makeProvider()
    const port = makeFakeStagePort({ autoStage: true })
    port.emitCredit(0, 100_000)
    const ack = makeFakeAckGate()
    ack.paint('req-1', 100)
    const started: string[] = []
    const ended: Array<{ segmentId: string; ok: boolean }> = []
    const degraded: string[] = []
    // 组合根的映射方式：queue 事件 -> controller 回报接口
    let controllerRef: ReturnType<typeof createEarlyTtsController> | null = null

    const queue = createTurnPlaybackQueue({
      turnId: 'turn-1',
      requestId: 'req-1',
      volume: 1,
      port: port.port,
      ackGate: ack.gate,
      logger: noopLogger(),
      policy: TINY_POLICY,
      callbacks: {
        onSegmentStarted: (id) => {
          started.push(id)
          controllerRef?.reportPlaybackStarted(id)
        },
        onSegmentEnded: (id, ok) => {
          ended.push({ segmentId: id, ok })
          controllerRef?.reportPlaybackEnded(id, ok)
        },
        onTurnDegraded: (reason) => {
          degraded.push(reason)
          controllerRef?.reportPlaybackDegraded(reason)
        },
        onHostUnavailable: () => {}
      }
    })

    const controller = createEarlyTtsController(
      { turnId: 'turn-1', requestId: 'req-1', options: OPTIONS, provider },
      {
        logger: noopLogger(),
        onSegmentReady: (segment) => queue.enqueue(segment),
        settleTimeoutMs: 2_000
      },
      {
        enabled: true,
        firstMinUnits: 12,
        nextMinUnits: 8,
        maxHoldMs: 900,
        targetMaxGraphemes: 120,
        hardMaxGraphemes: 200,
        maxAheadSegments: 2,
        maxBufferedChars: 4_096
      }
    )
    controllerRef = controller

    const deltas = ['第一句话已经说完了呀。', '第二句话也说完了呢。']
    deltas.forEach((delta, i) => {
      controller.appendCommittedText({ delta, chatSequence: 4 + i })
    })
    const hash = createHash('sha256')
    for (const d of deltas) hash.update(d)
    controller.finishText({ visibleChars: 21, visibleSha256: hash.digest('hex') })

    // 合成并发 1：逐个放行，直到全部结束
    while (resolveNext()) {
      await flush(2)
    }
    const outcome = await controller.whenSettled()

    expect(degraded).toEqual([])
    expect(ended.length).toBeGreaterThanOrEqual(1)
    expect(ended.every((e) => e.ok)).toBe(true)
    expect(outcome.committedSegments).toBe(2)
    expect(outcome.playedSegments).toBe(2)
    expect(outcome.fallbackToTextOnly).toBe(false)
    queue.dispose()
  })
})
