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
import type { L2Memory } from '../l2-store'

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
   * 加载持久化状态。文件缺失 -> 返回空状态（首次启动，turn=0）；
   * 文件损坏/schemaVersion 不符 -> 抛 MEM_DB_CORRUPT fatal（C-α-2：不许静默清空）。
   * 返回 { turn, states }：turn 是持久化的全局 DMAE 轮计数器（F5-002 §3.2 单调延续），
   * 调用方（service.initialize）必须从它恢复，否则重启后 dmae_turns.turn 主键被 INSERT OR REPLACE 覆盖。
   * 不做孤儿清理（调用方用 reconcileStates 与 L2 DB 对齐）。
   */
  load(): { turn: number; states: Map<string, DmaeEntryState> }
  /** 原子写状态到磁盘（atomicWriteJson）。turn 必须与 states 同快照保存，保证重启延续 */
  save(states: Map<string, DmaeEntryState>, turn: number): void
  /** 状态文件路径（诊断用） */
  readonly path: string
  /**
   * P2-31.5C1-9：健康度（R11 的数据源，F5-002 §3.7）。
   * - lastLoadReset：上次 load 遇到损坏的时间戳（null=从未；load 抛错前设置）
   * - lastSaveOk：上次 save 是否成功
   * - lastSaveAt：上次成功 save 的时间戳
   * - saveFailures7d：近 7 天 save 失败次数
   */
  getHealth(): DmaeStateHealth
}

/** DMAE 状态文件健康度（F5-002 §3.7 R11 数据源） */
export interface DmaeStateHealth {
  lastLoadReset: number | null
  /**
   * P2（2026-08-10 审计）：reset 的具体原因（修复前恒 invalid-json，schema-mismatch 永不可见）。
   * null = 从未 reset。
   */
  lastLoadResetReason: 'invalid-json' | 'schema-mismatch' | null
  lastSaveOk: boolean
  lastSaveAt: number | null
  saveFailures7d: number
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

  // P2-31.5C1-9：健康度追踪
  let lastLoadReset: number | null = null
  let lastLoadResetReason: DmaeStateHealth['lastLoadResetReason'] = null
  let lastSaveOk = true
  let lastSaveAt: number | null = null
  const saveFailureTimestamps: number[] = []

  function pruneOldFailures(now: number): void {
    const cutoff = now - 7 * 24 * 60 * 60 * 1000
    while (saveFailureTimestamps.length > 0 && saveFailureTimestamps[0] < cutoff) {
      saveFailureTimestamps.shift()
    }
  }

  function load(): { turn: number; states: Map<string, DmaeEntryState> } {
    const empty = new Map<string, DmaeEntryState>()
    // C-α-2：区分 missing（正常首次初始化）与 invalid（阻断启动，不许猜）。
    // 依据 F5-013 §3 doc:192：损坏文件不许静默清空，必须抛错引导恢复。
    const vr = readJsonVersion(filePath)
    if (vr.kind === 'missing') {
      return { turn: 0, states: empty }
    }
    if (vr.kind === 'invalid') {
      // C1-9：记录 load 遇到损坏（在抛错前设置，调用方 catch 后可读 getHealth）
      lastLoadReset = Date.now()
      lastLoadResetReason = 'invalid-json'
      throw new AppError({
        code: 'MEM_DB_CORRUPT',
        userMessage: `DMAE 状态文件损坏（${vr.reason}），请从备份恢复：${path.basename(filePath)}`,
        severity: 'fatal',
        retryable: false,
        cause: { file: filePath, reason: vr.reason }
      })
    }
    if (vr.version !== DMAE_STATE_SCHEMA_VERSION) {
      lastLoadReset = Date.now()
      lastLoadResetReason = 'schema-mismatch'
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
      lastLoadReset = Date.now()
      lastLoadResetReason = 'invalid-json'
      throw new AppError({
        code: 'MEM_DB_CORRUPT',
        userMessage: `DMAE 状态文件结构损坏（entries 缺失或非对象），请从备份恢复：${path.basename(filePath)}`,
        severity: 'fatal',
        retryable: false
      })
    }

    // 持久化 turn：非负整数才接受，否则回退 0（防御旧/损坏文件；004 迁移保证 turn 存在）
    const turn =
      typeof data.turn === 'number' && Number.isInteger(data.turn) && data.turn >= 0 ? data.turn : 0

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
    return { turn, states }
  }

