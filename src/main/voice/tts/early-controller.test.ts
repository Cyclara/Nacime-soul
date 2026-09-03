// src/main/voice/tts/early-controller.test.ts
// P3B-07 / F5-007-2：EarlyTtsController 合同。
// 核心验收：C02（合成并发1、播放顺序）/ C04（admission 暡停不丢字）/
// C13（最终长度/hash 不符不猜余段）/ C14（finishText/cancel 幂等）/
// C17（never-settling 时 ChatService 不等待）。合成层注入受控 deferred provider。

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { Logger } from '@shared/observability/types'
import type { BoundTtsProvider, TtsSynthesisOptions } from '@shared/voice/tts-types'
import {
  createEarlyTtsController,
  type EarlyTtsController,
  type EarlyTtsControllerOptions,
  type ReadyTtsSegment
} from './early-controller'

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

interface DeferredCall {
  readonly text: string
  resolve: (pcm: Float32Array) => void
  reject: (err: Error) => void
}

function makeDeferredProvider(): {
  provider: BoundTtsProvider
  calls: DeferredCall[]
  cancelReasons: string[]
} {
  const calls: DeferredCall[] = []
  const cancelReasons: string[] = []
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
    synthesize: (text) =>
      new Promise<Float32Array>((resolve, reject) => {
        calls.push({ text, resolve, reject })
      }),
    health: async () => ({ healthy: true, checkedAt: 0 }),
    cancel: (reason) => {
      cancelReasons.push(reason)
    },
    dispose: () => {}
  }
  return { provider, calls, cancelReasons }
}

const TURN_OPTIONS: TtsSynthesisOptions = {
  voiceId: 'nacime',
  speed: 1,
  pitch: 0,
  volume: 1,
  requestedSampleRate: 24_000
}

interface Harness {
  controller: EarlyTtsController
  calls: DeferredCall[]
  cancelReasons: string[]
  ready: ReadyTtsSegment[]
  options: EarlyTtsControllerOptions
}

function makeController(
  opts?: Partial<EarlyTtsControllerOptions>,
  settleTimeoutMs = 2_000
): Harness {
  const { provider, calls, cancelReasons } = makeDeferredProvider()
  const ready: ReadyTtsSegment[] = []
  const options: EarlyTtsControllerOptions = {
    enabled: true,
    firstMinUnits: 12,
    nextMinUnits: 8,
    maxHoldMs: 900,
    targetMaxGraphemes: 120,
    hardMaxGraphemes: 200,
    maxAheadSegments: 2,
    maxBufferedChars: 4_096,
    ...opts
  }
  const controller = createEarlyTtsController(
    { turnId: 't1', requestId: 'r1', options: TURN_OPTIONS, provider },
    { logger: noopLogger(), onSegmentReady: (s) => ready.push(s), settleTimeoutMs },
    options
  )
  return { controller, calls, cancelReasons, ready, options }
}

const flush = (ticks = 3): Promise<void> =>
  new Promise<void>((resolve) => {
    void (async () => {
      for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 0))
      resolve()
    })()
  })

function pcm(samples = 8): Float32Array {
  const out = new Float32Array(samples)
  for (let i = 0; i < samples; i++) out[i] = Math.sin(i) * 0.5
  return out
}

/** 三句可切长文（首句 13 单位过门槛，每句 >= 8 单位）。 */
const THREE_SENTENCES = '第一句话已经说完了呀。第二句话也说完了呢。第三句话还在继续说着呢。'

function finishHash(controller: EarlyTtsController, deltas: string[], chars: number): void {
  const hash = createHash('sha256')
  for (const d of deltas) hash.update(d)
  controller.finishText({ visibleChars: chars, visibleSha256: hash.digest('hex') })
}

