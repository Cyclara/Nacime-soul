// src/main/llm/stream.ts
// P1-19: 流式增量解析 - SSE 协议解析 + UTF-8 跨 chunk 边界 + AbortSignal
// 依据：S-001 P1-19 验收"chunk 顺序正确；abort 后无晚到 chunk；UTF-8 跨 chunk 边界"
//
// 设计要点：
//   1. parseSseStream 是通用 SSE 解析器，不绑定 OpenAI wire 格式
//   2. UTF-8 跨 chunk 边界：用 TextDecoder({ stream: true })，不在 chunk 边界截断多字节字符
//   3. AbortSignal：signal.aborted 时立即停止读取，保证"abort 后无晚到 chunk"
//   4. 超时由调用方（adapter）通过 AbortController 管理，parseSseStream 只响应 signal
//   5. SSE 行协议：data: <payload>\n\n，支持多行 data 拼接（SSE 规范）
//
// 依据 S-003 §3.8：delta 单块最大 16KB 由 ChatService 合并控制，provider 层不合并。

import { AppError } from '@shared/errors'

/** SSE 流解析选项 */
export interface SseParseOptions {
  /** 外部取消信号。abort 后立即停止读取，保证无晚到 chunk */
  signal?: AbortSignal
}

/** SSE 行协议：data: <payload>\n\n，支持多行 data 拼接（SSE 规范） */
const MAX_LINE_LENGTH = 1_000_000 // M-27：单行缓冲上限（1MB），防恶意/故障端点无限增长内存
const MAX_DATA_LINES = 100_000 // M-27：单事件累积 data 行上限

/**
 * 解析 SSE 流，逐个 yield data 负载字符串。
 *
 * SSE 协议（W3C EventSource 规范）：
 *   - 以 `data: ` 开头的行是数据行
 *   - 多行 data 以 \n 分隔，事件以空行（\n\n）结束
 *   - `: ` 开头是注释行（心跳）
 *   - `event:` / `id:` / `retry:` 是其他字段（本解析器忽略）
 *
 * 本解析器逐行 yield data 内容。多行 data 按 SSE 规范用 \n 拼接后 yield。
 * 调用方（adapter）负责将 data 字符串解析为 vendor 特定的 JSON。
 *
 * @param response fetch Response，必须有 body 流
 * @param opts 解析选项（signal）
 * @yields data 负载字符串（不含 `data: ` 前缀）
 */
export async function* parseSseStream(
  response: Response,
  opts: SseParseOptions = {}
): AsyncIterable<string> {
  const body = response.body
  if (!body) {
    throw new AppError({
      code: 'LLM_MALFORMED',
      userMessage: '模型响应体为空',
      severity: 'error',
      retryable: false
    })
  }

  const reader = body.getReader()
  // TextDecoder stream:true 模式：保留未完成的多字节序列到下一次 decode，解决 UTF-8 跨 chunk 边界
  const decoder = new TextDecoder('utf-8')
  let lineBuffer = ''
  // 当前事件的 data 行累积（SSE 规范：多行 data 用 \n 拼接为一个事件）
  let dataLines: string[] = []

  const signal = opts.signal

  // 已 abort 则直接返回
  if (signal?.aborted) {
    try {
      reader.releaseLock()
    } catch {
      /* already released */
    }
    return
  }

  // abort 时取消 reader，使正在等待的 reader.read() 立即 reject
  const onAbort = (): void => {
    reader.cancel().catch((): void => {
      /* noop */
    })
  }
  if (signal) {
    signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    while (true) {
      let readResult: ReadableStreamReadResult<Uint8Array>
      try {
        readResult = await reader.read()
      } catch (e) {
        // 审计 B-5：只有 abort 才是"正常结束"。
        // 旧实现把一切读取异常都当正常结束，于是网络中断（undici
        // 'terminated'/ECONNRESET）产生的半截回复会被当成完整回复落库，
        // 用户看到的是一句没说完的话，且没有任何错误提示、无法重试。
        if (signal?.aborted) {
          // 用户主动取消：静默返回，保证"abort 后无晚到 chunk"
          return
        }
        throw new AppError({
          code: 'LLM_SERVER',
          userMessage: '回复中断了，网络好像不太稳定。要我再试一次吗？',
          severity: 'error',
          retryable: true,
          cause: e
        })
      }

      const { done, value } = readResult
      if (done) break

      // UTF-8 跨 chunk 边界：stream:true 保留未完成的多字节序列
      lineBuffer += decoder.decode(value, { stream: true })

      // M-27：单行长度上限（无换行的巨行会无限增长 lineBuffer）
      if (lineBuffer.length > MAX_LINE_LENGTH) {
        throw new AppError({
          code: 'LLM_MALFORMED',
          userMessage: '模型响应行过长，连接可能异常',
          severity: 'error',
          retryable: false
        })
      }

      // 按行处理。最后一个可能不完整的行保留在 lineBuffer。
      const lines = lineBuffer.split('\n')
      lineBuffer = lines.pop() ?? ''

      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '') // 去除 CR（CRLF -> LF 兼容）

        if (line === '') {
          // 空行 = 事件结束。如果有累积的 data，yield 并重置。
          if (dataLines.length > 0) {
            yield dataLines.join('\n')
            dataLines = []
          }
          continue
        }

        if (line.startsWith(':')) {
          // 注释行（SSE 心跳），忽略
          continue
        }

        if (line.startsWith('data:')) {
          // data 行。slice(5) 去掉 "data:" 前缀，trim 去掉可选的单个空格。
          // SSE 规范：data: 后面有一个可选空格，然后是数据。
          const data = line.slice(5)
          // 保留 data 内容（包括前导空格后的内容），但去掉规范允许的单个前导空格
          dataLines.push(data.startsWith(' ') ? data.slice(1) : data)
          // M-27：单事件累积 data 行上限（超大事件防内存膨胀）
          if (dataLines.length > MAX_DATA_LINES) {
            throw new AppError({
              code: 'LLM_MALFORMED',
              userMessage: '模型响应事件过大，连接可能异常',
              severity: 'error',
              retryable: false
            })
          }
          continue
        }

        // event: / id: / retry: 等其他字段，Phase 1 忽略
      }
    }

    // M-01 修复：流结束时先把 decoder 残留的尾字节并入 lineBuffer，再统一按行 flush。
    // 旧实现把 decoder.decode() 补出的字符单独按"整行以 data: 开头"判断——
    // 当流无结尾空行、且最后 data 行的末字符被切在 chunk 边界时，补全出的尾字符
    // 因不构成完整 `data:` 行而被静默丢弃（如 "你"+"好"首字节 → 只 yield "你"）。
    const tail = decoder.decode()
    if (tail) {
      lineBuffer += tail
    }
    // flush 剩余的 lineBuffer（可能没有结尾空行）
    if (lineBuffer) {
      const line = lineBuffer.replace(/\r$/, '')
      if (line.startsWith('data:')) {
        const data = line.slice(5)
        dataLines.push(data.startsWith(' ') ? data.slice(1) : data)
      }
    }
    // flush 最后一个事件（如果流结束时没有空行结尾）
    if (dataLines.length > 0) {
      yield dataLines.join('\n')
      dataLines = []
    }
  } finally {
    if (signal) {
      signal.removeEventListener('abort', onAbort)
    }
    try {
      reader.releaseLock()
    } catch {
      /* already released */
    }
  }
}
