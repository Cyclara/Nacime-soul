// src/main/voice/voice-chain.integration.test.ts
// P3B-20：语音全链路组装测试（main 进程级，全假件不真发声——S-004）。
//
// 链路：LLM 流（faux provider）→ ChatService（voice hook）→ 真 VoiceOrchestrator
// → 真 TTS Registry（静音假 provider）→ 真 playback queue → 内存 loopback port
// （假 stage 回 credit/started/ended，等价 renderer 侧 playback-host+audio-player）。
// 覆盖完成定义 3/6 的 main 侧组装：
//   - ack 先于发声（C22）：假 renderer 在 chunk 后立即 observeAck；
//   - started 才报 speaking；ended 收尾；
//   - barge-in：VAD speech_start → 打断（stage 收 cancel('barge-in')）；
//   - LLM 失败（断网）：failed 事件照常、用户消息（转写草稿的 main 侧落点）不丢、
//     语音取消、无音频帧——「断网只影响 LLM，不破坏语音链路」。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type { Logger } from '@shared/observability/types'
import type { ChatStreamEvent } from '@shared/chat/types'
import { createChatService, type ChatEventSink } from '../chat/service'
import { createMemorySessionStore } from '../chat/session-store'
import { createMemoryPromptLoader } from '../prompts/loader'
import { registerHook, clearHooks } from '../hooks/registry'
import { setHookRunnerLogger } from '../hooks/runner'
import { sanitizeMessageHook } from '../hooks/builtin/sanitize-message'
import { createFauxProvider } from '../llm/providers/faux'
import type { FauxStep } from '../llm/providers/faux'
import type {
  BoundTtsProvider,
  TtsProviderCapabilities,
  TtsProviderFactory
} from '@shared/voice/tts-types'
import type { TtsConfig } from '@shared/config/types'
import type { VoiceEvent } from '@shared/voice/voice-events'
import type { MessagePortMainLike } from './playback/types'
import { createPlaybackHostManager } from './playback/stage-host-manager'
import { createChatRenderAckGate } from './playback/ack-gate'
import { createTtsRegistry } from './tts/registry'
import { createVoiceOrchestrator } from './orchestrator'

const REPLY = '当然可以，我们一起把这条语音链路走通。'

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

class LoopbackPort implements MessagePortMainLike {
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

  audioFrames(): Array<{ segmentId: string; finalFrame: boolean }> {
    return this.posted
      .filter((m) => (m as { type?: string }).type === 'audio')
      .map((m) => {
        const frame = m as { segmentId: string; finalFrame: boolean }
        return { segmentId: frame.segmentId, finalFrame: frame.finalFrame }
      })
  }

  cancelReasons(): string[] {
    return this.posted
      .filter((m) => (m as { type?: string }).type === 'cancel')
      .map((m) => (m as { reason: string }).reason)
  }
}

const CAPS: Readonly<TtsProviderCapabilities> = Object.freeze({
  streamingText: false,
  streamingAudio: false,
  supportsCancel: true,
  devTestOnly: false,
  segmentCorrelation: false
})

interface Chain {
  service: ReturnType<typeof createChatService>
  events: ChatStreamEvent[]
  orchestrator: ReturnType<typeof createVoiceOrchestrator>
  voiceEvents: VoiceEvent[]
  port: LoopbackPort
  gate: ReturnType<typeof createChatRenderAckGate>
  sessionStore: ReturnType<typeof createMemorySessionStore>
  provider: BoundTtsProvider
}

