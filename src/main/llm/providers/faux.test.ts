// src/main/llm/providers/faux.test.ts
// P1-22 测试：Faux Provider
// 依据：S-001 P1-22 验收"可编程流、调用次数、剩余响应数均可断言"
//       S-004 §3.3 #21-#24（队列消费、chunk 流式、abort、中途错误）
//       S-004 §3.2 FauxStep / FauxProviderHandle 契约

import { describe, it, expect } from 'vitest'
import { createFauxProvider, type FauxStep } from './faux'
import type { LlmRequest } from '../types'
import { AppError, isAppError } from '@shared/errors'

// === 测试辅助 ===

function makeRequest(text = 'hello'): LlmRequest {
  return {
    messages: [{ role: 'user', content: text }]
  }
}

async function collectChunks(
  iterable: AsyncIterable<unknown>
): Promise<Array<{ type: string; text?: string; inputTokens?: number; outputTokens?: number }>> {
  const chunks: Array<{
    type: string
    text?: string
    inputTokens?: number
    outputTokens?: number
  }> = []
  for await (const chunk of iterable) {
    chunks.push(
      chunk as { type: string; text?: string; inputTokens?: number; outputTokens?: number }
    )
  }
  return chunks
}

// === 测试 ===

describe('P1-22 Faux Provider', () => {
  it('S-004 #21: 响应队列按顺序消费，pending 数正确', async () => {
    const faux = createFauxProvider()
    faux.setResponses([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
      { type: 'text', text: 'third' }
    ])

    expect(faux.pending()).toBe(3)

    // 第一次调用
    const chunks1 = await collectChunks(faux.stream(makeRequest()))
    expect(faux.pending()).toBe(2)
    expect(faux.callCount()).toBe(1)

    // 第二次调用
    const chunks2 = await collectChunks(faux.stream(makeRequest()))
    expect(faux.pending()).toBe(1)
    expect(faux.callCount()).toBe(2)

    // 第三次调用
    const chunks3 = await collectChunks(faux.stream(makeRequest()))
    expect(faux.pending()).toBe(0)
    expect(faux.callCount()).toBe(3)

    // 验证响应顺序
    const text1 = chunks1
      .filter((c) => c.type === 'delta')
      .map((c) => c.text)
      .join('')
    const text2 = chunks2
      .filter((c) => c.type === 'delta')
      .map((c) => c.text)
      .join('')
    const text3 = chunks3
      .filter((c) => c.type === 'delta')
      .map((c) => c.text)
      .join('')
    expect(text1).toBe('first')
    expect(text2).toBe('second')
    expect(text3).toBe('third')
  })

  it('S-004 #22: 按 chunk 产生完整文本', async () => {
    const faux = createFauxProvider()
    faux.setResponses([{ type: 'text', text: 'Hello, World!', chunkSize: 5 }])

    const chunks = await collectChunks(faux.stream(makeRequest()))
    const deltas = chunks.filter((c) => c.type === 'delta')

    // chunkSize=5 -> ['Hello', ', Wor', 'ld!']
    expect(deltas).toHaveLength(3)
    expect(deltas[0]!.text).toBe('Hello')
    expect(deltas[1]!.text).toBe(', Wor')
    expect(deltas[2]!.text).toBe('ld!')

    // 完整文本拼接正确
    const fullText = deltas.map((c) => c.text).join('')
    expect(fullText).toBe('Hello, World!')
  })

  it('不分块时整段文本作为一个 delta', async () => {
    const faux = createFauxProvider()
    faux.setResponses([{ type: 'text', text: 'one piece' }])

    const chunks = await collectChunks(faux.stream(makeRequest()))
    const deltas = chunks.filter((c) => c.type === 'delta')

    expect(deltas).toHaveLength(1)
    expect(deltas[0]!.text).toBe('one piece')
  })

  it('产出 usage chunk（流末尾）', async () => {
    const faux = createFauxProvider()
    faux.setResponses([{ type: 'text', text: 'hello world' }])

    const chunks = await collectChunks(faux.stream(makeRequest('test input')))

    const usage = chunks.find((c) => c.type === 'usage')
    expect(usage).toBeDefined()
    expect(usage!.inputTokens).toBeGreaterThan(0)
    expect(usage!.outputTokens).toBeGreaterThan(0)

    // usage 是最后一个 chunk
    expect(chunks[chunks.length - 1]!.type).toBe('usage')
  })

  it('S-004 #23: AbortSignal 后停止出块', async () => {
    const faux = createFauxProvider()
    faux.setResponses([
      { type: 'text', text: 'abcdefghijklmnopqrstuvwxyz', chunkSize: 1, delayMs: 50 }
    ])

    const controller = new AbortController()
    const collected: string[] = []

    // 启动流式迭代，在收到几个 chunk 后 abort
    const iter = faux.stream(makeRequest(), controller.signal)
    let count = 0
    for await (const chunk of collected.length < 99 ? iter : iter) {
      if (chunk && typeof chunk === 'object' && 'type' in chunk && chunk.type === 'delta') {
        collected.push((chunk as { text: string }).text)
        count++
        if (count === 3) {
          controller.abort()
        }
      }
    }

    // abort 后不应产出全部 26 个 chunk
    expect(collected.length).toBeLessThan(26)
    expect(collected.length).toBeGreaterThanOrEqual(1)
  })

  it('S-004 #24: 中途错误保留已接收文本并抛 AppError', async () => {
    const faux = createFauxProvider()
    faux.setResponses([{ type: 'error', code: 'LLM_SERVER', afterChars: 15 }])

    const collected: string[] = []
    let caughtError: unknown = null

    try {
      for await (const chunk of faux.stream(makeRequest())) {
        if (chunk && typeof chunk === 'object' && 'type' in chunk && chunk.type === 'delta') {
          collected.push((chunk as { text: string }).text)
        }
      }
    } catch (e) {
      caughtError = e
    }

    // 已接收部分文本
    expect(collected.length).toBeGreaterThan(0)
    const receivedText = collected.join('')
    expect(receivedText.length).toBe(15)

    // 抛出 AppError
    expect(isAppError(caughtError)).toBe(true)
    expect((caughtError as InstanceType<typeof AppError>).code).toBe('LLM_SERVER')
  })

  it('error step afterChars=0 时直接抛错，无 delta', async () => {
    const faux = createFauxProvider()
    faux.setResponses([{ type: 'error', code: 'LLM_AUTH' }])

    let caughtError: unknown = null
    let deltaCount = 0

    try {
      for await (const chunk of faux.stream(makeRequest())) {
        if (chunk && typeof chunk === 'object' && 'type' in chunk && chunk.type === 'delta') {
          deltaCount++
        }
      }
    } catch (e) {
      caughtError = e
    }

    expect(deltaCount).toBe(0)
    expect(isAppError(caughtError)).toBe(true)
    expect((caughtError as InstanceType<typeof AppError>).code).toBe('LLM_AUTH')
  })

  it('函数响应：按 request 动态决定响应', async () => {
    const faux = createFauxProvider()
    const factory: FauxStep = (request, state) => {
      const userText = request.messages[0]!.content
      return {
        type: 'text',
        text: `call#${state.callCount}: echo "${userText}"`
      }
    }
    faux.setResponses([factory])

    const chunks = await collectChunks(faux.stream(makeRequest('hello')))
    const text = chunks
      .filter((c) => c.type === 'delta')
      .map((c) => c.text)
      .join('')

    expect(text).toBe('call#1: echo "hello"')
    expect(faux.callCount()).toBe(1)
  })

  it('函数响应可以是 async', async () => {
    const faux = createFauxProvider()
    const factory: FauxStep = async (_request, state) => {
      await new Promise((r) => setTimeout(r, 10))
      return { type: 'text', text: `async call#${state.callCount}` }
    }
    faux.setResponses([factory])

    const chunks = await collectChunks(faux.stream(makeRequest()))
    const text = chunks
      .filter((c) => c.type === 'delta')
      .map((c) => c.text)
      .join('')

    expect(text).toBe('async call#1')
  })

  it('calls() 记录所有请求', async () => {
    const faux = createFauxProvider()
    faux.setResponses([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' }
    ])

    await collectChunks(faux.stream(makeRequest('first')))
    await collectChunks(faux.stream(makeRequest('second')))

    const calls = faux.calls()
    expect(calls).toHaveLength(2)
    expect(calls[0]!.messages[0]!.content).toBe('first')
    expect(calls[1]!.messages[0]!.content).toBe('second')
  })

  it('队列耗尽时抛测试错误', async () => {
    const faux = createFauxProvider()
    // 不设置任何响应

    let caughtError: unknown = null
    try {
      await collectChunks(faux.stream(makeRequest()))
    } catch (e) {
      caughtError = e
    }

    expect(isAppError(caughtError)).toBe(true)
    expect((caughtError as InstanceType<typeof AppError>).userMessage).toContain(
      'no more responses queued'
    )
  })

  it('appendResponses 追加到队列末尾', async () => {
    const faux = createFauxProvider()
    faux.setResponses([{ type: 'text', text: 'first' }])
    faux.appendResponses([{ type: 'text', text: 'second' }])

    expect(faux.pending()).toBe(2)

    const chunks1 = await collectChunks(faux.stream(makeRequest()))
    const chunks2 = await collectChunks(faux.stream(makeRequest()))

    expect(
      chunks1
        .filter((c) => c.type === 'delta')
        .map((c) => c.text)
        .join('')
    ).toBe('first')
    expect(
      chunks2
        .filter((c) => c.type === 'delta')
        .map((c) => c.text)
        .join('')
    ).toBe('second')
  })

  it('reset() 清空队列和调用记录', async () => {
    const faux = createFauxProvider()
    faux.setResponses([{ type: 'text', text: 'a' }])
    await collectChunks(faux.stream(makeRequest()))

    expect(faux.callCount()).toBe(1)
    expect(faux.calls()).toHaveLength(1)

    faux.reset()

    expect(faux.callCount()).toBe(0)
    expect(faux.calls()).toHaveLength(0)
    expect(faux.pending()).toBe(0)
  })

  it('delayMs 控制出块间隔', async () => {
    const faux = createFauxProvider()
    faux.setResponses([{ type: 'text', text: 'abcde', chunkSize: 1, delayMs: 30 }])

    const start = Date.now()
    await collectChunks(faux.stream(makeRequest()))
    const elapsed = Date.now() - start

    // 5 chunks * 30ms = ~150ms（允许误差）
    expect(elapsed).toBeGreaterThanOrEqual(100)
  })

  it('多个 text step 的 chunkSize 独立', async () => {
    const faux = createFauxProvider()
    faux.setResponses([
      { type: 'text', text: '123456', chunkSize: 2 },
      { type: 'text', text: 'abc', chunkSize: 1 }
    ])

    const chunks1 = await collectChunks(faux.stream(makeRequest()))
    const chunks2 = await collectChunks(faux.stream(makeRequest()))

    const deltas1 = chunks1.filter((c) => c.type === 'delta')
    const deltas2 = chunks2.filter((c) => c.type === 'delta')

    expect(deltas1).toHaveLength(3) // '12', '34', '56'
    expect(deltas2).toHaveLength(3) // 'a', 'b', 'c'
  })
})
