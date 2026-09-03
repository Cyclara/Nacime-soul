// src/main/voice/orchestrator.ts
// P3B-18（F5-007 §1.5/§1.13/§1.14 + S-Phase3 Step 5）：VoiceOrchestrator。
//
// 把 ChatService 的 releaseText 流、TTS Registry、播放队列与 stage speaking 状态
// 组装成一条链；同时实现 ChatVoiceTtsHook（F5-007 §1.5 冻结顺序：先 sink chunk、
// 再恰好一次 onCommittedDelta；finishText 同步返回，C17）。
//
// 一轮一个 voice session；teardown 幂等（验收）。chat/voice/live2d 无环依赖：
//   chat service ──hook──▶ orchestrator ──▶ registry/providers
//        │                      │
//   chat-stream event      playback queue ──port──▶ stage（live2d 窗口）
// renderer 只收 voice-state 事件与 get-state 投影，store 不互调（S-006-补充 §1.4）。
//
// 降级纪律（裁定二 + §1.13）：任何环节失败都退纯文字，绝不换通用音色、绝不重播；
// 文字流永不等待语音（hook 方法全部同步返回，异步部分在 session 内自驱）。
//
// bind 异步 vs delta 同步的调和：beginTurn 后 ChatService 立即流式喂 delta，而
// registry.bind 是异步的——controller 就绪前的 delta 有界缓冲（≤4KiB），就绪后
// 按到达序 replay；超界该轮 text-only（与 controller 的 maxBufferedChars 同量级）。

import { createHash, randomUUID } from 'node:crypto'
import type { Logger } from '@shared/observability/types'
import type { MetricsRegistry } from '@shared/observability/types'
import type { TtsConfig } from '@shared/config/types'
import { AppError } from '@shared/errors'
import type {
  BoundTtsProvider,
  TtsCancelReason,
  EarlyTtsDegradedReason
} from '@shared/voice/tts-types'
import { isTtsTextOnly } from '@shared/voice/tts-types'
import type {
  VoiceEvent,
  VoicePublicSnapshot,
  VoiceTtsProviderOption,
  VoiceTtsVoiceOption
} from '@shared/voice/voice-events'
import type { ChatVoiceTtsHook } from '../chat/service'
import {
  createEarlyTtsController,
  type EarlyTtsController,
  type EarlyTtsOutcome
} from './tts/early-controller'
import type { TtsRegistry } from './tts/registry'
import { createTurnPlaybackQueue } from './playback/queue'
import type { TurnPlaybackQueue } from './playback/types'
import type { ChatRenderAckGateInternal } from './playback/ack-gate'
import type { PlaybackHostManager } from './playback/stage-host-manager'

/**
 * 早期播放切段参数（F5-007 §3.2：实验参数不进 config，真实数据说话后再调）。
 * 与 early-controller 测试基线一致：首段 ≥12 单元、后续 ≥8、hold 900ms、
 * 段目标 120 / 硬顶 200 graphemes、ahead 2、缓冲 4KiB。
 */
const EARLY_TTS_OPTIONS_V1 = {
  enabled: true,
  firstMinUnits: 12,
  nextMinUnits: 8,
  maxHoldMs: 900,
  targetMaxGraphemes: 120,
  hardMaxGraphemes: 200,
  maxAheadSegments: 2,
  maxBufferedChars: 4_096
} as const

/** bind 就绪前 delta 缓冲上限（字符）；超界该轮 text-only。 */
const PENDING_DELTA_BUFFER_MAX_CHARS = 4_096
/**
 * 普通 TTS（`earlyPlaybackEnabled=false`，F5-007 §3.2/边界条件）：整轮文字都到齐后才
 * 朗读，因此 delta 要缓冲到 finishTurn。上限取 controller 的 maxBufferedChars 量级的
 * 4 倍——普通模式没有「边说边清」的机会，长回复超界则本轮纯文字（不截断朗读）。
 */
const DEFERRED_TURN_MAX_CHARS = 16_384

interface PendingDelta {
  readonly delta: string
  readonly chatSequence: number
}

