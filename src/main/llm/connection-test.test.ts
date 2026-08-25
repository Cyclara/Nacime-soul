// src/main/llm/connection-test.test.ts
// P1-20 测试：连接测试
// 依据：S-001 P1-20 验收"Faux 连接成功；401->LLM_AUTH；5xx->LLM_SERVER"
//       S-001 P1-20 "连接测试不写日志正文"

import { describe, it, expect } from 'vitest'
import { testConnection } from './connection-test'
import { createFauxProvider } from './providers/faux'
import type { LLMProvider, LlmStreamChunk } from './types'
import type { Logger } from '@shared/observability/types'
import { AppError } from '@shared/errors'

// === 测试辅助 ===

function noopLogger(): Logger {
  const log: Logger = {
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
      return log
    }
  }
  return log
}

/** 创建一个手动控制的 provider（用于测试超时和错误） */
function makeManualProvider(opts: {
  chunks?: LlmStreamChunk[]
  error?: Error
  delayMs?: number
}): LLMProvider {
  const { chunks = [], error, delayMs = 0 } = opts
  return {
    async *stream(_request, signal) {
      if (delayMs > 0) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs)
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              reject(new DOMException('Aborted', 'AbortError'))
            },
            { once: true }
          )
        })
      }
      if (error) throw error
      for (const chunk of chunks) {
        if (signal?.aborted) return
        yield chunk
      }
    }
  }
}

/**
 * 模拟真实 provider（openai-compatible）的 abort 语义：
 * 外部 abort 时生成器静默 return（不抛错），模拟"超时后循环自然结束"的路径。
 * 旧实现会因此把超时误判为"流自然结束=连接成功"（S-03 回归用例）。
 */

function makeSilentAbortProvider(delayMs = 10_000): LLMProvider {
  return {
    // eslint-disable-next-line require-yield -- 有意不 yield 任何 chunk（静默返回，模拟真实 provider）
    async *stream(_request, signal) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs)
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            resolve() // 静默返回，不 reject
          },
          { once: true }
        )
      })
      return // 生成器自然结束，不 yield 任何 chunk
    }
  }
}

// === 测试 ===