describe('P3B-07 early-controller：C02 非流式合成（并发 1，顺序播放）', () => {
  it('合成并发恒为 1；ready 段按 sequence 0/1/2 有序产出', async () => {
    const h = makeController()
    h.controller.appendCommittedText({ delta: THREE_SENTENCES, chatSequence: 1 })
    // admission=2：提交 2 段，但合成并发 1
    expect(h.calls.length).toBe(1)

    h.calls[0]!.resolve(pcm())
    await flush()
    expect(h.ready.length).toBe(1)
    expect(h.ready[0]!.sequence).toBe(0)
    // 第 1 段 ready 后（未播放，仍占 admission），第 2 段开始合成
    expect(h.calls.length).toBe(2)

    h.calls[1]!.resolve(pcm())
    await flush()
    expect(h.ready.length).toBe(2)
    expect(h.ready[1]!.sequence).toBe(1)

    // 播放推进释放配额：第 3 段（此前因 admission=2 留在 pending）被提交并合成
    h.controller.reportPlaybackStarted(h.ready[0]!.segmentId)
    await flush()
    expect(h.calls.length).toBe(3)
    h.calls[2]!.resolve(pcm())
    await flush()
    expect(h.ready.length).toBe(3)
    expect(h.ready[2]!.sequence).toBe(2)
  })

  it('segment 文本与 chat sequence 范围正确（ack gate 锚点）', async () => {
    const h = makeController()
    h.controller.appendCommittedText({ delta: '第一句话已经说完了呀。', chatSequence: 4 })
    h.controller.appendCommittedText({ delta: '第二句话也说完了呢。', chatSequence: 5 })
    finishHash(h.controller, ['第一句话已经说完了呀。', '第二句话也说完了呢。'], 21) // 11+10

    h.calls[0]!.resolve(pcm())
    await flush()
    h.calls[1]!.resolve(pcm())
    await flush()
    h.controller.reportPlaybackStarted(h.ready[0]!.segmentId)
    h.controller.reportPlaybackEnded(h.ready[0]!.segmentId, true)
    h.controller.reportPlaybackStarted(h.ready[1]!.segmentId)
    h.controller.reportPlaybackEnded(h.ready[1]!.segmentId, true)
    const outcome = await h.controller.whenSettled()

    expect(h.ready[0]!.chatSequenceStart).toBe(4)
    expect(h.ready[0]!.chatSequenceEnd).toBe(4)
    expect(h.ready[1]!.chatSequenceStart).toBe(5)
    expect(h.ready[1]!.chatSequenceEnd).toBe(5)
    expect(outcome.committedSegments).toBe(2)
    expect(outcome.playedSegments).toBe(2)
    expect(outcome.textCharsSeen).toBe(21)
    expect(outcome.firstCommitMs).not.toBeNull()
    expect(outcome.firstAudioMs).not.toBeNull()
    expect(outcome.fallbackToTextOnly).toBe(false)
  })
})

describe('P3B-07 early-controller：C04 admission ledger', () => {
  it('admission 满时暂停 commit，播放释放后继续，文字不丢', async () => {
    const h = makeController({ maxAheadSegments: 2 })
    // 四句长文：一次 append 后最多提交 2 段
    const four =
      '第一句话已经说完了呀。第二句话也说完了呢。第三句话还在继续说着呢。第四句话也快说完了呀。'
    h.controller.appendCommittedText({ delta: four, chatSequence: 1 })
    expect(h.calls.length).toBe(1) // 只有 1 个在合成（并发 1），committed=2

    h.calls[0]!.resolve(pcm())
    await flush()
    h.controller.reportPlaybackStarted(h.ready[0]!.segmentId) // playing：让出 admission
    await flush()
    // 释放 1 个配额 -> 第 3 句提交、第 2 句合成中
    expect(h.calls.length).toBe(2)

    h.calls[1]!.resolve(pcm())
    await flush()
    h.controller.reportPlaybackEnded(h.ready[0]!.segmentId, true)
    await flush()
    // 又释放 -> 第 4 句提交
    expect(h.calls.length).toBe(3)

    h.calls[2]!.resolve(pcm())
    await flush()
    finishHash(h.controller, [four], four.length)
    h.controller.reportPlaybackEnded(h.ready[1]!.segmentId, true)
    h.controller.reportPlaybackStarted(h.ready[2]!.segmentId)
    h.controller.reportPlaybackEnded(h.ready[2]!.segmentId, true)
    const outcome = await h.controller.whenSettled()
    // 四句一个不丢
    expect(outcome.committedSegments).toBe(4)
    expect(outcome.playedSegments).toBe(3) // 第 4 句 ready 后没有播放回报，由 settle 超时收尾
  }, 5_000)
})

