// src/main/memory/dmae/engine.test.ts
// P2-23 / D-02 / D-03：DMAE 引擎状态机--三态边界、MAX_ACTIVE 裁剪、Floor 复活、
// modelReward Active gating + Rm<D clamp、importance 豁免、silence 更新。
import { describe, it, expect } from 'vitest'
import {
  updateTurn,
  rankActiveEntries,
  countStates,
  createInitialEntryState,
  deriveEntryState,
  type DmaeEntryState,
  type DmaeTurnInput
} from './engine'
import type { DmaeParams } from './formulas'

const P: DmaeParams = {
  maxScore: 100,
  promptThreshold: 30,
  userRewardBase: 20,
  wakeGamma: 0.5,
  modelRewardBase: 8,
  wakeLambda: 0.3,
  decayAlpha: 1.5,
  decayBeta: 0.3
}

const NOW = 1_700_000_000_000

function makeState(activation: number, userSilence = 0, modelSilence = 0): DmaeEntryState {
  return { activation, userSilence, modelSilence, everActivated: activation > 0 }
}

function makeStates(
  entries: Array<{ id: string; activation: number; us?: number; ms?: number; importance?: number }>
): { states: Map<string, DmaeEntryState>; importances: Map<string, number> } {
  const states = new Map<string, DmaeEntryState>()
  const importances = new Map<string, number>()
  for (const e of entries) {
    states.set(e.id, makeState(e.activation, e.us ?? 0, e.ms ?? 0))
    importances.set(e.id, e.importance ?? 5)
  }
  return { states, importances }
}

function hits(user: string[] = [], model: string[] = []): DmaeTurnInput {
  return {
    userHitIds: new Set(user),
    modelHitIds: new Set(model)
  }
}

const importanceOf = (map: Map<string, number>) => (id: string) => map.get(id) ?? 5

// === D-02 三态边界 ===

describe('D-02 三态边界 + archivedAt', () => {
  it('activation 衰减到 ≤0 -> Archived（transition 含 archivedAt=now）', () => {
    const { states, importances } = makeStates([
      { id: 'm1', activation: 0.5, us: 10, ms: 10, importance: 5 }
    ])
    const res = updateTurn(states, hits(), P, importanceOf(importances), () => NOW)
    // 衰减后 activation -> 0
    expect(states.get('m1')!.activation).toBe(0)
    const t = res.transitions.find((x) => x.id === 'm1')
    expect(t).toBeDefined()
    expect(t!.to).toBe('Archived')
    expect(t!.archivedAt).toBe(NOW) // 写入时间戳
  })

  it('activation≥threshold -> Active（无迁移则无 transition）', () => {
    const { states, importances } = makeStates([{ id: 'm1', activation: 50, importance: 5 }])
    const res = updateTurn(states, hits(['m1']), P, importanceOf(importances), () => NOW)
    // userHit 后 activation 上升，仍 Active
    expect(deriveEntryState(states.get('m1')!, P.promptThreshold)).toBe('Active')
    expect(res.transitions).toHaveLength(0)
  })

  it('(0,threshold) -> Dormant', () => {
    const { states, importances } = makeStates([{ id: 'm1', activation: 15, importance: 5 }])
    updateTurn(states, hits(), P, importanceOf(importances), () => NOW)
    // 轻微衰减后仍 Dormant
    expect(deriveEntryState(states.get('m1')!, P.promptThreshold)).toBe('Dormant')
  })

  it('Active -> Dormant 迁移（activation 跌破 threshold）', () => {
    const { states, importances } = makeStates([
      { id: 'm1', activation: 30.1, us: 5, ms: 5, importance: 5 }
    ])
    const res = updateTurn(states, hits(), P, importanceOf(importances), () => NOW)
    const t = res.transitions.find((x) => x.id === 'm1')
    expect(t).toBeDefined()
    expect(t!.from).toBe('Active')
    expect(t!.to).toBe('Dormant')
    expect(t!.archivedAt).toBeUndefined() // archivedAt 不变
  })
})

// === D-02 Floor 复活 ===

