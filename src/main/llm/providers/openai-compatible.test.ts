// src/main/llm/providers/openai-compatible.test.ts
// P1-18 测试：OpenAI-compatible Adapter 契约测试
// 依据：S-001 P1-18 验收"Faux Provider 与 adapter 契约测试通过"
//       S-001 P1-19 验收"401 不重试"
//       S-004 §3.3.1 合同门禁 #5（Provider scope）

import { describe, it, expect, vi } from 'vitest'
import { OpenAICompatibleProvider } from './openai-compatible'
import type { CompatFlags, LlmRequest } from '../types'
import type { Logger } from '@shared/observability/types'
import { isAppError } from '@shared/errors'
import type { ReasoningEffort } from '@shared/config/types'

// === 测试辅助 ===

function noopLogger(): Logger {
  return {
    fatal() {
      /* noop */
    },
    error() {
      /* noop */
    },
    warn() {
      /* noop */
    },
    info() {
      /* noop */
    },
    debug() {
      /* noop */
    },
    child() {
      return noopLogger()
    }
  }
}

const DEFAULT_COMPAT: CompatFlags = {
  thinkingFormat: 'none',
  supportsToolCalls: false,
  supportsVision: false,
  maxTokensField: 'max_tokens'
}

const DEEPSEEK_COMPAT: CompatFlags = {
  thinkingFormat: 'thinking_type',
  supportsToolCalls: true,
  supportsVision: false,
  maxTokensField: 'max_tokens'
}

function makeConfig(
  overrides: Partial<{
    baseUrl: string
    model: string
    temperature: number
    topP: number
    maxTokens: number
    timeoutMs: number
    reasoningEffort: ReasoningEffort
  }> = {}
): ConstructorParameters<typeof OpenAICompatibleProvider>[0] {
  return {
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    temperature: 0.8,
    topP: 0.95,
    maxTokens: 2048,
    timeoutMs: 60_000,
    reasoningEffort: 'off',
    ...overrides
  }
}

/** 创建 SSE body 流 */
function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    }
  })
  return new Response(stream, { status })
}

/** 创建 mock fetch，记录请求体并返回预设响应 */
function mockFetch(
  response: Response,
  captureBody?: (body: Record<string, unknown>) => void
): typeof globalThis.fetch {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body && captureBody) {
      captureBody(JSON.parse(init.body as string) as Record<string, unknown>)
    }
    return response
  }) as unknown as typeof globalThis.fetch
}

/** 收集 stream 的所有 chunk */
async function collectChunks(
  provider: OpenAICompatibleProvider,
  request: LlmRequest,
  signal?: AbortSignal
): Promise<Array<{ type: string; text?: string; inputTokens?: number; outputTokens?: number }>> {
  const chunks: Array<{
    type: string
    text?: string
    inputTokens?: number
    outputTokens?: number
  }> = []
  for await (const chunk of provider.stream(request, signal)) {
    chunks.push(chunk)
  }
  return chunks
}

const SIMPLE_REQUEST: LlmRequest = {
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello' }
  ]
}

// ── 正常流式 ──

