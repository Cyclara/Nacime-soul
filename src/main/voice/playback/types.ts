// src/main/voice/playback/types.ts
// P3B-08 / F5-007 §1.14/§1.5：main 侧播放层类型--port 抽象、ChatRenderAckGate、
// turn 播放队列合同。跨进程 DTO 真源在 @shared/voice/playback-types（renderer 侧
// P3B-16 也要 import；F5-007 §3.1 manifest 把 types.ts 列在 main 侧，由本文件
// re-export 满足）。实现：audio-port.ts / ack-gate.ts / queue.ts。

import type { PcmFormat, TtsCancelReason } from '@shared/voice/tts-types'
import type { StageToMainAudioMessage } from '@shared/voice/playback-types'
import type { Unsubscribe } from '@shared/ipc/contracts'
import type { ReadyTtsSegment, PlaybackDegradedReason } from '../tts/early-controller'

export type {
  MainToStageAudioMessage,
  PcmPlaybackRequest,
  StageCreditMessage,
  StageToMainAudioMessage
} from '@shared/voice/playback-types'

/** §1.14：每 stage generation 一个 port；消息在专用 MessageChannelMain 上流动。 */
export interface MessagePortMainLike {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  on(event: 'close', listener: () => void): void
  close(): void
}

/** 生产环境由 P3B-15 用 MessageChannelMain + webContents.postMessage 实现；测试注入假 port。 */
export interface StagePortTransport {
  /** 建 channel 并把 renderer 端转交 stage；返回 main 端。stage 不可用返回 null。 */
  createPort(): MessagePortMainLike | null
}

// ── ChatRenderAckGate（§1.5 冻结接口；P3B-15A 的 chat:ack-rendered 通道喂 observeAck） ──

export interface ChatRenderAck {
  requestId: string
  sequence: number
  paintedAt: number
}

export interface ChatRenderAckGate {
  /** 等 chat renderer 已 apply state 并至少经过下一次 requestAnimationFrame。 */
  waitForPainted(requestId: string, sequence: number, signal: AbortSignal): Promise<ChatRenderAck>
}

// ── StageAudioPort（generation + 绝对 credit 协议的 main 侧） ──

export type SendFrameResult =
  | 'sent'
  /** C20：无 credit（或余额不足）不发送；等待 stage 回收后重试。 */
  | 'no-credit'
  /** frame 超过 generation 冻结容量，永远发不出去。 */
  | 'frame-too-large'
  | 'closed'

/** 待发送 frame（generation/frameId 由 port 内部补齐）。 */
export interface OutboundAudioFrame {
  turnId: string
  segmentId: string
  sequence: number
  frameIndex: number
  format: PcmFormat
  pcm: ArrayBuffer
  finalFrame: boolean
  volume: number
}

export interface StageAudioPort {
  readonly generation: string
  readonly isAlive: boolean
  /** 首个 credit 冻结前为 null（此间 sendFrame 一律 no-credit，C20）。 */
  readonly capacityBytes: number | null
  readonly availableBytes: number
  /** 丢弃的协议违规消息计数（重复/乱序 credit、旧 generation、坏形状）。 */
  readonly protocolErrors: number
  sendFrame(frame: OutboundAudioFrame): SendFrameResult
  sendCancel(reason: TtsCancelReason): void
  sendDispose(): void
  close(): void
  onMessage(handler: (message: StageToMainAudioMessage) => void): Unsubscribe
  onClosed(handler: () => void): Unsubscribe
}

// ── turn 播放队列（P3B-08 主体；组合根 P3B-18 持有并映射回调到 controller） ──

export interface PlaybackQueueCallbacks {
  /** stage 报 started：PCM ready 不等于用户已听见（§1.14）。 */
  onSegmentStarted(segmentId: string): void
  /** 对应 chat sequence painted 到 stage 真正 started 的有符号偏差（ms；负值表示协议违例）。 */
  onPaintToAudioOffset?(offsetMs: number): void
  onSegmentEnded(segmentId: string, ok: boolean): void
  /** §1.13 STOP_AFTER_CURRENT -> TEXT_ONLY(remainder)：剩余纯文字，绝不换音色。 */
  onTurnDegraded(reason: PlaybackDegradedReason): void
  /** host 级故障（port 关闭/销毁）通知组合根：后续 turn 也 text-only 直到恢复（§1.14）。 */
  onHostUnavailable?(): void
}

export interface TurnPlaybackQueue {
  /** controller 的 onSegmentReady 出口；按到达顺序（= sequence 顺序）入队。 */
  enqueue(segment: ReadyTtsSegment): void
  /** 本轮已接收但尚未播放完成的 segment 最大数量（当前段 + pending），P3B-21 指标源。 */
  highWaterMark(): number
  /** 用户取消/barge-in/新轮/app quit：立即停（发 port cancel，stage 同步停+口型释放）。 */
  cancel(reason: TtsCancelReason): void
  /** 本地清理（turn settle 后 teardown）：不发 port 消息、不停在播音频。 */
  dispose(): void
}