describe('D-02 Floor 复活（仅 Archived->Active）', () => {
  it('Archived + userHit -> Floor 复活到 max(计算值, importance)', () => {
    const { states, importances } = makeStates([
      { id: 'm1', activation: 0, us: 5, ms: 5, importance: 60 }
    ])
    const res = updateTurn(states, hits(['m1']), P, importanceOf(importances), () => NOW)
    // Ru(5) = 20×(1+0.5×ln6) ≈ 37.92；Floor=60 -> max(37.92, 60) = 60
    expect(states.get('m1')!.activation).toBeCloseTo(60, 5)
    const t = res.transitions.find((x) => x.id === 'm1')
    expect(t!.from).toBe('Archived')
    expect(t!.to).toBe('Active')
    expect(t!.archivedAt).toBeNull() // 清空
    expect(res.stats.floorRevivals).toBe(1)
  })

  it('Floor 计算值高于 importance 时取计算值', () => {
    const { states, importances } = makeStates([
      { id: 'm1', activation: 0, us: 20, ms: 20, importance: 10 }
    ])
    updateTurn(states, hits(['m1']), P, importanceOf(importances), () => NOW)
    // Ru(20) = 20×(1+0.5×ln21) = 20×(1+0.5×3.0445) = 20×2.5223 = 50.45
    // Floor=10 -> max(50.45, 10) = 50.45
    expect(states.get('m1')!.activation).toBeCloseTo(50.4457, 3)
  })

  it('Dormant + userHit -> 不触发 Floor（仅 Archived 复活才 floor）', () => {
    const { states, importances } = makeStates([
      { id: 'm1', activation: 15, us: 5, ms: 5, importance: 60 } // Dormant
    ])
    const res = updateTurn(states, hits(['m1']), P, importanceOf(importances), () => NOW)
    // Ru(5) = 20×(1+0.5×ln6)；aNew = 15 + Ru(5)（不 floor 到 60）
    const ru5 = 20 * (1 + 0.5 * Math.log(6))
    expect(states.get('m1')!.activation).toBeCloseTo(15 + ru5, 8)
    expect(res.stats.floorRevivals).toBe(0)
  })

  it('Active + userHit -> 不触发 Floor', () => {
    const { states, importances } = makeStates([
      { id: 'm1', activation: 50, us: 5, ms: 5, importance: 60 } // Active
    ])
    const res = updateTurn(states, hits(['m1']), P, importanceOf(importances), () => NOW)
    expect(res.stats.floorRevivals).toBe(0)
    // aNew = 50 + Ru(5)（不 floor 到 60，因为已经 > 60 前不触发）
    const ru5 = 20 * (1 + 0.5 * Math.log(6))
    expect(states.get('m1')!.activation).toBeCloseTo(50 + ru5, 8)
  })

  it('Archived + 仅 modelHit -> 不触发 Floor（Floor 仅 userHit 复活）', () => {
    const { states, importances } = makeStates([
      { id: 'm1', activation: 0, us: 5, ms: 5, importance: 60 } // Archived
    ])
    const res = updateTurn(states, hits([], ['m1']), P, importanceOf(importances), () => NOW)
    expect(res.stats.floorRevivals).toBe(0)
    // modelHit + Archived -> 无 Rm（gating：仅 Active 给 Rm）；只衰减
    expect(states.get('m1')!.activation).toBe(0)
  })
})

// === modelReward Active gating + Rm<D clamp ===