describe('OpenAICompatibleProvider 正常流式', () => {
  it('delta chunk 顺序正确', async () => {
    const response = sseResponse([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n'
    ])
    const provider = new OpenAICompatibleProvider(
      makeConfig(),
      'sk-test-key',
      DEFAULT_COMPAT,
      mockFetch(response),
      noopLogger()
    )
    const chunks = await collectChunks(provider, SIMPLE_REQUEST)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toEqual({ type: 'delta', text: 'Hello' })
    expect(chunks[1]).toEqual({ type: 'delta', text: ' world' })
  })

  it('usage chunk 在流末尾提取', async () => {
    const response = sseResponse([
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
      'data: [DONE]\n\n'
    ])
    const provider = new OpenAICompatibleProvider(
      makeConfig(),
      'sk-test-key',
      DEFAULT_COMPAT,
      mockFetch(response),
      noopLogger()
    )
    const chunks = await collectChunks(provider, SIMPLE_REQUEST)
    expect(chunks).toHaveLength(2)
    expect(chunks[1]).toEqual({
      type: 'usage',
      inputTokens: 10,
      outputTokens: 5
    })
  })

  it('reasoning_content 提取为 reasoning chunk', async () => {
    const response = sseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
      'data: [DONE]\n\n'
    ])
    const provider = new OpenAICompatibleProvider(
      makeConfig(),
      'sk-test-key',
      DEFAULT_COMPAT,
      mockFetch(response),
      noopLogger()
    )
    const chunks = await collectChunks(provider, SIMPLE_REQUEST)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toEqual({ type: 'reasoning', text: 'thinking...' })
    expect(chunks[1]).toEqual({ type: 'delta', text: 'answer' })
  })

  it('首个 delta 含 role 字段时只提取 content', async () => {
    const response = sseResponse([
      'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: [DONE]\n\n'
    ])
    const provider = new OpenAICompatibleProvider(
      makeConfig(),
      'sk-test-key',
      DEFAULT_COMPAT,
      mockFetch(response),
      noopLogger()
    )
    const chunks = await collectChunks(provider, SIMPLE_REQUEST)
    // 空字符串 content 不 yield delta（delta?.content 为 "" 是 falsy）
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toEqual({ type: 'delta', text: 'Hi' })
  })

  it('格式错误的 JSON chunk 被跳过，不中断流', async () => {
    const response = sseResponse([
      'data: {"choices":[{"delta":{"content":"before"}}]}\n\n',
      'data: {malformed json}\n\n',
      'data: {"choices":[{"delta":{"content":"after"}}]}\n\n',
      'data: [DONE]\n\n'
    ])
    const provider = new OpenAICompatibleProvider(
      makeConfig(),
      'sk-test-key',
      DEFAULT_COMPAT,
      mockFetch(response),
      noopLogger()
    )
    const chunks = await collectChunks(provider, SIMPLE_REQUEST)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toEqual({ type: 'delta', text: 'before' })
    expect(chunks[1]).toEqual({ type: 'delta', text: 'after' })
  })
})

// ── HTTP 错误映射 ──

describe('OpenAICompatibleProvider HTTP 错误映射', () => {
  it('401 -> LLM_AUTH, retryable=false（不重试）', async () => {
    const response = new Response('{"error":{"message":"Invalid API Key"}}', { status: 401 })
    const provider = new OpenAICompatibleProvider(
      makeConfig(),
      'sk-invalid',
      DEFAULT_COMPAT,
      mockFetch(response),
      noopLogger()
    )
    try {
      await collectChunks(provider, SIMPLE_REQUEST)
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(isAppError(e)).toBe(true)
      if (isAppError(e)) {
        expect(e.code).toBe('LLM_AUTH')
        expect(e.retryable).toBe(false)
      }
    }
  })

  it('403 -> LLM_AUTH, retryable=false', async () => {
    const response = new Response('Forbidden', { status: 403 })
    const provider = new OpenAICompatibleProvider(
      makeConfig(),
      'sk-test',
      DEFAULT_COMPAT,
      mockFetch(response),
      noopLogger()
    )
    try {
      await collectChunks(provider, SIMPLE_REQUEST)
      expect.unreachable('should have thrown')
    } catch (e) {
      if (isAppError(e)) {
        expect(e.code).toBe('LLM_AUTH')
        expect(e.retryable).toBe(false)
      }
    }
  })

  it('429 -> LLM_RATE_LIMIT, retryable=true', async () => {
    const response = new Response('Rate limited', { status: 429 })
    const provider = new OpenAICompatibleProvider(
      makeConfig(),
      'sk-test',
      DEFAULT_COMPAT,
      mockFetch(response),
      noopLogger()
    )
    try {
      await collectChunks(provider, SIMPLE_REQUEST)
      expect.unreachable('should have thrown')
    } catch (e) {
      if (isAppError(e)) {
        expect(e.code).toBe('LLM_RATE_LIMIT')
        expect(e.retryable).toBe(true)
      }
    }
  })

  it('500 -> LLM_SERVER, retryable=true', async () => {
    const response = new Response('Internal Server Error', { status: 500 })
    const provider = new OpenAICompatibleProvider(
      makeConfig(),
      'sk-test',
      DEFAULT_COMPAT,
      mockFetch(response),
      noopLogger()
    )
    try {
      await collectChunks(provider, SIMPLE_REQUEST)
      expect.unreachable('should have thrown')
    } catch (e) {
      if (isAppError(e)) {
        expect(e.code).toBe('LLM_SERVER')
        expect(e.retryable).toBe(true)
      }
    }
  })

  it('400 -> LLM_MALFORMED, retryable=false', async () => {
    const response = new Response('Bad Request', { status: 400 })
    const provider = new OpenAICompatibleProvider(
      makeConfig(),
      'sk-test',
      DEFAULT_COMPAT,
      mockFetch(response),
      noopLogger()
    )
    try {
      await collectChunks(provider, SIMPLE_REQUEST)
      expect.unreachable('should have thrown')
    } catch (e) {
      if (isAppError(e)) {
        expect(e.code).toBe('LLM_MALFORMED')
        expect(e.retryable).toBe(false)
      }
    }
  })
})