describe('P3B-07 early-controller：失败降级（§1.13）', () => {
  it('首段合成失败（无已播音频）-> 本轮 text-only，后续不再合成', async () => {
    const h = makeController()
    h.controller.appendCommittedText({ delta: THREE_SENTENCES, chatSequence: 1 })
    expect(h.calls.length).toBe(1)
    h.calls[0]!.reject(new Error('engine down'))
    await flush()

    const outcome = await h.controller.whenSettled()
    expect(outcome.fallbackToTextOnly).toBe(true)
    expect(outcome.degradedReason).toBe('synthesis-error')
    expect(h.calls.length).toBe(1) // 降级后不再发起第二次合成
    expect(h.cancelReasons).toContain('provider-failed')
  })

  it('已播音频后失败 -> 已播段保留，剩余 text-only，不整段重播', async () => {
    const h = makeController()
    h.controller.appendCommittedText({ delta: THREE_SENTENCES, chatSequence: 1 })
    h.calls[0]!.resolve(pcm())
    await flush()
    h.controller.reportPlaybackStarted(h.ready[0]!.segmentId)
    h.controller.reportPlaybackEnded(h.ready[0]!.segmentId, true)
    await flush()

    // 第 2 段合成失败
    h.calls[1]!.reject(new Error('gpu oom'))
    await flush()
    const outcome = await h.controller.whenSettled()
    expect(outcome.playedSegments).toBe(1) // 第 1 段照常计入已播
    expect(outcome.fallbackToTextOnly).toBe(true)
    expect(outcome.degradedReason).toBe('synthesis-error')
    expect(h.calls.length).toBe(2) // 没有第 3 次合成（不重播）
  })

  it('PCM 校验拒绝：空/非有限样本按合成失败处理', async () => {
    const h = makeController()
    h.controller.appendCommittedText({ delta: THREE_SENTENCES, chatSequence: 1 })
    const bad = new Float32Array([0.1, Number.NaN, 0.3])
    h.calls[0]!.resolve(bad)
    await flush()
    const outcome = await h.controller.whenSettled()
    expect(outcome.fallbackToTextOnly).toBe(true)
    expect(outcome.degradedReason).toBe('synthesis-error')
  })
})

describe('P3B-07 early-controller：C13 最终一致性', () => {
  it('长度不符 -> 不猜余段、取消未播、降级有 reason', async () => {
    const h = makeController()
    h.controller.appendCommittedText({ delta: THREE_SENTENCES, chatSequence: 1 })
    h.controller.finishText({ visibleChars: 999, visibleSha256: 'deadbeef' })
    const outcome = await h.controller.whenSettled()
    expect(outcome.fallbackToTextOnly).toBe(true)
    expect(outcome.degradedReason).toBe('segmenter-error')
    expect(h.calls.length).toBe(1) // 第一次合成已发起（append 时同步启动）
    expect(h.ready.length).toBe(0) // 但结果被丢弃：无任何音频产出
  })

  it('hash 不符 -> 同样降级；一致时尾段作为 stream-end 提交一次', async () => {
    const h = makeController()
    const short = '好。后面我再慢慢说。' // 累计 8 单位 < 12：全程无正常提交
    h.controller.appendCommittedText({ delta: short, chatSequence: 1 })
    h.controller.finishText({ visibleChars: short.length, visibleSha256: 'wrong-hash' })
    const degraded = await h.controller.whenSettled()
    expect(degraded.degradedReason).toBe('segmenter-error')

    const h2 = makeController()
    h2.controller.appendCommittedText({ delta: short, chatSequence: 1 })
    finishHash(h2.controller, [short], short.length)
    // stream-end 尾段恰好提交一次并合成
    expect(h2.calls.length).toBe(1)
    h2.calls[0]!.resolve(pcm())
    await flush()
    h2.controller.reportPlaybackStarted(h2.ready[0]!.segmentId)
    h2.controller.reportPlaybackEnded(h2.ready[0]!.segmentId, true)
    const outcome = await h2.controller.whenSettled()
    expect(outcome.committedSegments).toBe(1)
    expect(h2.ready[0]!.boundary).toBe('stream-end')
    expect(outcome.playedSegments).toBe(1)
  })
})