describe('modelReward Active gating + Rm<D clamp', () => {
  it('modelHit + Active -> 给 Rm', () => {
    const { states, importances } = makeStates([
      { id: 'm1', activation: 50, us: 2, ms: 0, importance: 5 } // Active
    ])
    updateTurn(states, hits([], ['m1']), P, importanceOf(importances), () => NOW)
    // usNew=3, msNew=0；decay = 1.5×9/√5 = 6.037
    // rawRm = 8×e^(-0.3×2) = 4.390；clamp(0, 4.390, 6.037-0.01) = 4.390
    // aNew = 50 + 4.390 - 6.037 = 48.353
    expect(states.get('m1')!.activation).toBeCloseTo(48.353, 2)
  })

  it('modelHit + Dormant -> 无 Rm（gating）', () => {
    const { states, importances } = makeStates([
      { id: 'm1', activation: 15, us: 2, ms: 0, importance: 5 } // Dormant
    ])
    updateTurn(states, hits([], ['m1']), P, importanceOf(importances), () => NOW)
    // 无 Rm；只衰减：aNew = 15 - 6.037 = 8.963
    expect(states.get('m1')!.activation).toBeCloseTo(8.963, 2)
  })

  it('Rm<D clamp：decay 很小时 Rm 被 clamp 到 decay-ε', () => {
    const { states, importances } = makeStates([
      { id: 'm1', activation: 50, us: 0, ms: 0, importance: 5 } // Active
    ])
    updateTurn(states, hits([], ['m1']), P, importanceOf(importances), () => NOW)
    // usNew=1, msNew=0；decay = 1.5×1/√5 = 0.6708
    // rawRm = 8×e^0 = 8；clamp(0, 8, 0.6708-0.01=0.6608) = 0.6608
    // aNew = 50 + 0.6608 - 0.6708 = 49.99
    expect(states.get('m1')!.activation).toBeCloseTo(49.99, 2)
  })

  it('Rm<D clamp 不产生负 modelReward', () => {
    // decay=0 时（importance=10 豁免），Rm clamp 到 -ε -> max(0, ...) = 0
    const { states, importances } = makeStates([
      { id: 'm1', activation: 50, us: 0, ms: 0, importance: 10 } // Active, 豁免 decay
    ])
    updateTurn(states, hits([], ['m1']), P, importanceOf(importances), () => NOW)
    // decay=0；rawRm=8；clamp(0, 8, 0-0.01=-0.01) = max(0, ...) = 0
    // aNew = 50 + 0 - 0 = 50
    expect(states.get('m1')!.activation).toBe(50)
  })
})

// === importance=10 豁免（D-04 引擎层） ===

describe('importance≥10 豁免：永不衰减', () => {
  it('importance=10 沉默 N 轮后 activation 不降', () => {
    const { states, importances } = makeStates([
      { id: 'm1', activation: 50, us: 0, ms: 0, importance: 10 }
    ])
    // 连续 10 轮沉默
    for (let i = 0; i < 10; i++) {
      updateTurn(states, hits(), P, importanceOf(importances), () => NOW)
    }
    expect(states.get('m1')!.activation).toBe(50) // 永不衰减
    expect(states.get('m1')!.userSilence).toBe(10)
  })

  it('importance=9 仍衰减（边界）', () => {
    const { states, importances } = makeStates([
      { id: 'm1', activation: 50, us: 0, ms: 0, importance: 9 }
    ])
    updateTurn(states, hits(), P, importanceOf(importances), () => NOW)
    expect(states.get('m1')!.activation).toBeLessThan(50)
  })
})

// === silence 更新 ===

describe('silence 更新', () => {
  it('userHit 重置 us=0', () => {
    const { states, importances } = makeStates([
      { id: 'm1', activation: 50, us: 5, ms: 3, importance: 5 }
    ])
    updateTurn(states, hits(['m1']), P, importanceOf(importances), () => NOW)
    expect(states.get('m1')!.userSilence).toBe(0)
    expect(states.get('m1')!.modelSilence).toBe(0) // userHit 也重置 ms
  })

  it('modelHit 重置 ms=0 但 us 继续累积', () => {
    const { states, importances } = makeStates([
      { id: 'm1', activation: 50, us: 5, ms: 3, importance: 5 }
    ])
    updateTurn(states, hits([], ['m1']), P, importanceOf(importances), () => NOW)
    expect(states.get('m1')!.userSilence).toBe(6) // 不重置
    expect(states.get('m1')!.modelSilence).toBe(0) // modelHit 重置
  })

  it('沉默时 us/ms 各 +1', () => {
    const { states, importances } = makeStates([
      { id: 'm1', activation: 50, us: 2, ms: 4, importance: 5 }
    ])
    updateTurn(states, hits(), P, importanceOf(importances), () => NOW)
    expect(states.get('m1')!.userSilence).toBe(3)
    expect(states.get('m1')!.modelSilence).toBe(5)
  })
})

// === D-03 MAX_ACTIVE 裁剪 ===

