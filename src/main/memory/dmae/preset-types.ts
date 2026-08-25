// src/main/memory/dmae/preset-types.ts
// P2-35：DMAE 预设系统（F5-002 §3.5）。
// 依据：F5-002 §3.5 的 BUILTIN_PRESETS + resolvePreset + diffParams + lerpPresets + 导入导出格式。
//
// 设计要点：
//   1. 预设 = 基线 + 命名偏移量（baseline:'default' + overrides），不是全量快照
//   2. BUILTIN_PRESETS 常驻 shared（唯一真源，2026-08-10 审计：修掉 main/renderer 双份复制）
//   3. Bm/λ 在任何内置预设里都不出现（§2.1 事实 A：它们被 clamp 完全吃掉）
//   4. 有效杠杆只有五个：α、β、Bu、γ、promptThreshold
//   5. 每个预设的存活轮数都按 §3.4 公式验算过

import type { DmaePreset, UserDmaePreset } from '@shared/memory/dmae-config'
import { BUILTIN_PRESETS } from '@shared/memory/dmae-config'
import { PARAM_SCHEMA_RANGE } from './advice-types'
import type { DmaeParamsSnapshot } from './history-types'
import type { TunableParam } from './advice-types'

export { BUILTIN_PRESETS }

// === 预设算法 ===

/** 解析预设为完整参数（baseline 展开 + overrides 覆盖） */
export function resolvePreset(
  preset: DmaePreset,
  defaults: DmaeParamsSnapshot
): DmaeParamsSnapshot {
  // baseline='default' -> 从 defaults 展开
  const resolved: DmaeParamsSnapshot = { ...defaults }
  // overrides 覆盖
  for (const [key, value] of Object.entries(preset.overrides)) {
    if (key in resolved) {
      ;(resolved as unknown as Record<string, number>)[key] = value as number
    }
  }
  return resolved
}

/** 预设 diff。返回按 |相对变化| 降序排列 */
export interface ParamDiffEntry {
  param: TunableParam
  label: string
  from: number
  to: number
  relativeChange: number
  effect: 'persist' | 'volatile'
  narrative: string
}

/** 参数作用方向表（与 advice-types 一致，此处为 diff 展示用） */
const PARAM_INFO: Record<string, { label: string; effect: 'persist' | 'volatile' }> = {
  userRewardBase: { label: '记忆力度 Bu', effect: 'persist' },
  wakeGamma: { label: '重复提及增长 γ', effect: 'persist' },
  modelRewardBase: { label: '主动提及权重 Bm', effect: 'persist' },
  wakeLambda: { label: '主动提及衰减 λ', effect: 'volatile' },
  decayAlpha: { label: '遗忘速度 α', effect: 'volatile' },
  decayBeta: { label: '模型侧遗忘 β', effect: 'volatile' },
  promptThreshold: { label: '进入门槛 threshold', effect: 'volatile' }
}

/** 预设 diff：返回按 |相对变化| 降序排列的差异列表 */
export function diffParams(from: DmaeParamsSnapshot, to: DmaeParamsSnapshot): ParamDiffEntry[] {
  const entries: ParamDiffEntry[] = []
  for (const key of Object.keys(PARAM_INFO) as TunableParam[]) {
    const fromVal = from[key as keyof DmaeParamsSnapshot] as number
    const toVal = to[key as keyof DmaeParamsSnapshot] as number
    if (fromVal !== toVal) {
      const info = PARAM_INFO[key]
      const relativeChange = fromVal !== 0 ? (toVal - fromVal) / fromVal : 0
      const direction = toVal > fromVal ? '提高' : '降低'
      entries.push({
        param: key,
        label: info.label,
        from: fromVal,
        to: toVal,
        relativeChange: Math.abs(relativeChange),
        effect: info.effect,
        narrative: `${info.label}从 ${fromVal} ${direction}到 ${toVal}`
      })
    }
  }
  entries.sort((a, b) => b.relativeChange - a.relativeChange)
  return entries
}

