// src/main/llm/compat/detect-compat.test.ts
// P1-18 测试：compat flags 自动检测 + 显式覆盖
// 依据：S-001 P1-18 验收、S-004 §3.3.1 合同门禁 #5（Provider scope）
//       技术分析 §4.5.1 Pi detectCompat()/getCompat() 两层解析模式

import { describe, it, expect } from 'vitest'
import { detectCompat, resolveCompat } from './detect-compat'
import type { CompatOverrides } from '../types'

describe('detectCompat', () => {
  it('DeepSeek 检测：thinking_type + max_tokens + supportsToolCalls', () => {
    const compat = detectCompat('deepseek', 'https://api.deepseek.com/v1')
    expect(compat.thinkingFormat).toBe('thinking_type')
    expect(compat.maxTokensField).toBe('max_tokens')
    expect(compat.supportsToolCalls).toBe(true)
    expect(compat.supportsVision).toBe(false)
  })

  it('DeepSeek 通过 baseUrl 检测（provider 不匹配）', () => {
    const compat = detectCompat('custom', 'https://api.deepseek.com/v1')
    expect(compat.thinkingFormat).toBe('thinking_type')
  })

  it('OpenAI 检测：max_completion_tokens + supportsToolCalls + supportsVision', () => {
    const compat = detectCompat('openai', 'https://api.openai.com/v1')
    expect(compat.thinkingFormat).toBe('none')
    expect(compat.maxTokensField).toBe('max_completion_tokens')
    expect(compat.supportsToolCalls).toBe(true)
    expect(compat.supportsVision).toBe(true)
  })

  it('OpenAI 通过 baseUrl 检测', () => {
    const compat = detectCompat('custom', 'https://api.openai.com/v1')
    expect(compat.maxTokensField).toBe('max_completion_tokens')
  })

  it('Moonshot 检测：supportsToolCalls=true', () => {
    const compat = detectCompat('moonshot', 'https://api.moonshot.cn/v1')
    expect(compat.supportsToolCalls).toBe(true)
    expect(compat.thinkingFormat).toBe('none')
  })

  it('DashScope 检测：enable_thinking 风格', () => {
    const compat = detectCompat('dashscope', 'https://dashscope.aliyuncs.com/v1')
    expect(compat.thinkingFormat).toBe('enable_thinking')
    expect(compat.supportsToolCalls).toBe(true)
    expect(compat.supportsVision).toBe(true)
  })

  it('OpenRouter 检测：max_completion_tokens', () => {
    const compat = detectCompat('openrouter', 'https://openrouter.ai/api/v1')
    expect(compat.maxTokensField).toBe('max_completion_tokens')
    expect(compat.supportsToolCalls).toBe(true)
  })

  it('未知 provider 返回默认值（保守）', () => {
    const compat = detectCompat('unknown-provider', 'https://example.com/v1')
    expect(compat.thinkingFormat).toBe('none')
    expect(compat.maxTokensField).toBe('max_tokens')
    expect(compat.supportsToolCalls).toBe(false)
    expect(compat.supportsVision).toBe(false)
  })

  it('大小写不敏感：DEEPSEEK 也匹配', () => {
    const compat = detectCompat('DeepSeek', 'https://API.DEEPSEEK.COM/v1')
    expect(compat.thinkingFormat).toBe('thinking_type')
  })
})

describe('resolveCompat', () => {
  it('无 override 时使用自动检测结果', () => {
    const compat = resolveCompat('deepseek', 'https://api.deepseek.com/v1', {})
    expect(compat.thinkingFormat).toBe('thinking_type')
    expect(compat.maxTokensField).toBe('max_tokens')
  })

  it('显式 override 覆盖自动检测', () => {
    const overrides: CompatOverrides = {
      thinkingFormat: 'reasoning_split',
      maxTokensField: 'max_completion_tokens'
    }
    const compat = resolveCompat('deepseek', 'https://api.deepseek.com/v1', overrides)
    // override > detect
    expect(compat.thinkingFormat).toBe('reasoning_split')
    expect(compat.maxTokensField).toBe('max_completion_tokens')
    // 未 override 的字段使用 detect 结果
    expect(compat.supportsToolCalls).toBe(true)
  })

  it('部分 override：只覆盖指定字段，其余用检测值', () => {
    const overrides: CompatOverrides = {
      supportsVision: true
    }
    const compat = resolveCompat('deepseek', 'https://api.deepseek.com/v1', overrides)
    expect(compat.supportsVision).toBe(true) // override
    expect(compat.thinkingFormat).toBe('thinking_type') // detect
    expect(compat.supportsToolCalls).toBe(true) // detect
    expect(compat.maxTokensField).toBe('max_tokens') // detect
  })

  it('空 override 对象 = 纯自动检测', () => {
    const compat = resolveCompat('openai', 'https://api.openai.com/v1', {})
    expect(compat.maxTokensField).toBe('max_completion_tokens')
    expect(compat.supportsVision).toBe(true)
  })

  it('override 全部字段', () => {
    const overrides: CompatOverrides = {
      thinkingFormat: 'enable_thinking',
      supportsToolCalls: false,
      supportsVision: false,
      maxTokensField: 'max_tokens'
    }
    const compat = resolveCompat('openai', 'https://api.openai.com/v1', overrides)
    expect(compat.thinkingFormat).toBe('enable_thinking')
    expect(compat.supportsToolCalls).toBe(false)
    expect(compat.supportsVision).toBe(false)
    expect(compat.maxTokensField).toBe('max_tokens')
  })

  it('未知 provider + 无 override = 全默认值', () => {
    const compat = resolveCompat('unknown', 'https://example.com', {})
    expect(compat.thinkingFormat).toBe('none')
    expect(compat.supportsToolCalls).toBe(false)
    expect(compat.supportsVision).toBe(false)
    expect(compat.maxTokensField).toBe('max_tokens')
  })
})
