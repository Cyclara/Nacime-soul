// src/main/chat/datetime-prefix.test.ts
// 时间前缀格式：本地时区构造 + 本地读取，与运行环境时区无关。

import { describe, it, expect } from 'vitest'
import { formatTimePrefix } from './datetime-prefix'

describe('formatTimePrefix', () => {
  it('格式为 [YYYY-MM-DD HH:MM] + 尾随空格', () => {
    const ts = new Date(2026, 7, 21, 17, 58).getTime()
    expect(formatTimePrefix(ts)).toBe('[2026-08-21 17:58] ')
  })

  it('月/日/时/分不足两位补零', () => {
    const ts = new Date(2026, 0, 5, 3, 7).getTime()
    expect(formatTimePrefix(ts)).toBe('[2026-01-05 03:07] ')
  })

  it('同一分钟内的两个时间戳前缀相同（KV cache 友好）', () => {
    const a = new Date(2026, 7, 21, 17, 58, 1).getTime()
    const b = new Date(2026, 7, 21, 17, 58, 59).getTime()
    expect(formatTimePrefix(a)).toBe(formatTimePrefix(b))
  })

  it('跨天的两个时间戳前缀不同（她能感知"昨天/今天"）', () => {
    const day1 = new Date(2026, 7, 20, 23, 32).getTime()
    const day2 = new Date(2026, 7, 21, 17, 58).getTime()
    expect(formatTimePrefix(day1)).not.toBe(formatTimePrefix(day2))
    expect(formatTimePrefix(day1)).toContain('2026-08-20')
    expect(formatTimePrefix(day2)).toContain('2026-08-21')
  })
})
