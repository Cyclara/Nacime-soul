// src/main/observability/error-buffer.ts
// 内存错误环形缓冲：保留最近 50 条已脱敏错误，供 DebugSnapshot.recentErrors 使用
// 依据：F5-011 §3（DebugSnapshot.recentErrors ≤50）、S-001 P1-12

import type { ErrorCode } from '@shared/errors'
import type { LogLevel } from '@shared/observability/types'

/** 单条错误记录（已脱敏）。与 DebugSnapshot.recentErrors 元素结构一致 */
export interface ErrorEntry {
  ts: number
  level: LogLevel
  code?: ErrorCode
  msg: string // 已过 scrub()，安全
}

/** 默认缓冲容量。依据 F5-011 §3 DebugSnapshot.recentErrors ≤50 */
const DEFAULT_MAX_ENTRIES = 50

/**
 * 内存错误环形缓冲。
 * 保留最近 N 条错误记录，超出容量时丢弃最旧的。
 *
 * 依据 F5-011 §2 "败而不崩"：缓冲溢出丢弃最旧，不影响主流程。
 * 仅 error 及以上级别入缓冲（由 Logger 决定是否 push）。
 */
export class ErrorBuffer {
  private readonly entries: ErrorEntry[] = []
  private readonly maxEntries: number

  constructor(maxEntries: number = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries
  }

  /** 推入一条错误记录。超出容量时丢弃最旧的 */
  push(entry: ErrorEntry): void {
    this.entries.push(entry)
    if (this.entries.length > this.maxEntries) {
      this.entries.shift()
    }
  }

  /** 返回当前缓冲的副本（按时间顺序，旧->新） */
  snapshot(): ErrorEntry[] {
    return [...this.entries]
  }

  /** 清空缓冲 */
  clear(): void {
    this.entries.length = 0
  }

  /** 当前条数 */
  get size(): number {
    return this.entries.length
  }
}

/** 创建 ErrorBuffer */
export function createErrorBuffer(maxEntries?: number): ErrorBuffer {
  return new ErrorBuffer(maxEntries)
}
