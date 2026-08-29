// src/main/ipc/handlers/compliance.ts
// P3C1-08: Compliance IPC handler（F5-001 §3.10）
//
// 通道：
//   companion:compliance:get-snapshot -> deps.getSnapshot（调试面板快照，聚合量无正文）
//
// 红线（F5-001 §3.10「审查不可见」原则）：
//   - 合规只有一个 invoke 通道（快照拉取），**没有 event 通道**--
//     不存在任何需要主动推给渲染进程的审查状态。
//   - 快照只含聚合量（ruleHits/ring/派生率），日志不记任何正文。

import type { Logger } from '@shared/observability/types'
import type { ComplianceSnapshot } from '@shared/compliance/types'
import { registerValidatedHandler } from '../register'

/** Compliance handler 依赖 */
export interface ComplianceHandlerDeps {
  /** setupCompliance 返回的快照数据源（内存态现算）。 */
  getSnapshot: () => ComplianceSnapshot
  logger: Logger
}

/**
 * IPC 最后一层白名单投影。TypeScript 类型不能删除运行时多余键；审计模型的自由文本
 * 必须视为不可信，因此即使上游 future regression 给 snapshot/ring 偷塞 rationale/content，
 * 此处也绝不把它跨进程交给 renderer。
 */
function projectPublicSnapshot(snapshot: ComplianceSnapshot): ComplianceSnapshot {
  return {
    gateEnabled: snapshot.gateEnabled,
    gateScope: snapshot.gateScope,
    ruleHits: { ...snapshot.ruleHits },
    rejectedRules: snapshot.rejectedRules.map((r) => ({ id: r.id, reason: r.reason })),
    recentViolations: snapshot.recentViolations.map((v) => ({
      turnId: v.turnId,
      type: v.type,
      severity: v.severity,
      detectionMethod: v.detectionMethod,
      ...(v.ruleId !== undefined ? { ruleId: v.ruleId } : {})
    })),
    approxFalsePositiveRate: snapshot.approxFalsePositiveRate,
    approxEscapeRate: snapshot.approxEscapeRate
  }
}

/**
 * 注册合规 IPC handler。在 main/index.ts 中调用（registerComplianceHandlers），
 * 需在 configureIpcGuard 之后。
 */
export function registerComplianceHandlers(deps: ComplianceHandlerDeps): void {
  const complianceLogger = deps.logger.child('compliance-ipc')

  // === companion:compliance:get-snapshot ===
  // 只读查询；快照结构在 shared 类型上冻结（聚合量，无正文）。
  registerValidatedHandler('companion:compliance:get-snapshot', async () => {
    const snapshot = projectPublicSnapshot(deps.getSnapshot())
    complianceLogger.debug('compliance snapshot served', {
      scope: 'compliance',
      metrics: {
        gateEnabled: snapshot.gateEnabled ? 1 : 0,
        ruleHitTotal: Object.keys(snapshot.ruleHits).length,
        recentViolations: snapshot.recentViolations.length
      }
    })
    return snapshot
  })

  complianceLogger.debug('compliance handlers registered', { scope: 'ipc' })
}
