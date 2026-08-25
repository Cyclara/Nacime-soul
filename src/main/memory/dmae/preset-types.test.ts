// src/main/memory/dmae/preset-types.test.ts
// P2-35 预设系统测试（2026-08-10 审计补：preset-types.ts 此前 0% 覆盖）。
// 核心回归：resolvePreset 解析 baseline、diffParams、lerpPresets、importPresets 越界裁剪。
import { describe, it, expect } from 'vitest'
import {
  BUILTIN_PRESETS,
  resolvePreset,
  diffParams,
  lerpPresets,
  importPresets
} from './preset-types'
import { DEFAULT_DMAE_PARAMS } from '@shared/memory/dmae-config'
import type { DmaeParamsSnapshot } from './history-types'

const DEFAULTS: DmaeParamsSnapshot = { ...DEFAULT_DMAE_PARAMS }

describe('P2-35: BUILTIN_PRESETS 真源在 shared（无双份复制）', () => {
  it('内置 4 个，Bm/λ 不出现，id 命名空间正确', () => {
    expect(BUILTIN_PRESETS).toHaveLength(4)
    for (const p of BUILTIN_PRESETS) {
      expect(p.builtin).toBe(true)
      expect(p.overrides.modelRewardBase).toBeUndefined() // Bm 不出现在内置预设
      expect(p.overrides.wakeLambda).toBeUndefined() // λ 不出现在内置预设
    }
    expect(BUILTIN_PRESETS.map((p) => p.id)).toEqual([
      'preset.default',
      'preset.tender',
      'preset.present',
      'preset.curious'
    ])
  })
})

describe('P2-35: resolvePreset 解析 baseline + overrides', () => {
  it('默认预设 -> 全默认参数', () => {
    const defaultPreset = BUILTIN_PRESETS.find((p) => p.id === 'preset.default')!
    expect(resolvePreset(defaultPreset, DEFAULTS)).toEqual(DEFAULTS)
  })

  it('温柔体贴 -> decayAlpha/decayBeta/Bu/γ 覆盖，未覆盖的保持默认', () => {
    const tender = BUILTIN_PRESETS.find((p) => p.id === 'preset.tender')!
    const r = resolvePreset(tender, DEFAULTS)
    expect(r.decayAlpha).toBe(0.3)
    expect(r.decayBeta).toBe(0.1)
    expect(r.userRewardBase).toBe(25)
    expect(r.wakeGamma).toBe(0.8)
    expect(r.promptThreshold).toBe(30) // 未覆盖 -> 默认
    expect(r.maxScore).toBe(100)
  })
})

describe('P2-35: diffParams / lerpPresets', () => {
  it('diffParams 只列差异参数，按相对变化降序', () => {
    const to: DmaeParamsSnapshot = { ...DEFAULTS, decayAlpha: 0.3, promptThreshold: 40 }
    const diffs = diffParams(DEFAULTS, to)
    expect(diffs.map((d) => d.param).sort()).toEqual(['decayAlpha', 'promptThreshold'])
    expect(diffs[0].relativeChange).toBeGreaterThanOrEqual(diffs[1].relativeChange)
  })

  it('lerpPresets t=0 -> a，t=1 -> b，中间线性', () => {
    const a: DmaeParamsSnapshot = { ...DEFAULTS, decayAlpha: 0.3 }
    const b: DmaeParamsSnapshot = { ...DEFAULTS, decayAlpha: 1.5 }
    expect(lerpPresets(a, b, 0).decayAlpha).toBe(0.3)
    expect(lerpPresets(a, b, 1).decayAlpha).toBe(1.5)
    expect(lerpPresets(a, b, 0.5).decayAlpha).toBe(0.9)
    // t 越界裁剪
    expect(lerpPresets(a, b, 2).decayAlpha).toBe(1.5)
  })
})

describe('P2-35: importPresets 越界裁剪 + 过滤', () => {
  it('越界参数裁剪到 schema 范围并 warn', () => {
    const raw = {
      presets: [
        {
          id: 'preset.user.mine',
          name: '我的预设',
          overrides: { decayAlpha: 99, promptThreshold: -5 } // 都越界
        }
      ]
    }
    const { presets, warnings } = importPresets(raw, DEFAULTS)
    expect(presets).toHaveLength(1)
    expect(presets[0].overrides.decayAlpha).toBe(2) // clamp 到 max
    expect(presets[0].overrides.promptThreshold).toBe(1) // clamp 到 min
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('内置预设 / 非法 id / 未知参数被跳过', () => {
    const raw = {
      presets: [
        { id: 'preset.default', name: '默认', overrides: {}, builtin: true }, // 内置跳过
        { id: 'evil', name: '坏 id', overrides: {} }, // id 非法
        { id: 'preset.user.ok', name: '好的', overrides: { nope: 1 } } // 未知参数跳过
      ]
    }
    const { presets, warnings } = importPresets(raw, DEFAULTS)
    expect(presets).toHaveLength(1)
    expect(presets[0].id).toBe('preset.user.ok')
    expect(warnings.length).toBeGreaterThanOrEqual(2)
  })

  it('重复 id 跳过', () => {
    const raw = {
      presets: [
        { id: 'preset.user.a', name: 'A', overrides: {} },
        { id: 'preset.user.a', name: 'A 重复', overrides: {} }
      ]
    }
    const { presets } = importPresets(raw, DEFAULTS)
    expect(presets).toHaveLength(1)
  })

  it('非对象/缺 presets 数组 -> 空 + 警告', () => {
    expect(importPresets(null, DEFAULTS).presets).toEqual([])
    expect(importPresets({}, DEFAULTS).warnings.length).toBeGreaterThan(0)
  })
})
