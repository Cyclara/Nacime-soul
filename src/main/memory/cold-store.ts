// src/main/memory/cold-store.ts
// P3G-05：冷存储先写后删。冷记录不含向量；文本可在未来找回时重新嵌入。

import {
  appendFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  closeSync
} from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import type { ColdIndexEntry, ColdRecord } from '@shared/memory/gc-types'

export interface ColdStore {
  append(records: readonly ColdRecord[]): string | null
  searchIndex(keywords: readonly string[]): readonly ColdIndexEntry[]
  read(id: string): ColdRecord | null
}

function safeKeywords(content: string): string[] {
  const tokens = content.toLowerCase().match(/[\p{L}\p{N}]{1,32}/gu) ?? []
  return [...new Set(tokens)].slice(0, 8)
}

function isWithin(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate)
  return suffix !== '..' && !suffix.startsWith(`..${sep}`)
}

export function createColdStore(options: {
  readonly directory: string
  readonly now?: () => number
}): ColdStore {
  const root = resolve(options.directory)
  const now = options.now ?? Date.now
  const indexPath = join(root, 'index.json')

  const readIndex = (): ColdIndexEntry[] => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(indexPath, 'utf8'))
      return Array.isArray(parsed) ? parsed.filter(isColdIndexEntry) : []
    } catch {
      return []
    }
  }

  const writeIndex = (entries: readonly ColdIndexEntry[]): void => {
    const temporary = `${indexPath}.tmp`
    const handle = openSync(temporary, 'w')
    try {
      appendFileSync(handle, JSON.stringify(entries), 'utf8')
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
    renameSync(temporary, indexPath)
  }

  return {
    append(records) {
      if (records.length === 0) return null
      const year = new Date(now()).getFullYear()
      const file = join(root, `${year}.jsonl.gz`)
      if (!isWithin(root, file)) return null
      try {
        // 冷目录可能被用户手动删除；重建后按空索引继续，不让 GC 因此报错。
        mkdirSync(root, { recursive: true })
        if (existsSync(file)) gunzipSync(readFileSync(file))
      } catch {
        // 现有冷文件损坏时保守中止；绝不覆盖导致历史记录双失。
        return null
      }
      try {
        // gzip 支持拼接 member；逐批 append 保留已有记录，fsync 成功前绝不删热区。
        const handle = openSync(file, 'a')
        try {
          appendFileSync(
            handle,
            gzipSync(`${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
          )
          fsyncSync(handle)
        } finally {
          closeSync(handle)
        }
        const indexed = new Map(readIndex().map((entry) => [entry.id, entry]))
        for (const record of records) {
          indexed.set(record.id, {
            id: record.id,
            year,
            keywords: safeKeywords(record.content),
            type: record.type,
            purgedAt: record.purgedAt
          })
        }
        writeIndex([...indexed.values()].sort((left, right) => left.id.localeCompare(right.id)))
      } catch {
        // 磁盘满/权限失败：返回 null 让 GC 跳过本轮 purge。宁可留下一条重复冷记录
        // （append-only 按 id 去重）也不能在索引没落盘时删掉热区行。
        return null
      }
      return file
    },

    searchIndex(keywords) {
      const wanted = new Set(keywords.map((keyword) => keyword.toLowerCase()).filter(Boolean))
      if (wanted.size === 0) return []
      return readIndex().filter((entry) =>
        entry.keywords.some((keyword) => wanted.has(keyword.toLowerCase()))
      )
    },

    read(id) {
      const entry = readIndex().find((candidate) => candidate.id === id)
      if (entry === undefined) return null
      const file = join(root, `${entry.year}.jsonl.gz`)
      if (!isWithin(root, file) || !existsSync(file)) return null
      try {
        for (const line of gunzipSync(readFileSync(file)).toString('utf8').split(/\r?\n/)) {
          if (line.length === 0) continue
          const parsed: unknown = JSON.parse(line)
          if (isColdRecord(parsed) && parsed.id === id) return parsed
        }
      } catch {
        return null
      }
      return null
    }
  }
}

function isColdIndexEntry(value: unknown): value is ColdIndexEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Partial<ColdIndexEntry>
  return (
    typeof entry.id === 'string' &&
    typeof entry.year === 'number' &&
    Array.isArray(entry.keywords) &&
    typeof entry.type === 'string' &&
    typeof entry.purgedAt === 'number'
  )
}

function isColdRecord(value: unknown): value is ColdRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<ColdRecord>
  return (
    typeof record.id === 'string' &&
    typeof record.content === 'string' &&
    typeof record.type === 'string' &&
    typeof record.importance === 'number' &&
    typeof record.createdAt === 'number' &&
    typeof record.purgedAt === 'number' &&
    Array.isArray(record.evidenceIds) &&
    Array.isArray(record.sourceMessageIds)
  )
}
