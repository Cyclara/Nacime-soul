// src/main/llm/providers/faux.ts
// P1-22: Pi 模式 Faux Provider - 可编程测试替身
// 依据：S-001 P1-22、S-004 §3.2（FauxStep / FauxProviderHandle 契约）、Pi faux.ts
//
// 核心价值（S-004 §2）：
//   "Pi Faux Provider 的真实价值是可编程 response queue、函数响应、chunk 流和事件记录；
//    本项目复用该契约，不用单一 vi.fn().mockResolvedValue() 冒充 provider。"
//
// 能力：
//   1. 响应队列：FIFO 消费，shift() 取下一个 step
//   2. 函数响应：step 可以是 (request, state) => FauxStep，按 request 动态响应
//   3. chunk 流式：text step 按 chunkSize 分块，delayMs 控制节奏
//   4. 中途错误：error step 在 afterChars 个字符后抛 AppError
//   5. AbortSignal：abort 后停止出块
//   6. 调用记录：calls() 返回所有请求
//   7. 队列耗尽：无 step 时抛测试错误（而非静默返回空）
//
// 契约（S-004 §3.2 FauxProviderHandle）：
//   - setResponses(steps): 替换队列
//   - appendResponses(steps): 追加到队列
//   - pending(): 返回剩余响应数
//   - calls(): 返回已记录的请求
//   - reset(): 清空队列和记录

import type { ErrorCode } from '@shared/errors'
import { AppError } from '@shared/errors'
import type { LLMProvider, LlmRequest, LlmStreamChunk } from '../types'

// === FauxStep 契约（S-004 §3.2）===

/**
 * Faux Provider 的可编程响应步骤。
 *
 * - text: 产出文本，可选分块和延迟
 * - error: 产出 afterChars 个字符后抛 AppError（模拟中途错误）
 * - function: 按 request 动态决定响应（函数响应）
 */
export type FauxStep =
  | { type: 'text'; text: string; chunkSize?: number; delayMs?: number }
  | { type: 'error'; code: ErrorCode; afterChars?: number }
  | ((request: LlmRequest, state: { callCount: number }) => FauxStep | Promise<FauxStep>)

/** FauxStep 解析后的类型（排除函数形式） */
type FauxResolvedStep =
  | { type: 'text'; text: string; chunkSize?: number; delayMs?: number }
  | { type: 'error'; code: ErrorCode; afterChars?: number }

/**
 * Faux Provider 句柄。扩展 LLMProvider 接口，提供测试断言方法。
 * 依据 S-004 §3.2 FauxProviderHandle 契约。
 */
export interface FauxProviderHandle extends LLMProvider {
  /** 替换响应队列 */
  setResponses(steps: FauxStep[]): void
  /** 追加响应到队列末尾 */
  appendResponses(steps: FauxStep[]): void
  /** 返回剩余响应数 */
  pending(): number
  /** 返回已记录的请求（只读副本） */
  calls(): readonly LlmRequest[]
  /** 清空队列和调用记录，重置 callCount */
  reset(): void
  /** 返回当前 callCount */
  callCount(): number
}

// === 内部辅助 ===

/** 用于 error step 的占位文本（afterChars 截取） */
const ERROR_PLACEHOLDER_TEXT =
  'This is a faux response that will be interrupted by a simulated error. '.repeat(4)

/** 将文本按 chunkSize 分割为 chunk 数组 */
function splitIntoChunks(text: string, chunkSize: number): string[] {
  if (chunkSize <= 0) return [text]
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize))
  }
  return chunks.length > 0 ? chunks : ['']
}

/** 延迟函数，支持 AbortSignal 提前取消 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true }
      )
    }
  })
}

/** 粗略估算 token 数（用于 usage chunk） */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// === Faux Provider 实现 ===

/**
 * 创建 Faux Provider。
 *
 * 使用方式：
 * ```ts
 * const faux = createFauxProvider()
 * faux.setResponses([{ type: 'text', text: 'hello' }])
 * for await (const chunk of faux.stream({ messages: [...] })) {
 *   // { type: 'delta', text: 'hello' }
 *   // { type: 'usage', inputTokens: 1, outputTokens: 2 }
 * }
 * expect(faux.callCount()).toBe(1)
 * expect(faux.pending()).toBe(0)
 * ```
 */
export function createFauxProvider(): FauxProviderHandle {
  let queue: FauxStep[] = []
  const calls: LlmRequest[] = []
  const state = { callCount: 0 }

  async function* stream(request: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmStreamChunk> {
    // 记录请求 + 递增 callCount
    calls.push(request)
    state.callCount++

    // 取下一个 step
    const step = queue.shift()
    if (!step) {
      // 队列耗尽：抛测试错误（S-004 §3.2 "响应队列耗尽时报测试错误"）
      throw new AppError({
        code: 'UNKNOWN',
        userMessage: 'Faux Provider: no more responses queued',
        severity: 'error',
        retryable: false
      })
    }

    // 解析函数 step（支持嵌套：工厂返回的 step 可能仍是工厂）
    let resolved: FauxResolvedStep = step as FauxResolvedStep
    let current: FauxStep = step
    let depth = 0
    while (typeof current === 'function' && depth < 10) {
      current = await current(request, state)
      depth++
    }
    resolved = current as FauxResolvedStep

    // error step：先产出 afterChars 个字符，再抛错
    if (resolved.type === 'error') {
      const afterChars = resolved.afterChars ?? 0
      if (afterChars > 0) {
        const prefix = ERROR_PLACEHOLDER_TEXT.slice(0, afterChars)
        const chunks = splitIntoChunks(prefix, Math.max(1, Math.ceil(afterChars / 3)))
        for (const chunk of chunks) {
          if (signal?.aborted) return
          yield { type: 'delta', text: chunk }
        }
      }
      throw new AppError({
        code: resolved.code,
        userMessage: `Faux simulated error: ${resolved.code}`,
        severity: 'error',
        retryable: false
      })
    }

    // text step：分块流式产出
    const { text, chunkSize, delayMs } = resolved
    const chunks = chunkSize ? splitIntoChunks(text, chunkSize) : [text]

    for (const chunk of chunks) {
      // abort 检查（每次出块前）
      if (signal?.aborted) return

      // 延迟（模拟流式节奏）
      if (delayMs && delayMs > 0) {
        await delay(delayMs, signal)
        if (signal?.aborted) return
      }

      yield { type: 'delta', text: chunk }
    }

    // 产出 usage（流末尾）
    const inputTokens = estimateTokens(request.messages.map((m) => m.content).join(''))
    const outputTokens = estimateTokens(text)
    yield { type: 'usage', inputTokens, outputTokens }
  }

  return {
    stream,
    setResponses(steps: FauxStep[]): void {
      queue = [...steps]
    },
    appendResponses(steps: FauxStep[]): void {
      queue.push(...steps)
    },
    pending(): number {
      return queue.length
    },
    calls(): readonly LlmRequest[] {
      return [...calls]
    },
    reset(): void {
      queue = []
      calls.length = 0
      state.callCount = 0
    },
    callCount(): number {
      return state.callCount
    }
  }
}
