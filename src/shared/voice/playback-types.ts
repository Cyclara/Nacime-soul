// src/shared/voice/playback-types.ts
// P3B-08 / F5-007 §1.14：TTS 专用音频 port 的跨进程消息 DTO 与运行时校验。
//
// 这些消息**不走普通 invoke/event IPC**（账本 §4.2 明示不为 PCM 登记通道名）：main 经
// MessageChannelMain 建专用 port 转交 stage，PCM frame / credit / started / ended 全在
// 这条 port 上流动。main 与 stage 两个进程都要 import 这些形状，因此真源放 shared
// （与 tts-types.ts 同例；F5-007 §3.1 manifest 写的 `src/main/voice/playback/types.ts`
// 由 main 侧 re-export 满足，类型形状一字未改）。
//
// 校验纪律（§1.14 第 7 条）：普通 IPC 六处 validator 不拿来验证每个音频 frame，但
// port 消息仍做运行时 shape/size/token 校验--renderer 侧是不可信输入面。校验函数为
// 纯函数，main（校验 stage->main 入站）与 stage（校验 main->stage 入站）双侧共用。

import type { PcmFormat, TtsCancelReason } from './tts-types'

/** §1.14：有界 frame 的 PCM 播放请求。 */
export interface PcmPlaybackRequest {
  type: 'audio'
  generation: string
  turnId: string
  segmentId: string
  sequence: number
  /** `${generation}:${segmentId}:${frameIndex}`，重复帧拒绝。 */
  frameId: string
  frameIndex: number
  format: PcmFormat
  /** 有界 frame；Electron 传输有复制成本，不宣称零拷贝。 */
  pcm: ArrayBuffer
  finalFrame: boolean
  volume: number
}

export type MainToStageAudioMessage =
  | PcmPlaybackRequest
  | { type: 'cancel'; generation: string; reason: TtsCancelReason }
  | { type: 'dispose'; generation: string }

/** §1.14：credit 是**绝对空闲字节**（不是 additive grant），creditSequence 单调防重复/乱序。 */
export interface StageCreditMessage {
  type: 'credit'
  generation: string
  /** 该 generation 启动时冻结；后续消息必须完全相同。 */
  capacityBytes: number
  /** 绝对空闲字节，不是 additive grant；单调序列防重复/乱序。 */
  availableBytes: number
  creditSequence: number
}

export type StageToMainAudioMessage =
  | StageCreditMessage
  | { type: 'started'; generation: string; segmentId: string; audioStartAt: number }
  | { type: 'ended'; generation: string; segmentId: string; playedMs: number }
  | { type: 'cancelled'; generation: string; segmentId?: string; reason: TtsCancelReason }
  | { type: 'error'; generation: string; segmentId?: string; code: string }

// ── 校验边界（§1.14 第 7 条 shape/size/token；值与消息里的 id 同界） ──

export const AUDIO_PORT_GENERATION_MAX_LENGTH = 64
export const AUDIO_PORT_ID_MAX_LENGTH = 128
export const AUDIO_PORT_CODE_MAX_LENGTH = 64
/** 单 frame PCM 字节硬上限（协议层；发送侧运营值见 main 侧 PLAYBACK_QUEUE_POLICY_V1）。 */
export const AUDIO_PORT_FRAME_BYTES_MAX = 262_144
/** volume 文档未定界；接受 0..2（含轻度过载）。收紧只改此常量。 */
export const AUDIO_PORT_VOLUME_MAX = 2

const CANCEL_REASONS: readonly TtsCancelReason[] = [
  'user-cancel',
  'barge-in',
  'new-turn',
  'provider-failed',
  'window-destroyed',
  'app-quit'
]

function isFiniteInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maxLength
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

/** 允许键集合的子集（可选键场景：segmentId 省略时是 host 级消息）。 */
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function isPcmFormat(value: unknown): value is PcmFormat {
  if (typeof value !== 'object' || value === null) return false
  const format = value as Record<string, unknown>
  return (
    isFiniteInt(format['sampleRate'], 8_000, 96_000) &&
    format['channels'] === 1 &&
    format['sampleFormat'] === 'f32le' &&
    format['interleaved'] === true
  )
}