function buildChain(llmSteps: FauxStep[], ttsEnabled = true): Chain {
  const events: ChatStreamEvent[] = []
  const voiceEvents: VoiceEvent[] = []
  const port = new LoopbackPort()
  const hostManager = createPlaybackHostManager({
    logger: logger(),
    newGenerationId: () => 'gen-1',
    createStageChannel: () => port
  })
  hostManager.attachStage({ id: 1, isDestroyed: () => false, postMessage: () => {} })
  const gate = createChatRenderAckGate()
  const registry = createTtsRegistry(logger())
  const provider: BoundTtsProvider = {
    id: 'silent-fake',
    capabilities: CAPS,
    format: { sampleRate: 24000, channels: 1, sampleFormat: 'f32le', interleaved: true },
    async synthesize() {
      return new Float32Array(2400) // 100ms 静音 @24kHz
    },
    health: async () => ({ healthy: true, checkedAt: 0 }),
    cancel() {
      /* 假件：取消无副作用 */
    },
    dispose: async () => {}
  }
  const factory: TtsProviderFactory = { bind: async () => provider }
  registry.register({ id: 'silent-fake', capabilities: CAPS, factory })
  const orchestrator = createVoiceOrchestrator({
    logger: logger(),
    registry,
    hostManager,
    ackGate: gate,
    getTtsConfig: (): TtsConfig => ({
      enabled: ttsEnabled,
      provider: 'silent-fake',
      voiceId: 'test-voice',
      speed: 1,
      pitch: 0,
      volume: 1,
      sampleRate: 24000,
      cacheEnabled: true,
      earlyPlaybackEnabled: true
    }),
    runtime: () => 'test',
    emitEvent: (event) => voiceEvents.push(event)
  })
  const sessionStore = createMemorySessionStore()
  const faux = createFauxProvider()
  faux.setResponses(llmSteps)
  // 假 renderer 的 sink 由各测试自带（每个测试决定 ack 节奏）；events 是共享收集数组
  const service = createChatService({
    logger: logger(),
    promptLoader: createMemoryPromptLoader({
      'seed.md': 'You are Nacime.',
      'system.md': 'Speak naturally.',
      'identity.md': 'Name: Nacime',
      'soul.md': 'Curious and warm.',
      'styles/casual.md': 'Casual tone.'
    }),
    sessionStore,
    providerFactory: () => ({
      provider: faux,
      capabilities: { contextWindow: 64000, maxOutputTokens: 2048 }
    }),
    voice: orchestrator
  })
  return { service, events, orchestrator, voiceEvents, port, gate, sessionStore, provider }
}

