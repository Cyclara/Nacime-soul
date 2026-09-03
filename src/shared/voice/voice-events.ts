// src/shared/voice/voice-events.ts
// P3B-14：`companion:event:voice-state` 的载荷（S-006-补充 §1.4 voice store 的
// 唯一事件源；P3B-14 先落语音输入/测试录音所需子集，P3B-18 orchestrator 扩
// speaking 事件——additive，不改已有形状）。
//
// 纪律：事件只投影状态与结果，不携带音频/路径/原始错误文本（F5-001「审查
// 不可见」同款精神；错误用枚举码）。

import type { AsrErrorCode } from './asr-types'
import type { EarlyTtsDegradedReason } from './tts-types'

/** VAD 三态（与 main 侧 VadStateMachine 同一状态机；单一来源在本文件）。 */
export type VoiceVadState = 'idle' | 'active' | 'inactive'

export type VoiceEvent =
  /** 开始监听（start-listening 成功，麦克风已开）。 */
  | { readonly type: 'listening-started' }
  /** 停止监听：user=用户停止；mic-closed=采集端关闭（停止/出错/设备拔出）；error=启动失败。 */
  | {
      readonly type: 'listening-stopped'
      readonly reason: 'user' | 'mic-closed' | 'error'
      readonly errorCode?: AsrErrorCode
    }
  /** VAD 状态迁移（UI 电平/说话指示；仅监听期间发）。 */
  | { readonly type: 'vad-state'; readonly state: VoiceVadState }
  /** 一段话语转写完成（VAD speech_end -> ASR 定稿）。 */
  | { readonly type: 'transcript'; readonly text: string }
  /**
   * P3V-09：流式识别的**半成品**转写——还会被后续音频改写。
   * UI 只做灰色预览，不入对话历史、不触发发送；离线引擎永远不发这个事件。
   */
  | { readonly type: 'transcript-partial'; readonly text: string }
  /** 识别失败（会话继续；UI 提示可重试）。 */
  | { readonly type: 'asr-error'; readonly code: AsrErrorCode }
  // ── P3B-18：TTS 侧（orchestrator 发；只有真开了口才成对出现）──
  /** 首个 segment 被 stage 确认 started：用户真的听见了（§1.14 started 才标 playing）。 */
  | { readonly type: 'speaking-started'; readonly requestId: string }
  /**
   * 本轮语音终局。completed=自然播完；cancelled=用户取消/barge-in/app-quit；
   * degraded=播放降级（host 消失/ack 超时/合成失败——本轮或剩余轮纯文字）。
   */
  | {
      readonly type: 'speaking-ended'
      readonly requestId: string
      readonly reason: 'completed' | 'cancelled' | 'degraded'
    }

/** 说话状态投影的结束原因（speaking-ended.reason 的真源别名，UI/测试共用）。 */
export type VoiceSpeakingEndReason = Extract<VoiceEvent, { type: 'speaking-ended' }>['reason']

// ── P3B-18：`companion:voice:test-tts` 请求（试听；无音色/路径参数——一切以当前配置为准）──

export interface VoiceTestTtsRequest {
  readonly text: string
}

/** 试听文本上限：设置页一句话试听远小于此；超界=协议错误。 */
export const VOICE_TEST_TTS_TEXT_MAX_CHARS = 2_000

export function isVoiceTestTtsRequest(value: unknown): value is VoiceTestTtsRequest {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    Object.keys(v).length === 1 &&
    typeof v['text'] === 'string' &&
    v['text'].length >= 1 &&
    v['text'].length <= VOICE_TEST_TTS_TEXT_MAX_CHARS
  )
}

// ── P3B-18：`companion:voice:get-state` 的投影（无正文/无路径/无自由文本）──

export interface VoiceTtsProviderOption {
  readonly id: string
  readonly displayName: string
  /** 运行状态；available=无需常驻服务（Edge）或已配置待启动，running=服务就绪。 */
  readonly state: 'available' | 'starting' | 'running' | 'failed'
  readonly devTestOnly: boolean
}

export interface VoiceTtsVoiceOption {
  readonly id: string
  readonly providerId: string
  readonly displayName: string
}

export interface VoicePublicSnapshot {
  /** 配置开关：TTS 关闭时 orchestrator 全旁路（无 session、恒不发声）。 */
  readonly ttsEnabled: boolean
  /** F5-007 §3.2「提前朗读」开关：true=边生成边分段朗读；false=整轮文字到齐后朗读。 */
  readonly earlyPlaybackEnabled: boolean
  /** 当前配置指向的 provider id（未注册 provider 在 bind 时判 text-only）。 */
  readonly providerId: string
  /** 当前安装可用的 provider（无路径/命令行）；设置页据此展示而非硬编码猜测。 */
  readonly providers: readonly VoiceTtsProviderOption[]
  /** provider 对应的可选音色；仅 id/displayName，不暴露权重/参考音频绝对路径。 */
  readonly voices: readonly VoiceTtsVoiceOption[]
  /** voiceId 非空（空 = 恒 voice-missing 纯文字，裁定二）。 */
  readonly voiceConfigured: boolean
  /** stage PlaybackHost 可用（port 存活）；false 时播放纯文字直到 stage 重建。 */
  readonly hostAvailable: boolean
  /** stage 已确认在播（speaking-started 后、speaking-ended 前）。 */
  readonly speaking: boolean
  /** 正在说的轮（speaking=true 时非空）。 */
  readonly speakingRequestId: string | null
  /** 最近一次降级原因（本轮「只有文字」的 UI 提示源；null=无）。 */
  readonly lastDegradedReason: EarlyTtsDegradedReason | null
}

// ── 运行时校验（IPC event validator / renderer store 防御共用）──

const VAD_STATES: readonly VoiceVadState[] = ['idle', 'active', 'inactive']
const SPEAKING_END_REASONS: readonly VoiceSpeakingEndReason[] = [
  'completed',
  'cancelled',
  'degraded'
]

export function isVoiceEvent(value: unknown): value is VoiceEvent {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  switch (v['type']) {
    case 'listening-started':
      return Object.keys(v).length === 1
    case 'listening-stopped': {
      if (!['user', 'mic-closed', 'error'].includes(String(v['reason']))) return false
      const keys = Object.keys(v)
      return keys.length === 2 || (keys.length === 3 && typeof v['errorCode'] === 'string')
    }
    case 'vad-state':
      return (
        Object.keys(v).length === 2 &&
        typeof v['state'] === 'string' &&
        (VAD_STATES as readonly string[]).includes(v['state'])
      )
    case 'transcript':
    case 'transcript-partial':
      return Object.keys(v).length === 2 && typeof v['text'] === 'string'
    case 'asr-error':
      return Object.keys(v).length === 2 && typeof v['code'] === 'string'
    case 'speaking-started':
      return Object.keys(v).length === 2 && typeof v['requestId'] === 'string'
    case 'speaking-ended':
      return (
        Object.keys(v).length === 3 &&
        typeof v['requestId'] === 'string' &&
        typeof v['reason'] === 'string' &&
        (SPEAKING_END_REASONS as readonly string[]).includes(v['reason'])
      )
    default:
      return false
  }
}
