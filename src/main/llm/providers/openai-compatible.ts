// src/main/llm/providers/openai-compatible.ts
// P1-18: OpenAI-compatible Adapter
// 依据：S-001 P1-18、技术分析 §4.5.1、S-003 §3.2 错误码
//
// 职责：
//   1. 将中立 LlmRequest 转为 OpenAI Chat Completions wire 格式
//   2. 应用 4 个 compat flags（maxTokensField、thinkingFormat 等）
//   3. 发起 fetch 请求（含 Authorization header）
//   4. 检查 HTTP 状态码 -> 映射 AppError（401 不重试）
//   5. 用 parseSseStream 解析 SSE 流 -> 映射 LlmStreamChunk
//   6. 管理 idle timeout（timeoutMs）和外部 AbortSignal
//
// 安全红线：
//   - API Key 只出现在 Authorization header，不进日志
//   - 聊天正文不进日志（只记 provider/model/status/latency）
//   - vendor wire 类型（OpenAIStreamChunk）不导出，仅本文件内部使用

import type { Logger } from '@shared/observability/types'
import type { ReasoningEffort } from '@shared/config/types'
import { AppError } from '@shared/errors'
import type { CompatFlags, LLMProvider, LlmMessage, LlmRequest, LlmStreamChunk } from '../types'
import { mapHttpError, mapFetchError } from '../errors'
import { parseSseStream } from '../stream'