describe('D-03 rankActiveEntries MAX_ACTIVE 裁剪', () => {
  it('20 条超阈值 -> 取 activation 前 15', () => {
    const { states } = makeStates(
      Array.from({ length: 20 }, (_, i) => ({
        id: `m${i}`,
        activation: 30 + i, // 30..49，全部 Active
        importance: 5
      }))
    )
    const ranked = rankActiveEntries(states, P.promptThreshold, 15)
    expect(ranked).toHaveLength(15)
    // 取 activation 最高的 15 条（m5..m19，activation 35..49）
    expect(ranked[0].id).toBe('m19') // 最高 49
    expect(ranked[14].id).toBe('m5') // 第 15 高 35
  })

  it('并列分数按 id 升序（稳定 tiebreak）', () => {
    const { states } = makeStates(
      Array.from({ length: 20 }, (_, i) => ({
        id: `m${i.toString().padStart(2, '0')}`, // m00..m19，字典序
        activation: 50, // 全部并列
        importance: 5
      }))
    )
    const ranked = rankActiveEntries(states, P.promptThreshold, 15)
    expect(ranked).toHaveLength(15)
    // 同分按 id 升序：m00, m01, ..., m14
    expect(ranked[0].id).toBe('m00')
    expect(ranked[14].id).toBe('m14')
  })

  it('超阈值不足 maxActive 时全选（不补 Dormant）', () => {
    const { states } = makeStates([
      { id: 'm1', activation: 50, importance: 5 },
      { id: 'm2', activation: 40, importance: 5 },
      { id: 'm3', activation: 10, importance: 5 } // Dormant，不选
    ])
    const ranked = rankActiveEntries(states, P.promptThreshold, 15)
    expect(ranked).toHaveLength(2)
    expect(ranked.map((r) => r.id)).toEqual(['m1', 'm2'])
  })

  it('threshold 边界：activation=threshold 算 Active', () => {
    const { states } = makeStates([
      { id: 'm1', activation: 30, importance: 5 } // = threshold
    ])
    const ranked = rankActiveEntries(states, P.promptThreshold, 15)
    expect(ranked).toHaveLength(1)
  })

  it('maxActive=0 返回空数组', () => {
    const { states } = makeStates([{ id: 'm1', activation: 50, importance: 5 }])
    const ranked = rankActiveEntries(states, P.promptThreshold, 0)
    expect(ranked).toHaveLength(0)
  })
})

// === countStates ===

describe('countStates', () => {
  it('统计 active/dormant/archived', () => {
    const { states } = makeStates([
      { id: 'm1', activation: 50, importance: 5 }, // Active
      { id: 'm2', activation: 30, importance: 5 }, // Active
      { id: 'm3', activation: 15, importance: 5 }, // Dormant
      { id: 'm4', activation: 0, importance: 5 } // Archived
    ])
    const c = countStates(states, P.promptThreshold)
    expect(c).toEqual({ active: 2, dormant: 1, archived: 1 })
  })
})

// === createInitialEntryState ===

describe('createInitialEntryState', () => {
  it('M-46：新条目落 Dormant 缓冲带（activation=importance×2），us/ms=0，everActivated=true', () => {
    const st = createInitialEntryState(5, P.promptThreshold)
    expect(st.activation).toBe(10)
    expect(st.userSilence).toBe(0)
    expect(st.modelSilence).toBe(0)
    expect(st.everActivated).toBe(true)
    expect(deriveEntryState(st, P.promptThreshold)).toBe('Dormant')
  })

  it('初始永不 Active：clamp 到 threshold-1', () => {
    const st = createInitialEntryState(10, 15)
    expect(st.activation).toBe(14)
    expect(deriveEntryState(st, 15)).toBe('Dormant')
  })
})

// === 多条目集成 ===

