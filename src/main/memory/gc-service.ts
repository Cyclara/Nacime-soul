// src/main/memory/gc-service.ts
// P3G-03..06：GC 管保留权；DMAE 不改 lifecycle，GC 不改 activation。

import type { Logger } from '@shared/observability/types'
import type { GcCandidate, GcPolicy, GcReport } from '@shared/memory/gc-types'
import type { L2Memory, L2Store } from './l2-store'
import type { VectorStore } from './vector/types'
import type { MemoryRevisionClock } from './revision-clock'
import type { MemoryEventBroadcaster } from './event-broadcaster'
import type { ColdStore } from './cold-store'
import { scanGcCandidates, type GcScanResult } from './gc-policy'

export interface GcService {
  scan(): GcScanResult
  run(options?: { dryRun?: boolean }): GcReport
  listRecycleBin(limit: number, offset: number): { items: readonly L2Memory[]; total: number }
  restore(memoryId: string): boolean
  emptyRecycleBin(): number
}

export function createGcService(options: {
  readonly l2Store: L2Store
  readonly vectorStore: VectorStore
  readonly revisionClock: MemoryRevisionClock
  readonly broadcaster: MemoryEventBroadcaster
  readonly coldStore: ColdStore
  readonly db?: import('better-sqlite3').Database
  readonly getPolicy: () => GcPolicy
  readonly logger: Logger
  readonly now?: () => number
}): GcService {
  const now = options.now ?? Date.now

  const visible = (): L2Memory[] => options.l2Store.list({ lifecycleState: ['archived', 'soft_deleted'] })
  const scan = (): GcScanResult => scanGcCandidates(visible(), options.getPolicy(), now())

  const persistReport = (report: GcReport): void => {
    try {
      options.db?.prepare(`INSERT OR REPLACE INTO gc_log (ran_at, report) VALUES (?, ?)`).run(report.ranAt, JSON.stringify(report))
    } catch {
      // 报告写入失败不回滚已经安全完成的保守 GC 批次。
    }
  }

  const updateSoftDeleted = (candidate: GcCandidate): boolean => {
    const memory = options.l2Store.get(candidate.memoryId)
    if (memory === null || memory.lifecycleState !== 'archived') return false
    options.l2Store.update(memory.id, { lifecycleState: 'soft_deleted', softDeletedAt: now() })
    return true
  }

  const purge = (candidates: readonly GcCandidate[], policy: GcPolicy): { count: number; coldFile: string | null; quotaExceeded: number } => {
    const permitted = candidates.slice(0, policy.maxPurgePerRun)
    const records = permitted
      .map((candidate) => options.l2Store.get(candidate.memoryId))
      .filter((memory): memory is L2Memory => memory !== null && memory.lifecycleState === 'soft_deleted')
      .map((memory) => ({
        id: memory.id,
        content: memory.content,
        type: memory.type,
        importance: memory.importance,
        createdAt: parseCreatedAt(memory.id),
        archivedAt: memory.archivedAt,
        purgedAt: now(),
        evidenceIds: memory.evidenceIds,
        sourceMessageIds: memory.sourceMessageIds
      }))
    if (records.length === 0) return { count: 0, coldFile: null, quotaExceeded: Math.max(0, candidates.length - permitted.length) }
    if (!policy.coldStorage.enabled) return { count: 0, coldFile: null, quotaExceeded: candidates.length }
    // 磁盘满/冷目录不可写时整段跳过 purge；soft-delete 段已完成的结果保留。
    let coldFile: string | null = null
    try {
      coldFile = options.coldStore.append(records)
    } catch {
      coldFile = null
    }
    if (coldFile === null) {
      options.logger.warn('memory GC skipped purge: cold storage write failed', {
        scope: 'memory',
        code: 'MEM_WRITE_FAIL',
        metrics: { deferred: records.length }
      })
      return { count: 0, coldFile: null, quotaExceeded: candidates.length }
    }
    for (const record of records) {
      // 顺序铁律：cold append+fsync 已成功，才允许删除热区和向量。
      options.l2Store.remove(record.id)
      options.vectorStore.remove(record.id)
    }
    return { count: records.length, coldFile, quotaExceeded: Math.max(0, candidates.length - permitted.length) }
  }

  return {
    scan,
    run(input = {}) {
      const startedAt = now()
      const policy = options.getPolicy()
      const scanned = visible().length
      const result = scan()
      const softCandidates = result.candidates.filter((candidate) => candidate.action === 'soft_delete')
      const purgeCandidates = result.candidates.filter((candidate) => candidate.action === 'purge')
      if (input.dryRun) {
        const report = { ranAt: startedAt, dryRun: true, scanned, softDeleted: 0, purged: 0, skipped: result.skipped, coldFile: null, durationMs: Math.max(0, now() - startedAt) }
        persistReport(report)
        return report
      }
      let softDeleted = 0
      for (const candidate of softCandidates) if (updateSoftDeleted(candidate)) softDeleted++
      const purged = purge(purgeCandidates, policy)
      const changed = softDeleted + purged.count
      if (changed > 0) {
        options.revisionClock.next()
        options.broadcaster.notify('l2')
      }
      const report: GcReport = {
        ranAt: startedAt,
        dryRun: false,
        scanned,
        softDeleted,
        purged: purged.count,
        skipped: { ...result.skipped, quotaExceeded: result.skipped.quotaExceeded + purged.quotaExceeded },
        coldFile: purged.coldFile,
        durationMs: Math.max(0, now() - startedAt)
      }
      persistReport(report)
      options.logger.info('memory GC run completed', { scope: 'memory', metrics: { scanned: report.scanned, softDeleted, purged: report.purged } })
      return report
    },
    listRecycleBin(limit, offset) {
      const total = options.l2Store.count({ lifecycleState: 'soft_deleted' })
      return { items: options.l2Store.list({ lifecycleState: 'soft_deleted', limit, offset }), total }
    },
    restore(memoryId) {
      const memory = options.l2Store.get(memoryId)
      if (memory === null || memory.lifecycleState !== 'soft_deleted') return false
      options.l2Store.update(memoryId, { lifecycleState: 'archived', softDeletedAt: null })
      options.revisionClock.next()
      options.broadcaster.notify('l2')
      return true
    },
    emptyRecycleBin() {
      const policy = options.getPolicy()
      const candidates = options.l2Store.list({ lifecycleState: 'soft_deleted' }).map((memory) => ({
        memoryId: memory.id,
        action: 'purge' as const,
        reasons: ['user-confirmed-recycle-bin-empty'],
        ageDays: 0,
        lastAccessDays: null
      }))
      const result = purge(candidates, { ...policy, maxPurgePerRun: policy.maxPurgePerRun })
      if (result.count > 0) {
        options.revisionClock.next()
        options.broadcaster.notify('l2')
      }
      return result.count
    }
  }
}

function parseCreatedAt(id: string): number {
  const match = /^l2_(\d+)_/.exec(id)
  const value = match === null ? 0 : Number(match[1])
  return Number.isFinite(value) ? value : 0
}