/** OpenAI Chat Completions 流式 chunk 的 wire 格式（vendor 类型，仅本文件内部使用） */
interface OpenAIStreamChunk {
  choices?: Array<{
    index?: number
    delta?: {
      role?: string
      content?: string
      /** DeepSeek 等模型的推理内容字段 */
      reasoning_content?: string
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

/** adapter 构造参数（从 ModelConfig 提取的运行时配置） */
export interface OpenAICompatibleConfig {
  baseUrl: string
  model: string
  temperature: number
  topP: number
  maxTokens: number
  timeoutMs: number
  reasoningEffort: ReasoningEffort
}

/**
 * OpenAI-compatible Provider。
 *
 * 实现 LLMProvider 接口，将中立请求转为 OpenAI Chat Completions API 调用。
 * 兼容 DeepSeek、OpenAI、Moonshot、DashScope 等 OpenAI 兼容厂商。
 *
 * vendor SDK 类型不导出：OpenAIStreamChunk 仅本文件内部使用，
 * 上层（ChatService）只看到 LlmStreamChunk。
 */
export class OpenAICompatibleProvider implements LLMProvider {
  private readonly config: OpenAICompatibleConfig
  private readonly apiKey: string
  private readonly compat: CompatFlags
  private readonly fetchFn: typeof globalThis.fetch
  private readonly logger: Logger

  constructor(
    config: OpenAICompatibleConfig,
    apiKey: string,
    compat: CompatFlags,
    fetchFn: typeof globalThis.fetch,
    logger: Logger
  ) {
    this.config = config
    this.apiKey = apiKey
    this.compat = compat
    this.fetchFn = fetchFn
    this.logger = logger
  }

  /**
   * 发起流式请求。
   *
   * 流程：
   *   1. 构建 OpenAI wire 请求体（应用 compat flags）
   *   2. 创建 AbortController，链接外部 signal + idle timeout
   *   3. fetch POST /chat/completions
   *   4. 检查 HTTP 状态 -> 非 2xx 映射 AppError
   *   5. parseSseStream 解析 SSE -> 映射 LlmStreamChunk
   *   6. idle timeout 或外部 abort 时立即停止
   */
  async *stream(request: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmStreamChunk> {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`
    const body = this.buildRequestBody(request)

    // 安全日志：记录思考模式开关状态（不记录 body/正文/API Key）
    this.logger.debug('sending chat request', {
      scope: 'llm',
      tags: { provider: this.config.model },
      metrics: { thinkingEnabled: this.config.reasoningEffort !== 'off' ? 1 : 0 }
    })

    // AbortController 管理：外部 signal + idle timeout 共同控制
    const controller = new AbortController()
    let timedOut = false

    // 链接外部 signal
    if (signal) {
      if (signal.aborted) {
        controller.abort()
      } else {
        signal.addEventListener('abort', () => controller.abort(), { once: true })
      }
    }

    // idle timeout：timeoutMs 内无数据则 abort
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const resetIdleTimer = (): void => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, this.config.timeoutMs)
    }

    resetIdleTimer()

    try {
      // === 发起请求 ===
      let response: Response
      try {
        response = await this.fetchFn(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`
          },
          body: JSON.stringify(body),
          signal: controller.signal
        })
      } catch (e) {
        // fetch 失败：区分超时 / 外部取消 / 网络错误
        if (timedOut) {
          throw new AppError({
            code: 'NET_TIMEOUT',
            userMessage: '模型连接超时',
            severity: 'error',
            retryable: true
          })
        }
        if (signal?.aborted) {
          // 外部取消，不产生错误
          return
        }
        const mapped = mapFetchError(e, this.logger, {
          provider: this.config.model
        })
        if (mapped) throw mapped
        return
      }

      resetIdleTimer()

      // === 检查 HTTP 状态 ===
      if (!response.ok) {
        const errorBody = await response.text().catch(() => '')
        throw mapHttpError(response.status, errorBody, this.logger, {
          provider: this.config.model
        })
      }

      // === 解析 SSE 流 ===
      for await (const data of parseSseStream(response, {
        signal: controller.signal
      })) {
        resetIdleTimer()

        // [DONE] 标记流结束
        if (data === '[DONE]') {
          return
        }

        // 解析 JSON chunk
        let chunk: OpenAIStreamChunk
        try {
          chunk = JSON.parse(data) as OpenAIStreamChunk
        } catch {
          // 跳过格式错误的 chunk（不中断流）
          this.logger.debug('skipped malformed SSE chunk', {
            scope: 'llm',
            tags: { provider: this.config.model }
          })
          continue
        }

        // 映射到 LlmStreamChunk
        const choice = chunk.choices?.[0]
        const delta = choice?.delta

        if (delta?.content) {
          yield { type: 'delta', text: delta.content }
        }

        if (delta?.reasoning_content) {
          yield { type: 'reasoning', text: delta.reasoning_content }
        }

        if (chunk.usage) {
          yield {
            type: 'usage',
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0
          }
        }
      }

      // 流自然结束。检查是否因超时中断。
      if (timedOut) {
        throw new AppError({
          code: 'NET_TIMEOUT',
          userMessage: '模型响应超时',
          severity: 'error',
          retryable: true
        })
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer)
    }
  }

  /**
   * 构建 OpenAI Chat Completions 请求体。
   * 应用 compat flags：
   *   - maxTokensField：max_tokens vs max_completion_tokens
   *   - thinkingFormat：reasoningEffort != 'off' 时按格式添加 thinking 参数
   */
  private buildRequestBody(request: LlmRequest): Record<string, unknown> {
    const messages: Array<{ role: string; content: string }> = request.messages.map(
      (msg: LlmMessage) => ({
        role: msg.role,
        content: msg.content
      })
    )

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      stream: true,
      temperature: this.config.temperature,
      top_p: this.config.topP,
      // compat flag: maxTokensField
      [this.compat.maxTokensField]: this.config.maxTokens,
      // 请求 usage 信息（流末尾返回 token 用量）
      stream_options: { include_usage: true }
    }

    // 思考模式参数（依据 thinkingFormat）：
    //   reasoningEffort='off' → 显式关闭（DeepSeek V4 默认 enabled，不发参数≠关闭）
    //   reasoningEffort!='off' → 显式开启
    // 来源：https://api-docs.deepseek.com/zh-cn/guides/thinking_mode（2026-07-15 实测）
    // thinkingFormat='none' 时厂商不支持思考模式，两种情况都不发参数。
    const wantThinking = this.config.reasoningEffort !== 'off'
    switch (this.compat.thinkingFormat) {
      case 'thinking_type':
        // DeepSeek V4 风格：{"thinking":{"type":"enabled/disabled"}}
        body['thinking'] = { type: wantThinking ? 'enabled' : 'disabled' }
        break
      case 'enable_thinking':
        // DashScope 风格：{"enable_thinking": true/false}
        body['enable_thinking'] = wantThinking
        break
      case 'reasoning_split':
        // MiniMax 风格：只有开启时发参数（无显式关闭格式）
        if (wantThinking) {
          body['reasoning_split'] = true
        }
        break
      case 'none':
      default:
        // 厂商不支持思考模式（Moonshot 等），不发参数
        break
    }

    return body
  }
}