describe('集成：多条目混合 turn', () => {
  it('用户提及 + 模型提及 + 沉默同时发生', () => {
    const { states, importances } = makeStates([
      { id: 'user', activation: 0, us: 5, ms: 5, importance: 60 }, // Archived，userHit -> Floor 复活
      { id: 'model', activation: 50, us: 2, ms: 0, importance: 5 }, // Active，modelHit -> Rm
      { id: 'silent', activation: 40, us: 1, ms: 1, importance: 5 } // Active，沉默 -> 衰减
    ])
    const res = updateTurn(
      states,
      hits(['user'], ['model']),
      P,
      importanceOf(importances),
      () => NOW
    )
    expect(res.stats.userHits).toBe(1)
    expect(res.stats.modelHits).toBe(1)
    expect(res.stats.floorRevivals).toBe(1)
    // user: Floor 复活到 60
    expect(states.get('user')!.activation).toBeCloseTo(60, 5)
    // model: 衰减 + Rm
    expect(states.get('model')!.activation).toBeLessThan(50)
    expect(states.get('model')!.activation).toBeGreaterThan(45)
    // silent: 衰减
    expect(states.get('silent')!.activation).toBeLessThan(40)
  })

  it('stats gauges：active/dormant/archived 更新后计数正确', () => {
    const { states, importances } = makeStates([
      { id: 'a1', activation: 50, us: 0, ms: 0, importance: 5 }, // Active
      { id: 'a2', activation: 30, us: 0, ms: 0, importance: 5 }, // Active（=threshold）
      { id: 'd1', activation: 15, us: 0, ms: 0, importance: 5 }, // Dormant
      { id: 'x1', activation: 0, us: 0, ms: 0, importance: 5 } // Archived
    ])
    const res = updateTurn(states, hits(), P, importanceOf(importances), () => NOW)
    // 全部沉默一轮：a1/a2 衰减但仍 Active（50->49.2, 30->29.2 Dormant?）
    // 验证 gauges 之和 = 总条目数
    expect(res.stats.active + res.stats.dormant + res.stats.archived).toBe(4)
    // gauges 与 countStates 一致
    const c = countStates(states, P.promptThreshold)
    expect(res.stats.active).toBe(c.active)
    expect(res.stats.dormant).toBe(c.dormant)
    expect(res.stats.archived).toBe(c.archived)
  })
})

// === P2-31.5D：引擎诊断 ABI（F5-002 §3.2/§3.7）===