describe('P3B-07 early-controller：C14 幂等与 C17 不阻塞', () => {
  it('finishText 重复调用幂等：无重复音频、无重复尾段', async () => {
    const h = makeController()
    const short = '好。后面我再慢慢说。'
    h.controller.appendCommittedText({ delta: short, chatSequence: 1 })
    finishHash(h.controller, [short], short.length)
    finishHash(h.controller, [short], short.length) // 第二次被 inputState 守卫吞掉
    expect(h.calls.length).toBe(1)
    h.calls[0]!.resolve(pcm())
    await flush()
    h.controller.reportPlaybackStarted(h.ready[0]!.segmentId)
    h.controller.reportPlaybackEnded(h.ready[0]!.segmentId, true)
    const outcome = await h.controller.whenSettled()
    expect(outcome.committedSegments).toBe(1)
    expect(h.ready.length).toBe(1)
  })

  it('cancel 幂等：provider.cancel 恰好一次、whenSettled 只有一份结果', async () => {
    const h = makeController()
    h.controller.appendCommittedText({ delta: THREE_SENTENCES, chatSequence: 1 })
    await h.controller.cancel('user-cancel')
    await h.controller.cancel('user-cancel')
    expect(h.cancelReasons).toEqual(['user-cancel'])
    const outcome = await h.controller.whenSettled()
    expect(outcome.cancelled).toBe(true)
    // 合成中的调用已作废：即使 provider 稍后 resolve 也不再产出音频
    h.calls[0]!.resolve(pcm())
    await flush()
    expect(h.ready.length).toBe(0)
  })

  it('C17：never-settling provider 下 finishText 立即返回，settle 超时兜底收尾', async () => {
    const h = makeController({}, 60)
    h.controller.appendCommittedText({ delta: THREE_SENTENCES, chatSequence: 1 })
    // provider 永不 resolve（deferred 挂起）
    const t0 = Date.now()
    finishHash(h.controller, [THREE_SENTENCES], THREE_SENTENCES.length)
    expect(Date.now() - t0).toBeLessThan(50) // finishText 同步立即返回
    const outcome = await h.controller.whenSettled()
    expect(outcome.fallbackToTextOnly).toBe(true)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50) // 确实等了超时才收尾
  })
})

describe('P3B-07 early-controller：输入边界与安全阀', () => {
  it('chat sequence 非严格递增 -> 降级 text-only（§1.6 规则 1）', async () => {
    const h = makeController()
    h.controller.appendCommittedText({ delta: THREE_SENTENCES, chatSequence: 5 })
    h.controller.appendCommittedText({ delta: '更多的话。', chatSequence: 5 }) // 不递增
    finishHash(h.controller, [THREE_SENTENCES, '更多的话。'], THREE_SENTENCES.length + 5)
    const outcome = await h.controller.whenSettled()
    expect(outcome.degradedReason).toBe('segmenter-error')
    expect(outcome.fallbackToTextOnly).toBe(true)
  })

  it('pending 超 maxBufferedChars 安全阀 -> 剩余 text-only（S12）', async () => {
    const h = makeController({ maxBufferedChars: 60 })
    const noBoundary = '无'.repeat(80) // 无任何标点，也无 hard-limit 触发（80 < 200）
    h.controller.appendCommittedText({ delta: noBoundary, chatSequence: 1 })
    const outcome = h.controller.outcome()
    expect(outcome.degradedReason).toBe('queue-overflow')
    finishHash(h.controller, [noBoundary], noBoundary.length)
    const settledOutcome = await h.controller.whenSettled()
    expect(settledOutcome.fallbackToTextOnly).toBe(true)
  })

  it('自我纠正段：标记 correctionRole 并携带 0-80ms gap 提示（§1.12.2）', async () => {
    const h = makeController()
    const text = '等等，我刚才说错了，正确应该是这样算才对。'
    h.controller.appendCommittedText({ delta: text, chatSequence: 1 })
    finishHash(h.controller, [text], text.length)
    expect(h.calls.length).toBe(1)
    h.calls[0]!.resolve(pcm())
    await flush()
    expect(h.ready[0]!.correctionRole).toBe('self-correction')
    expect(h.ready[0]!.suggestedGapMs).toBeGreaterThan(0)
    expect(h.ready[0]!.suggestedGapMs).toBeLessThanOrEqual(80)
    expect((await h.controller.whenSettled()).correctionDetected).toBe(true)
  })

  it('enabled=false：不提交任何 segment，文本照常计账', async () => {
    const h = makeController({ enabled: false })
    h.controller.appendCommittedText({ delta: THREE_SENTENCES, chatSequence: 1 })
    finishHash(h.controller, [THREE_SENTENCES], THREE_SENTENCES.length)
    const outcome = await h.controller.whenSettled()
    expect(outcome.committedSegments).toBe(0)
    expect(outcome.fallbackToTextOnly).toBe(true)
    expect(outcome.degradedReason).toBe('disabled')
    expect(h.calls.length).toBe(0)
  })
})

