// src/main/memory/conflict/score.test.ts
// P2-19 / C-01：加分制 100% branch——各信号贡献、阈值边界(75/55/35)、三兜底任一命中→none。
import { describe, it, expect } from 'vitest'
import { scoreConflict, deriveBand, type ConflictSignals } from './score'

/** 一个不触发任何兜底、分数为 0 的基线信号 */
function base(): ConflictSignals {
  return {
    correctionIntent: false,
    ragScore: null,
    recentInjection: false,
    evidence: 'single', // 非 none，避免兜底；贡献 +8
    localContradiction: false,
    impactScope: 'none',
    targetArchived: false,
    recentlyResolved: false,
    detectionSource: 'rag'
  }
}

describe('P2-19 deriveBand boundaries', () => {
  it('75/74 → high/normal', () => {
    expect(deriveBand(75, false)).toBe('high')
    expect(deriveBand(74, false)).toBe('normal')
  })
  it('55/54 → normal/idle', () => {
    expect(deriveBand(55, false)).toBe('normal')
    expect(deriveBand(54, false)).toBe('idle')
  })
  it('35/34 → idle/none', () => {
    expect(deriveBand(35, false)).toBe('idle')
    expect(deriveBand(34, false)).toBe('none')
  })
  it('overridden → none regardless of score', () => {
    expect(deriveBand(100, true)).toBe('none')
  })
})

describe('P2-19 signal contributions', () => {
  it('correctionIntent +20', () => {
    expect(scoreConflict({ ...base(), correctionIntent: true }).breakdown.correctionIntent).toBe(20)
  })
  it('ragScore tiers: null→0, ≥0.75→25, ≥0.45→18, else→10', () => {
    expect(scoreConflict({ ...base(), ragScore: null }).breakdown.ragCandidate).toBe(0)
    expect(scoreConflict({ ...base(), ragScore: 0.8 }).breakdown.ragCandidate).toBe(25)
    expect(scoreConflict({ ...base(), ragScore: 0.5 }).breakdown.ragCandidate).toBe(18)
    expect(scoreConflict({ ...base(), ragScore: 0.2 }).breakdown.ragCandidate).toBe(10)
  })
  it('recentInjection +20', () => {
    expect(scoreConflict({ ...base(), recentInjection: true }).breakdown.recentInjection).toBe(20)
  })
  it('evidence tiers: both→15, single→8, none→0 (+ noEvidence -20)', () => {
    expect(scoreConflict({ ...base(), evidence: 'both' }).breakdown.evidence).toBe(15)
    expect(scoreConflict({ ...base(), evidence: 'single' }).breakdown.evidence).toBe(8)
    const none = scoreConflict({ ...base(), evidence: 'none' })
    expect(none.breakdown.evidence).toBe(0)
    expect(none.breakdown.noEvidence).toBe(-20)
  })
  it('localContradiction +10', () => {
    expect(
      scoreConflict({ ...base(), localContradiction: true }).breakdown.localContradiction
    ).toBe(10)
  })
  it('impactScope tiers: high→10, medium→6, low→3, none→0', () => {
    expect(scoreConflict({ ...base(), impactScope: 'high' }).breakdown.impactScope).toBe(10)
    expect(scoreConflict({ ...base(), impactScope: 'medium' }).breakdown.impactScope).toBe(6)
    expect(scoreConflict({ ...base(), impactScope: 'low' }).breakdown.impactScope).toBe(3)
    expect(scoreConflict({ ...base(), impactScope: 'none' }).breakdown.impactScope).toBe(0)
  })
  it('negatives: archived -25, recentlyResolved -25', () => {
    expect(scoreConflict({ ...base(), targetArchived: true }).breakdown.archived).toBe(-25)
    expect(scoreConflict({ ...base(), recentlyResolved: true }).breakdown.recentlyResolved).toBe(
      -25
    )
  })
})

describe('P2-19 combined score + band', () => {
  it('high band: correction+recent+evidence(both)+impact(high)+local = 75', () => {
    const r = scoreConflict({
      ...base(),
      correctionIntent: true,
      recentInjection: true,
      evidence: 'both',
      impactScope: 'high',
      localContradiction: true
    })
    expect(r.score).toBe(75)
    expect(r.band).toBe('high')
    expect(r.overridden).toBe(false)
  })

  it('normal band: same minus localContradiction = 65', () => {
    const r = scoreConflict({
      ...base(),
      correctionIntent: true,
      recentInjection: true,
      evidence: 'both',
      impactScope: 'high'
    })
    expect(r.score).toBe(65)
    expect(r.band).toBe('normal')
  })
})

describe('P2-19 safety overrides (any → none)', () => {
  it('detectionSource local → none even with high score', () => {
    const r = scoreConflict({
      ...base(),
      detectionSource: 'local',
      correctionIntent: true,
      recentInjection: true,
      ragScore: 0.9,
      evidence: 'both',
      impactScope: 'high'
    })
    expect(r.overridden).toBe(true)
    expect(r.band).toBe('none')
  })
  it('targetArchived → none', () => {
    const r = scoreConflict({
      ...base(),
      targetArchived: true,
      correctionIntent: true,
      recentInjection: true,
      ragScore: 0.9,
      evidence: 'both'
    })
    expect(r.overridden).toBe(true)
    expect(r.band).toBe('none')
  })
  it('evidence none → none', () => {
    const r = scoreConflict({
      ...base(),
      evidence: 'none',
      correctionIntent: true,
      recentInjection: true,
      ragScore: 0.9
    })
    expect(r.overridden).toBe(true)
    expect(r.band).toBe('none')
  })
  it('no override path proceeds to score-based band', () => {
    const r = scoreConflict({ ...base(), evidence: 'both', correctionIntent: true })
    expect(r.overridden).toBe(false)
  })
})
