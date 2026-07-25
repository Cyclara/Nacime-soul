// src/main/observability/logger.ts
// Logger 实现：LogFields 白名单 + scrub 脱敏 + 写盘失败降级 console + error 缓冲
// 依据：F5-011 §3、§5、S-001 P1-12
//
// 设计要点：
//   1. LogSink 接口抽象写入目标 -> 测试不依赖 electron-log
//   2. logger.ts 不静态导入 electron-log -> 测试无 Electron 依赖
//   3. 生产环境在 main 入口用 createElectronLogSink(log) 注入
//   4. 写盘失败降级 console（F5-011 §5 "绝不 throw"）
//   5. 格式化用 logger.scope（child 链权威），不读 fields.scope

import type { Logger, LogFields, LogLevel } from '@shared/observability/types'
import { scrub } from './scrub'
import type { ErrorBuffer } from './error-buffer'

/** 日志级别优先级（数字越小越严重）。依据 F5-011 §3 LogLevel */
const LEVEL_ORDER: Record<LogLevel, number> = {
  fatal: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4
}

/** tags 值最大长度。依据 F5-011 §3 LogFields.tags "短字符串（≤64 字符，超长截断）" */
const MAX_TAG_LENGTH = 64

// === LogSink 接口 ===

/**
 * 日志写入目标接口。
 * 生产环境用 electron-log 实现（createElectronLogSink），测试环境用 fake sink。
 */
export interface LogSink {
  write(level: LogLevel, formattedLine: string): void
}

/** console 降级 sink（写盘失败时用）。依据 F5-011 §5 */
const consoleSink: LogSink = {
  write(level, line) {
    const fn =
      level === 'fatal' || level === 'error'
        ? console.error
        : level === 'warn'
          ? console.warn
          : console.log
    fn(line)
  }
}

/** electron-log 的最小接口（避免静态导入 electron-log） */
export interface ElectronLogLike {
  error(...args: unknown[]): void
  warn(...args: unknown[]): void
  info(...args: unknown[]): void
  debug(...args: unknown[]): void
  verbose(...args: unknown[]): void
}

/**
 * 创建 electron-log sink。
 * 生产环境调用，传入 electron-log/main 的实例。
 * logger.ts 不静态导入 electron-log，避免测试时的 Electron 依赖。
 * 依据 F5-011 §5 "renderer 走 preload 桥，日志统一汇到 main 写盘"。
 *
 * electron-log 级别映射：fatal -> error（electron-log 无 fatal 级别）
 */
export function createElectronLogSink(electronLog: ElectronLogLike): LogSink {
  return {
    write(level, line) {
      switch (level) {
        case 'fatal':
        case 'error':
          electronLog.error(line)
          break
        case 'warn':
          electronLog.warn(line)
          break
        case 'info':
          electronLog.info(line)
          break
        case 'debug':
          electronLog.debug(line)
          break
      }
    }
  }
}

// === Logger 实现 ===

class LoggerImpl implements Logger {
  private readonly scope: string
  private readonly sink: LogSink
  private readonly minLevel: LogLevel
  private readonly errorBuffer?: ErrorBuffer

  constructor(opts: {
    scope: string
    sink: LogSink
    minLevel?: LogLevel
    errorBuffer?: ErrorBuffer
  }) {
    this.scope = opts.scope
    this.sink = opts.sink
    this.minLevel = opts.minLevel ?? 'info'
    this.errorBuffer = opts.errorBuffer
  }

  fatal(msg: string, fields: LogFields): void {
    this.log('fatal', msg, fields)
  }
  error(msg: string, fields: LogFields): void {
    this.log('error', msg, fields)
  }
  warn(msg: string, fields: LogFields): void {
    this.log('warn', msg, fields)
  }
  info(msg: string, fields: LogFields): void {
    this.log('info', msg, fields)
  }
  debug(msg: string, fields: LogFields): void {
    this.log('debug', msg, fields)
  }

