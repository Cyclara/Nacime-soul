// src/main/voice/orchestrator.test.ts
// P3B-18：VoiceOrchestrator——hook 顺序、bind 装配/降级、C22 ack 顺序、speaking 事件、
// cancel/barge-in 幂等、test-tts。全部用假 registry provider + 假 port（S-004 不真发声）。

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { Logger, MetricsRegistry } from '@shared/observability/types'
import type { TtsConfig } from '@shared/config/types'
import type {
  BoundTtsProvider,
  TtsProviderCapabilities,
  TtsProviderFactory
} from '@shared/voice/tts-types'
import type { VoiceEvent } from '@shared/voice/voice-events'
import type { MessagePortMainLike } from './playback/types'
import { createPlaybackHostManager } from './playback/stage-host-manager'
import { createChatRenderAckGate } from './playback/ack-gate'
import { createTtsRegistry } from './tts/registry'
import { createMetrics } from '../observability/metrics'
import { createVoiceOrchestrator, type VoiceOrchestrator } from './orchestrator'

function logger(): Logger {
  const value: Logger = {
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
    child: () => value
  }
  return value
}

class FakeMainPort implements MessagePortMainLike {
  posted: unknown[] = []
  private readonly messageHandlers = new Set<(event: { data: unknown }) => void>()
  private readonly closeHandlers = new Set<() => void>()
  closed = false

  postMessage(message: unknown): void {
    this.posted.push(message)
  }

  on(event: 'message' | 'close', listener: unknown): void {
    if (event === 'message') {
      this.messageHandlers.add(listener as (event: { data: unknown }) => void)
    } else {
      this.closeHandlers.add(listener as () => void)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const handler of [...this.closeHandlers]) handler()
  }

  emit(data: unknown): void {
    for (const handler of [...this.messageHandlers]) handler({ data })
  }

  audioFrameCount(): number {
    return this.posted.filter((m) => (m as { type?: string }).type === 'audio').length
  }

  lastAudioSegmentId(): string | null {
    for (let i = this.posted.length - 1; i >= 0; i -= 1) {
      const message = this.posted[i] as { type?: string; segmentId?: string } | undefined
      if (message?.type === 'audio') return message.segmentId ?? null
    }
    return null
  }
}

const CAPS: Readonly<TtsProviderCapabilities> = Object.freeze({
  streamingText: false,
  streamingAudio: false,
  supportsCancel: true,
  devTestOnly: false,
  segmentCorrelation: false
})

interface Harness {
  orchestrator: VoiceOrchestrator
  port: FakeMainPort
  gate: ReturnType<typeof createChatRenderAckGate>
  events: VoiceEvent[]
  provider: BoundTtsProvider & { disposeCount: number; cancelReasons: string[] }
  metrics: MetricsRegistry
}

const TTS_CONFIG: Readonly<TtsConfig> = Object.freeze({
  enabled: true,
  provider: 'fake-provider',
  voiceId: 'test-voice',
  speed: 1,
  pitch: 0,
  volume: 1,
  sampleRate: 24000,
  cacheEnabled: true,
  // 本文件多数用例验证的是早播链路（delta 到达即合成）；普通 TTS 模式用例显式关掉
  earlyPlaybackEnabled: true
})

