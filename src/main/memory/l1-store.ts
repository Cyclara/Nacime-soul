// src/main/memory/l1-store.ts
// L1 近期状态存储（短期目标 + 近期偏好）。JSON 持久化到 data/l1-state.json。
// 依据：S-Phase2 P2-05、技术分析 §1.1.1（L1 层）。
//
// 设计：
//   - 正则分流：命中 目标|想要|计划|打算 → recentGoals，否则 recentPreferences。
//   - 有界近期窗口（每类保留最近 MAX 条），新的替换最旧的——是"窗口滚动"而非"清空重写"，
//     避免误删仍在窗口内的并行目标。
//   - 每条带时效戳（updatedAt）。

import type { Logger } from '@shared/observability/types'
import { AppError } from '@shared/errors'
import { atomicWriteJson, readJsonVersion } from '../migrations/atomic-json'
import { EXPECTED_VERSIONS } from '../migrations/types'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import type { MemoryRevisionClock } from './revision-clock'
import type { MemoryEventBroadcaster } from './event-broadcaster'

const GOAL_PATTERN = /目标|想要|计划|打算/

/** 每类近期状态保留的最大条数（窗口大小）。对应 P2-05"3 轮内替换近期状态"。 */
const MAX_ENTRIES = 3

export interface L1Entry {
  text: string
  updatedAt: number
}

export interface L1State {
  schemaVersion: number
  recentGoals: L1Entry[]
  recentPreferences: L1Entry[]
}

export type L1Event = 'l1.refreshed'

export interface L1Store {
  get(): L1State
  /** 分流写入近期状态。命中目标正则进 recentGoals，否则 recentPreferences。 */
  record(text: string): void
  clear(): void
  on(event: L1Event, handler: () => void): () => void
}

const CURRENT_VERSION = EXPECTED_VERSIONS.l1

export interface L1StoreOptions {
  filePath: string
  logger?: Logger
  now?: () => number
  /** P2-29: 可选，记忆事件广播（memory.enabled=true 时注入）。S-012 §1.4 */
  revisionClock?: MemoryRevisionClock
  broadcaster?: MemoryEventBroadcaster
}

export function createL1Store(opts: L1StoreOptions): L1Store {
  const { filePath } = opts
  const now = opts.now ?? ((): number => Date.now())
  const revisionClock = opts.revisionClock
  const broadcaster = opts.broadcaster

  const listeners = new Set<() => void>()
  let state: L1State = load()

  function load(): L1State {
    // C-α-2：区分 missing（正常首次初始化）与 invalid（阻断启动，不许猜）。
    const empty: L1State = {
      schemaVersion: CURRENT_VERSION,
      recentGoals: [],
      recentPreferences: []
    }
    const vr = readJsonVersion(filePath)
    if (vr.kind === 'missing') return empty
    if (vr.kind === 'invalid') {
      throw new AppError({
        code: 'MEM_DB_CORRUPT',
        userMessage: `L1 状态文件损坏（${vr.reason}），请从备份恢复：${path.basename(filePath)}`,
        severity: 'fatal',
        retryable: false,
        cause: { file: filePath, reason: vr.reason }
      })
    }
    if (vr.version !== CURRENT_VERSION) {
      throw new AppError({
        code: 'MEM_DB_CORRUPT',
        userMessage: `L1 状态文件版本不匹配（期望 ${CURRENT_VERSION}，实际 ${vr.version}），请运行迁移或从备份恢复`,
        severity: 'fatal',
        retryable: false,
        cause: { file: filePath, expected: CURRENT_VERSION, actual: vr.version }
      })
    }
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<L1State>
    return {
      schemaVersion: CURRENT_VERSION,
      recentGoals: sanitize(parsed.recentGoals),
      recentPreferences: sanitize(parsed.recentPreferences)
    }
  }

  function sanitize(arr: unknown): L1Entry[] {
    if (!Array.isArray(arr)) return []
    return arr
      .filter(
        (e): e is L1Entry =>
          !!e &&
          typeof (e as L1Entry).text === 'string' &&
          typeof (e as L1Entry).updatedAt === 'number'
      )
      .slice(-MAX_ENTRIES)
  }

  function persist(): void {
    atomicWriteJson(filePath, state)
  }

  /** P2-29: JSON rename 成功 -> 短 DB 事务 next -> 广播（S-012 §1.4） */
  function notifyChange(): void {
    if (revisionClock && broadcaster) {
      revisionClock.next()
      broadcaster.notify('l1')
    }
  }

  function emit(): void {
    for (const h of listeners) {
      try {
        h()
      } catch {
        /* 订阅者异常不影响写入 */
      }
    }
  }

  return {
    get() {
      return {
        schemaVersion: state.schemaVersion,
        recentGoals: [...state.recentGoals],
        recentPreferences: [...state.recentPreferences]
      }
    },

    record(text) {
      const trimmed = text.trim()
      if (trimmed.length === 0) return
      const entry: L1Entry = { text: trimmed, updatedAt: now() }
      const key = GOAL_PATTERN.test(trimmed) ? 'recentGoals' : 'recentPreferences'
      // 去重同文本后追加，滚动保留最近 MAX 条
      state[key] = [...state[key].filter((e) => e.text !== trimmed), entry].slice(-MAX_ENTRIES)
      persist()
      notifyChange()
      emit()
    },

    clear() {
      state = { schemaVersion: CURRENT_VERSION, recentGoals: [], recentPreferences: [] }
      persist()
      notifyChange()
      emit()
    },

    on(_event, handler) {
      listeners.add(handler)
      return () => listeners.delete(handler)
    }
  }
}
