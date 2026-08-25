// src/renderer/src/utils/time-divider.test.ts
// 时间分隔条：插入规则（首条/间隔 5 分钟）+ 标签老化规则（今天→昨天→前天→月日→年月日）。
// 全部用本地时区构造时间，与运行环境时区无关。

import { describe, it, expect } from 'vitest'
import { shouldShowDivider, formatDividerLabel, DIVIDER_GAP_MS } from './time-divider'

describe('shouldShowDivider', () => {
  it('首条消息前必显示', () => {
    expect(shouldShowDivider(null, 0)).toBe(true)
  })

  it('间隔 <= 5 分钟不显示', () => {
    const t0 = new Date(2026, 7, 21, 10, 0).getTime()
    expect(shouldShowDivider(t0, t0 + DIVIDER_GAP_MS)).toBe(false)
    expect(shouldShowDivider(t0, t0 + 60_000)).toBe(false)
  })

  it('间隔 > 5 分钟显示', () => {
    const t0 = new Date(2026, 7, 21, 10, 0).getTime()
    expect(shouldShowDivider(t0, t0 + DIVIDER_GAP_MS + 1)).toBe(true)
  })
})

describe('formatDividerLabel 标签老化', () => {
  const now = new Date(2026, 7, 21, 18, 30).getTime() // 2026-08-21 18:30

  it('今天 → 仅 HH:mm', () => {
    const t = new Date(2026, 7, 21, 10, 5).getTime()
    expect(formatDividerLabel(t, now)).toBe('10:05')
  })

  it('时分不足两位补零', () => {
    const t = new Date(2026, 7, 21, 3, 7).getTime()
    expect(formatDividerLabel(t, now)).toBe('03:07')
  })

  it('昨天 → 昨天 HH:mm', () => {
    const t = new Date(2026, 7, 20, 23, 32).getTime()
    expect(formatDividerLabel(t, now)).toBe('昨天 23:32')
  })

  it('前天 → 前天 HH:mm', () => {
    const t = new Date(2026, 7, 19, 8, 5).getTime()
    expect(formatDividerLabel(t, now)).toBe('前天 08:05')
  })

  it('按日历日而不是 24 小时判定：昨天 23:59 对今天 00:01 也是「昨天」', () => {
    const justAfterMidnight = new Date(2026, 7, 21, 0, 1).getTime()
    const t = new Date(2026, 7, 20, 23, 59).getTime()
    expect(formatDividerLabel(t, justAfterMidnight)).toBe('昨天 23:59')
  })

  it('今年更早（大前天起）→ M月D日，不带时分', () => {
    const t = new Date(2026, 7, 3, 15, 40).getTime()
    expect(formatDividerLabel(t, now)).toBe('8月3日')
  })

  it('跨年 → YYYY年M月D日 HH:mm', () => {
    const t = new Date(2025, 11, 31, 23, 59).getTime()
    expect(formatDividerLabel(t, now)).toBe('2025年12月31日 23:59')
  })

  it('同一条消息随 now 推移换说法（ aging ）', () => {
    const t = new Date(2026, 7, 20, 23, 32).getTime()
    const day1 = new Date(2026, 7, 20, 23, 40).getTime()
    const day2 = new Date(2026, 7, 21, 9, 0).getTime()
    const day3 = new Date(2026, 7, 22, 9, 0).getTime()
    const day4 = new Date(2026, 7, 23, 9, 0).getTime()
    expect(formatDividerLabel(t, day1)).toBe('23:32')
    expect(formatDividerLabel(t, day2)).toBe('昨天 23:32')
    expect(formatDividerLabel(t, day3)).toBe('前天 23:32')
    expect(formatDividerLabel(t, day4)).toBe('8月20日')
  })
})
