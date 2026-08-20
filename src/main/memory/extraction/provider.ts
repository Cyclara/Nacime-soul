// src/main/memory/extraction/provider.ts
// ExtractionProvider 窄适配。依据 S-010 §1.5。
//
// 现有 LLMProvider.stream(LlmRequest) 不承载 temperature/maxTokens/schema/timeout，
// 因此 P2-10 必须定义窄适配，而不是假装已有 API。
//
// 硬 composition 合同（S-010 §1.5）：
//   新增 ExtractionProviderFactory，其实例、配置选择和 Faux response queue 都不得与
//   ChatService 的 providerFactory 共享；否则聊天/提取会串吃 FIFO 响应。
//
// 安全红线：
//   - temperature=0、max output 受限（建议 800，上限 1200）
//   - 失败映射为空候选（service 层处理）
//   - 提取输出正文不能写日志

import { AppError } from '@shared/errors'
import type { Logger } from '@shared/observability/types'
import type { LlmMessage } from '../../llm/types'
import { mapFetchError, mapHttpError } from '../../llm/errors'
import { CANDIDATE_ENVELOPE_SCHEMA } from './candidate'

export interface ExtractionRequest {
  messages: readonly LlmMessage[]
  temperature: 0
  maxOutputTokens: number // 建议 800，上限 1200
  jsonSchema: object
  timeoutMs: number // 默认 30_000
}

export interface ExtractionProvider {
  /**
   * 可内部收集 stream，但返回前执行输出 64KiB 上限与 AbortSignal。
   * 返回完整的模型输出字符串（供 parser 处理）。
   */
  complete(request: ExtractionRequest, signal: AbortSignal): Promise<string>
}

export type ExtractionProviderFactory = () => ExtractionProvider

// === FauxExtractionProvider（测试用，独立队列 + calls 记录）===

export interface FauxExtractionProviderHandle extends ExtractionProvider {
  /** 替换响应队列 */
  setResponses(responses: string[]): void
  /** 追加响应到队列末尾 */
  appendResponses(responses: string[]): void
  /** 返回剩余响应数 */
  pending(): number
  /** 返回已记录的请求 */
  calls(): readonly ExtractionRequest[]
  /** 清空队列和调用记录 */
  reset(): void
}

/**
 * 创建 Faux Extraction Provider。
 * 独立于 ChatService 的 FauxProvider，避免串吃 FIFO 响应。
 * 队列耗尽时抛测试错误（同 S-004 §3.2 契约）。
 */
export function createFauxExtractionProvider(): FauxExtractionProviderHandle {
  let queue: string[] = []
  const calls: ExtractionRequest[] = []

  async function complete(request: ExtractionRequest, signal: AbortSignal): Promise<string> {
    calls.push(request)
    const next = queue.shift()
    if (next === undefined) {
      throw new AppError({
        code: 'UNKNOWN',
        userMessage: 'Faux Extraction Provider: no more responses queued',
        severity: 'error',
        retryable: false
      })
    }
    if (signal.aborted) {
      throw new AppError({
        code: 'UNKNOWN',
        userMessage: 'Faux Extraction Provider: aborted',
        severity: 'error',
        retryable: false
      })
    }
    return next
  }

  return {
    complete,
    setResponses(responses: string[]): void {
      queue = [...responses]
    },
    appendResponses(responses: string[]): void {
      queue.push(...responses)
    },
    pending(): number {
      return queue.length
    },
    calls(): readonly ExtractionRequest[] {
      return [...calls]
    },
    reset(): void {
      queue = []
      calls.length = 0
    }
  }
}

// === OpenAI-compatible ExtractionProvider ===

export interface OpenAIExtractionConfig {
  provider: string
  model: string
  baseUrl: string
  apiKey: string
  /** 默认 800 */
  maxOutputTokens?: number
  /** 默认 30_000 */
  timeoutMs?: number
}

export interface OpenAIExtractionDeps {
  logger: Logger
  /** 生产注入 createSecureFetch；默认 globalThis.fetch */
  fetchFn?: typeof globalThis.fetch
}

const DEFAULT_MAX_OUTPUT_TOKENS = 800
const DEFAULT_TIMEOUT_MS = 30_000
const OUTPUT_BYTE_LIMIT = 64 * 1024

/**
 * 创建 OpenAI-compatible ExtractionProvider。
 * 把窄请求映射到厂商 wire（/chat/completions，response_format=json_object）。
 */
export function createOpenAIExtractionProvider(
  cfg: OpenAIExtractionConfig,
  deps: OpenAIExtractionDeps
): ExtractionProvider {
  const fetchFn = deps.fetchFn ?? globalThis.fetch
  const logger = deps.logger
  const defaultTimeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const tags = { provider: cfg.provider, model: cfg.model }

  async function complete(request: ExtractionRequest, signal: AbortSignal): Promise<string> {
    // 请求级 timeoutMs 优先（P2-38 sync_turn 用 20s 便宜画像）；未指定回退构造配置（默认 30s）。
    // 修复前只读 cfg.timeoutMs，request.timeoutMs 形同虚设，sync_turn 的短超时生产失效。
    const timeoutMs = request.timeoutMs ?? defaultTimeoutMs
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)

    // 外部 signal 与内部 timer 联动
    if (signal.aborted) controller.abort()
    signal.addEventListener('abort', () => controller.abort(), { once: true })

    try {
      const body = {
        model: cfg.model,
        messages: request.messages,
        temperature: 0,
        max_tokens: request.maxOutputTokens,
        response_format: { type: 'json_object' }
      }
      const res = await fetchFn(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cfg.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      })
      if (!res.ok) {
        const resBody = await res.text().catch(() => '')
        throw mapHttpError(res.status, resBody, logger, tags)
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      const content = json.choices?.[0]?.message?.content
      if (typeof content !== 'string') {
        logger.warn('extraction response malformed', {
          scope: 'memory',
          code: 'LLM_MALFORMED',
          metrics: { choices: json.choices?.length ?? -1 }
        })
        throw new AppError({
          code: 'LLM_MALFORMED',
          userMessage: '提取服务返回格式异常',
          severity: 'error',
          retryable: false
        })
      }
      // 64 KiB 输出上限
      if (content.length > OUTPUT_BYTE_LIMIT) {
        logger.warn('extraction output exceeds 64KiB', {
          scope: 'memory',
          code: 'LLM_MALFORMED',
          metrics: { outputChars: content.length }
        })
        throw new AppError({
          code: 'LLM_MALFORMED',
          userMessage: '提取输出超长',
          severity: 'error',
          retryable: false
        })
      }
      return content
    } catch (e) {
      if (e instanceof AppError) throw e
      const mapped = mapFetchError(e, logger, tags, timedOut)
      throw (
        mapped ?? new AppError({ code: 'UNKNOWN', severity: 'error', retryable: false, cause: e })
      )
    } finally {
      clearTimeout(timer)
    }
  }

  return { complete }
}

// === 默认 ExtractionRequest 工厂 ===

/**
 * 构建默认的 ExtractionRequest。
 * 使用 CANDIDATE_ENVELOPE_SCHEMA 作为 jsonSchema。
 */
export function defaultExtractionRequest(messages: readonly LlmMessage[]): ExtractionRequest {
  return {
    messages,
    temperature: 0,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    jsonSchema: CANDIDATE_ENVELOPE_SCHEMA as unknown as object,
    timeoutMs: DEFAULT_TIMEOUT_MS
  }
}