describe('P2-31.5D: 引擎诊断 ABI', () => {
  it('diagnostics.entries 包含全部条目，逐条带 raw/effective/gated/decay', () => {
    const { states, importances } = makeStates([
      { id: 'active1', activation: 50, us: 0, ms: 0, importance: 5 },
      { id: 'silent1', activation: 30, us: 2, ms: 2, importance: 5 }
    ])
    const res = updateTurn(
      states,
      { userHitIds: new Set(['active1']), modelHitIds: new Set(['active1']) },
      P,
      importanceOf(importances),
      () => NOW
    )
    expect(res.diagnostics.entries).toHaveLength(2)
    const active1Diag = res.diagnostics.entries.find((d) => d.memoryId === 'active1')!
    expect(active1Diag.userHit).toBe(true)
    expect(active1Diag.modelHit).toBe(true)
    expect(active1Diag.modelHitGated).toBe(false) // aOld=50 >= 30 -> Active -> 不 gated
    expect(active1Diag.modelRewardRaw).toBeGreaterThan(0) // rawRm = Bm * e^0 = 8
    expect(active1Diag.modelRewardEffective).toBeGreaterThanOrEqual(0)
    expect(active1Diag.modelRewardEffective).toBeLessThanOrEqual(active1Diag.modelRewardRaw)
    // active1 被 user+model 命中 -> usNew=0, msNew=0 -> decay=0（不是 >0）
    expect(active1Diag.decay).toBe(0)
    // silent1 未被命中 -> usNew=3, msNew=3 -> decay>0
    const silent1Diag = res.diagnostics.entries.find((d) => d.memoryId === 'silent1')!
    expect(silent1Diag.decay).toBeGreaterThan(0)
    // raw 由引擎带出（S-F02：禁止在诊断层重算）
    expect(active1Diag.modelRewardRaw).toBeCloseTo(
      P.modelRewardBase * Math.exp(-P.wakeLambda * 0),
      5
    )
  })

  it('modelHit 但 aOld 非 Active -> modelHitGated=true, rawRm=0', () => {
    const { states, importances } = makeStates([
      { id: 'dormant1', activation: 15, us: 0, ms: 0, importance: 5 } // Dormant (< 30)
    ])
    const res = updateTurn(
      states,
      { userHitIds: new Set(), modelHitIds: new Set(['dormant1']) },
      P,
      importanceOf(importances),
      () => NOW
    )
    const d = res.diagnostics.entries[0]
    expect(d.modelHit).toBe(true)
    expect(d.modelHitGated).toBe(true) // aOld=15 < 30 -> Dormant -> gated
    expect(d.modelRewardRaw).toBe(0) // 没走到 clamp
    expect(d.modelRewardEffective).toBe(0)
    expect(res.diagnostics.modelHitsGated).toBe(1)
  })

  it('modelRewardRawSum / modelRewardEffectiveSum 只累加真正进了 clamp 的', () => {
    const { states, importances } = makeStates([
      { id: 'active1', activation: 50, us: 0, ms: 0, importance: 5 }, // Active, modelHit
      { id: 'dormant1', activation: 15, us: 0, ms: 0, importance: 5 } // Dormant, modelHit -> gated
    ])
    const res = updateTurn(
      states,
      { userHitIds: new Set(), modelHitIds: new Set(['active1', 'dormant1']) },
      P,
      importanceOf(importances),
      () => NOW
    )
    // 只有 active1 贡献 raw/effective sum
    expect(res.diagnostics.modelRewardRawSum).toBeGreaterThan(0)
    expect(res.diagnostics.modelRewardEffectiveSum).toBeGreaterThanOrEqual(0)
    expect(res.diagnostics.modelHitsGated).toBe(1)
  })

  it('everActivated 翻转：aNew > 0 时置 true，一旦为 true 不再回落', () => {
    const { states, importances } = makeStates([
      { id: 'new1', activation: 0, us: 0, ms: 0, importance: 5 } // Archived, everActivated=false
    ])
    // 首次 userHit -> Floor 复活到 importance=5 -> aNew=5 > 0 -> everActivated 翻 true
    const res1 = updateTurn(
      states,
      { userHitIds: new Set(['new1']), modelHitIds: new Set() },
      P,
      importanceOf(importances),
      () => NOW
    )
    expect(states.get('new1')!.everActivated).toBe(true)
    expect(res1.diagnostics.entries[0].firstActivation).toBe(true)
    expect(res1.diagnostics.entries[0].everActivatedBefore).toBe(false)

    // 下一轮沉默 -> activation 衰减但可能仍 > 0，everActivated 保持 true
    const res2 = updateTurn(
      states,
      { userHitIds: new Set(), modelHitIds: new Set() },
      P,
      importanceOf(importances),
      () => NOW
    )
    expect(states.get('new1')!.everActivated).toBe(true) // 不回落
    expect(res2.diagnostics.entries[0].everActivatedBefore).toBe(true)
    expect(res2.diagnostics.entries[0].firstActivation).toBe(false)
  })

  it('trueFloorRevivals 剔除 firstActivation（R09 口径）', () => {
    // 两条 Archived 记忆：
    // - new1: everActivated=false -> 首次命中 = firstActivation，floorRevivals++ 但不是 trueFloorRevival
    // - old1: everActivated=true -> 真实复活，floorRevivals++ 且是 trueFloorRevival
    const states = new Map<string, DmaeEntryState>([
      ['new1', { activation: 0, userSilence: 5, modelSilence: 5, everActivated: false }],
      ['old1', { activation: 0, userSilence: 5, modelSilence: 5, everActivated: true }]
    ])
    const importances = new Map<string, number>([
      ['new1', 5],
      ['old1', 5]
    ])
    const res = updateTurn(
      states,
      { userHitIds: new Set(['new1', 'old1']), modelHitIds: new Set() },
      P,
      importanceOf(importances),
      () => NOW
    )
    // 原始 floorRevivals = 2（两条都复活）
    expect(res.stats.floorRevivals).toBe(2)
    // trueFloorRevivals = 1（只有 old1 是真实复活）
    expect(res.diagnostics.trueFloorRevivals).toBe(1)
    // new1 是首次激活
    const new1Diag = res.diagnostics.entries.find((d) => d.memoryId === 'new1')!
    expect(new1Diag.firstActivation).toBe(true)
    const old1Diag = res.diagnostics.entries.find((d) => d.memoryId === 'old1')!
    expect(old1Diag.firstActivation).toBe(false)
  })

  it('改变 clamp 测试常数时采样结果同步（无第二份公式）', () => {
    // 用不同参数跑两轮，验证 diagnostics 的 rawRm 与公式一致
    const { states, importances } = makeStates([
      { id: 'a1', activation: 50, us: 0, ms: 0, importance: 5 }
    ])
    const paramsA: typeof P = { ...P, modelRewardBase: 10, wakeLambda: 0.4 }
    // modelHit 但不 userHit -> usNew=1, msNew=0
    const res = updateTurn(
      states,
      { userHitIds: new Set(), modelHitIds: new Set(['a1']) },
      paramsA,
      importanceOf(importances),
      () => NOW
    )
    const d = res.diagnostics.entries[0]
    // rawRm = Bm * e^(-λ * usOld) = 10 * e^(-0.4 * 0) = 10
    expect(d.modelRewardRaw).toBeCloseTo(10 * Math.exp(-0.4 * 0), 5)
    // usNew=1, msNew=0 -> decay = (α*1² + β*0²) / √5 = 1.5/√5
    const expectedDecay = (paramsA.decayAlpha * 1 * 1) / Math.sqrt(5)
    // effective = min(rawRm, decay - ε)
    expect(d.modelRewardEffective).toBeCloseTo(Math.max(0, Math.min(10, expectedDecay - 0.01)), 5)
  })
})

