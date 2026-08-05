// src/main/llm/stream.test.ts
// P1-19 测试：SSE 流解析 - chunk 顺序、UTF-8 跨 chunk 边界、abort 后无晚到 chunk
// 依据：S-001 P1-19 验收"chunk 顺序正确；abort 后无晚到 chunk；UTF-8 跨 chunk 边界"

import { describe, it, expect } from 'vitest'
import { parseSseStream } from './stream'
import { isAppError } from '@shared/errors'

/** 创建 mock Response，body 为给定的 SSE 文本块序列 */
function mockResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    }
  })
  return new Response(stream)
}

/** 收集 async iterable 的所有值 */
async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const result: string[] = []
  for await (const item of iter) {
    result.push(item)
  }
  return result
}

// ── chunk 顺序正确 ──

describe('parseSseStream chunk 顺序', () => {
  it('多个 data 事件按顺序 yield', async () => {
    const response = mockResponse(['data: chunk1\n\n', 'data: chunk2\n\n', 'data: chunk3\n\n'])
    const result = await collect(parseSseStream(response))
    expect(result).toEqual(['chunk1', 'chunk2', 'chunk3'])
  })

  it('单个 data 事件', async () => {
    const response = mockResponse(['data: hello world\n\n'])
    const result = await collect(parseSseStream(response))
    expect(result).toEqual(['hello world'])
  })

  it('[DONE] 标记作为 data yield', async () => {
    const response = mockResponse(['data: chunk1\n\ndata: [DONE]\n\n'])
    const result = await collect(parseSseStream(response))
    expect(result).toEqual(['chunk1', '[DONE]'])
  })

  it('空 data 行被 yield 为空字符串', async () => {
    const response = mockResponse(['data:\n\n'])
    const result = await collect(parseSseStream(response))
    // data: 后无内容，slice(5) 得到空字符串，startsWith(' ') 为 false，push('')
    expect(result).toEqual([''])
  })
})

// ── 多行 data 拼接（SSE 规范）──

describe('parseSseStream 多行 data', () => {
  it('多行 data 用 \\n 拼接为一个事件', async () => {
    const response = mockResponse(['data: line1\ndata: line2\ndata: line3\n\n'])
    const result = await collect(parseSseStream(response))
    expect(result).toEqual(['line1\nline2\nline3'])
  })

  it('多行 data 跨 chunk 边界', async () => {
    const response = mockResponse(['data: line1\ndata: ', 'line2\n\n'])
    const result = await collect(parseSseStream(response))
    expect(result).toEqual(['line1\nline2'])
  })
})

// ── UTF-8 跨 chunk 边界 ──

describe('parseSseStream UTF-8 跨 chunk 边界', () => {
  it('中文字符跨 chunk 边界不截断', async () => {
    // "你好世界" 的 UTF-8 编码：e4 bd a0 e5 a5 bd e4 b8 96 e7 95 8c
    // 在第 4 字节处切分（"你"完整，"好"被切）
    const fullText = '你好世界'
    const encoded = new TextEncoder().encode(fullText)
    const splitPoint = 4 // "你"完整(3字节) + "好"的第1字节
    const chunk1 = encoded.slice(0, splitPoint)
    const chunk2 = encoded.slice(splitPoint)

    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: '))
          controller.enqueue(chunk1)
          controller.enqueue(chunk2)
          controller.enqueue(new TextEncoder().encode('\n\n'))
          controller.close()
        }
      })
    )
    const result = await collect(parseSseStream(response))
    expect(result).toEqual(['你好世界'])
  })

  it('emoji 跨 chunk 边界不截断', async () => {
    // "🎉" 的 UTF-8 编码：f0 9f 8e 89（4 字节）
    const emoji = '🎉'
    const encoded = new TextEncoder().encode(emoji)
    expect(encoded.length).toBe(4)

    // 在第 2 字节处切分
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder()
          controller.enqueue(encoder.encode('data: '))
          controller.enqueue(encoded.slice(0, 2))
          controller.enqueue(encoded.slice(2))
          controller.enqueue(encoder.encode('\n\n'))
          controller.close()
        }
      })
    )
    const result = await collect(parseSseStream(response))
    expect(result).toEqual(['🎉'])
  })

  it('混合中英文跨 chunk 边界', async () => {
    const text = 'Hello世界World'
    const encoded = new TextEncoder().encode(text)
    // 在 "世" 的第 1 字节处切分
    const splitPoint = 8 // "Hello" (5) + "世"的第1字节在位置 7-9
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder()
          controller.enqueue(encoder.encode('data: '))
          controller.enqueue(encoded.slice(0, splitPoint))
          controller.enqueue(encoded.slice(splitPoint))
          controller.enqueue(encoder.encode('\n\n'))
          controller.close()
        }
      })
    )
    const result = await collect(parseSseStream(response))
    expect(result).toEqual(['Hello世界World'])
  })
})

// ── abort 后无晚到 chunk ──

describe('parseSseStream abort', () => {
  it('已 abort 的 signal 直接返回空', async () => {
    const response = mockResponse(['data: chunk1\n\n'])
    const controller = new AbortController()
    controller.abort()
    const result = await collect(parseSseStream(response, { signal: controller.signal }))
    expect(result).toEqual([])
  })

  it('abort 后不再 yield 后续 chunk', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // 全部数据预入队，模拟数据已在网络缓冲区
        controller.enqueue(encoder.encode('data: chunk1\n\n'))
        controller.enqueue(encoder.encode('data: chunk2\n\n'))
        controller.enqueue(encoder.encode('data: chunk3\n\n'))
      }
    })

    const abortController = new AbortController()
    const response = new Response(stream)

    const chunks: string[] = []
    const iterPromise = (async () => {
      for await (const item of parseSseStream(response, { signal: abortController.signal })) {
        chunks.push(item)
        // 收到第一个 chunk 后立即 abort
        if (chunks.length === 1) {
          abortController.abort()
        }
      }
    })()

    await iterPromise
    // chunk1 在 abort 前已 yield；abort 后 reader.cancel() 阻止后续读取
    // chunk2/chunk3 不应出现（或至多 chunk1 + chunk2，取决于 cancel 时序）
    expect(chunks[0]).toBe('chunk1')
    expect(chunks.length).toBeLessThanOrEqual(2)
  })
})

