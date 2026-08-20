// src/main/llm/compat/thinking-wire.test.ts
// buildThinkingWireParams 单测：聊天/提取共用的思考模式 wire 映射。
// 重点钉死两件事：
//   1. V-02② 档位映射（low→low、medium→high、high→max）在提取共用后不回归
//   2. 2026-08-20 事件：enabled=false 必须产出显式关闭参数（DeepSeek V4 默认 enabled，
//      不发参数≠关闭，提取管线曾因此静默空转）
import { describe, it, expect } from 'vitest'
import { buildThinkingWireParams } from './thinking-wire'

describe('buildThinkingWireParams', () => {
  describe('thinking_type（DeepSeek V4）', () => {
    it('enabled + effort 映射官方档位 low/high/max（无 medium）', () => {
      expect(buildThinkingWireParams('thinking_type', true, 'low')).toEqual({
        thinking: { type: 'enabled' },
        reasoning_effort: 'low'
      })
      expect(buildThinkingWireParams('thinking_type', true, 'medium')).toEqual({
        thinking: { type: 'enabled' },
        reasoning_effort: 'high'
      })
      expect(buildThinkingWireParams('thinking_type', true, 'high')).toEqual({
        thinking: { type: 'enabled' },
        reasoning_effort: 'max'
      })
    })

    it('enabled 不带 effort 时只发 thinking.type', () => {
      expect(buildThinkingWireParams('thinking_type', true)).toEqual({
        thinking: { type: 'enabled' }
      })
    })

    it('disabled 显式关闭且不带 reasoning_effort（2026-08-20 提取空转事件修复）', () => {
      const params = buildThinkingWireParams('thinking_type', false)
      expect(params).toEqual({ thinking: { type: 'disabled' } })
      expect('reasoning_effort' in params).toBe(false)
    })
  })

  describe('enable_thinking（DashScope）', () => {
    it('enabled / disabled 直发布尔', () => {
      expect(buildThinkingWireParams('enable_thinking', true)).toEqual({ enable_thinking: true })
      expect(buildThinkingWireParams('enable_thinking', false)).toEqual({ enable_thinking: false })
    })
  })

  describe('reasoning_split（MiniMax）', () => {
    it('仅开启时发参数；关闭不发（无显式关闭格式，服务端默认关）', () => {
      expect(buildThinkingWireParams('reasoning_split', true)).toEqual({ reasoning_split: true })
      expect(buildThinkingWireParams('reasoning_split', false)).toEqual({})
    })
  })

  describe('none（厂商不支持思考模式）', () => {
    it('开/关都不发参数', () => {
      expect(buildThinkingWireParams('none', true)).toEqual({})
      expect(buildThinkingWireParams('none', false)).toEqual({})
    })
  })
})
