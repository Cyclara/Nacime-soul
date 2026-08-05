// src/main/memory/dmae/state-file.ts
// P2-24: DMAE 持久化 + 开关。引擎状态存 data/dmae-state.json。
// 依据：S-Phase2 P2-24、S-004-补充 D-04、F5-013（atomicWriteJson）、F5-011（LogFields 白名单）。
//
// 设计要点：
//   1. dmae-state.json = { schemaVersion, entries: { [memoryId]: { activation, userSilence, modelSilence } } }
//   2. atomicWriteJson 原子写（F5-013 §3，写入中断不损坏旧文件）
//   3. 损坏检测：JSON 解析失败 / schemaVersion 不符 / entries 结构错 -> 抛 MEM_DB_CORRUPT fatal（C-α-2：
//      静默清空 = 丢用户数据，改为阻断启动引导恢复。文件缺失仍返回空 = 正常首次初始化）
//   4. 孤儿清理：状态文件与 DB 记忆列表漂移时以 DB 为准（stateFile 有但 L2 已删 -> 清掉；L2 新增 -> 初始化）
//   5. memory.dmae.enabled=false 时 context-assembler 已只读 L0/L1（P2-16B）；本模块不关心开关，由调用方判断
//
// 隐私纪律（F5-011）：状态文件只存 activation/US/MS 数值，不含记忆 content/引用/查询。
// 日志只记计数（removed/added/重置原因），不记 memoryId 列表外的内容。

import * as fs from 'node:fs'
import * as path from 'node:path'
import { atomicWriteJson, readJsonVersion } from '../../migrations/atomic-json'
import { AppError } from '@shared/errors'
import { EXPECTED_VERSIONS } from '../../migrations/types'
import type { Logger } from '@shared/observability/types'
import { createInitialEntryState, type DmaeEntryState } from './engine'

/**
 * dmae-state.json 的 schema 版本。从 EXPECTED_VERSIONS.dmae 派生（F5-002 §6.3 S-F05）。
 * 写错则 load() 判定版本不符 -> 抛 MEM_DB_CORRUPT -> 阻断启动（C-α-2）。
 * 当前 = 4（004 迁移升版：加 turn + everActivated）。
 */
const DMAE_STATE_SCHEMA_VERSION = EXPECTED_VERSIONS.dmae

/** 持久化的 DMAE 状态数据 */
export interface DmaeStateData {
  schemaVersion: number
  /** 当前轮次计数器（v4 新增，004 迁移初值 0） */
  turn: number
  entries: Record<string, DmaeEntryState>
}

/** DmaeStateStore：load/save dmae-state.json，损坏阻断启动 */
export interface DmaeStateStore {
  /**
   * 加载持久化状态。文件缺失 -> 返回空 Map（首次启动）；
   * 文件损坏/schemaVersion 不符 -> 抛 MEM_DB_CORRUPT fatal（C-α-2：不许静默清空）。
   * 不做孤儿清理（调用方用 reconcileStates 与 L2 DB 对齐）。
   */
  load(): Map<string, DmaeEntryState>
  /** 原子写状态到磁盘（atomicWriteJson） */
  save(states: Map<string, DmaeEntryState>): void
  /** 状态文件路径（诊断用） */
  readonly path: string
}

export interface DmaeStateStoreOptions {
  filePath: string
  logger: Logger
}

/**
 * 创建 DmaeStateStore。
 * 文件操作全部在此模块，不泄露 fs 给上层。
 */
