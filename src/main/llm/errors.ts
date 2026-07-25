// src/main/llm/errors.ts
// LLM 错误映射：HTTP 状态码 / 网络错误 -> AppError
// 依据：S-001 P1-18/P1-19、F5-011 §3 ErrorCode、S-003 §3.2 错误码
//
// 映射规则（依据 S-001 P1-19 验收"401 不重试"）：
//   401/403  -> LLM_AUTH        (retryable=false，不可重试)
//   429      -> LLM_RATE_LIMIT  (retryable=true)
//   5xx      -> LLM_SERVER      (retryable=true)
//   4xx(其他) -> LLM_MALFORMED   (retryable=false)
//   超时      -> NET_TIMEOUT     (retryable=true)
//   网络断开  -> NET_OFFLINE     (retryable=true)
//   DNS 失败  -> NET_DNS         (retryable=true)

import { AppError } from '@shared/errors'
import type { ErrorCode } from '@shared/errors'
import type { Logger } from '@shared/observability/types'

/** HTTP 状态码到 ErrorCode 的映射 */
function httpStatusToCode(status: number): ErrorCode {
  if (status === 401 || status === 403) return 'LLM_AUTH'
  if (status === 429) return 'LLM_RATE_LIMIT'
  if (status >= 500) return 'LLM_SERVER'
  if (status >= 400) return 'LLM_MALFORMED'
  return 'LLM_SERVER'
}

/** ErrorCode 对应的默认用户文案（预定义安全文案，不含动态内容）。仅覆盖 LLM 相关错误码 */
const ERROR_MESSAGES: Partial<Record<ErrorCode, string>> = {
  LLM_AUTH: 'API Key 无效或无权限',
  LLM_RATE_LIMIT: '请求过于频繁，请稍后再试',
  LLM_SERVER: '模型服务暂时不可用',
  LLM_MALFORMED: '请求参数有误',
  LLM_CIRCUIT_OPEN: '模型调用已熔断，请稍后再试',
  NET_TIMEOUT: '模型响应超时',
  NET_OFFLINE: '网络连接失败',
  NET_DNS: '域名解析失败',
  UNKNOWN: '未知错误'
}

/** 获取 ErrorCode 的用户文案，未注册的返回通用文案 */
function getMessage(code: ErrorCode): string {
  return ERROR_MESSAGES[code] ?? '模型调用失败'
}

/** ErrorCode 是否可重试 */
const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set([
  'LLM_RATE_LIMIT',
  'LLM_SERVER',
  'NET_TIMEOUT',
  'NET_OFFLINE',
  'NET_DNS'
])

/**
 * 将 HTTP 响应状态码映射为 AppError。
 * 依据 S-001 P1-19 验收"401 不重试"：401/403 -> LLM_AUTH retryable=false。
 *
 * @param status HTTP 状态码
 * @param errorBody 响应体文本（仅用于日志，不返回给 renderer）
 * @param logger 用于记录错误详情（errorBody 经过 scrub）
 * @param tags 附加日志标签（provider、model 等）
 */
export function mapHttpError(
  status: number,
  errorBody: string,
  logger: Logger,
  tags?: Record<string, string>
): AppError {
  const code = httpStatusToCode(status)
  const retryable = RETRYABLE_CODES.has(code)

  logger.warn('LLM HTTP error', {
    scope: 'llm',
    code,
    tags: { ...tags, status: String(status) },
    detail: errorBody.slice(0, 500) // 截断，防止超长错误体；经 scrub 脱敏后写盘
  })

  return new AppError({
    code,
    userMessage: getMessage(code),
    severity: 'error',
    retryable
  })
}

/**
 * 将 fetch 抛出的网络错误映射为 AppError。
 *
 * - AbortError（超时）-> NET_TIMEOUT
 * - AbortError（外部取消）-> 返回 null（调用方自行处理取消）
 * - DNS 解析失败 -> NET_DNS
 * - 其他网络错误 -> NET_OFFLINE
 *
 * @param error fetch 抛出的原始错误
 * @param logger 用于记录错误详情
 * @param tags 附加日志标签
 * @param isTimeout 是否为超时导致的 abort（区分超时和外部取消）
 */
export function mapFetchError(
  error: unknown,
  logger: Logger,
  tags?: Record<string, string>,
  isTimeout?: boolean
): AppError | null {
  const err = error as Error & { name?: string; cause?: { code?: string } }

  // AbortError
  if (err.name === 'AbortError') {
    if (isTimeout) {
      return new AppError({
        code: 'NET_TIMEOUT',
        userMessage: getMessage('NET_TIMEOUT'),
        severity: 'error',
        retryable: true
      })
    }
    // 外部取消，不产生错误
    return null
  }

  // DNS 解析失败
  const causeCode = err.cause?.code
  if (causeCode === 'ENOTFOUND' || causeCode === 'EAI_AGAIN') {
    logger.warn('LLM DNS resolution failed', {
      scope: 'llm',
      code: 'NET_DNS',
      tags,
      detail: err.message
    })
    return new AppError({
      code: 'NET_DNS',
      userMessage: getMessage('NET_DNS'),
      severity: 'error',
      retryable: true
    })
  }

  // 连接被拒绝 / 网络不可达
  if (
    causeCode === 'ECONNREFUSED' ||
    causeCode === 'ECONNRESET' ||
    causeCode === 'EPIPE' ||
    causeCode === 'ETIMEDOUT' ||
    causeCode === 'ENETUNREACH'
  ) {
    logger.warn('LLM network error', {
      scope: 'llm',
      code: 'NET_OFFLINE',
      tags,
      detail: err.message
    })
    return new AppError({
      code: 'NET_OFFLINE',
      userMessage: getMessage('NET_OFFLINE'),
      severity: 'error',
      retryable: true
    })
  }

  // 其他未知网络错误
  logger.error('LLM fetch failed', {
    scope: 'llm',
    code: 'UNKNOWN',
    tags,
    detail: err.message
  })
  return new AppError({
    code: 'NET_OFFLINE',
    userMessage: getMessage('NET_OFFLINE'),
    severity: 'error',
    retryable: true,
    cause: error
  })
}
