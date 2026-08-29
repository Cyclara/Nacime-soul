// src/main/compliance/audit-decision.test.ts
// P3C1-06：送审决策——enabled 硬门 / would-block 必审（裁定 1.6，无视采样率）/ 采样边界。

import { describe, it, expect } from 'vitest'
import { decideComplianceAudit } from './audit-decision'

describe('P3C1-06 audit-decision：送审决策', () => {
  it('enabled=false → 不送审（即使 would-block 命中）', () => {
    expect(
      decideComplianceAudit({ enabled: false, sampleRate: 1, wouldBlockHit: true, rng: () => 0 })
    ).toEqual({ audit: false })
  })

  it('would-block 命中 → 无视采样率强制送审（裁定 1.6；sampleRate=0 也送）', () => {
    expect(
      decideComplianceAudit({ enabled: true, sampleRate: 0, wouldBlockHit: true, rng: () => 0.999 })
    ).toEqual({ audit: true, reason: 'would-block' })
  })

  it('would-block 优先于采样原因（rate=1 时 reason 仍是 would-block）', () => {
    expect(
      decideComplianceAudit({ enabled: true, sampleRate: 1, wouldBlockHit: true, rng: () => 0 })
    ).toEqual({ audit: true, reason: 'would-block' })
  })

  it('sampleRate=1 恒采样送审', () => {
    expect(
      decideComplianceAudit({
        enabled: true,
        sampleRate: 1,
        wouldBlockHit: false,
        rng: () => 0.999
      })
    ).toEqual({ audit: true, reason: 'sampled' })
  })

  it('sampleRate=0 且无 would-block → 不送审', () => {
    expect(
      decideComplianceAudit({ enabled: true, sampleRate: 0, wouldBlockHit: false, rng: () => 0 })
    ).toEqual({ audit: false })
  })

  it('rng 注入决定边界两侧：0.1 < 0.25 送审；0.3 >= 0.25 不送', () => {
    const base = { enabled: true, sampleRate: 0.25, wouldBlockHit: false }
    expect(decideComplianceAudit({ ...base, rng: () => 0.1 })).toEqual({
      audit: true,
      reason: 'sampled'
    })
    expect(decideComplianceAudit({ ...base, rng: () => 0.3 })).toEqual({ audit: false })
  })

  it('rng() 恰好等于 rate → 不送审（严格小于）', () => {
    expect(
      decideComplianceAudit({
        enabled: true,
        sampleRate: 0.25,
        wouldBlockHit: false,
        rng: () => 0.25
      })
    ).toEqual({ audit: false })
  })

  it('sampleRate 越界防御 clamp：>1 按 1、<0 按 0', () => {
    expect(
      decideComplianceAudit({
        enabled: true,
        sampleRate: 1.5,
        wouldBlockHit: false,
        rng: () => 0.999
      })
    ).toEqual({ audit: true, reason: 'sampled' })
    expect(
      decideComplianceAudit({ enabled: true, sampleRate: -0.5, wouldBlockHit: false, rng: () => 0 })
    ).toEqual({ audit: false })
  })
})
