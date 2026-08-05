// src/main/migrations/sentinel.ts
// 迁移锁文件哨兵：迁移中途崩溃/断电时，下次启动据此触发恢复。依据 F5-013 §3。
//
// 2026-08-03 C-α-1 修复：clearSentinel 不再静默吞异常。
// 迁移成功后清哨兵是"提交确认"--清不掉就必须 fatal，否则下次启动会看到哨兵
// 把已迁移好的数据整体滚回旧版本（Windows 文件锁/杀软占用极常见）。

import * as fs from 'node:fs'
import * as path from 'node:path'
import { atomicWriteJson } from './atomic-json'

const SENTINEL_NAME = '.migration-lock.json'

export interface SentinelData {
  startedAt: number
  /** 迁移前各存储版本 */
  from: Partial<Record<string, number>>
  /** 目标版本 */
  to: Partial<Record<string, number>>
  /** 备份目录绝对路径，恢复时据此还原整个 data/ */
  backupPath: string
}

export function sentinelPath(dataDir: string): string {
  return path.join(dataDir, SENTINEL_NAME)
}

/** 读哨兵。不存在/损坏返回 null。 */
export function readSentinel(dataDir: string): SentinelData | null {
  let raw: string
  try {
    raw = fs.readFileSync(sentinelPath(dataDir), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as SentinelData
    if (typeof parsed.backupPath === 'string' && typeof parsed.startedAt === 'number') {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

export function writeSentinel(dataDir: string, data: SentinelData): void {
  atomicWriteJson(sentinelPath(dataDir), data)
}

/**
 * 删哨兵。返回是否成功删除（文件不存在也返回 true -- 目标状态已达成）。
 * 不再静默吞异常：调用方必须检查返回值，失败 = fatal。
 */
export function clearSentinel(dataDir: string): boolean {
  try {
    fs.rmSync(sentinelPath(dataDir), { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * 校验哨兵可安全恢复：字段完整 + 备份目录真实存在。
 * 返回 null 表示可恢复，否则返回不可恢复的原因。
 * 依据 C-α-1：恢复前必须校验，缺备份时不要"尽力而为"地半恢复。
 */
export function validateSentinel(sentinel: SentinelData): string | null {
  if (!sentinel.backupPath) {
    return 'sentinel missing backupPath'
  }
  if (!fs.existsSync(sentinel.backupPath)) {
    return `backup directory does not exist: ${sentinel.backupPath}`
  }
  return null
}