// ── abort 处理 ──

describe('OpenAICompatibleProvider abort', () => {
  it('外部 abort 后停止 yield', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // 预入队多个 chunk，模拟数据已在缓冲区
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"chunk1"}}]}\n\n'))
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"chunk2"}}]}\n\n'))
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"chunk3"}}]}\n\n'))
      }
    })
    const response = new Response(stream, { status: 200 })

    const provider = new OpenAICompatibleProvider(
      makeConfig({ timeoutMs: 30_000 }),
      'sk-test',
      DEFAULT_COMPAT,
      mockFetch(response),
      noopLogger()
    )

    const abortController = new AbortController()
    const chunks: Array<{ type: string; text?: string }> = []

    const iterPromise = (async () => {
      for await (const chunk of provider.stream(SIMPLE_REQUEST, abortController.signal)) {
        chunks.push(chunk)
        // 收到第一个 chunk 后 abort
        if (chunks.length === 1) {
          abortController.abort()
        }
      }
    })()

    await iterPromise
    // chunk1 在 abort 前 yield；后续 chunk 被 reader.cancel() 阻止
    expect(chunks[0]).toEqual({ type: 'delta', text: 'chunk1' })
    expect(chunks.length).toBeLessThanOrEqual(2)
  })

  it('请求前已 abort 则直接返回', async () => {
    const response = sseResponse([
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: [DONE]\n\n'
    ])
    const provider = new OpenAICompatibleProvider(
      makeConfig(),
      'sk-test',
      DEFAULT_COMPAT,
      mockFetch(response),
      noopLogger()
    )

    const abortController = new AbortController()
    abortController.abort()

    const chunks = await collectChunks(provider, SIMPLE_REQUEST, abortController.signal)
    expect(chunks).toHaveLength(0)
  })
})

// ── 请求体构建（compat flags）──

