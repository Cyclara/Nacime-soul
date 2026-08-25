// src/main/memory/l0-store.ts
// L0 用户画像存储（持久事实）。JSON 持久化到 data/l0-profile.json。
// 依据：S-Phase2 P2-04、技术分析 §1.1.1（L0 层）、F5-006（L0_FIELD_WEIGHTS 字段对齐）。
//
// 铁律：
//   - 只有 certainty='explicit' 且 attribution='user_explicit' 才写（L0 是"用户"的画像，
//     角色自我认知/推断不得混入；"你叫小明"这类指向角色的陈述被 MemoryJudge 拦在门外，
//     本 Store 再做一道来源门槛，纵深防御）。
//   - isPinned 字段（用户手动设定）跳过自动写。
//   - 非白名单字段一律拒绝。
//   - 初始全"未知"（fields 为空）。

import type { Logger } from '@shared/observability/types'
import { AppError } from '@shared/errors'
import { atomicWriteJson, readJsonVersion } from '../migrations/atomic-json'
import { EXPECTED_VERSIONS } from '../migrations/types'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import type { MemoryRevisionClock } from './revision-clock'
import type { MemoryEventBroadcaster } from './event-broadcaster'

/** L0 字段白名单 + 中文描述。键与 F5-006 L0_FIELD_WEIGHTS 对齐（含 relationship_status 蛇形）。 */
export const L0_FIELD_DESCRIPTIONS = {
  preferredName: '希望被称呼的名字/昵称',
  name: '真实姓名',
  occupation: '职业/工作',
  likes: '喜好',
  dislikes: '厌恶',
  age: '年龄',
  gender: '性别',
  relationship_status: '感情状态',
  permanentNote: '长期备注'
} as const

export type L0FieldKey = keyof typeof L0_FIELD_DESCRIPTIONS

const L0_FIELD_KEYS = new Set<string>(Object.keys(L0_FIELD_DESCRIPTIONS))

export interface L0Field {
  value: string
  isPinned: boolean
  updatedAt: number
  source: 'user_explicit' | 'user_pinned'
}

export interface L0Profile {
  schemaVersion: number
  fields: Partial<Record<L0FieldKey, L0Field>>
}

/** 提取管线/MemoryJudge 产出的 L0 写候选 */
export interface L0WriteCandidate {
  field: string
  value: string
  certainty: 'explicit' | 'inferred'
  attribution: 'user_explicit' | 'inferred' | 'creator'
}

export type L0Event = 'l0.filled' | 'l0.updated'

export interface L0Store {
  get(): L0Profile
  getField(field: L0FieldKey): L0Field | null
  /** 显式来源门槛 + 白名单 + pinned 跳过。返回是否实际写入 */
  set(candidate: L0WriteCandidate): boolean
  /** 用户手动设定（UI）：直接写并置 isPinned=true */
  setPinned(field: L0FieldKey, value: string): void
  /** 用户清空某字段（fillRate 允许下降） */
  clearField(field: L0FieldKey): void
  /** 已填字段键列表 */
  filledFields(): L0FieldKey[]
  /** 订阅事件，返回取消订阅 */
  on(event: L0Event, handler: (field: L0FieldKey) => void): () => void
}

const CURRENT_VERSION = EXPECTED_VERSIONS.l0

export interface L0StoreOptions {
  filePath: string
  logger?: Logger
  now?: () => number
  /** P2-29: 可选，记忆事件广播（memory.enabled=true 时注入）。S-022 §1.4：JSON rename 成功 -> 短 DB 事务 next -> 广播 */
  revisionClock?: MemoryRevisionClock
  broadcaster?: MemoryEventBroadcaster
}

