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
  it('新条目 activation=0（Archived 冷态），us/ms=0', () => {
    const st = createInitialEntryState()
    expect(st.activation).toBe(0)
    expect(st.userSilence).toBe(0)
    expect(st.modelSilence).toBe(0)
    expect(deriveEntryState(st, P.promptThreshold)).toBe('Archived')
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