describe('OpenAICompatibleProvider 请求体构建', () => {
  it('使用 max_tokens 字段（默认 compat）', async () => {
    const response = sseResponse(['data: [DONE]\n\n'])
    let capturedBody: Record<string, unknown> = {}
    const provider = new OpenAICompatibleProvider(
      makeConfig({ maxTokens: 1024 }),
      'sk-test',
      DEFAULT_COMPAT,
      mockFetch(response, (b) => (capturedBody = b)),
      noopLogger()
    )
    await collectChunks(provider, SIMPLE_REQUEST)
    expect(capturedBody['max_tokens']).toBe(1024)
    expect(capturedBody['max_completion_tokens']).toBeUndefined()
  })

  it('使用 max_completion_tokens 字段（OpenAI compat）', async () => {
    const response = sseResponse(['data: [DONE]\n\n'])
    let capturedBody: Record<string, unknown> = {}
    const openaiCompat: CompatFlags = {
      ...DEFAULT_COMPAT,
      maxTokensField: 'max_completion_tokens'
    }
    const provider = new OpenAICompatibleProvider(
      makeConfig({ maxTokens: 4096 }),
      'sk-test',
      openaiCompat,
      mockFetch(response, (b) => (capturedBody = b)),
      noopLogger()
    )
    await collectChunks(provider, SIMPLE_REQUEST)
    expect(capturedBody['max_completion_tokens']).toBe(4096)
    expect(capturedBody['max_tokens']).toBeUndefined()
  })

  it('请求体含 model、messages、stream、temperature、top_p', async () => {
    const response = sseResponse(['data: [DONE]\n\n'])
    let capturedBody: Record<string, unknown> = {}
    const provider = new OpenAICompatibleProvider(
      makeConfig({ model: 'deepseek-chat', temperature: 0.5, topP: 0.9 }),
      'sk-test',
      DEFAULT_COMPAT,
      mockFetch(response, (b) => (capturedBody = b)),
      noopLogger()
    )
    await collectChunks(provider, SIMPLE_REQUEST)
    expect(capturedBody['model']).toBe('deepseek-chat')
    expect(capturedBody['stream']).toBe(true)
    expect(capturedBody['temperature']).toBe(0.5)
    expect(capturedBody['top_p']).toBe(0.9)
    expect(capturedBody['stream_options']).toEqual({ include_usage: true })
    expect(capturedBody['messages']).toEqual([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' }
    ])
  })

  it('Authorization header 含 Bearer token', async () => {
    const response = sseResponse(['data: [DONE]\n\n'])
    let capturedHeaders: Record<string, string> = {}
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>
      return response
    }) as unknown as typeof globalThis.fetch

    const provider = new OpenAICompatibleProvider(
      makeConfig(),
      'sk-secret-key',
      DEFAULT_COMPAT,
      fetchFn,
      noopLogger()
    )
    await collectChunks(provider, SIMPLE_REQUEST)
    expect(capturedHeaders['Authorization']).toBe('Bearer sk-secret-key')
    expect(capturedHeaders['Content-Type']).toBe('application/json')
  })

  it('baseUrl 尾部斜杠被去除', async () => {
    const response = sseResponse(['data: [DONE]\n\n'])
    let capturedUrl = ''
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === 'string' ? input : input.toString()
      return response
    }) as unknown as typeof globalThis.fetch

    const provider = new OpenAICompatibleProvider(
      makeConfig({ baseUrl: 'https://api.deepseek.com/v1/' }),
      'sk-test',
      DEFAULT_COMPAT,
      fetchFn,
      noopLogger()
    )
    await collectChunks(provider, SIMPLE_REQUEST)
    expect(capturedUrl).toBe('https://api.deepseek.com/v1/chat/completions')
  })
})

// ── DeepSeek 兼容 ──

