// src/main/migrations/scripts/004_dmae_state_v2.ts
// 迁移 004：dmae-state.json v1 -> v4（F5-002 §3.2 + 2026-08-03 裁定 T-01）。
// store='dmae'，id=4（2 被 002_extraction_key 占用、3 预留给 003_dmae_history db 表，
// dmae 拿不到 2/3，版本号 = 迁移 id = 4）。
//
// 两处结构变更（一次做完）：
//   1. 顶层加 turn: 0（轮次计数器，引擎递增，当前阶段固定 0）
//   2. 每条 entry 加 everActivated: boolean（初值 = activation > 0）
//
// 铁律（F5-002 §5）：保留全部 entries + activation，不许走"schemaVersion 不符 -> 重置"路径。
// everActivated 初值的已知代价：历史上曾 Active、如今已衰减到 0 的老条目会被误标 false，
// 导致下一次真实复活少计一次 trueFloorRevivals（R09 漏报，info 级，可接受）。
// 选择这个方向是因为它只会漏报不会误报。
//
// schemaVersion 由 MigrationRunner 在 validate 通过后用 setJsonVersion 写入（=4），
// 本脚本的 up() 不写 schemaVersion（与 db 迁移的 setDbVersion 对称）。

import type { Migration } from '../types'
import { join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { atomicWriteJson } from '../atomic-json'

const DMAE_STATE_FILE = 'dmae-state.json'

export const migration: Migration = {
  id: 4,
  store: 'dmae',
  title: 'dmae-state.json v1->v4: add turn + everActivated (preserve activations)',
  up({ dataDir }) {
    const filePath = join(dataDir, DMAE_STATE_FILE)

    // 文件不存在 = 首次安装（无旧状态可迁移）。创建初始 v4 结构文件，
    // 让 runner 的 setJsonVersion 能写入版本号。schemaVersion 留给 runner 设置。
    if (!existsSync(filePath)) {
      atomicWriteJson(filePath, { turn: 0, entries: {} })
      return
    }

    const raw = readFileSync(filePath, 'utf8')
    const data = JSON.parse(raw) as {
      schemaVersion?: unknown
      entries?: Record<string, unknown>
      turn?: unknown
    }

    // 顶层加 turn（若已有则保留，否则初始化 0）
    const turn = typeof data.turn === 'number' && Number.isInteger(data.turn) ? data.turn : 0

    // 每条 entry 加 everActivated（初值 = activation > 0）
    const entries: Record<string, unknown> = {}
    if (data.entries && typeof data.entries === 'object') {
      for (const [id, entry] of Object.entries(data.entries)) {
        if (!entry || typeof entry !== 'object') {
          // 损坏条目原样保留（load 的 isValidEntryState 会跳过它）
          entries[id] = entry
          continue
        }
        const e = entry as Record<string, unknown>
        const activation = typeof e.activation === 'number' ? e.activation : 0
        // 已有 everActivated 保留（幂等），否则按 activation > 0 初始化
        const everActivated =
          typeof e.everActivated === 'boolean' ? e.everActivated : activation > 0
        entries[id] = {
          activation: e.activation,
          userSilence: e.userSilence,
          modelSilence: e.modelSilence,
          everActivated
        }
      }
    }

    // 不写 schemaVersion -- runner 的 setJsonVersion 会在 validate 通过后写入
    const after = {
      schemaVersion: data.schemaVersion,
      turn,
      entries
    }
    atomicWriteJson(filePath, after)
  },
  validate({ dataDir }) {
    const filePath = join(dataDir, DMAE_STATE_FILE)
    let raw: string
    try {
      raw = readFileSync(filePath, 'utf8')
    } catch {
      return { ok: false, detail: `${DMAE_STATE_FILE} not found after migration up()` }
    }
    let data: { turn?: unknown; entries?: Record<string, unknown> }
    try {
      data = JSON.parse(raw)
    } catch {
      return { ok: false, detail: `${DMAE_STATE_FILE} is not valid JSON after migration` }
    }
    // turn 必须存在且为非负整数
    if (typeof data.turn !== 'number' || !Number.isInteger(data.turn) || data.turn < 0) {
      return { ok: false, detail: 'turn missing or invalid after migration' }
    }
    // 每条 entry 必须有 everActivated
    if (!data.entries || typeof data.entries !== 'object') {
      return { ok: false, detail: 'entries missing after migration' }
    }
    for (const [id, entry] of Object.entries(data.entries)) {
      if (!entry || typeof entry !== 'object') continue // 损坏条目由 load 跳过
      const e = entry as Record<string, unknown>
      if (typeof e.everActivated !== 'boolean') {
        return { ok: false, detail: `entry ${id} missing everActivated after migration` }
      }
    }
    return { ok: true }
  }
}