export function createDmaeStateStore(opts: DmaeStateStoreOptions): DmaeStateStore {
  const { filePath, logger } = opts

  function load(): Map<string, DmaeEntryState> {
    const empty = new Map<string, DmaeEntryState>()
    // C-α-2：区分 missing（正常首次初始化）与 invalid（阻断启动，不许猜）。
    // 依据 F5-013 §3 doc:192：损坏文件不许静默清空，必须抛错引导恢复。
    const vr = readJsonVersion(filePath)
    if (vr.kind === 'missing') {
      return empty
    }
    if (vr.kind === 'invalid') {
      throw new AppError({
        code: 'MEM_DB_CORRUPT',
        userMessage: `DMAE 状态文件损坏（${vr.reason}），请从备份恢复：${path.basename(filePath)}`,
        severity: 'fatal',
        retryable: false,
        cause: { file: filePath, reason: vr.reason }
      })
    }
    if (vr.version !== DMAE_STATE_SCHEMA_VERSION) {
      throw new AppError({
        code: 'MEM_DB_CORRUPT',
        userMessage: `DMAE 状态文件版本不匹配（期望 ${DMAE_STATE_SCHEMA_VERSION}，实际 ${vr.version}），请运行迁移或从备份恢复`,
        severity: 'fatal',
        retryable: false,
        cause: { file: filePath, expected: DMAE_STATE_SCHEMA_VERSION, actual: vr.version }
      })
    }

    // readJsonVersion 已确认文件可解析且版本号正确；这里重新读完整内容做结构校验
    const raw = fs.readFileSync(filePath, 'utf8')
    const data = JSON.parse(raw) as Partial<DmaeStateData>
    if (!data || typeof data !== 'object' || !data.entries || typeof data.entries !== 'object') {
      throw new AppError({
        code: 'MEM_DB_CORRUPT',
        userMessage: `DMAE 状态文件结构损坏（entries 缺失或非对象），请从备份恢复：${path.basename(filePath)}`,
        severity: 'fatal',
        retryable: false
      })
    }

    // 字段级清理：单条 entry 损坏跳过，保留合法条目（不算文件级损坏）
    const states = new Map<string, DmaeEntryState>()
    for (const [id, entry] of Object.entries(data.entries)) {
      if (!isValidEntryState(entry)) continue
      states.set(id, {
        activation: entry.activation,
        userSilence: entry.userSilence,
        modelSilence: entry.modelSilence,
        everActivated: entry.everActivated
      })
    }
    return states
  }

  function save(states: Map<string, DmaeEntryState>): void {
    const entries: Record<string, DmaeEntryState> = {}
    for (const [id, st] of states) {
      entries[id] = {
        activation: st.activation,
        userSilence: st.userSilence,
        modelSilence: st.modelSilence,
        everActivated: st.everActivated
      }
    }
    const data: DmaeStateData = {
      schemaVersion: DMAE_STATE_SCHEMA_VERSION,
      turn: 0, // turn 由引擎递增（P2-31.5 接入），当前阶段固定 0
      entries
    }
    try {
      atomicWriteJson(filePath, data)
    } catch (e) {
      // 写入失败不阻塞主流程（败而不崩）；下一轮 turn.end 会重试
      logger.warn('dmae state save failed; will retry next turn', {
        scope: 'memory',
        code: 'MEM_WRITE_FAIL',
        detail: e instanceof Error ? e.message : String(e),
        metrics: { entries: states.size }
      })
    }
  }

  return { load, save, path: filePath }
}

/** 校验单条 entry state 结构（损坏文件可能含非法字段） */
function isValidEntryState(v: unknown): v is DmaeEntryState {
  if (!v || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  return (
    typeof e.activation === 'number' &&
    Number.isFinite(e.activation) &&
    typeof e.userSilence === 'number' &&
    Number.isFinite(e.userSilence) &&
    typeof e.modelSilence === 'number' &&
    Number.isFinite(e.modelSilence) &&
    typeof e.everActivated === 'boolean'
  )
}

/** reconcile 结果（诊断/日志用） */
export interface ReconcileResult {
  /** 清理的孤儿状态数（stateFile 有但 L2 已删） */
  removed: number
  /** 新增的初始状态数（L2 有但 stateFile 没有） */
  added: number
}

/**
 * 状态文件与 L2 DB 对齐（以 DB 为准）。
 *
 * - states 有但 l2Ids 没有的 -> 删（孤儿清理）
 * - l2Ids 有但 states 没有的 -> 初始化 createInitialEntryState()（activation=0, Archived 冷态）
 * - 两者都有的 -> 保留
 *
 * 原地更新 states；返回 removed/added 计数。
 */
export function reconcileStates(
  states: Map<string, DmaeEntryState>,
  l2Ids: Iterable<string>
): ReconcileResult {
  const l2Set = new Set(l2Ids)
  let removed = 0
  let added = 0

  // 孤儿清理：states 有但 L2 已删
  for (const id of states.keys()) {
    if (!l2Set.has(id)) {
      states.delete(id)
      removed++
    }
  }

  // 新增初始化：L2 有但 states 没有
  for (const id of l2Set) {
    if (!states.has(id)) {
      states.set(id, createInitialEntryState())
      added++
    }
  }

  return { removed, added }
}