interface TurnSession {
  readonly turnId: string
  readonly requestId: string
  readonly abort: AbortController
  /**
   * 早播（true）：delta 就绪即喂 controller 切段合成；
   * 普通 TTS（false）：delta 全部缓冲，finishTurn 时一次性 replay——同一 controller/
   * queue/ack 门，只是提交时机推到流结束（F5-007 边界条件「provider 已结束再合成
   * 属于普通 TTS」）。
   */
  readonly earlyPlayback: boolean
  /** bind 就绪前（早播）/ finishTurn 前（普通）的 delta 缓冲（有界）。 */
  pendingDeltas: PendingDelta[]
  pendingBufferChars: number
  /** finishTurn 先于 bind 完成到达时暂存（极短轮）。 */
  finishPending: { visibleChars: number; visibleSha256: string } | null
  /** 装配完成信号（controller 就绪或已降级）；settle 在装配完成前必须等它。 */
  readonly ready: Promise<void>
  /** ready 的 resolve 端（beginSessionAsync 所有出口都必须调用恰好一次）。 */
  readonly resolveReady: () => void
  provider: BoundTtsProvider | null
  controller: EarlyTtsController | null
  queue: TurnPlaybackQueue | null
  speakingStarted: boolean
  settleStarted: boolean
  cancelled: boolean
}

export interface VoiceOrchestratorDeps {
  readonly logger: Logger
  readonly registry: TtsRegistry
  readonly hostManager: PlaybackHostManager
  /**
   * chat paint ack gate（P3B-15A tracker.gate）；播放队列发声前等「文字已绘制」。
   * Internal 形状：test-tts 的 ack 豁免需要 observeAck 预喂 seq 0。
   */
  readonly ackGate: ChatRenderAckGateInternal
  readonly getTtsConfig: () => Readonly<TtsConfig>
  readonly runtime: () => 'dev' | 'test' | 'packaged-production'
  readonly emitEvent: (event: VoiceEvent) => void
  /** 设置页 provider/音色目录（main-only 路径已脱敏为 id/displayName）。 */
  readonly listProviderOptions?: () => readonly VoiceTtsProviderOption[]
  readonly listVoiceOptions?: () => readonly VoiceTtsVoiceOption[]
  /** 指标（P3B-21；未注入 = 不埋点）。 */
  readonly metrics?: MetricsRegistry
  readonly now?: () => number
}

export interface VoiceOrchestrator extends ChatVoiceTtsHook {
  /** `companion:voice:get-state` 投影。 */
  getState(): VoicePublicSnapshot
  /** `companion:voice:test-tts`：试听一句话（与 chat 语音互斥；先取消在播）。 */
  testTts(text: string): Promise<void>
  /** `companion:voice:cancel-speaking`：停止当前说话（幂等；返回是否有活跃 session）。 */
  cancelSpeaking(): boolean
  /** P3B-19：barge-in——用户开口打断当前 TTS/早播（幂等；返回是否真打断）。 */
  onBargeIn(): boolean
  /** app quit teardown：取消当前 session（registry.disposeAll 由组合根另行调用）。 */
  dispose(): void
}