export function createL0Store(opts: L0StoreOptions): L0Store {
  const { filePath } = opts
  const now = opts.now ?? ((): number => Date.now())
  const revisionClock = opts.revisionClock
  const broadcaster = opts.broadcaster

  const listeners: Record<L0Event, Set<(field: L0FieldKey) => void>> = {
    'l0.filled': new Set(),
    'l0.updated': new Set()
  }

  const profile: L0Profile = load()

  function load(): L0Profile {
    // C-α-2：区分 missing（正常首次初始化）与 invalid（阻断启动，不许猜）。
    // 依据 F5-013 §3 doc:192：schemaVersion 被删/改乱 -> 视为 v0 -> 无法识别对话框/从备份恢复，不猜。
    const vr = readJsonVersion(filePath)
    if (vr.kind === 'missing') {
      return { schemaVersion: CURRENT_VERSION, fields: {} }
    }
    if (vr.kind === 'invalid') {
      throw new AppError({
        code: 'MEM_DB_CORRUPT',
        userMessage: `L0 画像文件损坏（${vr.reason}），请从备份恢复：${path.basename(filePath)}`,
        severity: 'fatal',
        retryable: false,
        cause: { file: filePath, reason: vr.reason }
      })
    }
    if (vr.version !== CURRENT_VERSION) {
      throw new AppError({
        code: 'MEM_DB_CORRUPT',
        userMessage: `L0 画像文件版本不匹配（期望 ${CURRENT_VERSION}，实际 ${vr.version}），请运行迁移或从备份恢复`,
        severity: 'fatal',
        retryable: false,
        cause: { file: filePath, expected: CURRENT_VERSION, actual: vr.version }
      })
    }
    // readJsonVersion 已确认文件可解析且版本号正确；这里重新读完整内容做字段级校验
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<L0Profile>
    if (!parsed.fields || typeof parsed.fields !== 'object') {
      throw new AppError({
        code: 'MEM_DB_CORRUPT',
        userMessage: `L0 画像文件结构损坏（fields 字段缺失或非对象），请从备份恢复：${path.basename(filePath)}`,
        severity: 'fatal',
        retryable: false
      })
    }
    // 字段级清理：只保留白名单字段（单条字段损坏不算文件级损坏，跳过即可）
    const fields: Partial<Record<L0FieldKey, L0Field>> = {}
    for (const [k, val] of Object.entries(parsed.fields)) {
      if (L0_FIELD_KEYS.has(k) && val && typeof (val as L0Field).value === 'string') {
        fields[k as L0FieldKey] = val as L0Field
      }
    }
    return { schemaVersion: CURRENT_VERSION, fields }
  }

  function persist(): void {
    atomicWriteJson(filePath, profile)
  }

  /** P2-29: JSON rename 成功 -> 短 DB 事务 next -> 广播（S-022 §1.4） */
  function notifyChange(): void {
    if (revisionClock && broadcaster) {
      revisionClock.next()
      broadcaster.notify('l0')
    }
  }

  function emit(event: L0Event, field: L0FieldKey): void {
    for (const h of listeners[event]) {
      try {
        h(field)
      } catch {
        /* 订阅者异常不影响写入 */
      }
    }
  }

  return {
    get() {
      return { schemaVersion: profile.schemaVersion, fields: { ...profile.fields } }
    },

    getField(field) {
      return profile.fields[field] ?? null
    },

    set(candidate) {
      // 门槛：显式来源
      if (candidate.certainty !== 'explicit' || candidate.attribution !== 'user_explicit')
        return false
      // 白名单
      if (!L0_FIELD_KEYS.has(candidate.field)) return false
      const field = candidate.field as L0FieldKey
      const existing = profile.fields[field]
      // pinned 字段跳过自动写
      if (existing?.isPinned) return false
      const isNew = existing === undefined
      const value = candidate.value.trim()
      if (value.length === 0) return false
      if (!isNew && existing.value === value) return false // 无变化不写
      profile.fields[field] = { value, isPinned: false, updatedAt: now(), source: 'user_explicit' }
      persist()
      notifyChange()
      emit(isNew ? 'l0.filled' : 'l0.updated', field)
      return true
    },

    setPinned(field, value) {
      if (!L0_FIELD_KEYS.has(field)) return
      const isNew = profile.fields[field] === undefined
      profile.fields[field] = { value, isPinned: true, updatedAt: now(), source: 'user_pinned' }
      persist()
      notifyChange()
      emit(isNew ? 'l0.filled' : 'l0.updated', field)
    },

    clearField(field) {
      if (profile.fields[field] === undefined) return
      delete profile.fields[field]
      persist()
      notifyChange()
      emit('l0.updated', field)
    },

    filledFields() {
      return Object.keys(profile.fields) as L0FieldKey[]
    },

    on(event, handler) {
      listeners[event].add(handler)
      return () => listeners[event].delete(handler)
    }
  }
}
