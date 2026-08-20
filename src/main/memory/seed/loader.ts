// src/main/memory/seed/loader.ts
// P2-36: Seed 文件加载器。
// 依据：S-Phase2 P2-36（5-8 个 seed 文件加载、格式校验失败->跳过该文件并 warn）
//
// 设计要点：
//   1. loadSeeds(seedsDir, logger): SeedEntry[] -- 读 seedsDir/*.md，逐文件 parse
//   2. 格式校验失败 -> 跳过该文件 + warn（不崩，S-Phase2 P2-36 验收：坏文件不崩）
//   3. 文件读取用 node:fs（不依赖 electron；路径由调用方注入）
//   4. 返回有效 SeedEntry 数组；目录不存在 -> 空数组 + warn
//   5. 不写 DB（P2-37 的 setup.ts 负责把 SeedEntry 写成 L2 记忆）

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Logger } from '@shared/observability/types'
import { parseSeedFrontmatter, type SeedFrontmatter } from './frontmatter'

/** 解析后的 seed 条目 */
export interface SeedEntry {
  /** 稳定 ID = `seed:{filename}`（不含扩展名）；P2-37 用作 L2 extractionKey */
  id: string
  /** 文件名（含扩展名），诊断用 */
  filename: string
  /** 解析后的 frontmatter */
  frontmatter: SeedFrontmatter
  /** 记忆正文（trim 后） */
  body: string
}

/** seed 目录下只读 .md 文件 */
const SEED_FILE_EXT = '.md'

/**
 * 从 seedsDir 加载全部 seed 文件。
 *
 * 行为：
 *   - 目录不存在 -> 空数组 + warn（不崩）
 *   - 目录存在 -> 读全部 *.md 文件，逐文件 parse frontmatter
 *   - 单文件 parse 失败 -> 跳过该文件 + warn，继续处理其他文件
 *   - 无 .md 文件 -> 空数组 + info
 *
 * 返回有效 SeedEntry 数组（可能为空）。
 */
export function loadSeeds(seedsDir: string, logger: Logger): SeedEntry[] {
  let files: string[]
  try {
    files = fs.readdirSync(seedsDir)
  } catch (e) {
    const code = e instanceof Error ? (e as NodeJS.ErrnoException).code : undefined
    if (code === 'ENOENT') {
      logger.warn('seeds directory does not exist; skipping seed loading', {
        scope: 'memory',
        tags: { seedsDir }
      })
      return []
    }
    // 其他读取错误（权限等）-> 空数组 + warn，不崩
    logger.warn('seeds directory unreadable; skipping seed loading', {
      scope: 'memory',
      tags: { seedsDir, reason: e instanceof Error ? e.message : String(e) }
    })
    return []
  }

  const mdFiles = files.filter((f) => f.toLowerCase().endsWith(SEED_FILE_EXT)).sort()
  if (mdFiles.length === 0) {
    logger.info('no seed files found in seeds directory', {
      scope: 'memory',
      tags: { seedsDir }
    })
    return []
  }

  const entries: SeedEntry[] = []
  let failed = 0
  for (const filename of mdFiles) {
    const filePath = path.join(seedsDir, filename)
    let content: string
    try {
      content = fs.readFileSync(filePath, 'utf-8')
    } catch (e) {
      logger.warn('seed file unreadable; skipping', {
        scope: 'memory',
        tags: { filename, reason: e instanceof Error ? e.message : String(e) }
      })
      failed++
      continue
    }

    try {
      const parsed = parseSeedFrontmatter(content)
      entries.push({
        id: seedId(filename),
        filename,
        frontmatter: parsed.frontmatter,
        body: parsed.body
      })
    } catch (e) {
      // 格式校验失败 -> 跳过该文件 + warn（P2-36 验收：坏文件不崩）
      const reason = e instanceof Error ? e.message : String(e)
      logger.warn('seed file failed frontmatter validation; skipping', {
        scope: 'memory',
        tags: { filename, reason }
      })
      failed++
    }
  }

  logger.info('seeds loaded', {
    scope: 'memory',
    metrics: { loaded: entries.length, failed }
  })

  return entries
}

/**
 * 从文件名生成稳定 seed ID。
 * `nacime-rain.md` -> `seed:nacime-rain`
 * 用作 L2 extractionKey（P2-37 幂等检查）。
 */
export function seedId(filename: string): string {
  const base = filename.endsWith(SEED_FILE_EXT)
    ? filename.slice(0, -SEED_FILE_EXT.length)
    : filename
  return `seed:${base}`
}