export function createVoiceOrchestrator(deps: VoiceOrchestratorDeps): VoiceOrchestrator {
  const logger = deps.logger
  const now = deps.now ?? Date.now
  const metrics = deps.metrics

  let current: TurnSession | null = null
  let speakingRequestId: string | null = null
  let lastDegradedReason: VoicePublicSnapshot['lastDegradedReason'] = null

  function emit(event: VoiceEvent): void {
    try {
      deps.emitEvent(event)
    } catch {
      /* 事件发送失败不影响语音链路 */
    }
  }

  function logInfo(msg: string, fields: Record<string, unknown>): void {
    try {
      logger.info(msg, { scope: 'tts', ...fields })
    } catch {
      /* logger 抛错不影响语音链路 */
    }
  }

  function logWarn(msg: string, fields: Record<string, unknown>): void {
    try {
      logger.warn(msg, { scope: 'tts', ...fields })
    } catch {
      /* logger 抛错不影响语音链路 */
    }
  }

  // ── session 生命周期 ──

  function newSession(turnId: string, requestId: string, earlyPlayback: boolean): TurnSession {
    let resolveReady!: () => void
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve
    })
    void ready.catch(() => {}) // ready 永不 reject；防御浮空 promise
    return {
      turnId,
      requestId,
      abort: new AbortController(),
      earlyPlayback,
      pendingDeltas: [],
      pendingBufferChars: 0,
      finishPending: null,
      ready,
      resolveReady: () => resolveReady(),
      provider: null,
      controller: null,
      queue: null,
      speakingStarted: false,
      settleStarted: false,
      cancelled: false
    }
  }

  /** 恰好一次收尾：停 provider/queue、清 speaking、发 speaking-ended（若开过口）。 */
  async function settleSession(session: TurnSession): Promise<void> {
    if (session.settleStarted) return
    session.settleStarted = true
    // bind 尚未完成（极短轮 finishTurn 抢跑）：等装配结束（controller 就绪或已降级）
    if (session.controller === null && !session.cancelled) {
      await session.ready
    }
    let reason: 'completed' | 'cancelled' | 'degraded' = 'completed'
    if (session.controller !== null) {
      const outcome: EarlyTtsOutcome = await session.controller.whenSettled()
      recordOutcome(session, outcome)
      // 听到过声音（≥1 段播完）= completed；整轮无声（text-only/全部失败）= degraded。
      reason = outcome.cancelled
        ? 'cancelled'
        : outcome.playedSegments > 0
          ? 'completed'
          : 'degraded'
    } else if (session.cancelled) {
      reason = 'cancelled'
    }
    try {
      session.queue?.dispose()
    } catch {
      /* queue dispose 自身幂等且不抛；防御 */
    }
    const provider = session.provider
    session.provider = null
    if (provider !== null) {
      try {
        await provider.dispose()
      } catch (err) {
        logWarn('voice session provider dispose failed', {
          turnId: session.turnId,
          detail: err instanceof Error ? err.message : String(err)
        })
      }
    }
    if (current === session) current = null
    if (session.speakingStarted && speakingRequestId === session.requestId) {
      speakingRequestId = null
      emit({ type: 'speaking-ended', requestId: session.requestId, reason })
    }
  }

  /** 取消 session（幂等）：停 provider 合成、停队列（stage 停声+口型释放）。 */
  function cancelSession(session: TurnSession, reason: TtsCancelReason): void {
    if (session.cancelled) return
    session.cancelled = true
    session.abort.abort()
    try {
      session.queue?.cancel(reason)
    } catch (err) {
      logWarn('voice session queue cancel failed', {
        turnId: session.turnId,
        detail: err instanceof Error ? err.message : String(err)
      })
    }
    void Promise.resolve(session.controller?.cancel(reason)).catch(() => {})
    void settleSession(session)
  }

  /** 该轮退纯文字（bind 失败/text-only/缓冲超界）；无声音则无需等收尾。 */
  function degradeSession(session: TurnSession, reason: EarlyTtsDegradedReason): void {
    if (lastDegradedReason !== reason) lastDegradedReason = reason
    logInfo('voice turn text-only', {
      turnId: session.turnId,
      tags: { reason }
    })
    metrics?.counter('tts.early.textOnlyFallbacks').inc()
    cancelSession(session, 'provider-failed')
  }

  function recordOutcome(session: TurnSession, outcome: EarlyTtsOutcome): void {
    if (metrics === undefined) return
    try {
      metrics.counter('tts.early.turns').inc()
      metrics.counter('tts.early.committed').inc(outcome.committedSegments)
      metrics.counter('tts.early.played').inc(outcome.playedSegments)
      if (outcome.firstCommitMs !== null) {
        metrics.histogram('tts.early.firstCommitMs').observe(outcome.firstCommitMs)
      }
      if (outcome.firstAudioMs !== null) {
        metrics.histogram('tts.early.firstAudioMs').observe(outcome.firstAudioMs)
      }
      if (outcome.correctionDetected) metrics.counter('tts.early.selfCorrections').inc()
      if (outcome.fallbackToTextOnly) metrics.counter('tts.early.textOnlyFallbacks').inc()
      const queueHighWater = session.queue?.highWaterMark() ?? 0
      const queueGauge = metrics.gauge('tts.early.queueHighWater')
      queueGauge.set(Math.max(queueGauge.value(), queueHighWater))
    } catch {
      /* 指标失败不影响语音链路 */
    }
    logInfo('voice turn settled', {
      turnId: session.turnId,
      metrics: {
        committed: outcome.committedSegments,
        played: outcome.playedSegments,
        failed: outcome.failedSegments,
        firstAudioMs: outcome.firstAudioMs ?? -1,
        queueHighWater: session.queue?.highWaterMark() ?? 0,
        degradedReason: outcome.degradedReason ?? 'none'
      }
    })
  }

  /** 普通 TTS：finishTurn 时把整轮缓冲的 delta 按序喂给 controller（一次性提交）。 */
  function flushDeferred(session: TurnSession, controller: EarlyTtsController): void {
    if (session.pendingDeltas.length === 0) return
    for (const pending of session.pendingDeltas) {
      controller.appendCommittedText(pending)
    }
    session.pendingDeltas = []
    session.pendingBufferChars = 0
  }

  /** bind → queue → controller 的异步装配；delta 经缓冲 replay。所有出口 resolve ready。 */
  async function beginSessionAsync(session: TurnSession, tts: Readonly<TtsConfig>): Promise<void> {
    try {
      const port = deps.hostManager.acquire()
      if (port === null) {
        // host 缺失直接判 text-only：§1.14「恢复只从下一 turn 发声」，本轮不再等 host
        degradeSession(session, 'playback-host-unavailable')
        return
      }
      const bound = await deps.registry.bind({
        providerId: tts.provider,
        options: {
          voiceId: tts.voiceId,
          speed: tts.speed,
          pitch: tts.pitch,
          volume: tts.volume,
          requestedSampleRate: tts.sampleRate
        },
        turnId: session.turnId,
        requestId: session.requestId,
        signal: session.abort.signal,
        runtime: deps.runtime()
      })
      if (session.cancelled) {
        // 装配期间被取消：bind 出的实例必须 dispose（防泄漏）
        if (!isTtsTextOnly(bound)) {
          await Promise.resolve(bound.dispose()).catch(() => {})
        }
        return
      }
      if (isTtsTextOnly(bound)) {
        degradeSession(session, bound.reason)
        return
      }
      session.provider = bound
      const queue = createTurnPlaybackQueue({
        turnId: session.turnId,
        requestId: session.requestId,
        volume: tts.volume,
        port,
        ackGate: deps.ackGate,
        callbacks: {
          onSegmentStarted: (segmentId) => {
            session.controller?.reportPlaybackStarted(segmentId)
            if (!session.speakingStarted) {
              session.speakingStarted = true
              speakingRequestId = session.requestId
              emit({ type: 'speaking-started', requestId: session.requestId })
            }
          },
          onPaintToAudioOffset: (offsetMs) => {
            try {
              metrics?.histogram('voice.paintToAudioMs').observe(offsetMs)
            } catch {
              /* 指标失败不影响播放 */
            }
          },
          onSegmentEnded: (segmentId, ok) => {
            session.controller?.reportPlaybackEnded(segmentId, ok)
          },
          onTurnDegraded: (reason) => {
            if (lastDegradedReason !== reason) lastDegradedReason = reason
            session.controller?.reportPlaybackDegraded(reason)
          }
        },
        logger
      })
      session.queue = queue
      const controller = createEarlyTtsController(
        {
          turnId: session.turnId,
          requestId: session.requestId,
          options: {
            voiceId: tts.voiceId,
            speed: tts.speed,
            pitch: tts.pitch,
            volume: tts.volume,
            requestedSampleRate: tts.sampleRate
          },
          provider: bound
        },
        {
          logger,
          onSegmentReady: (segment) => {
            queue.enqueue(segment)
          }
        },
        { ...EARLY_TTS_OPTIONS_V1 }
      )
      session.controller = controller
      // 早播：replay bind 期间缓冲的 delta（到达序 = chatSequence 升序）。
      // 普通 TTS：继续缓冲，等 finishTurn 一次性 replay（见 flushDeferred）。
      if (session.earlyPlayback) {
        for (const pending of session.pendingDeltas) {
          controller.appendCommittedText(pending)
        }
        session.pendingDeltas = []
        session.pendingBufferChars = 0
      }
      if (session.finishPending !== null) {
        const finish = session.finishPending
        session.finishPending = null
        flushDeferred(session, controller)
        controller.finishText(finish)
      }
    } catch (err) {
      if (!session.cancelled) {
        // Registry 三道判定外的唯一抛错路径：配置指向未注册 provider（AppError CFG_INVALID）
        logWarn('voice session bind failed; turn text-only', {
          turnId: session.turnId,
          detail: err instanceof Error ? err.message : String(err)
        })
        degradeSession(session, 'provider-unhealthy')
      }
    } finally {
      session.resolveReady()
    }
  }

  // ── ChatVoiceTtsHook（全部同步返回，C17）──

  return {
    beginTurn({ turnId, requestId }) {
      // 防御：上一轮未收尾（ChatService busy guard 下不应发生）——按 new-turn 让位
      if (current !== null) cancelSession(current, 'new-turn')
      const tts = deps.getTtsConfig()
      if (!tts.enabled) {
        current = null
        return
      }
      const session = newSession(turnId, requestId, tts.earlyPlaybackEnabled)
      current = session
      void beginSessionAsync(session, tts)
    },

    onCommittedDelta({ delta, chatSequence }) {
      const session = current
      if (session === null || session.cancelled || delta.length === 0) return
      const controller = session.controller
      if (controller !== null && session.earlyPlayback) {
        controller.appendCommittedText({ delta, chatSequence })
        return
      }
      // 早播且 bind 未完成 / 普通 TTS 全程：有界缓冲（超界该轮 text-only，不无限涨）
      const limit = session.earlyPlayback ? PENDING_DELTA_BUFFER_MAX_CHARS : DEFERRED_TURN_MAX_CHARS
      session.pendingBufferChars += delta.length
      if (session.pendingBufferChars > limit) {
        degradeSession(session, 'queue-overflow')
        return
      }
      session.pendingDeltas.push({ delta, chatSequence })
    },

    finishTurn(input) {
      const session = current
      if (session === null || session.cancelled) return
      const controller = session.controller
      if (controller !== null) {
        // 普通 TTS：此刻整轮文字才喂进去（stream-end 尾段 = 整段朗读）
        flushDeferred(session, controller)
        // finishText 同步立即返回（C17）：排水全在 controller 后台
        controller.finishText(input)
      } else {
        session.finishPending = input
      }
      void settleSession(session)
    },

    abortTurn(reason) {
      const session = current
      if (session === null) return
      cancelSession(session, reason)
    },

    // ── voice handlers ──

    getState(): VoicePublicSnapshot {
      const tts = deps.getTtsConfig()
      return {
        ttsEnabled: tts.enabled,
        earlyPlaybackEnabled: tts.earlyPlaybackEnabled,
        providerId: tts.provider,
        providers: deps.listProviderOptions?.() ?? [],
        voices: deps.listVoiceOptions?.() ?? [],
        voiceConfigured: tts.voiceId.length > 0,
        hostAvailable: deps.hostManager.acquire() !== null,
        speaking: speakingRequestId !== null,
        speakingRequestId,
        lastDegradedReason
      }
    },

    async testTts(text) {
      const tts = deps.getTtsConfig()
      if (!tts.enabled) {
        throw new AppError({
          code: 'TTS_ENGINE_DOWN',
          userMessage: '语音朗读未开启，请先在设置中开启',
          severity: 'error',
          retryable: false
        })
      }
      if (deps.hostManager.acquire() === null) {
        throw new AppError({
          code: 'TTS_ENGINE_DOWN',
          userMessage: '播放通道不可用，请确认 Live2D 窗口或语音宿主已就绪',
          severity: 'error',
          retryable: true
        })
      }
      // 与 chat 语音互斥：试听让位（在播的按 new-turn 停声）
      if (current !== null) cancelSession(current, 'new-turn')
      // 试听没有对应的 chat 文字上屏（paint ack 豁免）：预喂 seq 0，
      // queue 的 waitForPainted(requestId, 0) 立即满足——不是绕过 C22，是域外豁免。
      const requestId = `tts-test-${randomUUID()}`
      deps.ackGate.observeAck(requestId, 0)
      // 试听文本一次到齐：按早播路径直接喂（缓冲 replay 语义等价）
      const session = newSession(`tts-test-${requestId}`, requestId, true)
      current = session
      await beginSessionAsync(session, tts)
      if (session.controller === null) {
        // bind text-only / host 中途消失：给设置页一个确定错误
        throw new AppError({
          code: 'TTS_ENGINE_DOWN',
          userMessage: '当前音色不可用，无法试听',
          severity: 'error',
          retryable: true
        })
      }
      session.controller.appendCommittedText({ delta: text, chatSequence: 0 })
      session.controller.finishText({
        visibleChars: text.length,
        visibleSha256: createHash('sha256').update(text).digest('hex')
      })
      void settleSession(session)
    },

    cancelSpeaking(): boolean {
      const session = current
      if (session === null) return false
      cancelSession(session, 'user-cancel')
      return true
    },

    onBargeIn(): boolean {
      const session = current
      if (session === null) return false
      const startedAt = now()
      cancelSession(session, 'barge-in')
      try {
        metrics?.histogram('voice.bargeIn.latencyMs').observe(Math.max(0, now() - startedAt))
      } catch {
        /* 指标失败不影响打断 */
      }
      return true
    },

    dispose() {
      if (current !== null) cancelSession(current, 'app-quit')
    }
  }
}