describe('OpenAICompatibleProvider DeepSeek 兼容', () => {
  it('DeepSeek 流式响应正确解析', async () => {
    const response = sseResponse([
      'data: {"id":"chatcmpl-123","model":"deepseek-chat","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-123","model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-123","model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"！"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-123","model":"deepseek-chat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n'
    ])
    const provider = new OpenAICompatibleProvider(
      makeConfig(),
      'sk-deepseek-key',
      DEEPSEEK_COMPAT,
      mockFetch(response),
      noopLogger()
    )
    const chunks = await collectChunks(provider, SIMPLE_REQUEST)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toEqual({ type: 'delta', text: '你好' })
    expect(chunks[1]).toEqual({ type: 'delta', text: '！' })
  })

  // === 思考模式参数（thinking mode）===
  // 依据：https://api-docs.deepseek.com/zh-cn/guides/thinking_mode（2026-07-15 实测）
  // 修复：reasoningEffort='off' 时必须显式发关闭参数，不能省略（DeepSeek V4 默认 enabled）

  it('thinking_type + reasoningEffort=off → 发 {thinking:{type:"disabled"}}', async () => {
    const response = sseResponse(['data: [DONE]\n\n'])
    let capturedBody: Record<string, unknown> = {}
    const provider = new OpenAICompatibleProvider(
      makeConfig({ reasoningEffort: 'off' }),
      'sk-test',
      DEEPSEEK_COMPAT,
      mockFetch(response, (b) => (capturedBody = b)),
      noopLogger()
    )
    await collectChunks(provider, SIMPLE_REQUEST)
    expect(capturedBody['thinking']).toEqual({ type: 'disabled' })
  })

  it('thinking_type + reasoningEffort=high → 发 {thinking:{type:"enabled"}}', async () => {
    const response = sseResponse(['data: [DONE]\n\n'])
    let capturedBody: Record<string, unknown> = {}
    const provider = new OpenAICompatibleProvider(
      makeConfig({ reasoningEffort: 'high' }),
      'sk-test',
      DEEPSEEK_COMPAT,
      mockFetch(response, (b) => (capturedBody = b)),
      noopLogger()
    )
    await collectChunks(provider, SIMPLE_REQUEST)
    expect(capturedBody['thinking']).toEqual({ type: 'enabled' })
  })

  // === V-02②：思考力度档位映射（官方档位 low/high/max，无 medium）===
  // 依据：https://api-docs.deepseek.com/guides/thinking_mode（2026-08-20 查证）
  // 此前 low/medium/high 一律只发 enabled，端点按默认 high 跑，用户选择被静默忽略。

  it('thinking_type + low/medium/high → 发 reasoning_effort low/high/max', async () => {
    const cases = [
      ['low', 'low'],
      ['medium', 'high'],
      ['high', 'max']
    ] as const
    for (const [effort, expected] of cases) {
      const response = sseResponse(['data: [DONE]\n\n'])
      let capturedBody: Record<string, unknown> = {}
      const provider = new OpenAICompatibleProvider(
        makeConfig({ reasoningEffort: effort }),
        'sk-test',
        DEEPSEEK_COMPAT,
        mockFetch(response, (b) => (capturedBody = b)),
        noopLogger()
      )
      await collectChunks(provider, SIMPLE_REQUEST)
      expect(capturedBody['thinking']).toEqual({ type: 'enabled' })
      expect(capturedBody['reasoning_effort']).toBe(expected)
    }
  })

  it('thinking_type + reasoningEffort=off → 不发 reasoning_effort（仅 disabled）', async () => {
    const response = sseResponse(['data: [DONE]\n\n'])
    let capturedBody: Record<string, unknown> = {}
    const provider = new OpenAICompatibleProvider(
      makeConfig({ reasoningEffort: 'off' }),
      'sk-test',
      DEEPSEEK_COMPAT,
      mockFetch(response, (b) => (capturedBody = b)),
      noopLogger()
    )
    await collectChunks(provider, SIMPLE_REQUEST)
    expect(capturedBody['thinking']).toEqual({ type: 'disabled' })
    expect('reasoning_effort' in capturedBody).toBe(false)
  })

  it('enable_thinking + reasoningEffort=off → 发 enable_thinking:false', async () => {
    const response = sseResponse(['data: [DONE]\n\n'])
    let capturedBody: Record<string, unknown> = {}
    const dashscopeCompat: CompatFlags = {
      thinkingFormat: 'enable_thinking',
      supportsToolCalls: true,
      supportsVision: false,
      maxTokensField: 'max_tokens'
    }
    const provider = new OpenAICompatibleProvider(
      makeConfig({ reasoningEffort: 'off' }),
      'sk-test',
      dashscopeCompat,
      mockFetch(response, (b) => (capturedBody = b)),
      noopLogger()
    )
    await collectChunks(provider, SIMPLE_REQUEST)
    expect(capturedBody['enable_thinking']).toBe(false)
  })

  it('thinkingFormat=none 时 off/high 都不发思考参数（Moonshot 等不支持思考的厂商）', async () => {
    const response = sseResponse(['data: [DONE]\n\n'])
    for (const effort of ['off', 'high'] as const) {
      let capturedBody: Record<string, unknown> = {}
      const provider = new OpenAICompatibleProvider(
        makeConfig({ reasoningEffort: effort }),
        'sk-test',
        DEFAULT_COMPAT, // thinkingFormat='none'
        mockFetch(response, (b) => (capturedBody = b)),
        noopLogger()
      )
      await collectChunks(provider, SIMPLE_REQUEST)
      expect(capturedBody['thinking']).toBeUndefined()
      expect(capturedBody['enable_thinking']).toBeUndefined()
      expect(capturedBody['reasoning_split']).toBeUndefined()
    }
  })

  it('reasoning_split + reasoningEffort=off → 不发（MiniMax 无显式关闭格式）', async () => {
    const response = sseResponse(['data: [DONE]\n\n'])
    let capturedBody: Record<string, unknown> = {}
    const minimaxCompat: CompatFlags = {
      thinkingFormat: 'reasoning_split',
      supportsToolCalls: true,
      supportsVision: false,
      maxTokensField: 'max_tokens'
    }
    const provider = new OpenAICompatibleProvider(
      makeConfig({ reasoningEffort: 'off' }),
      'sk-test',
      minimaxCompat,
      mockFetch(response, (b) => (capturedBody = b)),
      noopLogger()
    )
    await collectChunks(provider, SIMPLE_REQUEST)
    expect(capturedBody['reasoning_split']).toBeUndefined()
  })
})