function makeHarness(opts?: {
  ttsConfig?: Partial<TtsConfig>
  failBind?: boolean
  textOnlyReason?: 'voice-missing'
  hostAvailable?: boolean
}): Harness {
  const events: VoiceEvent[] = []
  const port = new FakeMainPort()
  const hostAvailable = opts?.hostAvailable ?? true
  const hostManager = createPlaybackHostManager({
    logger: logger(),
    newGenerationId: () => 'gen-1',
    createStageChannel: () => (hostAvailable ? port : null)
  })
  if (hostAvailable) {
    hostManager.attachStage({ id: 1, isDestroyed: () => false, postMessage: () => {} })
  }
  const gate = createChatRenderAckGate()
  const registry = createTtsRegistry(logger())
  const metrics = createMetrics()
  const provider: BoundTtsProvider & { disposeCount: number; cancelReasons: string[] } = {
    id: 'fake-provider',
    capabilities: CAPS,
    format: { sampleRate: 24000, channels: 1, sampleFormat: 'f32le', interleaved: true },
    async synthesize() {
      return new Float32Array(480) // 20ms 静音 @24kHz
    },
    health: async () => ({ healthy: true, checkedAt: 0 }),
    cancel(reason) {
      provider.cancelReasons.push(reason)
    },
    dispose: async () => {
      provider.disposeCount += 1
    },
    disposeCount: 0,
    cancelReasons: []
  }
  const factory: TtsProviderFactory = {
    bind: async () => {
      if (opts?.failBind === true) throw new Error('boom')
      if (opts?.textOnlyReason !== undefined) {
        return { textOnly: true, reason: opts.textOnlyReason }
      }
      return provider
    }
  }
  registry.register({ id: 'fake-provider', capabilities: CAPS, factory })
  const orchestrator = createVoiceOrchestrator({
    logger: logger(),
    registry,
    hostManager,
    ackGate: gate,
    getTtsConfig: () => ({ ...TTS_CONFIG, ...opts?.ttsConfig }),
    runtime: () => 'test',
    emitEvent: (event) => events.push(event),
    metrics
  })
  return { orchestrator, port, gate, events, provider, metrics }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** 喂 credit、回 started/ended，把已就绪的一轮推到终局。 */
async function driveToCompletion(h: Harness): Promise<void> {
  h.port.emit({
    type: 'credit',
    generation: 'gen-1',
    capacityBytes: 1_440_000,
    availableBytes: 1_440_000,
    creditSequence: 0
  })
  await flush()
  await flush()
  const segmentId = h.port.lastAudioSegmentId()
  expect(segmentId).not.toBeNull()
  h.port.emit({ type: 'started', generation: 'gen-1', segmentId, audioStartAt: 0 })
  await flush()
  h.port.emit({ type: 'ended', generation: 'gen-1', segmentId, playedMs: 20 })
  await flush()
  await flush()
  await flush()
}

const TURN_DELTA = '你好呀世界今天天气真的很不错。'

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** 开始一轮并喂一段带句号的长 delta（≥ firstMinUnits 12，立即提交）。 */
function beginTurnWithDelta(h: Harness, requestId = 'r1'): void {
  h.orchestrator.beginTurn({ turnId: 't1', requestId })
  h.orchestrator.onCommittedDelta({ delta: TURN_DELTA, chatSequence: 1 })
}

describe('P3B-18 VoiceOrchestrator', () => {
  it('正常链路：delta→合成→ack 后才发声→started 才报 speaking→ended 收尾', async () => {
    const h = makeHarness()
    beginTurnWithDelta(h)
    h.orchestrator.finishTurn({ visibleChars: TURN_DELTA.length, visibleSha256: sha(TURN_DELTA) })

    await flush()
    await flush()
    await flush()
    // C22：ack 未喂前绝无音频帧
    expect(h.port.audioFrameCount()).toBe(0)

    h.gate.observeAck('r1', 1)
    await flush()
    await driveToCompletion(h)

    expect(h.port.audioFrameCount()).toBeGreaterThan(0)
    expect(h.events.map((e) => e.type)).toEqual(['speaking-started', 'speaking-ended'])
    expect(h.events[1]).toMatchObject({
      type: 'speaking-ended',
      requestId: 'r1',
      reason: 'completed'
    })
    expect(h.orchestrator.getState()).toMatchObject({ speaking: false, speakingRequestId: null })
    expect(h.provider.disposeCount).toBe(1)
    expect(h.metrics.snapshot()['tts.early.queueHighWater']).toBe(1)
    expect(h.metrics.snapshot()['voice.paintToAudioMs.count']).toBe(1)
  })

  it('host 不可用：beginTurn 即判 text-only；getState 反映 hostAvailable=false', async () => {
    const h = makeHarness({ hostAvailable: false })
    beginTurnWithDelta(h)
    h.orchestrator.finishTurn({ visibleChars: TURN_DELTA.length, visibleSha256: sha(TURN_DELTA) })
    await flush()
    await flush()
    await flush()

    expect(h.port.posted).toHaveLength(0)
    expect(h.orchestrator.getState()).toMatchObject({
      hostAvailable: false,
      speaking: false,
      lastDegradedReason: 'playback-host-unavailable'
    })
    expect(h.events).toHaveLength(0)
  })

  it('tts.enabled=false：全旁路（无 session、无 bind、无事件）', async () => {
    const h = makeHarness({ ttsConfig: { enabled: false } })
    beginTurnWithDelta(h)
    h.orchestrator.finishTurn({ visibleChars: 15, visibleSha256: 'cc'.repeat(32) })
    await flush()
    await flush()

    expect(h.events).toHaveLength(0)
    expect(h.orchestrator.getState()).toMatchObject({ ttsEnabled: false })
  })

  it('voiceId 为空：bind 判 voice-missing 退纯文字（裁定二）', async () => {
    const h = makeHarness({ ttsConfig: { voiceId: '' } })
    beginTurnWithDelta(h)
    h.orchestrator.finishTurn({ visibleChars: TURN_DELTA.length, visibleSha256: sha(TURN_DELTA) })
    await flush()
    await flush()
    await flush()

    expect(h.port.posted).toHaveLength(0)
    expect(h.orchestrator.getState().lastDegradedReason).toBe('voice-missing')
  })

  it('bind 抛错（未注册 provider 等）：该轮 text-only，不逃逸', async () => {
    const h = makeHarness({ failBind: true })
    beginTurnWithDelta(h)
    h.orchestrator.finishTurn({ visibleChars: TURN_DELTA.length, visibleSha256: sha(TURN_DELTA) })
    await flush()
    await flush()
    await flush()

    expect(h.port.posted).toHaveLength(0)
    expect(h.orchestrator.getState().lastDegradedReason).toBe('provider-unhealthy')
  })

  it('极短轮：finishTurn 先于 bind 完成到达也能完整装配并播完', async () => {
    const h = makeHarness()
    h.orchestrator.beginTurn({ turnId: 't1', requestId: 'r1' })
    h.orchestrator.finishTurn({ visibleChars: 0, visibleSha256: sha('') })
    // 空 delta：无段可播；装配照常完成，settle 等 ready 后收尾
    await flush()
    await flush()
    await flush()

    expect(h.events).toHaveLength(0)
    expect(h.provider.disposeCount).toBe(1)
    expect(h.orchestrator.getState().speaking).toBe(false)
  })

  it('cancelSpeaking：queue.cancel 发 port cancel + provider.cancel + speaking-ended(cancelled)', async () => {
    const h = makeHarness()
    beginTurnWithDelta(h)
    await flush()
    await flush()
    h.gate.observeAck('r1', 1)
    await flush()
    await driveToCompletionPreStarted(h)

    expect(h.events.map((e) => e.type)).toEqual(['speaking-started'])

    expect(h.orchestrator.cancelSpeaking()).toBe(true)
    await flush()
    await flush()
    await flush()

    expect(h.port.posted.some((m) => (m as { type?: string }).type === 'cancel')).toBe(true)
    expect(h.provider.cancelReasons).toContain('user-cancel')
    const ended = h.events.find((e) => e.type === 'speaking-ended')
    expect(ended).toMatchObject({ requestId: 'r1', reason: 'cancelled' })
    expect(h.orchestrator.getState().speaking).toBe(false)
  })

  /** 喂 credit + started，但不出 ended——轮停在「说话中」。 */
  async function driveToCompletionPreStarted(h: Harness): Promise<void> {
    h.port.emit({
      type: 'credit',
      generation: 'gen-1',
      capacityBytes: 1_440_000,
      availableBytes: 1_440_000,
      creditSequence: 0
    })
    await flush()
    await flush()
    const segmentId = h.port.lastAudioSegmentId()
    expect(segmentId).not.toBeNull()
    h.port.emit({ type: 'started', generation: 'gen-1', segmentId, audioStartAt: 0 })
    await flush()
  }

  it('barge-in：打断在播轮；无 session 时返回 false', async () => {
    const h = makeHarness()
    expect(h.orchestrator.onBargeIn()).toBe(false)

    beginTurnWithDelta(h)
    await flush()
    await flush()
    expect(h.orchestrator.onBargeIn()).toBe(true)
    await flush()
    await flush()

    expect(h.provider.cancelReasons).toContain('barge-in')
    expect(h.port.posted.some((m) => (m as { type?: string }).type === 'cancel')).toBe(true)
  })

  it('testTts：试听走同一 queue/controller（ack 豁免预喂 seq 0），终局后清理', async () => {
    const h = makeHarness()
    await h.orchestrator.testTts('试听一句话。')
    await driveToCompletion(h)

    expect(h.port.audioFrameCount()).toBeGreaterThan(0)
    const started = h.events.find((e) => e.type === 'speaking-started') as
      { requestId: string } | undefined
    expect(started?.requestId.startsWith('tts-test-')).toBe(true)
    expect(h.events.some((e) => e.type === 'speaking-ended')).toBe(true)
    expect(h.provider.disposeCount).toBe(1)
  })

  it('testTts：host 不可用抛 TTS_ENGINE_DOWN', async () => {
    const h = makeHarness({ hostAvailable: false })
    await expect(h.orchestrator.testTts('试听')).rejects.toMatchObject({
      code: 'TTS_ENGINE_DOWN'
    })
  })

  it('earlyPlaybackEnabled=false（普通 TTS）：delta 全部缓冲到 finishTurn 才合成，整段朗读', async () => {
    const h = makeHarness({ ttsConfig: { earlyPlaybackEnabled: false } })
    h.orchestrator.beginTurn({ turnId: 't1', requestId: 'r1' })
    h.orchestrator.onCommittedDelta({ delta: '第一句话说完了。', chatSequence: 1 })
    h.orchestrator.onCommittedDelta({ delta: '第二句话也说完了。', chatSequence: 2 })
    await flush()
    await flush()
    await flush()
    // 两句强边界都到齐、bind 也完成了，但普通模式下不提前合成：无音频帧、无 ack 等待
    h.gate.observeAck('r1', 2)
    h.port.emit({
      type: 'credit',
      generation: 'gen-1',
      capacityBytes: 1_440_000,
      availableBytes: 1_440_000,
      creditSequence: 0
    })
    await flush()
    await flush()
    expect(h.port.audioFrameCount()).toBe(0)

    const full = '第一句话说完了。第二句话也说完了。'
    h.orchestrator.finishTurn({ visibleChars: full.length, visibleSha256: sha(full) })
    await flush()
    await flush()
    await flush()
    // finishTurn 后整轮文字进入 controller → 合成 → 发声
    expect(h.port.audioFrameCount()).toBeGreaterThan(0)
    expect(h.orchestrator.getState().earlyPlaybackEnabled).toBe(false)
  })

  it('普通 TTS：整轮超 16K 字符缓冲上限 → 本轮纯文字（不截断朗读）', async () => {
    const h = makeHarness({ ttsConfig: { earlyPlaybackEnabled: false } })
    h.orchestrator.beginTurn({ turnId: 't1', requestId: 'r1' })
    await flush()
    await flush()
    const chunk = '这是一段很长的文字。'.repeat(200) // 2000 字符
    for (let i = 1; i <= 9; i += 1)
      h.orchestrator.onCommittedDelta({ delta: chunk, chatSequence: i })
    await flush()
    expect(h.orchestrator.getState().lastDegradedReason).toBe('queue-overflow')
    expect(h.port.audioFrameCount()).toBe(0)
  })

  it('新轮开始让位旧轮（new-turn cancel）；dispose 收尾当前轮', async () => {
    const h = makeHarness()
    beginTurnWithDelta(h, 'r1')
    await flush()
    await flush()

    h.orchestrator.beginTurn({ turnId: 't2', requestId: 'r2' })
    await flush()
    await flush()
    expect(h.provider.cancelReasons).toContain('new-turn')

    h.orchestrator.dispose()
    await flush()
    await flush()
    expect(h.provider.cancelReasons).toContain('app-quit')
  })
})