/**
 * 预设插值（t=0 返回 a，t=1 返回 b，中间线性插值后过 normalizeSuggestion 取整裁剪）。
 * 面板提供"从『活在当下』滑向『温柔体贴』"的单滑条 UX。
 */
export function lerpPresets(
  a: DmaeParamsSnapshot,
  b: DmaeParamsSnapshot,
  t: number
): DmaeParamsSnapshot {
  const clamped = Math.max(0, Math.min(1, t))
  const result: DmaeParamsSnapshot = { ...a }
  for (const key of Object.keys(result) as (keyof DmaeParamsSnapshot)[]) {
    const av = a[key] as number
    const bv = b[key] as number
    result[key] = round2(av + (bv - av) * clamped) as never
  }
  return result
}

// === 导入/导出格式 ===

/** 导入/导出格式。纯参数，不含用户数据（预设可分享） */
export interface DmaePresetExport {
  formatVersion: 1
  exportedAt: number
  appVersion: string
  presets: DmaePreset[]
}

/** 导出预设为可分享的 JSON */
export function exportPresets(
  presets: ReadonlyArray<DmaePreset>,
  appVersion: string
): DmaePresetExport {
  return {
    formatVersion: 1,
    exportedAt: Date.now(),
    appVersion,
    presets: [...presets]
  }
}

/**
 * 导入预设（越界值裁剪到范围内并 warn）。
 * 返回合法化后的预设列表 + 裁剪警告。
 */
export function importPresets(
  raw: unknown,
  defaults: DmaeParamsSnapshot
): { presets: UserDmaePreset[]; warnings: string[] } {
  const warnings: string[] = []
  if (!raw || typeof raw !== 'object') {
    return { presets: [], warnings: ['导入文件格式错误'] }
  }
  const data = raw as { presets?: unknown }
  if (!Array.isArray(data.presets)) {
    return { presets: [], warnings: ['导入文件缺少 presets 数组'] }
  }

  const presets: UserDmaePreset[] = []
  const seenIds = new Set<string>()

  for (const item of data.presets) {
    if (!item || typeof item !== 'object') continue
    const p = item as Record<string, unknown>

    // 内置预设跳过（不导入 builtin:true）
    if (p.builtin === true) continue

    // id 格式校验
    if (typeof p.id !== 'string' || !/^preset\.user\.[A-Za-z0-9_-]{1,64}$/.test(p.id)) {
      warnings.push(`跳过无效 id 的预设`)
      continue
    }
    if (seenIds.has(p.id)) {
      warnings.push(`跳过重复 id 的预设: ${p.id}`)
      continue
    }
    seenIds.add(p.id)

    // overrides 越界值裁剪
    const overrides: Record<string, number> = {}
    if (p.overrides && typeof p.overrides === 'object') {
      for (const [key, value] of Object.entries(p.overrides)) {
        if (typeof value !== 'number' || !Number.isFinite(value)) continue
        const range = PARAM_SCHEMA_RANGE[key]
        if (!range) {
          warnings.push(`跳过未知参数: ${key}`)
          continue
        }
        const clamped = Math.max(range.min, Math.min(range.max, value))
        if (clamped !== value) {
          warnings.push(`参数 ${key} 越界，已从 ${value} 裁剪到 ${clamped}`)
        }
        overrides[key] = clamped
      }
    }

    presets.push({
      id: p.id,
      name: typeof p.name === 'string' ? p.name.slice(0, 40) : '未命名预设',
      description: typeof p.description === 'string' ? p.description.slice(0, 160) : '',
      baseline: 'default',
      overrides: overrides as UserDmaePreset['overrides'],
      builtin: false,
      createdAt: typeof p.createdAt === 'number' ? p.createdAt : Date.now(),
      updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : Date.now()
    })
  }

  void defaults // 预留：未来可能需要 defaults 来验证 baseline
  return { presets, warnings }
}

/** 取 2 位小数 */
function round2(v: number): number {
  return Math.round(v * 100) / 100
}
