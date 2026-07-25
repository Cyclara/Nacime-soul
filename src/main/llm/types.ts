// src/main/llm/types.ts
// LLM 中立类型契约：消息、请求、流式 chunk、compat flags
// 依据：S-001 P1-18、技术分析 §4.5.1（Pi + OpenCode 双层模型兼容架构）
//
// 设计要点：
//   1. LlmMessage / LlmRequest 是中立类型，不绑定任何 vendor SDK
//   2. CompatFlags 只在 Phase 1 实现 4 个标志，其余 10 个预留为 undefined
//   3. LlmStreamChunk 是 provider -> ChatService 的流式协议，非 vendor wire 格式
//   4. ProviderCreateParams 封装创建 provider 所需的全部依赖（含 fetch 注入）

import type { ModelConfig } from '@shared/config/types'

// === LLM 消息 ===

/** LLM 消息角色。中立类型，不绑定 vendor SDK */
export type LlmRole = 'system' | 'user' | 'assistant'

/**
 * LLM 消息。中立类型，只含 role + content。
 * 依据技术分析 §4.5.1：协议层管"模型是什么协议"，兼容层管"同协议内不同提供商差异"。
 * vendor 特定字段（如 reasoning_content、tool_calls）不在此类型中。
 */
export interface LlmMessage {
  role: LlmRole
  content: string
}

// === LLM 请求 ===

/**
 * LLM 请求。中立类型。
 * messages 始终按 system -> user/assistant 交替排列（由 PromptBuilder 保证）。
 * 用户消息始终保持 user role（冻结合同 §1.0 注入边界）。
 */
export interface LlmRequest {
  messages: LlmMessage[]
}

// === 流式 Chunk ===

/**
 * LLM 流式 chunk。provider -> ChatService 的流式协议。
 *
 * - delta：正文内容增量
 * - reasoning：推理内容增量（thinking 模型，Phase 1 reasoningEffort=off 时不产生）
 * - usage：token 用量（通常在流末尾）
 *
 * 错误不作为 chunk 类型：provider 在出错时 throw AppError，
 * 调用方（ChatService）用 try/catch 捕获并转为 failed 事件。
 */
export type LlmStreamChunk =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }

// === Compat Flags ===

/**
 * 14 个 compat flags（Pi 源码完整列表）。
 * 依据技术分析 §4.5.1 + 可行性评审 §4.2：全部 14 个标志保留在接口定义中，
 * Phase 1-2 只实现前 4 个的判断逻辑，其余 10 个为 optional（undefined），
 * 将来接入新协议/模型时直接填值启用，零运行时开销。
 *
 * 解析优先级（借鉴 Pi getCompat）：显式配置 > 自动检测 > 默认值
 */
export interface CompatFlags {
  // ── Phase 1 实现判断逻辑的 4 个标志（detect-compat.ts 检测 + compatOverrides 覆盖）──

  /**
   * 推理/思考格式。当 reasoningEffort != 'off' 时如何传递 thinking 参数。
   * - none：不支持推理
   * - thinking_type：DeepSeek 风格 thinking: { type: 'enabled' }
   * - enable_thinking：DashScope 风格 enable_thinking: true
   * - reasoning_split：MiniMax 风格 reasoning_split: true
   */
  thinkingFormat: 'none' | 'thinking_type' | 'enable_thinking' | 'reasoning_split'

  /** 是否支持原生 tool calling */
  supportsToolCalls: boolean

  /** 是否支持图片输入（vision） */
  supportsVision: boolean

  /**
   * maxTokens 字段名。
   * - max_tokens：旧 OpenAI API 及大部分兼容厂商
   * - max_completion_tokens：新 OpenAI API（o1 系列）
   */
  maxTokensField: 'max_tokens' | 'max_completion_tokens'

  // ── Phase 4+ 预留标志（Phase 1 为 undefined，接入新协议/模型时启用）──

  /** 模型能否存储/微调 */
  supportsStore?: boolean

  /** 是否支持 developer 角色消息 */
  supportsDeveloperRole?: boolean

  /** reasoning_effort 参数支持 */
  supportsReasoningEffort?: boolean

  /** tool_call_id 必须回传 */
  requiresToolResultName?: boolean

  /** JSON schema strict 模式 */
  supportsStrictMode?: boolean

  /** Prompt 缓存的格式 */
  cacheControlFormat?: string

  /** 是否支持流式输出 */
  supportsStreaming?: boolean

  /** 是否支持 system 消息 */
  supportsSystemPrompt?: boolean

  /** 是否支持 temperature 参数 */
  supportsTemperature?: boolean

  /** tokenizer 类型（如 'tiktoken' | 'sentencepiece' | 'none'） */
  tokenizerType?: string
}

/**
 * ModelConfig.compatOverrides 的类型（全部 optional）。
 * 从 @shared/config/types 导入的 ModelConfig 已包含此字段，这里仅 re-export 类型。
 */
export type CompatOverrides = ModelConfig['compatOverrides']

// === Provider 创建参数 ===

/**
 * LLM Provider 中立接口。
 *
 * 所有 provider（OpenAI-compatible、Faux、未来 Anthropic）都实现此接口。
 * ChatService (P1-23) 只依赖此接口，不导入任何 vendor 类型。
 *
 * stream() 返回 AsyncIterable<LlmStreamChunk>：
 *   - 正常：yield delta/reasoning/usage chunk，迭代自然结束 = 流完成
 *   - 错误：throw AppError（调用方用 try/catch 捕获）
 *   - 取消：signal.abort() 后迭代立即结束，保证"abort 后无晚到 chunk"
 */
export interface LLMProvider {
  /**
   * 发起流式请求。
   * @param request LLM 请求（messages 等）
   * @param signal 外部取消信号。abort 后立即停止，无晚到 chunk。
   */
  stream(request: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmStreamChunk>
}

/**
 * 创建 LLMProvider 的参数。
 * fetchFn 默认为 globalThis.fetch；生产环境注入 createSecureFetch 以执行网络策略。
 */
export interface ProviderCreateParams {
  config: ModelConfig
  apiKey: string
  /** fetch 函数注入。生产环境传入 createSecureFetch(opts, logger) */
  fetchFn?: typeof globalThis.fetch
}
