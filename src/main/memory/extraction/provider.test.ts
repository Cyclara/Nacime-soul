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
