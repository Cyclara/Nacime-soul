// src/shared/memory/gc-types.ts
// P3G：GC 保留策略与无正文报告 DTO。DMAE 只读 activation，GC 从不写 activation。

import type { MemoryType } from './types'

export interface GcPolicy {
  archiveToSoftDeleteDays: { one_off: number; situational: number; stable: null }
  softDeleteToPurgeDays: number
  recentAccessGraceDays: number
  anchorImportanceMin: number
  maxPurgePerRun: number
  schedule: { idleMinutes: number; minIntervalHours: number; eagerCountThreshold: number }
  monthlyDigest: boolean
  coldStorage: { enabled: boolean; dir: string }
}

export interface GcCandidate {
  memoryId: string
  action: 'soft_delete' | 'purge'
  reasons: readonly string[]
  ageDays: number
  lastAccessDays: number | null
}

export interface GcSkippedCounts {
  pinned: number
  anchor: number
  recentAccess: number
  typeStable: number
  quotaExceeded: number
}

export interface GcReport {
  ranAt: number
  dryRun: boolean
  scanned: number
  softDeleted: number
  purged: number
  skipped: GcSkippedCounts
  coldFile: string | null
  durationMs: number
}

export interface ColdRecord {
  id: string
  content: string
  type: MemoryType
  importance: number
  createdAt: number
  archivedAt: number | null
  purgedAt: number
  evidenceIds: readonly string[]
  sourceMessageIds: readonly string[]
}

export interface ColdIndexEntry {
  id: string
  year: number
  keywords: readonly string[]
  type: MemoryType
  purgedAt: number
}
