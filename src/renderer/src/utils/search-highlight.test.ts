// src/renderer/src/utils/search-highlight.test.ts
// P2-44: 搜索高亮切分 + 结果行时间格式化。
import { describe, it, expect } from 'vitest'
import { queryToNeedles, splitByNeedles, formatSearchTime } from './search-highlight'

describe('P2-44 queryToNeedles：清洗规则与 main 侧 extractNeedles 对齐', () => {
  it('按空白切词，剥离标点', () => {
    expect(queryToNeedles('天气 code!')).toEqual(['天气', 'code'])
  })

  it('全角折半角', () => {
    expect(queryToNeedles('ＣＬＡＵＤＥ')).toEqual(['CLAUDE'])
  })

  it('纯标点词被丢弃', () => {
    expect(queryToNeedles('天气 ！！！')).toEqual(['天气'])
    expect(queryToNeedles('！！')).toEqual([])
  })
})

describe('P2-44 splitByNeedles：v-for <mark> 切分（不走 v-html）', () => {
  it('命中段标记 hit，其余原样', () => {
    expect(splitByNeedles('今天天气真好', ['天气'])).toEqual([
      { text: '今天', hit: false },
      { text: '天气', hit: true },
      { text: '真好', hit: false }
    ])
  })

  it('大小写不敏感，保留原文大小写', () => {
    expect(splitByNeedles('I love ClaudeCode', ['claude'])).toEqual([
      { text: 'I love ', hit: false },
      { text: 'Claude', hit: true },
      { text: 'Code', hit: false }
    ])
  })

  it('多 needle 取最早命中；长 needle 优先', () => {
    const parts = splitByNeedles('今天写 code 和天气', ['天气', 'code'])
    expect(parts).toEqual([
      { text: '今天写 ', hit: false },
      { text: 'code', hit: true },
      { text: ' 和', hit: false },
      { text: '天气', hit: true }
    ])
  })

  it('无命中返回单段；空 needles 原样返回', () => {
    expect(splitByNeedles('没有命中', ['xyz'])).toEqual([{ text: '没有命中', hit: false }])
    expect(splitByNeedles('原文', [])).toEqual([{ text: '原文', hit: false }])
    expect(splitByNeedles('', ['天气'])).toEqual([])
  })

  it('连续命中不重叠、不丢字符', () => {
    const parts = splitByNeedles('天气天气', ['天气'])
    expect(parts).toEqual([
      { text: '天气', hit: true },
      { text: '天气', hit: true }
    ])
    expect(parts.map((p) => p.text).join('')).toBe('天气天气')
  })
})

describe('P2-44 formatSearchTime：DeepSeek 式右侧时间戳', () => {
  // 2026-08-23 15:00 本地时间作 "现在"
  const now = new Date(2026, 7, 23, 15, 0, 0).getTime()

  it('今天 → HH:mm', () => {
    const morning = new Date(2026, 7, 23, 9, 5, 0).getTime()
    expect(formatSearchTime(morning, now)).toBe('09:05')
  })

  it('今年更早 → M月D日', () => {
    const earlier = new Date(2026, 2, 8, 23, 59, 0).getTime()
    expect(formatSearchTime(earlier, now)).toBe('3月8日')
  })

  it('跨年 → YYYY年M月D日', () => {
    const lastYear = new Date(2025, 11, 31, 23, 59, 0).getTime()
    expect(formatSearchTime(lastYear, now)).toBe('2025年12月31日')
  })
})