function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      if (cond()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error('waitFor timeout'))
      setTimeout(tick, 5)
    }
    tick()
  })
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('P3B-20 语音全链路（main 级组装）', () => {
  beforeEach(() => {
    clearHooks()
    setHookRunnerLogger(logger())
    registerHook(sanitizeMessageHook)
  })

  afterEach(() => {
    clearHooks()
  })

  it('LLM 回复 → TTS 分段合成 → ack 后发声 → speaking 事件闭环', async () => {
    const chain = buildChain([{ type: 'text', text: REPLY }])
    const sessionId = chain.service.createSession()
    const done = new Promise<void>((resolve) => {
      const poll = (): void => {
        if (chain.events.some((e) => e.type === 'completed')) return resolve()
        setTimeout(poll, 5)
      }
      poll()
    })
    // 语音输入 → ASR transcript → 发送到 chat（转写草稿的消费点）；sink 即假 renderer
    await chain.service.send(
      { sessionId, text: '你能说话吗', clientRequestId: 'c1' },
      (event: ChatStreamEvent) => {
        chain.events.push(event)
        // chunk 已绘制 → 立即回报 paint ack（C22 renderer 侧）
        if (event.type === 'chunk') chain.gate.observeAck(event.requestId, event.sequence)
      }
    )
    await done

    // 假 stage：初始 credit（stage attach 后立即冻结容量）
    chain.port.emit({
      type: 'credit',
      generation: 'gen-1',
      capacityBytes: 1_440_000,
      availableBytes: 1_440_000,
      creditSequence: 0
    })
    await waitFor(() => chain.port.audioFrames().length > 0)
    const first = chain.port.audioFrames()[0]!
    chain.port.emit({
      type: 'started',
      generation: 'gen-1',
      segmentId: first.segmentId,
      audioStartAt: Date.now()
    })
    await waitFor(() => chain.voiceEvents.some((e) => e.type === 'speaking-started'))
    const finalFrame = chain.port.audioFrames().at(-1)!
    expect(finalFrame.finalFrame).toBe(true)
    chain.port.emit({
      type: 'ended',
      generation: 'gen-1',
      segmentId: finalFrame.segmentId,
      playedMs: 100
    })
    await waitFor(() => chain.voiceEvents.some((e) => e.type === 'speaking-ended'))
    expect(chain.voiceEvents.map((e) => e.type)).toEqual(['speaking-started', 'speaking-ended'])
    expect(chain.events.some((e) => e.type === 'completed')).toBe(true)
  })

  it('barge-in：说话中 VAD speech_start → stage 收 cancel(barge-in) → speaking-ended(cancelled)', async () => {
    const chain = buildChain([{ type: 'text', text: REPLY }])
    const sessionId = chain.service.createSession()
    const sink: ChatEventSink = (event) => {
      chain.events.push(event)
      if (event.type === 'chunk') chain.gate.observeAck(event.requestId, event.sequence)
    }
    const completed = new Promise<void>((resolve) => {
      const poll = (): void => {
        if (chain.events.some((e) => e.type === 'completed')) return resolve()
        setTimeout(poll, 5)
      }
      poll()
    })
    await chain.service.send({ sessionId, text: '你好', clientRequestId: 'c2' }, sink)
    await completed

    chain.port.emit({
      type: 'credit',
      generation: 'gen-1',
      capacityBytes: 1_440_000,
      availableBytes: 1_440_000,
      creditSequence: 0
    })
    await waitFor(() => chain.port.audioFrames().length > 0)
    const first = chain.port.audioFrames()[0]!
    chain.port.emit({
      type: 'started',
      generation: 'gen-1',
      segmentId: first.segmentId,
      audioStartAt: 0
    })
    await waitFor(() => chain.voiceEvents.some((e) => e.type === 'speaking-started'))

    // 用户开口（VAD speech_start）→ barge-in
    expect(chain.orchestrator.onBargeIn()).toBe(true)
    await waitFor(() => chain.voiceEvents.some((e) => e.type === 'speaking-ended'))
    expect(chain.port.cancelReasons()).toContain('barge-in')
    const ended = chain.voiceEvents.find((e) => e.type === 'speaking-ended')
    expect(ended).toMatchObject({ reason: 'cancelled' })
  })

  it('LLM 失败（断网）：failed 事件 + 用户消息不丢 + 无音频帧', async () => {
    const chain = buildChain([{ type: 'error', code: 'LLM_SERVER' }])
    const sessionId = chain.service.createSession()
    const done = new Promise<void>((resolve) => {
      const poll = (): void => {
        if (chain.events.some((e) => e.type === 'failed')) return resolve()
        setTimeout(poll, 5)
      }
      poll()
    })
    await chain.service.send({ sessionId, text: '断网时说的这句话', clientRequestId: 'c3' }, ((
      event: ChatStreamEvent
    ) => {
      chain.events.push(event)
    }) as ChatEventSink)
    await done
    await flush()
    await flush()

    expect(chain.events.some((e) => e.type === 'failed')).toBe(true)
    // 用户消息（转写草稿的 main 侧落点）已入库：LLM 失败不丢
    const messages = chain.sessionStore.getMessages(sessionId, 100)
    expect(messages.some((m) => m.role === 'user' && m.content === '断网时说的这句话')).toBe(true)
    // 语音侧：本轮取消，无任何音频
    expect(chain.port.audioFrames()).toHaveLength(0)
    expect(chain.voiceEvents).toHaveLength(0)
  })

  it('TTS 关闭：文字链路零影响（回归护栏）', async () => {
    const chain = buildChain([{ type: 'text', text: REPLY }], false)
    const sessionId = chain.service.createSession()
    const done = new Promise<void>((resolve) => {
      const poll = (): void => {
        if (chain.events.some((e) => e.type === 'completed')) return resolve()
        setTimeout(poll, 5)
      }
      poll()
    })
    await chain.service.send({ sessionId, text: '你好', clientRequestId: 'c4' }, ((
      event: ChatStreamEvent
    ) => {
      chain.events.push(event)
    }) as ChatEventSink)
    await done

    expect(chain.events.some((e) => e.type === 'completed')).toBe(true)
    expect(chain.port.audioFrames()).toHaveLength(0)
    expect(chain.voiceEvents).toHaveLength(0)
  })
})
