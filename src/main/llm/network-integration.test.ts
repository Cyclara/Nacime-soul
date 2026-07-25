// src/main/llm/network-integration.test.ts
// 接线测试：验证 createProvider + createSecureFetch 集成后，私网/环回/元数据端点请求被拦截
// 依据：S-004 #17、P1-09B、S-001 P1-18/P1-20
//
// 此测试弥补"模块级测试全绿但未接线"的缺口（审查问题 7）：
// network-policy.test.ts 只测 createSecureFetch 模块本身，
// 本测试验证 createProvider 注入 createSecureFetch 后，真实 provider.stream() 会被拦截。
// 若 index.ts 的 providerFactory 忘记注入 fetchFn，此测试仍能验证"能力存在"，
// 配合 index.ts 代码审查确保接线不丢失。

import { describe, it, expect } from 'vitest'
import { createProvider, type ProviderFactoryDeps } from './provider'
import { createSecureFetch } from '../security/network-policy'
import type { Logger } from '@shared/observability/types'
import { isAppError } from '@shared/errors'
import type { LlmRequest } from './types'

// === 测试辅助 ===

function noopLogger(): Logger {
  const l: Logger = {
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
      return l
    }
  }
  return l
}

const deps: ProviderFactoryDeps = { logger: noopLogger() }

/** 生产环境网络策略选项（不允许 localhost HTTP 例外） */
const PROD_OPTS = { isDev: false, allowHttpLocalhostInDev: false }

/** 创建测试用 ModelConfig */
function makeConfig(baseUrl: string): Parameters<typeof createProvider>[0]['config'] {
  return {
    provider: 'test',
    protocol: 'openai-compatible',
    baseUrl,
    model: 'test-model',
    displayName: 'Test',
    temperature: 0.8,
    topP: 0.95,
    maxTokens: 2048,
    timeoutMs: 60_000,
    reasoningEffort: 'off',
    compatOverrides: {}
  }
}

/** 构建最小 LlmRequest */
const TEST_REQUEST: LlmRequest = {
  messages: [{ role: 'user', content: 'hi' }]
}

/**
 * 从 AsyncIterable 获取 AsyncIterator 并消费第一个 next()。
 * 若流在产出前抛出错误，该错误会被重新抛出（用于断言拦截行为）。
 */
async function consumeFirstChunk(stream: AsyncIterable<unknown>): Promise<void> {
  const iterator = stream[Symbol.asyncIterator]()
  await iterator.next()
}

// === 测试 ===

describe('P1-09B 接线：createProvider + createSecureFetch 集成', () => {
  it('私网 127.0.0.1 baseUrl 的请求被 secureFetch 拦截', async () => {
    const secureFetch = createSecureFetch(PROD_OPTS, noopLogger())
    const provider = createProvider(
      { config: makeConfig('http://127.0.0.1:8080/v1'), apiKey: 'sk-test', fetchFn: secureFetch },
      deps
    )

    // secureFetch 拦截 127.0.0.1 -> throw -> provider 经 mapFetchError 映射为 AppError
    await expect(
      consumeFirstChunk(provider.stream(TEST_REQUEST, new AbortController().signal))
    ).rejects.toThrow()
  })

  it('云元数据端点 169.254.169.254 被拦截（SSRF 防护核心场景）', async () => {
    const secureFetch = createSecureFetch(PROD_OPTS, noopLogger())
    const provider = createProvider(
      { config: makeConfig('http://169.254.169.254/v1'), apiKey: 'sk-test', fetchFn: secureFetch },
      deps
    )

    await expect(
      consumeFirstChunk(provider.stream(TEST_REQUEST, new AbortController().signal))
    ).rejects.toThrow()
  })

  it('IPv6 环回地址 [::1] 被拦截', async () => {
    const secureFetch = createSecureFetch(PROD_OPTS, noopLogger())
    const provider = createProvider(
      { config: makeConfig('http://[::1]:8080/v1'), apiKey: 'sk-test', fetchFn: secureFetch },
      deps
    )

    await expect(
      consumeFirstChunk(provider.stream(TEST_REQUEST, new AbortController().signal))
    ).rejects.toThrow()
  })

  it('私网 10.x.x.x 地址被拦截', async () => {
    const secureFetch = createSecureFetch(PROD_OPTS, noopLogger())
    const provider = createProvider(
      { config: makeConfig('http://10.0.0.1/v1'), apiKey: 'sk-test', fetchFn: secureFetch },
      deps
    )

    await expect(
      consumeFirstChunk(provider.stream(TEST_REQUEST, new AbortController().signal))
    ).rejects.toThrow()
  })

  it('拦截的错误被 provider 映射为 AppError（不静默吞掉）', async () => {
    const secureFetch = createSecureFetch(PROD_OPTS, noopLogger())
    const provider = createProvider(
      { config: makeConfig('http://192.168.1.1/v1'), apiKey: 'sk-test', fetchFn: secureFetch },
      deps
    )

    try {
      await consumeFirstChunk(provider.stream(TEST_REQUEST, new AbortController().signal))
      expect.fail('should have thrown')
    } catch (err) {
      // provider 的 mapFetchError 将网络策略拦截映射为 AppError（NET_OFFLINE）
      expect(isAppError(err)).toBe(true)
    }
  })

  it('不传 fetchFn 时默认使用 globalThis.fetch（index.ts 必须注入 createSecureFetch）', () => {
    // 文档化测试：createProvider 不传 fetchFn 时回退到原生 fetch（无 SSRF 防护）。
    // index.ts 的 providerFactory 必须传入 createSecureFetch 以启用 P1-09B Layer 2。
    // 此测试仅验证 provider 可创建，不测试 stream()（原生 fetch 会发起真实网络请求）。
    const provider = createProvider(
      { config: makeConfig('https://api.deepseek.com/v1'), apiKey: 'sk-test' },
      deps
    )
    expect(provider).toBeDefined()
    expect(typeof provider.stream).toBe('function')
  })
})
