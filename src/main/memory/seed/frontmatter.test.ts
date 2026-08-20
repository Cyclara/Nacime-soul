// src/main/memory/seed/frontmatter.test.ts
// P2-36 验收：frontmatter 解析。

import { describe, it, expect } from 'vitest'
import { parseSeedFrontmatter } from './frontmatter'
import { isAppError } from '@shared/errors'

describe('parseSeedFrontmatter', () => {
  it('解析完整合法 frontmatter', () => {
    const content = `---
type: seed
importance: 10
confidence: 1.0
source: creator
tags: [核心认知, 角色身份]
---

Nacime 喜欢雨天，雨声让她感到平静。`
    const result = parseSeedFrontmatter(content)
    expect(result.frontmatter.type).toBe('seed')
    expect(result.frontmatter.importance).toBe(10)
    expect(result.frontmatter.confidence).toBe(1.0)
    expect(result.frontmatter.source).toBe('creator')
    expect(result.frontmatter.tags).toEqual(['核心认知', '角色身份'])
    expect(result.body).toBe('Nacime 喜欢雨天，雨声让她感到平静。')
  })

  it('解析无 tags 的 frontmatter（tags 可选）', () => {
    const content = `---
type: seed
importance: 10
confidence: 0.8
source: creator
---

记忆正文`
    const result = parseSeedFrontmatter(content)
    expect(result.frontmatter.tags).toEqual([])
    expect(result.body).toBe('记忆正文')
  })

  it('解析单值 tags 形式', () => {
    const content = `---
type: seed
importance: 5
confidence: 1.0
source: user_explicit
tags: 性格
---

正文`
    const result = parseSeedFrontmatter(content)
    expect(result.frontmatter.tags).toEqual(['性格'])
  })

  it('解析空数组 tags', () => {
    const content = `---
type: seed
importance: 5
confidence: 1.0
source: inferred
tags: []
---

正文`
    const result = parseSeedFrontmatter(content)
    expect(result.frontmatter.tags).toEqual([])
  })

  it('解析 importance=1 边界', () => {
    const content = `---
type: seed
importance: 1
confidence: 0.0
source: creator
---

正文`
    const result = parseSeedFrontmatter(content)
    expect(result.frontmatter.importance).toBe(1)
    expect(result.frontmatter.confidence).toBe(0)
  })

  it('解析 inferred source', () => {
    const content = `---
type: seed
importance: 5
confidence: 0.6
source: inferred
---

正文`
    const result = parseSeedFrontmatter(content)
    expect(result.frontmatter.source).toBe('inferred')
  })

  it('解析 CRLF 行尾', () => {
    const content = `---\r\ntype: seed\r\nimportance: 10\r\nconfidence: 1.0\r\nsource: creator\r\ntags: [a, b]\r\n---\r\n\r\n正文`
    const result = parseSeedFrontmatter(content)
    expect(result.frontmatter.importance).toBe(10)
    expect(result.body).toBe('正文')
  })

  it('body 多行内容保留', () => {
    const content = `---
type: seed
importance: 10
confidence: 1.0
source: creator
---

第一行记忆。
第二行记忆。`
    const result = parseSeedFrontmatter(content)
    expect(result.body).toBe('第一行记忆。\n第二行记忆。')
  })

  // === 异常用例 ===

  it('缺 frontmatter -> AppError', () => {
    try {
      parseSeedFrontmatter('无 frontmatter 的正文')
      expect.fail('should have thrown')
    } catch (e) {
      expect(isAppError(e)).toBe(true)
    }
  })

  it('空内容 -> AppError', () => {
    try {
      parseSeedFrontmatter('')
      expect.fail('should have thrown')
    } catch (e) {
      expect(isAppError(e)).toBe(true)
    }
  })

  it('type 非 seed -> AppError', () => {
    const content = `---
type: prompt
importance: 10
confidence: 1.0
source: creator
---

正文`
    try {
      parseSeedFrontmatter(content)
      expect.fail('should have thrown')
    } catch (e) {
      expect(isAppError(e)).toBe(true)
    }
  })

  it('缺 type -> AppError', () => {
    const content = `---
importance: 10
confidence: 1.0
source: creator
---

正文`
    try {
      parseSeedFrontmatter(content)
      expect.fail('should have thrown')
    } catch (e) {
      expect(isAppError(e)).toBe(true)
    }
  })

  it('importance 越界（0）-> AppError', () => {
    const content = `---
type: seed
importance: 0
confidence: 1.0
source: creator
---

正文`
    try {
      parseSeedFrontmatter(content)
      expect.fail('should have thrown')
    } catch (e) {
      expect(isAppError(e)).toBe(true)
    }
  })

  it('importance 越界（11）-> AppError', () => {
    const content = `---
type: seed
importance: 11
confidence: 1.0
source: creator
---

正文`
    try {
      parseSeedFrontmatter(content)
      expect.fail('should have thrown')
    } catch (e) {
      expect(isAppError(e)).toBe(true)
    }
  })

  it('importance 非整数 -> AppError', () => {
    const content = `---
type: seed
importance: 5.5
confidence: 1.0
source: creator
---

正文`
    try {
      parseSeedFrontmatter(content)
      expect.fail('should have thrown')
    } catch (e) {
      expect(isAppError(e)).toBe(true)
    }
  })

  it('confidence 越界（1.5）-> AppError', () => {
    const content = `---
type: seed
importance: 10
confidence: 1.5
source: creator
---

正文`
    try {
      parseSeedFrontmatter(content)
      expect.fail('should have thrown')
    } catch (e) {
      expect(isAppError(e)).toBe(true)
    }
  })

  it('confidence 越界（-0.1）-> AppError', () => {
    const content = `---
type: seed
importance: 10
confidence: -0.1
source: creator
---

正文`
    try {
      parseSeedFrontmatter(content)
      expect.fail('should have thrown')
    } catch (e) {
      expect(isAppError(e)).toBe(true)
    }
  })

  it('source 非法值 -> AppError', () => {
    const content = `---
type: seed
importance: 10
confidence: 1.0
source: unknown
---

正文`
    try {
      parseSeedFrontmatter(content)
      expect.fail('should have thrown')
    } catch (e) {
      expect(isAppError(e)).toBe(true)
    }
  })

  it('body 为空 -> AppError', () => {
    const content = `---
type: seed
importance: 10
confidence: 1.0
source: creator
---`
    try {
      parseSeedFrontmatter(content)
      expect.fail('should have thrown')
    } catch (e) {
      expect(isAppError(e)).toBe(true)
    }
  })

  it('body 仅空白 -> AppError', () => {
    const content = `---
type: seed
importance: 10
confidence: 1.0
source: creator
---

   `
    try {
      parseSeedFrontmatter(content)
      expect.fail('should have thrown')
    } catch (e) {
      expect(isAppError(e)).toBe(true)
    }
  })

  it('body 超 500 字符 -> AppError', () => {
    const longBody = 'A'.repeat(501)
    const content = `---
type: seed
importance: 10
confidence: 1.0
source: creator
---

${longBody}`
    try {
      parseSeedFrontmatter(content)
      expect.fail('should have thrown')
    } catch (e) {
      expect(isAppError(e)).toBe(true)
    }
  })

  it('tags 超 16 个 -> AppError', () => {
    const manyTags = Array.from({ length: 17 }, (_, i) => `tag${i}`).join(', ')
    const content = `---
type: seed
importance: 10
confidence: 1.0
source: creator
tags: [${manyTags}]
---

正文`
    try {
      parseSeedFrontmatter(content)
      expect.fail('should have thrown')
    } catch (e) {
      expect(isAppError(e)).toBe(true)
    }
  })

  it('frontmatter 不闭合 -> AppError', () => {
    const content = `---
type: seed
importance: 10

正文`
    try {
      parseSeedFrontmatter(content)
      expect.fail('should have thrown')
    } catch (e) {
      expect(isAppError(e)).toBe(true)
    }
  })
})
