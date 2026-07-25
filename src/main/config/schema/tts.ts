// src/main/config/schema/tts.ts
// TTS 域 Valibot schema
// 依据：S-005 §3.3

import * as v from 'valibot'

/**
 * TTS 配置 schema。
 * API key 不在此处，单独走 SecretStore（S-005 §1）。
 */
export const TtsConfigSchema = v.object({
  enabled: v.boolean(),
  provider: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(64)),
  voiceId: v.pipe(v.string(), v.trim(), v.maxLength(128)),
  speed: v.pipe(v.number(), v.finite(), v.minValue(0.5), v.maxValue(2)),
  pitch: v.pipe(v.number(), v.finite(), v.minValue(-12), v.maxValue(12)),
  volume: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1)),
  sampleRate: v.picklist([16000, 22050, 24000, 44100, 48000]),
  cacheEnabled: v.boolean(),
  earlyPlaybackEnabled: v.boolean()
})
