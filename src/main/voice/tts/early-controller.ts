// src/main/voice/tts/early-controller.ts
// P3B-07 / F5-007-2：EarlyTtsController--turn 级早期播放状态机。
//
// 合同要点（F5-007 §1.4/1.5/1.6/1.11/1.13）：
//   - append 只接受已放行对用户的 releaseText；pending tail 有界（maxBufferedChars），
//     已提交正文只留 offset/hash，长回复不突破内存界（S12/ETTS-C12）。
//   - finishText **同步立即返回**（void）：ChatService 随即发 completed、释放 active turn，
//     绝不等待合成或播放（C17）；尾段由后台 worker 在配额释放后继续 commit，
//     pending 清空后才恰好一次进入 input-ended（C21：admission 满时尾段不丢）。
//   - admission ledger 统一计数 committed+synthesizing+ready（playing 另算），
//     满时不 commit、不丢文字（C04）；播放层经 reportPlaybackStarted/Ended 回报释放配额。
//   - 非流式 worker 并发 = 1：合成 N+1 与播放 N 可重叠，两次合成不重叠（§1.11，C02）。
//   - 失败降级（§1.13）：首段合成失败（尚无任何已播音频）-> 本轮 text-only；
//     其后失败 -> 已 ready/在播的不动，剩余纯文字。绝不换音色、绝不整段重播。
//   - cancel 幂等；本地立即停，provider 清理有界 best-effort。
//   - 内部任何异常 fail-open 到文字流（C15）：controller 标 text-only，不影响 ChatService。
//
// 本文件不含播放/端口（P3B-08）：ready 段经 deps.onSegmentReady 交给播放层，
// 播放层回 reportPlaybackStarted/Ended 驱动状态与配额。

import { createHash } from 'node:crypto'
import type { Logger } from '@shared/observability/types'
import type {
  BoundTtsProvider,
  EarlyTtsDegradedReason,
  PcmFormat,
  TtsCancelReason,
  TtsSynthesisOptions
} from '@shared/voice/tts-types'
import { isSelfCorrection } from './correction-detector'
import { scanSegments, type SegmentBoundaryKind } from './segmenter'

export type { EarlyTtsDegradedReason } from '@shared/voice/tts-types'

/**
 * 播放层（P3B-08）可上报的降级原因子集（§1.13/§1.14/§1.10.2 的播放侧）：
 * port 消失/never-credit -> playback-host-unavailable；paint ack 超时 ->
 * chat-render-ack-timeout；PCM 超界 -> queue-overflow；stage 报不支持格式 ->
 * unsupported-format。合成侧原因（synthesis-error 等）不经此口。
 */
export type PlaybackDegradedReason = Extract<
  EarlyTtsDegradedReason,
  'queue-overflow' | 'unsupported-format' | 'playback-host-unavailable' | 'chat-render-ack-timeout'
>

export interface EarlyTtsControllerOptions {
  readonly enabled: boolean
  readonly firstMinUnits: number
  readonly nextMinUnits: number
  readonly maxHoldMs: number
  readonly targetMaxGraphemes: number
  readonly hardMaxGraphemes: number
  readonly maxAheadSegments: number
  readonly maxBufferedChars: number
}

export interface EarlyTtsTurnContext {
  readonly turnId: string
  readonly requestId: string
  /** voiceId 唯一真源。 */
  readonly options: Readonly<TtsSynthesisOptions>
  readonly provider: BoundTtsProvider
}

export type EarlyTtsSegmentState =
  'draft' | 'committed' | 'synthesizing' | 'ready' | 'playing' | 'played' | 'failed' | 'cancelled'

export type EarlyTtsInputState =
  'accepting' | 'input-draining' | 'input-ended' | 'settled' | 'cancelled'

export interface EarlyTtsSegment {
  readonly id: string
  readonly sequence: number
  readonly text: string
  readonly chatSequenceStart: number
  readonly chatSequenceEnd: number
  readonly startOffset: number
  readonly endOffset: number
  readonly boundary: SegmentBoundaryKind
  state: EarlyTtsSegmentState
  correctionRole: 'none' | 'self-correction'
  readonly createdAt: number
  readonly committedAt: number
}

