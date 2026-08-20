// src/main/llm/compat/thinking-wire.ts
// 思考模式 wire 参数映射（聊天流式 + 记忆提取非流式共用）。
//
// 背景（2026-08-20 验收实测，提取管线静默空转事件）：
//   DeepSeek V4 服务端默认 thinking=enabled，请求不带 thinking 字段 ≠ 关闭。
//   提取管线（memory/extraction/provider.ts）此前不发任何思考参数 → 模型把
//   max_tokens=400 全部烧在 reasoning 上（usage.completion_tokens_details.reasoning_tokens=400、
//   finish_reason=length、content=''），每轮提取静默产出 0 候选，L0/L2 永不写入；
//   预算加大到 2048 依然被 reasoning 吃光——「加预算」不是解药，显式声明开关才是。
//   教训：凡调用 thinking-capable 厂商的请求路径，都必须显式声明思考开关意图。
//
// 厂商格式来源：
//   - DeepSeek：https://api-docs.deepseek.com/zh-cn/guides/thinking_mode（2026-07-15 实测 / 2026-08-20 查证）
//   - DashScope / MiniMax：沿 openai-compatible.ts 既有映射（行为不变）

import type { CompatFlags } from '../types'
import type { ReasoningEffort } from '@shared/config/types'

type ThinkingFormat = CompatFlags['thinkingFormat']

/**
 * 按厂商 thinkingFormat 生成思考模式 wire 参数（对象可 spread 进请求 body）。
 *
 * @param format  厂商思考参数格式（resolveCompat 解析结果）
 * @param enabled true=显式开启；false=显式关闭（有显式关闭格式的厂商）
 * @param effort  仅开启时可带力度；thinking_type 映射官方档位 low/high/max（无 medium：
 *                low→low、medium→high、high→max）。关闭时不发送。
 *
 * 各格式行为：
 *   - thinking_type（DeepSeek V4）：{"thinking":{"type":"enabled/disabled"}}（开+effort 时附 reasoning_effort）
 *   - enable_thinking（DashScope）：{"enable_thinking": true/false}
 *   - reasoning_split（MiniMax）：仅开启时 {"reasoning_split": true}（该厂商无显式关闭格式，服务端默认关）
 *   - 'none'：厂商不支持思考模式，一律 {}
 */
export function buildThinkingWireParams(
  format: ThinkingFormat,
  enabled: boolean,
  effort?: Exclude<ReasoningEffort, 'off'>
): Record<string, unknown> {
  switch (format) {
    case 'thinking_type': {
      const params: Record<string, unknown> = {
        thinking: { type: enabled ? 'enabled' : 'disabled' }
      }
      if (enabled && effort) {
        const effortMap: Record<Exclude<ReasoningEffort, 'off'>, string> = {
          low: 'low',
          medium: 'high',
          high: 'max'
        }
        params['reasoning_effort'] = effortMap[effort]
      }
      return params
    }
    case 'enable_thinking':
      return { enable_thinking: enabled }
    case 'reasoning_split':
      return enabled ? { reasoning_split: true } : {}
    case 'none':
    default:
      return {}
  }
}