describe('P1（2026-08-10 审计）：engine 诊断带 stateBefore/stateAfter + activationStats + archivedTransitions', () => {
  it('entry diagnostics 记录 stateBefore/stateAfter/权威 before 值', () => {
    const { states, importances } = makeStates([
      { id: 'm1', activation: 20, us: 3, ms: 2, importance: 5 } // Dormant
    ])
    // userHit -> Ru -> aNew 上升可能到 Active
    const res = updateTurn(
      states,
      { userHitIds: new Set(['m1']), modelHitIds: new Set() },
      P,
      importanceOf(importances),
      () => NOW
    )
    const d = res.diagnostics.entries[0]
    expect(d.stateBefore).toBe('Dormant')
    expect(d.activationBefore).toBe(20)
    expect(d.userSilenceBefore).toBe(3)
    expect(d.modelSilenceBefore).toBe(2)
    expect(d.activationAfter).toBe(states.get('m1')!.activation)
    // us=3 -> Ru=20*(1+0.5·ln4)≈33.9，decay=0（userHit 重置 us/ms）-> aNew≈53.9 >= 30 -> Active
    expect(d.stateAfter).toBe('Active' as const)
  })

  it('activationStats: count/sum/mean/median 来自本轮全部条目', () => {
    const { states, importances } = makeStates([
      { id: 'a', activation: 50, us: 0, ms: 0, importance: 5 },
      { id: 'b', activation: 10, us: 0, ms: 0, importance: 5 },
      { id: 'c', activation: 0, us: 0, ms: 0, importance: 5 }
    ])
    const res = updateTurn(
      states,
      { userHitIds: new Set(), modelHitIds: new Set() },
      P,
      importanceOf(importances),
      () => NOW
    )
    const s = res.diagnostics.activationStats
    expect(s.count).toBe(3)
    // 无 hit 只有衰减：aNew = aOld - decay(us=1, ms=1, I=5)
    // decay(1,1) = (1.5*1 + 0.3*1)/√5 = 1.8/√5 ≈ 0.805
    const decay = (P.decayAlpha + P.decayBeta) / Math.sqrt(5)
    const expected = [50 - decay, 10 - decay, 0].sort((x, y) => x - y)
    expect(s.sum).toBeCloseTo(
      expected.reduce((x, v) => x + v, 0),
      5
    )
    expect(s.mean).toBeCloseTo(s.sum / 3, 5)
    expect(s.median).toBeCloseTo(expected[1], 5) // 中位数
  })

  it('archivedTransitions 只统计迁入 Archived 的条目（不是总迁移数）', () => {
    // dormant -> archived（计 1），active -> dormant（不计）
    const { states, importances } = makeStates([
      { id: 'toArchived', activation: 5, us: 50, ms: 50, importance: 5 }, // Dormant -> 衰减到 0
      { id: 'toDormant', activation: 31, us: 0, ms: 0, importance: 5 } // Active -> 衰减到 <30
    ])
    const res = updateTurn(
      states,
      { userHitIds: new Set(), modelHitIds: new Set() },
      P,
      importanceOf(importances),
      () => NOW
    )
    // toArchived: 5 - decay -> 0 -> Archived；toDormant: 31 - decay -> ~30.2 仍 Active 或 Dormant
    expect(res.diagnostics.archivedTransitions).toBe(1)
  })

  it('无条目时 activationStats 全 0，archivedTransitions=0', () => {
    const res = updateTurn(
      new Map(),
      { userHitIds: new Set(), modelHitIds: new Set() },
      P,
      () => 5,
      () => NOW
    )
    expect(res.diagnostics.activationStats).toEqual({ count: 0, sum: 0, mean: 0, median: 0 })
    expect(res.diagnostics.archivedTransitions).toBe(0)
  })
})
