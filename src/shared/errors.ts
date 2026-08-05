// src/shared/errors.ts
// 错误体系：ErrorCode 族、AppError、PublicAppError
// 依据：F5-011 §3

/** 错误码族。前缀即所属子系统，UI 层按前缀选用户文案 */
export type ErrorCode =
  | 'NET_OFFLINE'
  | 'NET_TIMEOUT'
  | 'NET_DNS'
  | 'LLM_AUTH'
  | 'LLM_RATE_LIMIT'
  | 'LLM_SERVER'
  | 'LLM_MALFORMED'
  | 'LLM_CIRCUIT_OPEN'
  | 'TTS_ENGINE_DOWN'
  | 'TTS_TIMEOUT'
  | 'TTS_DECODE'
  | 'ASR_INIT_FAIL'
  | 'ASR_DEVICE'
  | 'ASR_MODEL_MISSING'
  | 'MEM_DB_CORRUPT'
  | 'MEM_MIGRATE_FAIL'
  | 'MEM_EMBED_FAIL'
  | 'MEM_WRITE_FAIL'
  | 'MEM_NOT_FOUND'
  | 'MEM_DISABLED'
  | 'L2D_MODEL_LOAD'
  | 'L2D_WEBGL'
  | 'L2D_TEXTURE'
  | 'CFG_INVALID'
  | 'CFG_MIGRATE_FAIL'
  | 'SEC_KEYSTORE_DOWNGRADE'
  | 'IPC_VALIDATION'
  | 'CHAT_BUSY'
  | 'CHAT_CONTEXT_TOO_LARGE'
  | 'UNKNOWN'

export type ErrorSeverity = 'fatal' | 'error' | 'warn'

/** 给 renderer 的安全错误（不含 cause/stack）。依据 S-002 §3.1 */
export interface PublicAppError {
  code: ErrorCode
  message: string
  severity: ErrorSeverity
  retryable: boolean
}

/** IPC 错误。统一结果信封的失败分支。依据 S-003 §3.1 */
export interface IpcError {
  code: ErrorCode | 'IPC_UNAUTHORIZED' | 'IPC_INTERNAL'
  message: string // 预定义安全文案，不含 stack/用户正文
  retryable: boolean
  requestId?: string
}

export interface AppErrorOptions {
  code: ErrorCode
  /** 给用户看的安全文案（预定义、不含动态内容）。undefined = 不向用户展示 */
  userMessage?: string
  severity: ErrorSeverity
  /** 原始错误。写日志时 message 过 scrub()，stack 只留前 10 帧 */
  cause?: unknown
  /** 是否可通过重试恢复（断路器/离线状态机会读这个） */
  retryable?: boolean
}

/**
 * 统一错误类。全项目 throw 的错误最终都包装成 AppError。
 * 依据 F5-011 §3。
 */
export class AppError extends Error {
  readonly code: ErrorCode
  readonly userMessage?: string
  readonly severity: ErrorSeverity
  readonly retryable: boolean

  constructor(opts: AppErrorOptions) {
    super(
      opts.userMessage ?? opts.code,
      opts.cause !== undefined ? { cause: opts.cause } : undefined
    )
    this.name = 'AppError'
    this.code = opts.code
    this.userMessage = opts.userMessage
    this.severity = opts.severity
    this.retryable = opts.retryable ?? false
  }

  /** 转为安全公开错误（剥离 cause/stack） */
  toPublic(): PublicAppError {
    return {
      code: this.code,
      message: this.userMessage ?? this.code,
      severity: this.severity,
      retryable: this.retryable
    }
  }
}

/** 判断未知值是否为 AppError */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError
}
