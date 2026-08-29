// src/main/config/schema/ui.ts
// UI 域 Valibot schema
// 依据：S-005 §3.5

import * as v from 'valibot'
import { THEME_SETTING_IDS } from '@shared/config/themes'

const WindowConfigSchema = v.object({
  width: v.pipe(v.number(), v.integer(), v.minValue(480), v.maxValue(3840)),
  height: v.pipe(v.number(), v.integer(), v.minValue(600), v.maxValue(2160)),
  x: v.optional(v.pipe(v.number(), v.integer())),
  y: v.optional(v.pipe(v.number(), v.integer())),
  maximized: v.boolean()
})

const ChatUiConfigSchema = v.object({
  sendOnEnter: v.boolean(),
  showTimestamps: v.boolean(),
  showReasoning: v.boolean()
})

const OnboardingConfigSchema = v.object({
  version: v.literal(1),
  stage: v.picklist(['provider-setup', 'connection-test', 'first-conversation', 'complete']),
  completedAt: v.optional(v.pipe(v.number(), v.finite(), v.integer(), v.minValue(0))),
  voiceSendMode: v.optional(v.picklist(['draft', 'send']))
})

const Live2dConfigSchema = v.object({
  enabled: v.boolean(),
  zoom: v.pipe(v.number(), v.finite(), v.minValue(0.25), v.maxValue(3)),
  alwaysOnTop: v.boolean(),
  // 取景偏移按画布百分比存储；required + 默认 0，老配置由 deepMergeWithDefaults 补齐。
  offsetX: v.pipe(v.number(), v.finite(), v.minValue(-100), v.maxValue(100)),
  offsetY: v.pipe(v.number(), v.finite(), v.minValue(-100), v.maxValue(100)),
  // Additive within config schema v1; undefined placeholder in defaults preserves old files.
  selectedModelId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128), v.regex(/^[A-Za-z0-9._:-]+$/)))
})

/**
 * UI 配置 schema。
 * 窗口位置 x/y 的显示器存在性校验在运行时做（S-005 §3.5），
 * schema 只保证整数。
 */
export const UiConfigSchema = v.object({
  locale: v.picklist(['zh-CN', 'en-US']),
  theme: v.picklist(THEME_SETTING_IDS),
  fontScale: v.pipe(v.number(), v.finite(), v.minValue(0.8), v.maxValue(1.5)),
  reduceMotion: v.boolean(),
  onboarding: OnboardingConfigSchema,
  window: WindowConfigSchema,
  chat: ChatUiConfigSchema,
  live2d: Live2dConfigSchema
})
