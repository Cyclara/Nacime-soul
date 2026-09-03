// src/main/voice/playback/audio-port.ts
// P3B-08 / F5-007 §1.14：StageAudioPort 实现--generation + 绝对 credit 协议。
//
// 协议铁律（§1.14，验收 C20）：
//   1. stage ready 后 main 建 channel 转交 renderer port；每次 stage 重建生成新 generation。
//   2. stage 先发 creditSequence=0 的绝对 credit，冻结 capacityBytes；main 只在
//      frameBytes <= availableBytes 时发送，发送后本地扣减。
//   3. credit 是**绝对空闲字节**：只有 stage 真正释放 frame/AudioBuffer 后才递增
//      creditSequence 并报告新的 availableBytes--main 不做加法，只整体替换。
//   4. main 只接受当前 generation、capacity 一致、creditSequence 严格大于已见值的
//      credit；available clamp 到 [0, capacityBytes]。重复/乱序/旧 generation 丢弃
//      并记协议错误。
//   5. 所有消息带 generation；旧窗口/旧 port/迟到事件直接丢弃。
//
// transport（真实 MessageChannelMain + webContents.postMessage）由 P3B-15 的组合根
// 注入；本模块只面向 MessagePortMainLike 抽象，测试用内存假 port。

import type { Logger } from '@shared/observability/types'
import type { PcmFormat, TtsCancelReason } from '@shared/voice/tts-types'
import { isStageToMainAudioMessage } from '@shared/voice/playback-types'
import type { StageToMainAudioMessage } from '@shared/voice/playback-types'
import type {
  MessagePortMainLike,
  OutboundAudioFrame,
  SendFrameResult,
  StageAudioPort
} from './types'

type MessageHandler = (message: StageToMainAudioMessage) => void
type ClosedHandler = () => void

function logWarn(
  logger: Logger,
  msg: string,
  fields: Record<string, unknown>,
  generation: string
): void {
  try {
    logger.warn(msg, { scope: 'tts', tags: { generation }, ...fields })
  } catch {
    /* logger 抛错不影响协议层（C15 精神） */
  }
}

/** frameId token：三段拼接，stage 侧按此拒绝重复/错位帧（§1.14）。 */
export function buildFrameId(generation: string, segmentId: string, frameIndex: number): string {
  return `${generation}:${segmentId}:${frameIndex}`
}

export function createStageAudioPort(options: {
  generation: string
  port: MessagePortMainLike
  logger: Logger
}): StageAudioPort {
  const { generation, port, logger } = options

  let closed = false
  let capacityBytes: number | null = null
  let availableBytes = 0
  let lastCreditSequence = -1
  let protocolErrors = 0
  const messageHandlers = new Set<MessageHandler>()
  const closedHandlers = new Set<ClosedHandler>()

  function emitClosed(): void {
    closed = true
    for (const handler of closedHandlers) handler()
  }

  function handleInbound(data: unknown): void {
    if (closed) return
    if (!isStageToMainAudioMessage(data)) {
      protocolErrors += 1
      logWarn(logger, 'audio-port: dropped malformed stage message', { protocolErrors }, generation)
      return
    }
    const message = data
    if (message.generation !== generation) {
      // 旧 generation / 迟到事件直接丢弃（§1.14 第 5 条）
      protocolErrors += 1
      logWarn(
        logger,
        'audio-port: dropped stale-generation message',
        { protocolErrors },
        generation
      )
      return
    }
    if (message.type === 'credit') {
      if (message.creditSequence <= lastCreditSequence) {
        // 重复/乱序 credit 丢弃且**不改变**可用量（C20）
        protocolErrors += 1
        logWarn(
          logger,
          'audio-port: dropped duplicate/out-of-order credit',
          {
            protocolErrors,
            metrics: { creditSequence: message.creditSequence, lastCreditSequence }
          },
          generation
        )
        return
      }
      if (capacityBytes !== null && message.capacityBytes !== capacityBytes) {
        // capacity 在该 generation 启动时冻结，后续必须完全相同
        protocolErrors += 1
        logWarn(
          logger,
          'audio-port: dropped credit with changed capacity',
          { protocolErrors, metrics: { expected: capacityBytes, got: message.capacityBytes } },
          generation
        )
        return
      }
      if (message.availableBytes > message.capacityBytes) {
        // clamp 到 [0, capacity]，不算协议错误（§1.14 第 4 条）
        message.availableBytes = message.capacityBytes
      }
      capacityBytes = message.capacityBytes
      availableBytes = message.availableBytes
      lastCreditSequence = message.creditSequence
    }
    for (const handler of messageHandlers) handler(message)
  }

  port.on('message', (event) => handleInbound(event.data))
  port.on('close', () => {
    if (!closed) emitClosed()
  })

  return {
    generation,
    get isAlive() {
      return !closed
    },
    get capacityBytes() {
      return capacityBytes
    },
    get availableBytes() {
      return availableBytes
    },
    get protocolErrors() {
      return protocolErrors
    },

    sendFrame(frame: OutboundAudioFrame): SendFrameResult {
      if (closed) return 'closed'
      const frameBytes = frame.pcm.byteLength
      if (capacityBytes !== null && frameBytes > capacityBytes) return 'frame-too-large'
      if (capacityBytes === null || availableBytes < frameBytes) return 'no-credit'
      const message = {
        type: 'audio' as const,
        generation,
        turnId: frame.turnId,
        segmentId: frame.segmentId,
        sequence: frame.sequence,
        frameId: buildFrameId(generation, frame.segmentId, frame.frameIndex),
        frameIndex: frame.frameIndex,
        format: frame.format,
        pcm: frame.pcm,
        finalFrame: frame.finalFrame,
        volume: frame.volume
      }
      try {
        port.postMessage(message)
      } catch (err) {
        logWarn(
          logger,
          'audio-port: postMessage failed; treating port as closed',
          { detail: err instanceof Error ? err.message : String(err) },
          generation
        )
        if (!closed) emitClosed()
        return 'closed'
      }
      availableBytes -= frameBytes
      return 'sent'
    },

    sendCancel(reason: TtsCancelReason): void {
      if (closed) return
      try {
        port.postMessage({ type: 'cancel', generation, reason })
      } catch {
        /* 关闭竞态下尽力而为 */
      }
    },

    sendDispose(): void {
      if (closed) return
      try {
        port.postMessage({ type: 'dispose', generation })
      } catch {
        /* 关闭竞态下尽力而为 */
      }
    },

    close(): void {
      if (closed) return
      emitClosed()
      try {
        port.close()
      } catch {
        /* 关闭竞态 */
      }
    },

    onMessage(handler: MessageHandler) {
      messageHandlers.add(handler)
      return () => messageHandlers.delete(handler)
    },

    onClosed(handler: ClosedHandler) {
      closedHandlers.add(handler)
      return () => closedHandlers.delete(handler)
    }
  }
}

/** 供发送侧自检/测试复用：mono f32 的字节换算。 */
export function pcmBytesFor(pcm: Float32Array): number {
  return pcm.byteLength
}

/** 期望 PCM 时长（毫秒）；队列 watchdog 用。 */
export function pcmDurationMs(pcm: Float32Array, format: PcmFormat): number {
  if (format.sampleRate <= 0) return 0
  return (pcm.length / format.sampleRate) * 1_000
}
