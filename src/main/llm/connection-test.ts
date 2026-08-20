// src/main/llm/connection-test.ts
// P1-20: Phase 1 单 provider 调用 - 连接测试
// 依据：S-001 P1-20 验收"Faux 连接成功；401->LLM_AUTH；5xx->LLM_SERVER"
//       S-001 P1-20 "连接测试不写日志正文"
//
// 设计要点：
//   1. testConnection 接受 LLMProvider 接口，不绑定具体实现
//   2. 用最小 ping 消息发起 stream，收到第一个 chunk 即判定连接成功
//   3. 收到首个 chunk 后立即 abort（不消耗完整回复）
//   4. 超时 -> NET_TIMEOUT；provider 抛 AppError -> 返回对应 code
//   5. 不记录消息正文（只记 provider/model/status/latency）
//
// 安全红线：
//   - ping 消息内容不进日志
//   - API Key 不进日志（由 provider 管理，只在 Authorization header）

import type { Logger } from '@shared/observability/types'
import type { ConnectionTestResult } from '@shared/config/types'
import { isAppError } from '@shared/errors'
import type { LLMProvider, LlmRequest } from './types'

/** 连接测试用的最小请求消息 */
const PING_REQUEST: LlmRequest = {
  messages: [{ role: 'user', content: 'ping' }]
}

/** testConnection 选项 */
export interface TestConnectionOptions {
  /** 超时毫秒数 */
  timeoutMs: number
  /** 日志器 */
  logger: Logger
  /** 附加日志标签（provider、model 等，不含正文） */
  tags?: Record<string, string>
}

/**
 * 测试与 LLM Provider 的连接。
 *
 * 流程：
 *   1. 创建 AbortController + 超时计时器
 *   2. 调用 provider.stream() 发送最小 ping 消息
 *   3. 收到第一个 chunk -> 连接成功，abort 并返回 { ok: true, latencyMs }
 *   4. provider 抛 AppError -> 返回 { ok: false, code }
 *   5. 超时 -> 返回 { ok: false, code: 'NET_TIMEOUT' }
 *
 * 不记录消息正文：日志只包含 provider/model/status/latency。
 *
 * @param provider LLM Provider 实例（可以是 OpenAI-compatible 或 Faux）
 * @param opts 选项（超时、日志、标签）
 */
export async function testConnection(
  provider: LLMProvider,
  opts: TestConnectionOptions
): Promise<ConnectionTestResult> {
  const { timeoutMs, logger, tags } = opts
  const controller = new AbortController()
  const start = Date.now()
  let gotChunk = false

  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    for await (const chunk of provider.stream(PING_REQUEST, controller.signal)) {
      // 收到第一个 chunk = 连接成功（chunk 内容不重要，只需确认连通）
      void chunk
      gotChunk = true
      controller.abort() // 立即停止，不消耗完整回复
      break
    }

    // S-03 修复：超时 abort 且从未收到任何 chunk -> 报超时，而不是"流自然结束=成功"。
    // 真实 provider（openai-compatible）把外部 abort 当"用户取消"静默返回（不抛错），
    // 于是挂起端点超时后 for-await 循环自然结束走到这里；若只看"循环结束"会误报成功。
    if (!gotChunk && controller.signal.aborted) {
      logger.warn('model connection test: timeout', {
        scope: 'llm',
        code: 'NET_TIMEOUT',
        tags: { ...tags, timeoutMs: String(timeoutMs) }
      })
      return { ok: false, code: 'NET_TIMEOUT' }
    }

    // 走到这里：要么收到了 chunk（成功），要么非超时的空流（空响应也视为连接成功）
    const latencyMs = Date.now() - start
    logger.info('model connection test passed', {
      scope: 'llm',
      tags: { ...tags, latencyMs: String(latencyMs) }
    })
    return { ok: true, latencyMs }
  } catch (e) {
    // 如果已经收到过 chunk，abort 是我们主动发起的（成功）
    if (gotChunk) {
      const latencyMs = Date.now() - start
      logger.info('model connection test passed', {
        scope: 'llm',
        tags: { ...tags, latencyMs: String(latencyMs) }
      })
      return { ok: true, latencyMs }
    }

    // Provider 错误（401、5xx 等已映射为 AppError）。先于超时判断：
    // 避免"401 与超时几乎同时发生"时超时掩盖真实的认证问题。
    if (isAppError(e)) {
      logger.warn('model connection test failed', {
        scope: 'llm',
        code: e.code,
        tags
      })
      return { ok: false, code: e.code }
    }

    // 超时（controller 被 timeout 触发 abort，且 provider 抛了错——如 fetch AbortError）
    if (controller.signal.aborted) {
      logger.warn('model connection test: timeout', {
        scope: 'llm',
        code: 'NET_TIMEOUT',
        tags: { ...tags, timeoutMs: String(timeoutMs) }
      })
      return { ok: false, code: 'NET_TIMEOUT' }
    }

    // 未知错误（非 AppError 的异常）
    logger.error('model connection test: unknown error', {
      scope: 'llm',
      code: 'UNKNOWN',
      tags,
      detail: e instanceof Error ? e.message : String(e)
    })
    return { ok: false, code: 'NET_OFFLINE' }
  } finally {
    clearTimeout(timeoutId)
  }
}