/** 交给播放层的 ready 段（P3B-08 消费；gap 提示来自 §1.12.2）。 */
export interface ReadyTtsSegment {
  readonly segmentId: string
  readonly sequence: number
  readonly pcm: Float32Array
  readonly format: PcmFormat
  readonly boundary: SegmentBoundaryKind
  readonly chatSequenceStart: number
  readonly chatSequenceEnd: number
  readonly correctionRole: 'none' | 'self-correction'
  /** 自我纠正段 0-80ms 内的接续提示；正常段 0 = 播放层按 §1.15 标点映射。 */
  readonly suggestedGapMs: number
}

export interface EarlyTtsOutcome {
  enabled: boolean
  textCharsSeen: number
  committedSegments: number
  playedSegments: number
  failedSegments: number
  correctionDetected: boolean
  fallbackToTextOnly: boolean
  firstCommitMs: number | null
  firstAudioMs: number | null
  cancelled: boolean
  degradedReason?: EarlyTtsDegradedReason
}

export interface EarlyTtsControllerDeps {
  readonly logger: Logger
  readonly now?: () => number
  /** ready 段出口；播放层（P3B-08）接端口/信用协议。 */
  readonly onSegmentReady: (segment: ReadyTtsSegment) => void
  /** whenSettled 的有界等待（C17：never-settling 时后台收尾也要能结束）。 */
  readonly settleTimeoutMs?: number
  /** provider.cancel 的有界等待。 */
  readonly providerCleanupTimeoutMs?: number
}

export interface EarlyTtsController {
  appendCommittedText(input: { delta: string; chatSequence: number }): void
  finishText(input: { visibleChars: number; visibleSha256: string }): void
  whenSettled(): Promise<EarlyTtsOutcome>
  cancel(reason: TtsCancelReason): Promise<void>
  outcome(): EarlyTtsOutcome
  /** 播放层回报：ready -> playing（playing 不占 admission 配额，§1.10.2）。 */
  reportPlaybackStarted(segmentId: string): void
  /** 播放层回报：playing/ready -> played（成功）或 failed（播放侧失败）。 */
  reportPlaybackEnded(segmentId: string, ok: boolean): void
  /**
   * 播放层回报（P3B-08）：host 消失 / ack 超时 / PCM 超界 -> 剩余纯文字
   * （§1.13 STOP_AFTER_CURRENT）。queue-overflow 走软停：停止继续合成/提交，
   * 但已 ready/在播的音频继续播完（§1.10.2「不丢已 ready 音频」）；其余取消
   * 未播队列、在播段自然结束。
   */
  reportPlaybackDegraded(reason: PlaybackDegradedReason): void
}

const SETTLE_TIMEOUT_DEFAULT_MS = 120_000
const PROVIDER_CLEANUP_TIMEOUT_DEFAULT_MS = 5_000
/** 自我纠正段与上一段的建议间隔（§1.12.2：0-80ms 区间内取固定值）。 */
const SELF_CORRECTION_GAP_MS = 60

interface DeltaRange {
  /** 绝对 UTF-16 偏移（最终可见文本坐标系）。 */
  readonly startOffset: number
  readonly endOffset: number
  readonly chatSequence: number
}