// === 审计 B-5 回归：网络中断 ≠ 正常结束 ===
// 修复前所有读取异常都被当成正常结束，半截回复会被当完整回复落库。
describe('parseSseStream 传输错误（B-5）', () => {
  it('无 abort 时读取失败必须抛 LLM_SERVER 且可重试（不静默截断）', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: partial\n\n'))
        // 模拟 undici 'terminated' / ECONNRESET
        controller.error(new Error('terminated'))
      }
    })
    const response = new Response(stream)

    const chunks: string[] = []
    let caught: unknown = null
    try {
      for await (const item of parseSseStream(response)) {
        chunks.push(item)
      }
    } catch (e) {
      caught = e
    }

    // 关键断言：必须抛错，让上层知道回复不完整（修复前是静默 return，被当正常结束）
    expect(caught).not.toBeNull()
    expect(caught).toMatchObject({ code: 'LLM_SERVER', retryable: true })
    // 本用例中流在首次 read 前即进入错误态，故 chunks 为空；
    // 重点不是收到多少，而是"错误没有被吞掉"。
    expect(chunks.length).toBeLessThanOrEqual(1)
  })

  it('已 yield 若干 chunk 后中途断线：保留已收内容且仍然抛错', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        // 用 pull 分次投递，让前两个 chunk 真的被读到再断
        controller.enqueue(encoder.encode('data: first\n\n'))
        await Promise.resolve()
        controller.enqueue(encoder.encode('data: second\n\n'))
        await Promise.resolve()
        controller.error(new Error('terminated'))
      }
    })
    const response = new Response(stream)

    const chunks: string[] = []
    let caught: unknown = null
    try {
      for await (const item of parseSseStream(response)) {
        chunks.push(item)
      }
    } catch (e) {
      caught = e
    }

    // 已收到的内容不丢
    expect(chunks).toContain('first')
    // 且错误没被吞（这正是"半截回复被存成完整"的根因）
    expect(caught).toMatchObject({ code: 'LLM_SERVER', retryable: true })
  })

  it('已 abort 时读取失败仍静默返回（用户主动取消不算错误）', async () => {
    const encoder = new TextEncoder()
    const abortController = new AbortController()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: chunk1\n\n'))
      }
    })
    const response = new Response(stream)

    const chunks: string[] = []
    // 不应抛错
    for await (const item of parseSseStream(response, { signal: abortController.signal })) {
      chunks.push(item)
      abortController.abort()
    }
    expect(chunks[0]).toBe('chunk1')
  })
})

// ── 注释/心跳行 ──

describe('parseSseStream 注释行', () => {
  it('跳过 : 开头的注释行（心跳）', async () => {
    const response = mockResponse([': heartbeat\n\ndata: chunk1\n\n'])
    const result = await collect(parseSseStream(response))
    expect(result).toEqual(['chunk1'])
  })

  it('忽略 event/id/retry 字段', async () => {
    const response = mockResponse(['event: message\nid: 123\ndata: chunk1\nretry: 3000\n\n'])
    const result = await collect(parseSseStream(response))
    expect(result).toEqual(['chunk1'])
  })
})

// ── 流边界条件 ──

describe('parseSseStream 边界条件', () => {
  it('无结尾空行时 flush 剩余 data', async () => {
    // 流结束时没有 \n\n，只有一行 data
    const response = mockResponse(['data: flush-me'])
    const result = await collect(parseSseStream(response))
    expect(result).toEqual(['flush-me'])
  })

  it('跨 chunk 的行边界', async () => {
    // "data: chu" + "nk1\n\n"
    const response = mockResponse(['data: chu', 'nk1\n\n'])
    const result = await collect(parseSseStream(response))
    expect(result).toEqual(['chunk1'])
  })

  it('空 body 抛 LLM_MALFORMED', async () => {
    const response = new Response(null)
    try {
      await collect(parseSseStream(response))
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(isAppError(e)).toBe(true)
      if (isAppError(e)) {
        expect(e.code).toBe('LLM_MALFORMED')
      }
    }
  })

  it('CRLF 行尾兼容', async () => {
    const response = mockResponse(['data: chunk1\r\n\r\ndata: chunk2\r\n\r\n'])
    const result = await collect(parseSseStream(response))
    expect(result).toEqual(['chunk1', 'chunk2'])
  })

  it('data: 后无空格', async () => {
    const response = mockResponse(['data:nospace\n\n'])
    const result = await collect(parseSseStream(response))
    expect(result).toEqual(['nospace'])
  })

  it('data: 后有一个空格（SSE 规范）', async () => {
    const response = mockResponse(['data: with-space\n\n'])
    const result = await collect(parseSseStream(response))
    expect(result).toEqual(['with-space'])
  })

  it('完整 OpenAI 流式响应模拟', async () => {
    const sseChunks = [
      'data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n'
    ]
    const response = mockResponse(sseChunks)
    const result = await collect(parseSseStream(response))
    expect(result).toHaveLength(5)
    expect(result[0]).toContain('"role":"assistant"')
    expect(result[1]).toContain('"Hello"')
    expect(result[4]).toBe('[DONE]')
  })
})