/** stage 侧入站校验（main->stage 方向）；测试的假 port 也用它断言线格式。 */
export function isPcmPlaybackRequest(value: unknown): value is PcmPlaybackRequest {
  if (typeof value !== 'object' || value === null) return false
  const msg = value as Record<string, unknown>
  if (msg['type'] !== 'audio') return false
  if (
    !hasExactKeys(msg, [
      'type',
      'generation',
      'turnId',
      'segmentId',
      'sequence',
      'frameId',
      'frameIndex',
      'format',
      'pcm',
      'finalFrame',
      'volume'
    ])
  ) {
    return false
  }
  const generation = msg['generation']
  const segmentId = msg['segmentId']
  const frameIndex = msg['frameIndex']
  if (!isBoundedString(generation, AUDIO_PORT_GENERATION_MAX_LENGTH)) return false
  if (!isBoundedString(msg['turnId'], AUDIO_PORT_ID_MAX_LENGTH)) return false
  if (!isBoundedString(segmentId, AUDIO_PORT_ID_MAX_LENGTH)) return false
  if (!isFiniteInt(msg['sequence'], 0, Number.MAX_SAFE_INTEGER)) return false
  if (!isFiniteInt(frameIndex, 0, Number.MAX_SAFE_INTEGER)) return false
  // frameId 是 token：三段必须与本消息字段严格一致，防拼接/重放错位
  if (msg['frameId'] !== `${generation}:${segmentId}:${frameIndex}`) return false
  if (!isPcmFormat(msg['format'])) return false
  const pcm = msg['pcm']
  if (!(pcm instanceof ArrayBuffer)) return false
  if (pcm.byteLength === 0 || pcm.byteLength > AUDIO_PORT_FRAME_BYTES_MAX) return false
  if (pcm.byteLength % 4 !== 0) return false // f32 样本必须整组
  if (typeof msg['finalFrame'] !== 'boolean') return false
  if (!isFiniteInt(msg['volume'], 0, AUDIO_PORT_VOLUME_MAX)) return false
  return true
}

export function isMainToStageAudioMessage(value: unknown): value is MainToStageAudioMessage {
  if (typeof value !== 'object' || value === null) return false
  const msg = value as Record<string, unknown>
  switch (msg['type']) {
    case 'audio':
      return isPcmPlaybackRequest(value)
    case 'cancel':
      return (
        hasExactKeys(msg, ['type', 'generation', 'reason']) &&
        isBoundedString(msg['generation'], AUDIO_PORT_GENERATION_MAX_LENGTH) &&
        CANCEL_REASONS.includes(msg['reason'] as TtsCancelReason)
      )
    case 'dispose':
      return (
        hasExactKeys(msg, ['type', 'generation']) &&
        isBoundedString(msg['generation'], AUDIO_PORT_GENERATION_MAX_LENGTH)
      )
    default:
      return false
  }
}

/** main 侧入站校验：stage 回报的 credit/started/ended/cancelled/error。 */
export function isStageToMainAudioMessage(value: unknown): value is StageToMainAudioMessage {
  if (typeof value !== 'object' || value === null) return false
  const msg = value as Record<string, unknown>
  const generation = msg['generation']
  switch (msg['type']) {
    case 'credit':
      return (
        hasExactKeys(msg, [
          'type',
          'generation',
          'capacityBytes',
          'availableBytes',
          'creditSequence'
        ]) &&
        isBoundedString(generation, AUDIO_PORT_GENERATION_MAX_LENGTH) &&
        isFiniteInt(msg['capacityBytes'], 0, Number.MAX_SAFE_INTEGER) &&
        isFiniteInt(msg['availableBytes'], 0, Number.MAX_SAFE_INTEGER) &&
        isFiniteInt(msg['creditSequence'], 0, Number.MAX_SAFE_INTEGER)
      )
    case 'started':
      return (
        hasExactKeys(msg, ['type', 'generation', 'segmentId', 'audioStartAt']) &&
        isBoundedString(generation, AUDIO_PORT_GENERATION_MAX_LENGTH) &&
        isBoundedString(msg['segmentId'], AUDIO_PORT_ID_MAX_LENGTH) &&
        isFiniteInt(msg['audioStartAt'], 0, Number.MAX_SAFE_INTEGER)
      )
    case 'ended':
      return (
        hasExactKeys(msg, ['type', 'generation', 'segmentId', 'playedMs']) &&
        isBoundedString(generation, AUDIO_PORT_GENERATION_MAX_LENGTH) &&
        isBoundedString(msg['segmentId'], AUDIO_PORT_ID_MAX_LENGTH) &&
        isFiniteInt(msg['playedMs'], 0, Number.MAX_SAFE_INTEGER)
      )
    case 'cancelled':
      return (
        hasOnlyKeys(msg, ['type', 'generation', 'segmentId', 'reason']) &&
        isBoundedString(generation, AUDIO_PORT_GENERATION_MAX_LENGTH) &&
        (msg['segmentId'] === undefined ||
          isBoundedString(msg['segmentId'], AUDIO_PORT_ID_MAX_LENGTH)) &&
        CANCEL_REASONS.includes(msg['reason'] as TtsCancelReason)
      )
    case 'error':
      return (
        hasOnlyKeys(msg, ['type', 'generation', 'segmentId', 'code']) &&
        isBoundedString(generation, AUDIO_PORT_GENERATION_MAX_LENGTH) &&
        (msg['segmentId'] === undefined ||
          isBoundedString(msg['segmentId'], AUDIO_PORT_ID_MAX_LENGTH)) &&
        isBoundedString(msg['code'], AUDIO_PORT_CODE_MAX_LENGTH)
      )
    default:
      return false
  }
}