  /**
   * 内部日志方法。
   * 流程：级别过滤 -> scrub 脱敏 -> 格式化 -> 推入错误缓冲 -> 写盘（失败降级 console）
   */
  private log(level: LogLevel, msg: string, fields: LogFields): void {
    // 级别过滤
    if (LEVEL_ORDER[level] > LEVEL_ORDER[this.minLevel]) return

    // 脱敏 msg 和 detail（写盘前最后一道，依据 F5-011 §3）
    const safeMsg = scrub(msg)
    const safeDetail = fields.detail !== undefined ? scrub(fields.detail) : undefined

    const line = this.formatLine(level, safeMsg, fields, safeDetail)

    // 推入错误缓冲（error 及以上级别）。依据 F5-011 §3 DebugSnapshot.recentErrors
    if (this.errorBuffer && LEVEL_ORDER[level] <= LEVEL_ORDER['error']) {
      this.errorBuffer.push({
        ts: Date.now(),
        level,
        code: fields.code,
        msg: safeMsg
      })
    }

    // 写盘，失败降级 console。依据 F5-011 §5 "日志写盘失败 -> 降级 console-only；绝不 throw"
    try {
      this.sink.write(level, line)
    } catch {
      consoleSink.write(level, line)
    }
  }

  /**
   * 格式化 LogFields 为单行可读字符串。
   * 用 logger.scope（child 链权威），不读 fields.scope。
   */
  private formatLine(
    level: LogLevel,
    msg: string,
    fields: LogFields,
    safeDetail: string | undefined
  ): string {
    const parts: string[] = [level.toUpperCase(), `[${this.scope}]`, msg]

    if (fields.code) parts.push(`code=${fields.code}`)
    if (fields.turnId) parts.push(`turnId=${fields.turnId}`)

    if (fields.tags) {
      for (const [k, v] of Object.entries(fields.tags)) {
        const truncated = v.length > MAX_TAG_LENGTH ? v.slice(0, MAX_TAG_LENGTH) : v
        parts.push(`${k}=${truncated}`)
      }
    }

    if (fields.metrics) {
      for (const [k, v] of Object.entries(fields.metrics)) {
        parts.push(`${k}=${v}`)
      }
    }

    if (safeDetail !== undefined) parts.push(`detail=${safeDetail}`)

    return parts.join(' ')
  }

  child(scope: string): Logger {
    return new LoggerImpl({
      scope: `${this.scope}.${scope}`,
      sink: this.sink,
      minLevel: this.minLevel,
      errorBuffer: this.errorBuffer
    })
  }
}

// === 全局配置与工厂 ===

/** 全局 sink（默认 console，生产环境通过 configureLogger 替换） */
let globalSink: LogSink = consoleSink
let globalMinLevel: LogLevel = 'info'
let globalErrorBuffer: ErrorBuffer | undefined

/**
 * 配置全局 Logger。生产环境在 main 入口调用。
 * 传入 electron-log sink 和可选的 ErrorBuffer。
 * 依据 F5-011 §5 "对外暴露：getLogger(scope)"。
 */
export function configureLogger(opts: {
  sink: LogSink
  minLevel?: LogLevel
  errorBuffer?: ErrorBuffer
}): void {
  globalSink = opts.sink
  globalMinLevel = opts.minLevel ?? 'info'
  globalErrorBuffer = opts.errorBuffer
}

/**
 * 获取带 scope 的 Logger。使用全局配置的 sink/minLevel/errorBuffer。
 * 依据 F5-011 §5 "对外暴露：getLogger(scope)"。
 */
export function getLogger(scope: string): Logger {
  return new LoggerImpl({
    scope,
    sink: globalSink,
    minLevel: globalMinLevel,
    errorBuffer: globalErrorBuffer
  })
}

/**
 * 创建独立 Logger（不依赖全局配置）。
 * 测试时用此函数创建带 fake sink 的 Logger。
 */
export function createLogger(opts: {
  scope: string
  sink: LogSink
  minLevel?: LogLevel
  errorBuffer?: ErrorBuffer
}): Logger {
  return new LoggerImpl(opts)
}