// ── M-02 回归：流中 error 事件 ──

describe('M-02 回归：流中错误不再被吞', () => {
  it('流中 {"error":{...}} 事件抛 LLM_SERVER（而非静默当 complete）', async () => {
    const response = sseResponse([
      'data: {"choices":[{"delta":{"content":"半截"}}]}\n\n',
      'data: {"error":{"message":"context length exceeded"}}\n\n',
      'data: [DONE]\n\n'
    ])
    const provider = new OpenAICompatibleProvider(
      makeConfig(),
      'sk-test-key',
      DEFAULT_COMPAT,
      mockFetch(response),
      noopLogger()
    )
    await expect(collectChunks(provider, SIMPLE_REQUEST)).rejects.toMatchObject({
      code: 'LLM_SERVER'
    })
  })

  it('finish_reason="error" 抛 LLM_SERVER', async () => {
    const response = sseResponse([
      'data: {"choices":[{"delta":{"content":"半截"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"error"}]}\n\n'
    ])
    const provider = new OpenAICompatibleProvider(
      makeConfig(),
      'sk-test-key',
      DEFAULT_COMPAT,
      mockFetch(response),
      noopLogger()
    )
    await expect(collectChunks(provider, SIMPLE_REQUEST)).rejects.toMatchObject({
      code: 'LLM_SERVER'
    })
  })

  it('finish_reason="length"（maxTokens 截断）仍正常完成不抛错', async () => {
    const response = sseResponse([
      'data: {"choices":[{"delta":{"content":"被截断的回复"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
      'data: [DONE]\n\n'
    ])
    const provider = new OpenAICompatibleProvider(
      makeConfig(),
      'sk-test-key',
      DEFAULT_COMPAT,
      mockFetch(response),
      noopLogger()
    )
    const chunks = await collectChunks(provider, SIMPLE_REQUEST)
    expect(
      chunks
        .filter((c) => c.type === 'delta')
        .map((c) => c.text)
        .join('')
    ).toBe('被截断的回复')
  })
})
