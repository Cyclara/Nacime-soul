// P3G-05：冷存储 gzip JSONL + 原子索引，损坏旧文件时宁可跳过 purge 也不覆盖。

import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createColdStore } from './cold-store'

const directories: string[] = []
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })))

function record(id: string): { id: string; content: string; type: 'one_off'; importance: number; createdAt: number; archivedAt: number; purgedAt: number; evidenceIds: string[]; sourceMessageIds: string[] } {
  return { id, content: '咖啡 和 散步', type: 'one_off' as const, importance: 5, createdAt: 1, archivedAt: 2, purgedAt: 3, evidenceIds: [], sourceMessageIds: [] }
}

describe('P3G cold store', () => {
  it('append fsync 后索引可搜索、gzip 主文件可读', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nacime-cold-'))
    directories.push(directory)
    const store = createColdStore({ directory, now: () => new Date(2026, 0, 1).getTime() })
    const file = store.append([record('m1')])
    expect(file).toMatch(/2026\.jsonl\.gz$/)
    expect(existsSync(join(directory, 'index.json'))).toBe(true)
    expect(store.searchIndex(['咖啡']).map((entry) => entry.id)).toEqual(['m1'])
    expect(store.read('m1')).toMatchObject({ id: 'm1', content: '咖啡 和 散步' })
    store.append([record('m2')])
    expect(store.read('m1')).toMatchObject({ id: 'm1' })
    expect(store.read('m2')).toMatchObject({ id: 'm2' })
  })

  it('已有冷文件损坏时不覆盖并返回 null', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nacime-cold-'))
    directories.push(directory)
    writeFileSync(join(directory, '2026.jsonl.gz'), 'not gzip')
    const store = createColdStore({ directory, now: () => new Date(2026, 0, 1).getTime() })
    expect(store.append([record('m1')])).toBeNull()
  })

  it('P3G-08 冷目录被用户手删：索引查询返回空而不抛错，下一次 append 重建目录', () => {
    const parent = mkdtempSync(join(tmpdir(), 'nacime-cold-'))
    directories.push(parent)
    const directory = join(parent, 'cold')
    const store = createColdStore({ directory, now: () => new Date(2026, 0, 1).getTime() })
    store.append([record('m1')])
    rmSync(directory, { recursive: true, force: true })

    expect(store.searchIndex(['咖啡'])).toEqual([])
    expect(store.read('m1')).toBeNull()
    expect(store.append([record('m2')])).toMatch(/2026\.jsonl\.gz$/)
    expect(store.read('m2')).toMatchObject({ id: 'm2' })
  })

  it('P3G-08 索引落盘失败时返回 null，让 GC 保守跳过删除', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nacime-cold-'))
    directories.push(directory)
    // index.json 被占为目录：gz 段可写但索引 rename 必失败，冷记录不可检索时不许删热区。
    mkdirSync(join(directory, 'index.json'))
    const store = createColdStore({ directory, now: () => new Date(2026, 0, 1).getTime() })
    expect(store.append([record('m1')])).toBeNull()
  })
})
