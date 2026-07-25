// src/main/llm/provider.test.ts
// P1-26: Provider scope 合同测试
// 依据：S-004 §3.3.1 合同门禁 #5
//       "Phase 1 registry 只有 openai-compatible 与 faux；anthropic 配置不可被执行"
//       S-001 P1-18（Provider 范围合同）

import { describe, it, expect } from 'vitest'
import { createProvider, type ProviderFactoryDeps } from './provider'
import type { LlmRequest } from './types'
import type { Logger } from '@shared/observability/types'
import { isAppError } from '@shared/errors'

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

/** 创建测试用 ModelConfig 的辅助函数 */
function makeConfig(
  overrides: Partial<{
    provider: string
    protocol: string
    baseUrl: string
    model: string
  }> = {}
): Parameters<typeof createProvider>[0]['config'] {
  return {
    provider: overrides.provider ?? 'deepseek',
    protocol: (overrides.protocol ?? 'openai-compatible') as 'openai-compatible' | 'anthropic',
    baseUrl: overrides.baseUrl ?? 'https://api.deepseek.com/v1',
    model: overrides.model ?? 'deepseek-chat',
    displayName: 'DeepSeek',
    temperature: 0.8,
    topP: 0.95,
    maxTokens: 2048,
    timeoutMs: 60000,
    reasoningEffort: 'off' as const,
    compatOverrides: {}
  }
}

// === 测试 ===

describe('合同门禁 #5: Provider scope', () => {
  describe('Phase 1 支持 openai-compatible', () => {
    it('openai-compatible 协议创建 OpenAICompatibleProvider', () => {
      const provider = createProvider({ config: makeConfig(), apiKey: 'sk-test-key' }, deps)

      expect(provider).toBeDefined()
      expect(typeof provider.stream).toBe('function')
    })

    it('openai-compatible 协议创建的 provider 可正常 stream', async () => {
      // 使用 mock fetch 避免真实网络请求
      const mockFetch = async (): Promise<Response> => {
        return new Response(
          'data: {"id":"test","choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n',
          {
            status: 200,
            headers: { 'content-type': 'text/event-stream' }
          }
        )
      }

      const provider = createProvider(
        { config: makeConfig(), apiKey: 'sk-test-key', fetchFn: mockFetch as typeof fetch },
        deps
      )

      const request: LlmRequest = {
        messages: [{ role: 'user', content: 'hello' }]
      }

      const chunks: unknown[] = []
      for await (const chunk of provider.stream(request, new AbortController().signal)) {
        chunks.push(chunk)
      }

      expect(chunks.length).toBeGreaterThan(0)
    })
  })

  describe('Phase 1 拒绝 anthropic', () => {
    it('anthropic 协议抛出 AppError', () => {
      expect(() =>
        createProvider(
          {
            config: makeConfig({
              provider: 'anthropic',
              protocol: 'anthropic',
              baseUrl: 'https://api.anthropic.com/v1',
              model: 'claude-sonnet-4-5'
            }),
            apiKey: 'sk-ant-test-key'
          },
          deps
        )
      ).toThrow()
    })

    it('anthropic 协议抛出的 AppError code 为 CFG_INVALID', () => {
      try {
        createProvider(
          {
            config: makeConfig({
              provider: 'anthropic',
              protocol: 'anthropic',
              baseUrl: 'https://api.anthropic.com/v1',
              model: 'claude-sonnet-4-5'
            }),
            apiKey: 'sk-ant-test-key'
          },
          deps
        )
        expect.fail('should have thrown')
      } catch (err) {
        expect(isAppError(err)).toBe(true)
        if (isAppError(err)) {
          expect(err.code).toBe('CFG_INVALID')
          expect(err.severity).toBe('error')
          expect(err.retryable).toBe(false)
        }
      }
    })

    it('anthropic 协议错误消息明确指出尚未实现', () => {
      try {
        createProvider(
          {
            config: makeConfig({
              provider: 'anthropic',
              protocol: 'anthropic',
              baseUrl: 'https://api.anthropic.com/v1',
              model: 'claude-sonnet-4-5'
            }),
            apiKey: 'sk-ant-test-key'
          },
          deps
        )
        expect.fail('should have thrown')
      } catch (err) {
        if (isAppError(err)) {
          expect(err.userMessage).toContain('Anthropic')
        }
      }
    })
  })

  describe('Phase 1 拒绝未知协议', () => {
    it('未知协议抛出 AppError', () => {
      expect(() =>
        createProvider(
          {
            config: makeConfig({
              provider: 'unknown',
              protocol: 'google-gemini' as 'openai-compatible',
              baseUrl: 'https://api.example.com/v1',
              model: 'some-model'
            }),
            apiKey: 'test-key'
          },
          deps
        )
      ).toThrow()
    })
  })

  describe('Faux Provider 不经 createProvider', () => {
    it('createProvider 不产生 Faux Provider', () => {
      // Faux Provider 由 P1-22 的 createFauxProvider() 直接构造
      // 不经 createProvider 工厂（它是测试替身，非生产协议）
      // 此测试验证 createProvider 只处理生产协议
      const provider = createProvider({ config: makeConfig(), apiKey: 'sk-test-key' }, deps)

      // 不是 Faux Provider（Faux Provider 有 setResponses/calls/pending 等方法）
      expect(provider).not.toHaveProperty('setResponses')
      expect(provider).not.toHaveProperty('calls')
      expect(provider).not.toHaveProperty('pending')
    })
  })
})