export function createEarlyTtsController(
  context: EarlyTtsTurnContext,
  deps: EarlyTtsControllerDeps,
  options: EarlyTtsControllerOptions
): EarlyTtsController {
  const now = deps.now ?? Date.now
  const turnStartedAt = now()

  // ── SegmenterState（§1.6）：pending tail 是唯一受 maxBufferedChars 约束的文本 ──
  let pendingText = ''
  let pendingStartOffset = 0
  let pendingDeltas: DeltaRange[] = []
  let totalCharsSeen = 0
  const incrementalHash = createHash('sha256')
  let nextSequence = 0
  let firstPendingCharAt: number | null = null
  let lastChatSequence: number | null = null

  let inputState: EarlyTtsInputState = 'accepting'
  const segments: EarlyTtsSegment[] = []
  let synthesizing = false
  let textOnlyRemainder = options.enabled ? false : true
  let degradedReason: EarlyTtsDegradedReason | undefined = options.enabled ? undefined : 'disabled'
  let cancelled = false
  let endInputDone = false
  let holdTimer: ReturnType<typeof setTimeout> | null = null
  let settleTimer: ReturnType<typeof setTimeout> | null = null
  let settled = false

  const outcome: EarlyTtsOutcome = {
    enabled: options.enabled,
    textCharsSeen: 0,
    committedSegments: 0,
    playedSegments: 0,
    failedSegments: 0,
    correctionDetected: false,
    fallbackToTextOnly: false,
    firstCommitMs: null,
    firstAudioMs: null,
    cancelled: false
  }

  let settleResolve: ((o: EarlyTtsOutcome) => void) | null = null
  const settledPromise = new Promise<EarlyTtsOutcome>((resolve) => {
    settleResolve = resolve
  })

  function logWarn(msg: string, fields: Record<string, unknown>): void {
    try {
      deps.logger.warn(msg, {
        scope: 'tts',
        turnId: context.turnId,
        tags: { provider: context.provider.id },
        ...fields
      })
    } catch {
      /* logger 抛错不影响文字流（C15） */
    }
  }

  function clearHoldTimer(): void {
    if (holdTimer !== null) {
      clearTimeout(holdTimer)
      holdTimer = null
    }
  }

  /** admission ledger：committed + synthesizing + ready（playing 另算，§1.10.2）。 */
  function admissionCount(): number {
    return segments.filter(
      (s) => s.state === 'committed' || s.state === 'synthesizing' || s.state === 'ready'
    ).length
  }

  function allSegmentsTerminal(): boolean {
    return segments.every(
      (s) => s.state === 'played' || s.state === 'failed' || s.state === 'cancelled'
    )
  }

  function finalizeOutcome(): void {
    outcome.textCharsSeen = totalCharsSeen
    outcome.committedSegments = segments.length
    outcome.playedSegments = segments.filter((s) => s.state === 'played').length
    outcome.failedSegments = segments.filter((s) => s.state === 'failed').length
    outcome.fallbackToTextOnly = textOnlyRemainder || segments.length === 0
    outcome.degradedReason = degradedReason
  }

  function trySettle(): void {
    if (settled) return
    const inputDone = inputState === 'input-ended' || inputState === 'cancelled'
    if (!inputDone) return
    // 只有「还在乎合成结果」时才等 in-flight：降级/取消后被放弃的合成不应卡住
    // 收尾（其结果会被 target.state === 'cancelled' 守卫丢弃）
    if (synthesizing && !textOnlyRemainder && !cancelled) return
    if (!allSegmentsTerminal()) return
    inputState = 'settled'
    settled = true
    clearHoldTimer()
    if (settleTimer !== null) {
      clearTimeout(settleTimer)
      settleTimer = null
    }
    finalizeOutcome()
    settleResolve?.(outcome)
  }

  async function boundedProviderCleanup(reason: TtsCancelReason): Promise<void> {
    try {
      await Promise.race([
        Promise.resolve(context.provider.cancel(reason)).then(
          () => undefined,
          () => undefined
        ),
        new Promise<void>((resolve) =>
          setTimeout(resolve, deps.providerCleanupTimeoutMs ?? PROVIDER_CLEANUP_TIMEOUT_DEFAULT_MS)
        )
      ])
    } catch {
      /* best-effort */
    }
  }

  /** 降级：取消未开始/未播的合成与队列；正在播的由播放层自然结束（§1.13）。 */
  function degradeToTextOnly(reason: EarlyTtsDegradedReason): void {
    if (degradedReason === undefined) degradedReason = reason
    textOnlyRemainder = true
    for (const seg of segments) {
      if (seg.state === 'committed' || seg.state === 'synthesizing' || seg.state === 'ready') {
        seg.state = 'cancelled'
      }
    }
    pendingText = ''
    pendingDeltas = []
    clearHoldTimer()
    void boundedProviderCleanup('provider-failed')
  }

  /**
   * 软停（§1.10.2 队列超界）：停止继续合成/提交，但**不丢已 ready 音频**--
   * synthesizing 让它完成（结果仍经 onSegmentReady 交给播放层），ready/playing
   * 继续播完；只把尚未开始的 committed 段判死（其文字早已可见）。
   */
  function softStopAfterCurrent(reason: EarlyTtsDegradedReason): void {
    if (degradedReason === undefined) degradedReason = reason
    textOnlyRemainder = true
    for (const seg of segments) {
      if (seg.state === 'committed') seg.state = 'cancelled'
    }
    pendingText = ''
    pendingDeltas = []
    clearHoldTimer()
  }

  /** 提交一个切出的前缀 segment（endOffset 相对 pending 起点）。 */
  function commitSegment(
    text: string,
    relativeEndOffset: number,
    boundary: SegmentBoundaryKind
  ): void {
    const sequence = nextSequence++
    const startOffset = pendingStartOffset
    const endOffset = pendingStartOffset + relativeEndOffset
    // 本段覆盖的 chat sequence 范围：与 [startOffset, endOffset) 相交的 delta
    let chatStart = lastChatSequence ?? 0
    let chatEnd = lastChatSequence ?? 0
    const overlapping = pendingDeltas.filter(
      (d) => d.endOffset > startOffset && d.startOffset < endOffset
    )
    if (overlapping.length > 0) {
      chatStart = overlapping[0]!.chatSequence
      chatEnd = overlapping[overlapping.length - 1]!.chatSequence
    }
    segments.push({
      id: `${context.turnId}:tts:${sequence}`,
      sequence,
      text,
      chatSequenceStart: chatStart,
      chatSequenceEnd: chatEnd,
      startOffset,
      endOffset,
      boundary,
      state: 'committed',
      correctionRole: isSelfCorrection(text) ? 'self-correction' : 'none',
      createdAt: now(),
      committedAt: now()
    })
    if (segments[segments.length - 1]!.correctionRole === 'self-correction') {
      outcome.correctionDetected = true
    }
    if (outcome.firstCommitMs === null) outcome.firstCommitMs = now() - turnStartedAt
    // 从 pending 左侧移除已提交前缀，裁剪 delta 区间表
    pendingText = pendingText.slice(relativeEndOffset)
    pendingStartOffset = endOffset
    pendingDeltas = pendingDeltas.filter((d) => d.endOffset > endOffset)
    if (pendingText.length === 0) {
      pendingDeltas = []
      firstPendingCharAt = null
      clearHoldTimer()
    }
    outcome.committedSegments = segments.length
  }

  /** 非流式合成 worker：并发 1（§1.11，C02）。 */
  async function synthesizeNext(): Promise<void> {
    if (synthesizing || textOnlyRemainder || cancelled) return
    const target = segments.find((s) => s.state === 'committed')
    if (target === undefined) return
    synthesizing = true
    target.state = 'synthesizing'
    try {
      const pcm = await context.provider.synthesize(target.text, context.options.voiceId)
      if (cancelled || readState(target) === 'cancelled') return
      validatePcm(pcm)
      target.state = 'ready'
      if (outcome.firstAudioMs === null) outcome.firstAudioMs = now() - turnStartedAt
      deps.onSegmentReady({
        segmentId: target.id,
        sequence: target.sequence,
        pcm,
        format: context.provider.format,
        boundary: target.boundary,
        chatSequenceStart: target.chatSequenceStart,
        chatSequenceEnd: target.chatSequenceEnd,
        correctionRole: target.correctionRole,
        suggestedGapMs: target.correctionRole === 'self-correction' ? SELF_CORRECTION_GAP_MS : 0
      })
    } catch (err) {
      if (cancelled || readState(target) === 'cancelled') return
      const hadPlayedAudio = segments.some((s) => s.state === 'played' || s.state === 'playing')
      target.state = 'failed'
      logWarn('early-tts synthesis failed; degrading remainder to text-only', {
        detail: err instanceof Error ? err.message : String(err),
        metrics: { sequence: target.sequence, hadPlayedAudio }
      })
      degradeToTextOnly('synthesis-error')
    } finally {
      synthesizing = false
      pump()
    }
  }

  /**
   * 经函数边界读取 segment 状态：degradeToTextOnly/cancel 会在 await 期间跨闭包
   * 把 synthesizing 段改成 cancelled，而 TS 的属性窄化看不到这种变异。
   */
  function readState(seg: EarlyTtsSegment): EarlyTtsSegmentState {
    return seg.state
  }

  /** PCM 有界校验（§1.11）：finite + 非空；格式以 provider.format 为权威。 */
  function validatePcm(pcm: Float32Array): void {
    if (pcm.length === 0) throw new Error('empty pcm')
    for (let i = 0; i < pcm.length; i++) {
      if (!Number.isFinite(pcm[i]!)) throw new Error('non-finite pcm sample')
    }
  }

  /** 主泵：提交可切前缀 -> 触发合成 -> 收尾判定。append/finish/播放回报/hold 超时后调用。 */
  function pump(): void {
    if (cancelled || settled) return
    try {
      const streamEnded = inputState === 'input-draining'

      // 1) admission 有空位时从 pending 左侧提交 segment（含 stream-end 尾段）
      while (
        !textOnlyRemainder &&
        pendingText.length > 0 &&
        admissionCount() < options.maxAheadSegments
      ) {
        const holdExpired =
          firstPendingCharAt !== null && now() - firstPendingCharAt >= options.maxHoldMs
        const result = scanSegments({
          pending: pendingText,
          config: {
            firstMinUnits: options.firstMinUnits,
            nextMinUnits: options.nextMinUnits,
            targetMaxGraphemes: options.targetMaxGraphemes,
            hardMaxGraphemes: options.hardMaxGraphemes
          },
          isFirstSegment: segments.length === 0,
          holdExpired,
          streamEnd: streamEnded
        })
        if (result.segments.length === 0) break
        // scanSegments 的 endOffset 全部相对**扫描时**的 pending；逐段提交会
        // 逐次左移 pending，因此每段的实际切长 = endOffset - 本轮已消费偏移
        let consumedInScan = 0
        let committedAny = false
        for (const seg of result.segments) {
          if (admissionCount() >= options.maxAheadSegments) break
          commitSegment(seg.text, seg.endOffset - consumedInScan, seg.boundary)
          consumedInScan = seg.endOffset
          committedAny = true
        }
        if (!committedAny) break
      }

      // 2) pending 超界安全阀（S12：唯一受 maxBufferedChars 约束的文本不能无限涨）
      if (!textOnlyRemainder && pendingText.length > options.maxBufferedChars) {
        const overflowed = pendingText.length
        logWarn('early-tts pending buffer overflow; remainder text-only', {
          metrics: { bufferedChars: overflowed }
        })
        degradeToTextOnly('queue-overflow')
      }

      // 3) 排水收口：文本流结束且 pending 全部提交 -> 恰好一次 input-ended（C21）
      if (inputState === 'input-draining' && !endInputDone && pendingText.length === 0) {
        endInputDone = true
        inputState = 'input-ended'
      }
      if (inputState === 'input-draining' && !endInputDone && textOnlyRemainder) {
        endInputDone = true
        inputState = 'input-ended'
      }

      // 4) 触发合成（并发 1）
      void synthesizeNext()

      // 5) 收尾
      trySettle()
    } catch (err) {
      // fail-open（C15）：任何内部异常 -> 本轮纯文字，文字流不受影响
      logWarn('early-tts internal error; fail-open to text', {
        detail: err instanceof Error ? err.message : String(err)
      })
      degradeToTextOnly('segmenter-error')
      trySettle()
    }
  }

  return {
    appendCommittedText({ delta, chatSequence }) {
      if (cancelled || inputState !== 'accepting') return
      if (delta.length === 0) return
      // sequence 必须严格递增，否则降级 text-only（§1.6 规则 1）
      if (lastChatSequence !== null && chatSequence <= lastChatSequence) {
        logWarn('early-tts chat sequence not increasing; degrade to text-only', {
          metrics: { got: chatSequence, last: lastChatSequence }
        })
        degradeToTextOnly('segmenter-error')
        return
      }
      totalCharsSeen += delta.length
      incrementalHash.update(delta)
      outcome.textCharsSeen = totalCharsSeen
      const deltaStart = pendingStartOffset + pendingText.length
      pendingText += delta
      pendingDeltas.push({
        startOffset: deltaStart,
        endOffset: deltaStart + delta.length,
        chatSequence
      })
      lastChatSequence = chatSequence
      if (firstPendingCharAt === null) {
        firstPendingCharAt = now()
        // hold timer：只触发重新判定，不直接强制切（§1.9）
        clearHoldTimer()
        holdTimer = setTimeout(() => {
          holdTimer = null
          pump()
        }, options.maxHoldMs)
      }
      pump()
    },

    finishText({ visibleChars, visibleSha256 }) {
      if (cancelled || inputState !== 'accepting') return // 重复调用幂等（C14）
      const digest = incrementalHash.digest('hex')
      if (visibleChars !== totalCharsSeen || digest !== visibleSha256) {
        // C13：不猜、不补全文、不重播；取消未播放工作，剩余纯文字
        logWarn('early-tts final text mismatch; degrade to text-only', {
          metrics: {
            expectedChars: visibleChars,
            seenChars: totalCharsSeen,
            hashMatch: digest === visibleSha256
          }
        })
        degradeToTextOnly('segmenter-error')
        inputState = 'input-ended'
        endInputDone = true
        trySettle()
        return
      }
      inputState = 'input-draining'
      // 同步立即返回（§1.5）：后续排水全在后台 pump
      pump()
    },

    whenSettled() {
      if (!settled && settleTimer === null) {
        const timeoutMs = deps.settleTimeoutMs ?? SETTLE_TIMEOUT_DEFAULT_MS
        settleTimer = setTimeout(() => {
          settleTimer = null
          if (!settled) {
            // C17：never-settling 的后台收尾超时--把一切非终态段封账为 cancelled
            logWarn('early-tts settle timeout; force settling', { metrics: { timeoutMs } })
            if (!cancelled) {
              for (const seg of segments) {
                if (seg.state !== 'played' && seg.state !== 'failed' && seg.state !== 'cancelled') {
                  seg.state = 'cancelled'
                }
              }
              textOnlyRemainder = true
            }
            settled = true
            finalizeOutcome()
            settleResolve?.(outcome)
          }
        }, timeoutMs)
      }
      return settledPromise
    },

    async cancel(reason) {
      if (cancelled || settled) return
      cancelled = true
      outcome.cancelled = true
      inputState = 'cancelled'
      clearHoldTimer()
      pendingText = ''
      pendingDeltas = []
      for (const seg of segments) {
        if (seg.state !== 'played' && seg.state !== 'failed') seg.state = 'cancelled'
      }
      await boundedProviderCleanup(reason)
      trySettle()
    },

    outcome() {
      return { ...outcome, degradedReason }
    },

    reportPlaybackStarted(segmentId) {
      const seg = segments.find((s) => s.id === segmentId)
      if (seg === undefined || seg.state !== 'ready') return
      seg.state = 'playing'
      // playing 不占 admission（§1.10.2）：让出配额给后续提交
      pump()
    },

    reportPlaybackEnded(segmentId, ok) {
      const seg = segments.find((s) => s.id === segmentId)
      if (seg === undefined) return
      if (seg.state !== 'playing' && seg.state !== 'ready') return
      seg.state = ok ? 'played' : 'failed'
      pump()
    },

    reportPlaybackDegraded(reason) {
      if (cancelled || settled) return
      if (reason === 'queue-overflow') {
        softStopAfterCurrent(reason)
      } else {
        degradeToTextOnly(reason)
      }
      pump()
      trySettle()
    }
  }
}
