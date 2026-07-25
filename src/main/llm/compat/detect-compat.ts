// src/main/llm/compat/detect-compat.ts
// P1-18: 兼容层 - 4 个 Phase 1 compat flags 自动检测
// 依据：S-001 P1-18、技术分析 §4.5.1（Pi detectCompat() 思路）、S-005 §3.2 compatOverrides
//
// 两层解析模式（借鉴 Pi getCompat()）：
//   1. detectCompat() 从 provider + baseUrl 自动推断
//   2. resolveCompat() 用 model.compatOverrides 逐字段显式覆盖（nullish coalescing）
//   优先级：显式配置 > 自动推断 > 默认值
//
// Phase 1 只实现 4 个标志的判断逻辑：
//   thinkingFormat / supportsToolCalls / supportsVision / maxTokensField
// 其余 10 个保留在 Pi 的接口定义中（undefined），将来接入新模型时直接启用。

import type { CompatFlags, CompatOverrides } from '../types'

/** 默认 compat flags（最保守值） */
const DEFAULT_COMPAT: CompatFlags = {
  thinkingFormat: 'none',
  supportsToolCalls: false,
  supportsVision: false,
  maxTokensField: 'max_tokens'
}

/**
 * 从 provider + baseUrl 自动检测 compat flags。
 * 依据技术分析 §4.5.1：detectCompat() 从 provider + baseUrl 自动推断。
 *
 * 检测规则基于 Pi 源码（api/openai-completions.ts:1173）简化：
 *   - DeepSeek：thinking_type + max_tokens + supportsToolCalls
 *   - OpenAI：none + max_completion_tokens + supportsToolCalls + supportsVision
 *   - 其他：默认值
 *
 * @param provider 配置中的 provider slug（如 'deepseek'、'openai'）
 * @param baseUrl API base URL
 */
export function detectCompat(provider: string, baseUrl: string): CompatFlags {
  const lowerProvider = provider.toLowerCase()
  const lowerUrl = baseUrl.toLowerCase()

  // DeepSeek V4：思考模式用 {"thinking":{"type":"enabled"}}（默认 enabled）
  // 来源：https://api-docs.deepseek.com/zh-cn/guides/thinking_mode（2026-07-15 实测）
  // deepseek-chat/deepseek-reasoner 将于 2026/07/24 废弃，对应 deepseek-v4-flash 的非思考/思考模式
  // DeepSeek 同时提供 Anthropic 端点（https://api.deepseek.com/anthropic），Phase 4+ Anthropic Adapter 用
  if (lowerProvider === 'deepseek' || lowerUrl.includes('deepseek.com')) {
    return {
      ...DEFAULT_COMPAT,
      thinkingFormat: 'thinking_type',
      supportsToolCalls: true
    }
  }

  // OpenAI 官方
  if (lowerProvider === 'openai' || lowerUrl.includes('api.openai.com')) {
    return {
      ...DEFAULT_COMPAT,
      maxTokensField: 'max_completion_tokens',
      supportsToolCalls: true,
      supportsVision: true
    }
  }

  // Moonshot（月之暗面）
  if (
    lowerProvider === 'moonshot' ||
    lowerProvider === 'moonshotai' ||
    lowerUrl.includes('api.moonshot.')
  ) {
    return {
      ...DEFAULT_COMPAT,
      supportsToolCalls: true
    }
  }

  // DashScope（阿里通义）- enable_thinking 风格
  if (lowerUrl.includes('dashscope.aliyuncs.com') || lowerProvider === 'dashscope') {
    return {
      ...DEFAULT_COMPAT,
      thinkingFormat: 'enable_thinking',
      supportsToolCalls: true,
      supportsVision: true
    }
  }

  // OpenRouter - 转发多厂商，默认保守
  if (lowerProvider === 'openrouter' || lowerUrl.includes('openrouter.ai')) {
    return {
      ...DEFAULT_COMPAT,
      maxTokensField: 'max_completion_tokens',
      supportsToolCalls: true,
      supportsVision: true
    }
  }

  return { ...DEFAULT_COMPAT }
}

/**
 * 解析最终 compat flags：自动检测 + 显式覆盖。
 * 依据技术分析 §4.5.1 getCompat()：model.compat 逐字段显式覆盖（nullish coalescing）。
 *
 * 优先级：显式配置（compatOverrides） > 自动推断（detectCompat） > 默认值
 *
 * @param provider 配置中的 provider slug
 * @param baseUrl API base URL
 * @param overrides 用户在配置中显式设置的 compatOverrides
 */
export function resolveCompat(
  provider: string,
  baseUrl: string,
  overrides: CompatOverrides
): CompatFlags {
  const detected = detectCompat(provider, baseUrl)

  return {
    thinkingFormat: overrides.thinkingFormat ?? detected.thinkingFormat,
    supportsToolCalls: overrides.supportsToolCalls ?? detected.supportsToolCalls,
    supportsVision: overrides.supportsVision ?? detected.supportsVision,
    maxTokensField: overrides.maxTokensField ?? detected.maxTokensField
  }
}
