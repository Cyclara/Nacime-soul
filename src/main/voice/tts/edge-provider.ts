// src/main/voice/tts/edge-provider.ts
// P3B-03：Edge dev/test 占位 provider。
//
// 定位（T-09 / 2026-08-03 审计裁定二 + F5-007 §1.3）：
//   - 这是 dev/test 里「听得见声音」的占位实现（Windows SAPI 本地合成，零网络、零新依赖），
//     **不是** Edge 神经网络音色，也不追求音色身份匹配--它只为打通链路存在。
//   - capabilities.devTestOnly = true；Registry（P3B-02）在生产资格门拦截，
//     本 factory 同时自检 runtime 双保险（F5-007 原文「Factory 必须在创建 provider 前返回」）。
//     任何一层命中都绝不实例化合成器。
//   - 生产环境不显示、不自动 fallback、无 renderer override；定制音色失败永不落到这里。
//
// 速度/音量/采样率的归属：speed 在 bind 时换算成 SAPI Rate 冻结；requestedSampleRate
// 由 adapter 重采样保证（PCM 与 format 一致）；volume 由播放侧应用
// （F5-007 §1.14 PcmPlaybackRequest.volume），PCM 不预乘；pitch SAPI 不支持，占位忽略。

import { AppError, isAppError } from '@shared/errors'
import type { Logger } from '@shared/observability/types'
import type {
  BoundTtsProvider,
  TtsProviderCapabilities,
  TtsProviderFactory
} from '@shared/voice/tts-types'
import { decodeWavToMonoF32, resampleLinearF32 } from './wav'

export const EDGE_TTS_PROVIDER_ID = 'edge'

export const EDGE_TTS_CAPABILITIES: Readonly<TtsProviderCapabilities> = Object.freeze({
  streamingText: false,
  streamingAudio: false,
  supportsCancel: true,
  devTestOnly: true,
  segmentCorrelation: false
})

/** 交给真实 runner（edge-sapi-runner）的最小合成请求；测试注入假实现替换整层。 */
export interface EdgeSapiSynthesisInput {
  readonly text: string
  readonly voice: string
  /** SAPI Rate，-10..10；由 options.speed 在 bind 时冻结换算。 */
  readonly rate: number
  readonly signal: AbortSignal
}

/** speed 倍率（0.5x..2x clamp）-> SAPI Rate（约对数刻度，-10..10）。 */
export function sapiRateFromSpeed(speed: number): number {
  const clamped = Math.min(2, Math.max(0.5, speed))
  const rate = Math.round(Math.log2(clamped) * 10)
  return Math.min(10, Math.max(-10, rate))
}

/**
 * SAPI voice 名白名单：只放行安全字符集。不合法/为空 -> null（runner 回退系统默认
 * voice，占位语义）。voiceId 是用户配置值，进 PowerShell 前必须收敛。
 */
export function sanitizeSapiVoiceName(voice: string): string | null {
  if (voice.length === 0 || voice.length > 64) return null
  return /^[A-Za-z0-9 ._-]+$/.test(voice) ? voice : null
}

function abortError(): Error {
  const err = new Error('edge tts synthesis aborted')
  err.name = 'AbortError'
  return err
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

export function createEdgeTtsProviderFactory(deps: {
  readonly logger: Logger
  /** 真实实现 spawn PowerShell SAPI 返回 WAV bytes（edge-sapi-runner.ts）；测试注入假实现。 */
  readonly synthesizeToWav: (input: EdgeSapiSynthesisInput) => Promise<Buffer>
}): TtsProviderFactory {
  return {
    async bind(input) {
      // 双保险第一层（Registry 已拦截过；这里按 F5-007 原文自检）：生产绝不实例化。
      if (input.runtime === 'packaged-production') {
        deps.logger.warn('edge tts rejected: dev-test-only provider in packaged production', {
          scope: 'tts',
          turnId: input.turnId,
          tags: { provider: EDGE_TTS_PROVIDER_ID }
        })
        return { textOnly: true, reason: 'provider-unhealthy' }
      }
      if (input.options.voiceId.length === 0) {
        return { textOnly: true, reason: 'voice-missing' }
      }

      const requestedSampleRate = input.options.requestedSampleRate
      const rate = sapiRateFromSpeed(input.options.speed)
      // provider 内部取消信号：外层 turn signal、cancel()、dispose() 三者都汇聚到这里
      const controller = new AbortController()
      const onOuterAbort = (): void => controller.abort()
      if (input.signal.aborted) controller.abort()
      else input.signal.addEventListener('abort', onOuterAbort, { once: true })

      const bound: BoundTtsProvider = {
        id: EDGE_TTS_PROVIDER_ID,
        capabilities: EDGE_TTS_CAPABILITIES,
        format: {
          sampleRate: requestedSampleRate,
          channels: 1,
          sampleFormat: 'f32le',
          interleaved: true
        },
        async synthesize(text, voice) {
          if (controller.signal.aborted) throw abortError()
          if (text.length === 0) return new Float32Array(0)
          if (voice.length === 0) throw new Error('edge tts: voice must not be empty')
          try {
            const wav = await deps.synthesizeToWav({ text, voice, rate, signal: controller.signal })
            const decoded = decodeWavToMonoF32(wav)
            return resampleLinearF32(decoded.pcm, decoded.sampleRate, requestedSampleRate)
          } catch (err) {
            if (isAbortError(err)) throw err
            if (isAppError(err)) throw err
            throw new AppError({
              code: 'TTS_ENGINE_DOWN',
              userMessage: '语音合成失败，本轮改为纯文字。',
              severity: 'error',
              retryable: true,
              cause: err
            })
          }
        },
        async health() {
          // 占位 provider 只存在于 dev/test：health 恒健康，真实可用性由每次 synthesize 兑现
          return { healthy: true, checkedAt: Date.now() }
        },
        cancel(reason) {
          deps.logger.info('edge tts cancelled', {
            scope: 'tts',
            tags: { provider: EDGE_TTS_PROVIDER_ID, reason }
          })
          controller.abort()
        },
        dispose() {
          controller.abort()
        }
      }
      return bound
    }
  }
}
