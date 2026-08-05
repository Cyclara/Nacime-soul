// src/main/memory/conflict/score.ts
// 冲突检测加分制纯函数（Cyrene-Agent 复用）。依据技术分析 §（冲突检测）+ S-Phase2 P2-19。
// 6 正信号 / 3 负信号 / 3 安全兜底（任一命中强制 none）。阈值 high≥75 / normal≥55 / idle≥35。
// 纯函数、无 IO；目标 100% branch 覆盖（S-004-补充 C-01）。

export type ConflictBand = 'high' | 'normal' | 'idle' | 'none'

export interface ConflictSignals {
  /** 用户明确纠正（+20） */
  correctionIntent: boolean
  /** RAG 检索相似度 [0,1]；null = 非 RAG 候选（+0）。≥0.75→25, ≥0.45→18, 其余→10 */
  ragScore: number | null
  /** 最近注入过（+20） */
  recentInjection: boolean
  /** 证据强度：both 双方都有→15, single 单方→8, none 无→0 */
  evidence: 'both' | 'single' | 'none'
  /** 词面矛盾（+10） */
  localContradiction: boolean
  /** 影响范围：high→10, medium→6, low→3, none→0 */
  impactScope: 'high' | 'medium' | 'low' | 'none'
  /** 目标记忆已归档（-25，且安全兜底） */
  targetArchived: boolean
  /** 最近刚解决过同一对冲突（-25） */
  recentlyResolved: boolean
  /** 检测来源：local 纯词法 / rag 检索。local = 安全兜底 */
  detectionSource: 'local' | 'rag'
}

export interface ConflictScore {
  score: number
  band: ConflictBand
  /** 逐信号贡献，供 conflict_log 审计 */
  breakdown: Record<string, number>
  /** 是否被安全兜底强制 none */
  overridden: boolean
}

export const CONFLICT_THRESHOLDS = { high: 75, normal: 55, idle: 35 } as const

function ragContribution(ragScore: number | null): number {
  if (ragScore === null) return 0
  if (ragScore >= 0.75) return 25
  if (ragScore >= 0.45) return 18
  return 10
}

function evidencePositive(evidence: ConflictSignals['evidence']): number {
  if (evidence === 'both') return 15
  if (evidence === 'single') return 8
  return 0
}

function impactContribution(impact: ConflictSignals['impactScope']): number {
  if (impact === 'high') return 10
  if (impact === 'medium') return 6
  if (impact === 'low') return 3
  return 0
}

/** 由分数与兜底标志派生冲突档位。单独导出以便边界（75/55/35）100% branch 测试。 */
export function deriveBand(score: number, overridden: boolean): ConflictBand {
  if (overridden) return 'none'
  if (score >= CONFLICT_THRESHOLDS.high) return 'high'
  if (score >= CONFLICT_THRESHOLDS.normal) return 'normal'
  if (score >= CONFLICT_THRESHOLDS.idle) return 'idle'
  return 'none'
}

/** 计算冲突分数与档位。安全兜底：本地检测 / 目标已归档 / 无证据，任一命中→none。 */
export function scoreConflict(s: ConflictSignals): ConflictScore {
  const breakdown: Record<string, number> = {
    correctionIntent: s.correctionIntent ? 20 : 0,
    ragCandidate: ragContribution(s.ragScore),
    recentInjection: s.recentInjection ? 20 : 0,
    evidence: evidencePositive(s.evidence),
    localContradiction: s.localContradiction ? 10 : 0,
    impactScope: impactContribution(s.impactScope),
    archived: s.targetArchived ? -25 : 0,
    noEvidence: s.evidence === 'none' ? -20 : 0,
    recentlyResolved: s.recentlyResolved ? -25 : 0
  }
  let score = 0
  for (const v of Object.values(breakdown)) score += v

  const overridden = s.detectionSource === 'local' || s.targetArchived || s.evidence === 'none'
  return { score, band: deriveBand(score, overridden), breakdown, overridden }
}