describe('P3B-08 播放层降级回报（reportPlaybackDegraded）', () => {
  it('queue-overflow 软停：committed 取消、synthesizing 照常完成、ready 不丢、不再发起新合成（§1.10.2）', async () => {
    const h = makeController()
    h.controller.appendCommittedText({ delta: THREE_SENTENCES, chatSequence: 1 })
    expect(h.calls.length).toBe(1)
    h.calls[0]!.resolve(pcm()) // seg0 ready；seg1 开始合成
    await flush()
    expect(h.calls.length).toBe(2)

    h.controller.reportPlaybackDegraded('queue-overflow')
    expect(h.controller.outcome().degradedReason).toBe('queue-overflow')

    // in-flight 合成完成后仍交付 ready（不丢已 ready 音频）
    h.calls[1]!.resolve(pcm())
    await flush()
    expect(h.ready.length).toBe(2)

    // 播放回报推进终态；软停后不再有第三个合成（第三句的 pending 已被清）
    h.controller.reportPlaybackStarted(h.ready[0]!.segmentId)
    h.controller.reportPlaybackEnded(h.ready[0]!.segmentId, true)
    h.controller.reportPlaybackEnded(h.ready[1]!.segmentId, true)
    finishHash(h.controller, [THREE_SENTENCES], THREE_SENTENCES.length)
    await flush()
    expect(h.calls.length).toBe(2)
    const outcome = await h.controller.whenSettled()
    expect(outcome.committedSegments).toBe(2)
    expect(outcome.playedSegments).toBe(2)
    expect(outcome.fallbackToTextOnly).toBe(true)
    expect(outcome.degradedReason).toBe('queue-overflow')
  })

  it('playback-host-unavailable 硬停：playing 不动、synthesizing/ready 取消、provider 有界清理（§1.13）', async () => {
    const h = makeController()
    h.controller.appendCommittedText({ delta: THREE_SENTENCES, chatSequence: 1 })
    h.calls[0]!.resolve(pcm()) // seg0 ready
    await flush()
    h.controller.reportPlaybackStarted(h.ready[0]!.segmentId) // seg0 playing
    expect(h.calls.length).toBe(2) // seg1 synthesizing

    h.controller.reportPlaybackDegraded('playback-host-unavailable')
    expect(h.cancelReasons).toContain('provider-failed')

    // 在播段自然结束（不被硬停打断）
    h.controller.reportPlaybackEnded(h.ready[0]!.segmentId, true)
    finishHash(h.controller, [THREE_SENTENCES], THREE_SENTENCES.length)
    const outcome = await h.controller.whenSettled()
    expect(outcome.playedSegments).toBe(1)
    expect(outcome.failedSegments).toBe(0)
    // seg0 进 playing 释放 admission，第三句在降级前已被提交：共 3 段
    // （seg1 synthesizing、seg2 committed 均被硬停取消，非 failed）
    expect(outcome.committedSegments).toBe(3)
    expect(outcome.degradedReason).toBe('playback-host-unavailable')
    expect(h.ready.length).toBe(1) // seg1 的合成结果被取消守卫丢弃
  })

  it('降级原因首个生效（重复回报幂等）', () => {
    const h = makeController()
    h.controller.appendCommittedText({ delta: THREE_SENTENCES, chatSequence: 1 })
    h.controller.reportPlaybackDegraded('chat-render-ack-timeout')
    h.controller.reportPlaybackDegraded('queue-overflow')
    expect(h.controller.outcome().degradedReason).toBe('chat-render-ack-timeout')
  })
})
