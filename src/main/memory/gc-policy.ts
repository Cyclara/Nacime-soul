// src/main/memory/gc-policy.ts
// P3G-02/03：GC 候选判定必须是纯函数；DMAE activation 不参与写入，只作为外层快照事实。

import type { GcCandidate, GcPolicy, GcSkippedCounts } from '@shared/memory/gc-types'
import type { L2Memory } from './l2-store'

export const DEFAULT_GC_POLICY: GcPolicy = {
  archiveToSoftDeleteDays: { one_off: 30, situational: 60, stable: null },
  softDeleteToPurgeDays: 90,
  recentAccessGraceDays: 90,
  anchorImportanceMin: 8,
  maxPurgePerRun: 500,
  schedule: { idleMinutes: 5, minIntervalHours: 20, eagerCountThreshold: 5000 },
  monthlyDigest: false,
  coldStorage: { enabled: true, dir: 'data/cold' }
}

export interface GcScanResult {
  candidates: readonly GcCandidate[]
  skipped: GcSkippedCounts
}

function ageDays(now: number, then: number | null | undefined): number {
  if (then === null || then === undefined) return 0
  return Math.floor(Math.max(0, now - then) / (24 * 60 * 60 * 1000))
}

export function scanGcCandidates(
  memories: readonly L2Memory[],
  policy: GcPolicy,
  now: number
): GcScanResult {
  const candidates: GcCandidate[] = []
  const skipped: GcSkippedCounts = { pinned: 0, anchor: 0, recentAccess: 0, typeStable: 0, quotaExceeded: 0 }

  for (const memory of memories) {
    if (memory.lifecycleState === 'soft_deleted') {
      const days = ageDays(now, memory.softDeletedAt ?? memory.archivedAt)
      if (days >= policy.softDeleteToPurgeDays) {
        candidates.push({ memoryId: memory.id, action: 'purge', reasons: ['soft-delete-retention-expired'], ageDays: days, lastAccessDays: memory.lastAccessedAt === null || memory.lastAccessedAt === undefined ? null : ageDays(now, memory.lastAccessedAt) })
      }
      continue
    }
    if (memory.lifecycleState !== 'archived') continue
    if (memory.isPinned) {
      skipped.pinned++
      continue
    }
    if (memory.importance >= policy.anchorImportanceMin || memory.source === 'creator') {
      skipped.anchor++
      continue
    }
    const retention = policy.archiveToSoftDeleteDays[memory.type]
    if (retention === null) {
      skipped.typeStable++
      continue
    }
    const accessDays = memory.lastAccessedAt === null || memory.lastAccessedAt === undefined ? null : ageDays(now, memory.lastAccessedAt)
    if (accessDays !== null && accessDays < policy.recentAccessGraceDays) {
      skipped.recentAccess++
      continue
    }
    const archivedDays = ageDays(now, memory.archivedAt)
    if (memory.archivedAt !== null && archivedDays >= retention) {
      candidates.push({ memoryId: memory.id, action: 'soft_delete', reasons: ['archived-retention-expired'], ageDays: archivedDays, lastAccessDays: accessDays })
    }
  }

  return { candidates, skipped }
}