  function save(states: Map<string, DmaeEntryState>, turn: number): void {
    // turn 必须是合法的非负整数（服务调用方传入自增后的轮次；防御损坏值避免污染文件）
    const safeTurn = Number.isInteger(turn) && turn >= 0 ? turn : 0
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
      turn: safeTurn,
      entries
    }
    try {
      atomicWriteJson(filePath, data)
      lastSaveOk = true
      lastSaveAt = Date.now()
    } catch (e) {
      lastSaveOk = false
      const now = Date.now()
      saveFailureTimestamps.push(now)
      pruneOldFailures(now)
      // 写入失败不阻塞主流程（败而不崩）；下一轮 turn.end 会重试
      logger.warn('dmae state save failed; will retry next turn', {
        scope: 'memory',
        code: 'MEM_WRITE_FAIL',
        detail: e instanceof Error ? e.message : String(e),
        metrics: { entries: states.size, failures7d: saveFailureTimestamps.length }
      })
    }
  }

  function getHealth(): DmaeStateHealth {
    pruneOldFailures(Date.now())
    return {
      lastLoadReset,
      lastLoadResetReason,
      lastSaveOk,
      lastSaveAt,
      saveFailures7d: saveFailureTimestamps.length
    }
  }

  return { load, save, path: filePath, getHealth }
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
  /** M-46 补偿：旧规则出生、从未被激活过的存量条目补发初始激活的条数 */
  healed: number
}

/**
 * 状态文件与 L2 DB 对齐（以 DB 为准）。
 *
 * - states 有但 l2Entries 没有的 -> 删（孤儿清理）
 * - l2Entries 有但 states 没有的 -> 初始化 createInitialEntryState(importance, threshold)
 *   （M-46：importance 比例初始激活，Dormant 缓冲带，不再 0 激活直落 Archived）
 * - 两者都有的 -> 保留；但 M-46 前出生、从未被激活过的存量条目（everActivated=false 且
 *   activation<=0，即旧规则"出生即 Archived"的受害者）按新规则补发一次初始激活。
 *   一次性：补发后 everActivated=true 且落盘，不再重复触发；之后正常沉默衰减回 Archived
 *   的条目（everActivated=true）不受影响。
 *
 * 原地更新 states；返回 removed/added/healed 计数。
 */
export function reconcileStates(
  states: Map<string, DmaeEntryState>,
  l2Entries: Iterable<Pick<L2Memory, 'id' | 'importance'>>,
  promptThreshold: number
): ReconcileResult {
  const l2Set = new Map<string, number>()
  for (const e of l2Entries) {
    l2Set.set(e.id, e.importance)
  }
  let removed = 0
  let added = 0
  let healed = 0

  // 孤儿清理：states 有但 L2 已删
  for (const id of states.keys()) {
    if (!l2Set.has(id)) {
      states.delete(id)
      removed++
    }
  }

  for (const [id, importance] of l2Set) {
    const existing = states.get(id)
    if (!existing) {
      // 新增初始化：L2 有但 states 没有（M-46：importance 比例初始激活）
      states.set(id, createInitialEntryState(importance, promptThreshold))
      added++
    } else if (!existing.everActivated && existing.activation <= 0) {
      // M-46 补偿：旧规则下出生即 0 激活、从未有过升温机会的存量条目，补发同样的初始激活
      states.set(id, createInitialEntryState(importance, promptThreshold))
      healed++
    }
  }

  return { removed, added, healed }
}
