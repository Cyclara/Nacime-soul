// src/main/compliance/audit-decision.ts
// 送审决策（F5-001 §3.6 + 开工裁定 1.6；P3C1-06 落地）。
//
// C1 送审规则（裁定 line 195 收束）：
//   1. 背景采样：auditSampleRate（默认 0.25）随机采样。
//   2. would-block 命中轮必审（裁定 1.6：§3.6「blocked 轮必审」在 C1/C2 的重解读——
//      `wouldBlockUnderFirstSegmentPolicy=true` 命中的轮**无视采样率**强制送审；
//      这是 C1 估计规则精度的核心数据源）。
//   3. dislike 轮必审（§3.7 补审）——不走本函数：用户反馈是 turn 结束后的异步动作，
//      由 P3C1-07 feedback 通路直接以 reason='dislike' 入队。
//
// 显式不实现（裁定留待 C1 调优后定）：S-C09「候选规则前 N 次命中强制审计」的 N 与自适应
//   细节——本函数是未来的自然落点，届时叠加在 would-block 规则之上。

export type ComplianceAuditSampledReason = 'sampled' | 'would-block'

export type ComplianceAuditDecision =
  | { readonly audit: true; readonly reason: ComplianceAuditSampledReason }
  | { readonly audit: false }

export interface DecideComplianceAuditOptions {
  /** persona.compliance.audit.enabled。false 一律不送审（hard gate）。 */
  readonly enabled: boolean
  /** persona.compliance.audit.sampleRate（0..1；防御性 clamp）。 */
  readonly sampleRate: number
  /** 本轮 TurnEndData.complianceRecords 中是否存在 wouldBlockUnderFirstSegmentPolicy=true 命中。 */
  readonly wouldBlockHit: boolean
  /** 注入以便测试；默认 Math.random。 */
  readonly rng?: () => number
}

/**
 * 判定本轮是否送离线审计。纯函数。
 * 优先级：enabled hard gate → would-block 必审（无视采样率）→ 采样。
 */
export function decideComplianceAudit(opts: DecideComplianceAuditOptions): ComplianceAuditDecision {
  if (!opts.enabled) return { audit: false }
  // 裁定 1.6：would-block 命中轮无视采样率强制送审
  if (opts.wouldBlockHit) return { audit: true, reason: 'would-block' }
  const rate = Math.min(1, Math.max(0, opts.sampleRate))
  const rng = opts.rng ?? Math.random
  if (rng() < rate) return { audit: true, reason: 'sampled' }
  return { audit: false }
}