describe('P1-20 Connection Test', () => {
  it('Faux 连接成功', async () => {
    const faux = createFauxProvider()
    faux.setResponses([{ type: 'text', text: 'hello' }])

    const result = await testConnection(faux, {
      timeoutMs: 5000,
      logger: noopLogger(),
      tags: { provider: 'faux', model: 'faux-1' }
    })

    expect(result.ok).toBe(true)
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('401 -> LLM_AUTH', async () => {
    const provider = makeManualProvider({
      error: new AppError({
        code: 'LLM_AUTH',
        userMessage: 'API Key 无效',
        severity: 'error',
        retryable: false
      })
    })

    const result = await testConnection(provider, {
      timeoutMs: 5000,
      logger: noopLogger(),
      tags: { provider: 'deepseek', model: 'deepseek-chat' }
    })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('LLM_AUTH')
  })

  it('5xx -> LLM_SERVER', async () => {
    const provider = makeManualProvider({
      error: new AppError({
        code: 'LLM_SERVER',
        userMessage: '模型服务暂时不可用',
        severity: 'error',
        retryable: true
      })
    })

    const result = await testConnection(provider, {
      timeoutMs: 5000,
      logger: noopLogger()
    })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('LLM_SERVER')
  })

  it('429 -> LLM_RATE_LIMIT', async () => {
    const provider = makeManualProvider({
      error: new AppError({
        code: 'LLM_RATE_LIMIT',
        userMessage: '请求过于频繁',
        severity: 'error',
        retryable: true
      })
    })

    const result = await testConnection(provider, {
      timeoutMs: 5000,
      logger: noopLogger()
    })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('LLM_RATE_LIMIT')
  })

  it('超时 -> NET_TIMEOUT', async () => {
    const provider = makeManualProvider({ delayMs: 1000 })

    const result = await testConnection(provider, {
      timeoutMs: 100,
      logger: noopLogger()
    })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('NET_TIMEOUT')
  })

  it('S-03 回归：provider 在超时 abort 时静默返回 -> 必须报 NET_TIMEOUT 而非误报成功', async () => {
    // 真实 openai-compatible provider 把外部 abort 当"用户取消"静默 return，
    // 旧实现在循环自然结束后误判为"连接成功"。
    const provider = makeSilentAbortProvider(10_000)

    const result = await testConnection(provider, {
      timeoutMs: 100,
      logger: noopLogger()
    })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('NET_TIMEOUT')
  })

  it('收到第一个 chunk 后立即停止（不等待完整回复）', async () => {
    const faux = createFauxProvider()
    faux.setResponses([
      {
        type: 'text',
        text: '这是一个很长的回复'.repeat(50),
        chunkSize: 1,
        delayMs: 50
      }
    ])

    const start = Date.now()
    const result = await testConnection(faux, {
      timeoutMs: 10000,
      logger: noopLogger()
    })
    const elapsed = Date.now() - start

    expect(result.ok).toBe(true)
    // 应该在收到第一个 chunk 后立即返回，不等待全部 50*7=350 个 chunk
    expect(elapsed).toBeLessThan(500)
  })

  it('空流（无 chunk）也视为连接成功', async () => {
    const provider = makeManualProvider({ chunks: [] })

    const result = await testConnection(provider, {
      timeoutMs: 5000,
      logger: noopLogger()
    })

    expect(result.ok).toBe(true)
  })

  it('非 AppError 的未知错误 -> NET_OFFLINE', async () => {
    const provider = makeManualProvider({
      error: new Error('network error')
    })

    const result = await testConnection(provider, {
      timeoutMs: 5000,
      logger: noopLogger()
    })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('NET_OFFLINE')
  })

  it('Faux error step -> 返回对应错误码', async () => {
    const faux = createFauxProvider()
    faux.setResponses([{ type: 'error', code: 'LLM_AUTH' }])

    const result = await testConnection(faux, {
      timeoutMs: 5000,
      logger: noopLogger()
    })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('LLM_AUTH')
  })

  it('Faux error step afterChars > 0 时连接测试仍成功（收到 chunk = 连接正常）', async () => {
    const faux = createFauxProvider()
    faux.setResponses([{ type: 'error', code: 'LLM_SERVER', afterChars: 10 }])

    const result = await testConnection(faux, {
      timeoutMs: 5000,
      logger: noopLogger()
    })

    // 连接测试只关心能否收到数据；中途错误是 ChatService 的关注点
    expect(result.ok).toBe(true)
  })

  it('latencyMs 是非负数', async () => {
    const faux = createFauxProvider()
    faux.setResponses([{ type: 'text', text: 'ok' }])

    const result = await testConnection(faux, {
      timeoutMs: 5000,
      logger: noopLogger()
    })

    expect(result.ok).toBe(true)
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('不记录消息正文（日志只含 provider/model/status）', async () => {
    const faux = createFauxProvider()
    faux.setResponses([{ type: 'text', text: 'response' }])

    const loggedFields: Array<{ msg: string; tags?: Record<string, string> }> = []
    const trackingLogger: Logger = {
      ...noopLogger(),
      info(msg: string, fields) {
        loggedFields.push({ msg, tags: fields.tags })
      }
    }

    await testConnection(faux, {
      timeoutMs: 5000,
      logger: trackingLogger,
      tags: { provider: 'deepseek', model: 'deepseek-chat' }
    })

    // 验证日志中有 provider/model 但没有 ping 消息正文
    const infoLog = loggedFields.find((l) => l.msg === 'model connection test passed')
    expect(infoLog).toBeDefined()
    expect(infoLog!.tags!.provider).toBe('deepseek')
    expect(infoLog!.tags!.model).toBe('deepseek-chat')
    // 日志中不应出现 ping 消息内容
    const allLogStr = JSON.stringify(loggedFields)
    expect(allLogStr).not.toContain('"content":"ping"')
    expect(allLogStr).not.toContain('messages')
  })
})
