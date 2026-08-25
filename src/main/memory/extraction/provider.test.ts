// src/main/memory/extraction/provider.test.ts
// P2-38 修复（2026-08-11 审计）：OpenAI provider 的 complete() 必须使用 request.timeoutMs，
// 否则 sync_turn 的 20s 短超时画像在生产静默失效（回退构造配置 30s）。
import { describe, it, expect } from 'vitest'
import { createOpenAIExtractionProvider } from './provider'
import { testNoopLogger } from '../../../../tests/helpers/test-db'

/** mock fetch：返回一个监听 signal abort 的 promise，abort 时 reject（模拟真实 fetch 行为） */
function makeFetch(): {
  fetchFn: typeof globalThis.fetch
  calls: Array<{ url: string; init: RequestInit }>
} {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    const signal = init?.signal ?? null
    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Aborted'))
        return
      }
      signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true })
      // 永不 resolve：abort 是唯一结束路径；若 5s 内未 abort，由测试兜底 reject
      setTimeout(() => resolve(null as unknown as Response), 60_000)
    })
  }) as typeof globalThis.fetch
  return { fetchFn, calls }
}

describe('P2-38 OpenAI provider request.timeoutMs', () => {
  it('使用 request.timeoutMs（50ms）时在该点 abort，而非 cfg 默认（30s）', async () => {
    const { fetchFn, calls } = makeFetch()
    const provider = createOpenAIExtractionProvider(
      { provider: 'test', model: 'm', baseUrl: 'https://api.example.com', apiKey: 'k' },
      { logger: testNoopLogger, fetchFn }
    )

    const start = Date.now()
    await expect(
      provider.complete(
        {
          messages: [{ role: 'user', content: 'hi' }],
          temperature: 0,
          maxOutputTokens: 100,
          jsonSchema: {},
          timeoutMs: 50 // 请求级短超时
        },
        new AbortController().signal
      )
    ).rejects.toThrow()

    const elapsed = Date.now() - start
    // 约 50ms abort（若走了 cfg 默认 30s 则这里会在 60s 兜底 resolve 而非 reject）
    expect(elapsed).toBeLessThan(2_000)
    expect(calls).toHaveLength(1)
  })

  it('未指定 request.timeoutMs 时使用 cfg.timeoutMs（50ms）', async () => {
    const { fetchFn, calls } = makeFetch()
    const provider = createOpenAIExtractionProvider(
      {
        provider: 'test',
        model: 'm',
        baseUrl: 'https://api.example.com',
        apiKey: 'k',
        timeoutMs: 50
      },
      { logger: testNoopLogger, fetchFn }
    )

    const start = Date.now()
    await expect(
      provider.complete(
        {
          messages: [{ role: 'user', content: 'hi' }],
          temperature: 0,
          maxOutputTokens: 100,
          jsonSchema: {},
          timeoutMs: undefined as unknown as number // 模拟未指定 -> 走 cfg.timeoutMs=50
        },
        new AbortController().signal
      )
    ).rejects.toThrow()

    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(2_000)
    expect(calls).toHaveLength(1)
  })
})

// 2026-08-20 验收实测修复：提取必须显式关思考。DeepSeek V4 服务端默认 thinking=enabled，
// 不发参数≠关闭——reasoning token 计入 max_tokens，sync_turn 的 400 预算被推理烧光，
// content='' → 每轮提取静默 0 候选（加大预算到 2048 同样被吃光）。
describe('提取 wire body 显式关思考（2026-08-20 修复）', () => {
  function makeOkFetch(): {
    fetchFn: typeof globalThis.fetch
    bodies: Array<Record<string, unknown>>
  } {
    const bodies: Array<Record<string, unknown>> = []
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"schemaVersion":1,"candidates":[]}' } }]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }) as typeof globalThis.fetch
    return { fetchFn, bodies }
  }

  type ThinkingFormat = 'none' | 'thinking_type' | 'enable_thinking' | 'reasoning_split'

  async function completeOnce(thinkingFormat?: ThinkingFormat): Promise<Record<string, unknown>> {
    const { fetchFn, bodies } = makeOkFetch()
    const provider = createOpenAIExtractionProvider(
      {
        provider: 'test',
        model: 'm',
        baseUrl: 'https://api.example.com',
        apiKey: 'k',
        thinkingFormat
      },
      { logger: testNoopLogger, fetchFn }
    )
    await provider.complete(
      {
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0,
        maxOutputTokens: 100,
        jsonSchema: {},
        timeoutMs: 1000
      },
      new AbortController().signal
    )
    const body = bodies[0]
    if (!body) throw new Error('expected exactly 1 fetch call')
    return body
  }

  it('thinking_type（DeepSeek V4）：body 带 thinking.type=disabled 且无 reasoning_effort', async () => {
    const body = await completeOnce('thinking_type')
    expect(body['thinking']).toEqual({ type: 'disabled' })
    expect('reasoning_effort' in body).toBe(false)
  })

  it('enable_thinking（DashScope）：body 带 enable_thinking=false', async () => {
    const body = await completeOnce('enable_thinking')
    expect(body['enable_thinking']).toBe(false)
  })

  it('reasoning_split（MiniMax）：关闭无显式格式，body 不带 reasoning_split', async () => {
    const body = await completeOnce('reasoning_split')
    expect('reasoning_split' in body).toBe(false)
  })

  it('未配置 thinkingFormat（none）：body 不带任何思考参数', async () => {
    const body = await completeOnce(undefined)
    expect('thinking' in body).toBe(false)
    expect('enable_thinking' in body).toBe(false)
    expect('reasoning_split' in body).toBe(false)
  })
})
