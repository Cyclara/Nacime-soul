// src/main/memory/seed/loader.test.ts
// P2-36 验收：坏文件不崩 + frontmatter 解析 + 文件加载。

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Logger } from '@shared/observability/types'
import { loadSeeds, seedId } from './loader'

// === 测试辅助 ===

function noopLogger(): Logger {
  const log: Logger = {
    fatal() {
      /* noop */
    },
    error() {
      /* noop */
    },
    warn() {
      /* noop */
    },
    info() {
      /* noop */
    },
    debug() {
      /* noop */
    },
    child() {
      return log
    }
  }
  return log
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'seed-loader-test-'))
}

function writeFile(dir: string, name: string, content: string): void {
  fs.writeFileSync(path.join(dir, name), content, 'utf-8')
}

function makeValidSeed(body: string, importance = 10): string {
  return `---
type: seed
importance: ${importance}
confidence: 1.0
source: creator
tags: [test]
---

${body}`
}

describe('loadSeeds', () => {
  let dir: string

  beforeEach(() => {
    dir = makeTmpDir()
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('加载多个合法 seed 文件', () => {
    writeFile(dir, 'seed-a.md', makeValidSeed('记忆 A'))
    writeFile(dir, 'seed-b.md', makeValidSeed('记忆 B'))
    writeFile(dir, 'seed-c.md', makeValidSeed('记忆 C'))

    const entries = loadSeeds(dir, noopLogger())
    expect(entries).toHaveLength(3)
    // 按文件名排序
    expect(entries[0].filename).toBe('seed-a.md')
    expect(entries[1].filename).toBe('seed-b.md')
    expect(entries[2].filename).toBe('seed-c.md')
    // body 正确
    expect(entries[0].body).toBe('记忆 A')
    expect(entries[0].frontmatter.importance).toBe(10)
    expect(entries[0].frontmatter.source).toBe('creator')
  })

  it('坏文件跳过不崩 + 继续加载其他合法文件', () => {
    writeFile(dir, 'good-1.md', makeValidSeed('合法记忆 1'))
    writeFile(dir, 'bad.md', '---\ntype: prompt\n---\n非 seed type')
    writeFile(dir, 'good-2.md', makeValidSeed('合法记忆 2'))
    writeFile(dir, 'broken.md', '无 frontmatter 的正文')

    const entries = loadSeeds(dir, noopLogger())
    expect(entries).toHaveLength(2)
    expect(entries[0].filename).toBe('good-1.md')
    expect(entries[1].filename).toBe('good-2.md')
  })

  it('目录不存在 -> 空数组不崩', () => {
    const entries = loadSeeds(path.join(dir, 'nonexistent'), noopLogger())
    expect(entries).toEqual([])
  })

  it('空目录 -> 空数组', () => {
    const entries = loadSeeds(dir, noopLogger())
    expect(entries).toEqual([])
  })

  it('只读 .md 文件（忽略 .txt/.json 等）', () => {
    writeFile(dir, 'seed.md', makeValidSeed('记忆'))
    writeFile(dir, 'notes.txt', '一些笔记')
    writeFile(dir, 'config.json', '{}')

    const entries = loadSeeds(dir, noopLogger())
    expect(entries).toHaveLength(1)
    expect(entries[0].filename).toBe('seed.md')
  })

  it('全部文件都坏 -> 空数组不崩', () => {
    writeFile(dir, 'bad-1.md', '无 frontmatter')
    writeFile(dir, 'bad-2.md', '---\ntype: seed\n---\n') // body 空

    const entries = loadSeeds(dir, noopLogger())
    expect(entries).toEqual([])
  })

  it('frontmatter 字段完整传递', () => {
    writeFile(
      dir,
      'full.md',
      `---
type: seed
importance: 8
confidence: 0.7
source: user_explicit
tags: [性格, 偏好, 日常]
---

用户喜欢简洁的回复。`
    )

    const entries = loadSeeds(dir, noopLogger())
    expect(entries).toHaveLength(1)
    const fm = entries[0].frontmatter
    expect(fm.type).toBe('seed')
    expect(fm.importance).toBe(8)
    expect(fm.confidence).toBe(0.7)
    expect(fm.source).toBe('user_explicit')
    expect(fm.tags).toEqual(['性格', '偏好', '日常'])
  })

  it('seedId 从文件名生成稳定 ID', () => {
    expect(seedId('nacime-rain.md')).toBe('seed:nacime-rain')
    expect(seedId('test.md')).toBe('seed:test')
    // 无扩展名也能工作
    expect(seedId('nacime-rain')).toBe('seed:nacime-rain')
  })

  it('entry.id 用 seedId 格式', () => {
    writeFile(dir, 'nacime-identity.md', makeValidSeed('记忆'))
    const entries = loadSeeds(dir, noopLogger())
    expect(entries[0].id).toBe('seed:nacime-identity')
  })

  it('importance=10 的 seed 条目正确解析（P2-37 豁免前提）', () => {
    writeFile(dir, 'exempt.md', makeValidSeed('豁免记忆', 10))
    const entries = loadSeeds(dir, noopLogger())
    expect(entries[0].frontmatter.importance).toBe(10)
  })

  it('importance<10 的 seed 条目也合法（非豁免 seed）', () => {
    writeFile(dir, 'normal.md', makeValidSeed('普通记忆', 5))
    const entries = loadSeeds(dir, noopLogger())
    expect(entries[0].frontmatter.importance).toBe(5)
  })
})
