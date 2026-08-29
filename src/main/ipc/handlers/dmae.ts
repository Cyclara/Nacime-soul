// src/main/ipc/handlers/dmae.ts
// P2-32/34：DMAE 面板 IPC handler（5 invoke：get-panel/get-trend/explain/run-benchmark/record-qualitative）。
// 依据：F5-002 §3.7（6 通道中 P2-32 先实现 get-panel/get-trend/explain）、S-003-补充 §3.7。
//
// 边界条件：
//   - memory.enabled=false 或 dmae.enabled=false -> 返回 disabled 信封（不抛错，面板显示引导态）
//   - explain 的 memoryId 不存在 -> 返回 null（面板显示"该记忆暂无分解数据"）
//   - get-dmae-history 的真实实现由 diagnostics 服务提供（替换 memory.ts:213 的空返回 stub）
//
// 安全红线：
//   - handler 不直接 new Database 或访问 dmae-state.json——一律经 DmaeDiagnosticsService
//   - contentPreview 是唯一允许携带记忆内容的字段（≤60 字符，仅走 IPC 到本地渲染）

import type { Logger } from '@shared/observability/types'
import type { DmaeDiagnosticsService } from '../../memory/dmae/diagnostics'
import { registerValidatedHandler } from '../register'
import type { MemoryConfig } from '@shared/config/types'
import type {
  DmaePanelRequest,
  DmaeTrendRequest,
  DmaeExplainRequest,
  DmaeBenchmarkRequest,
  DmaeQualitativeRequest
} from '@shared/memory/types'
import type { DmaePanelSnapshot, DmaeTurnExplanation } from '../../memory/dmae/diagnostics'
import type { DmaeDailyAggregate } from '../../memory/dmae/history-types'
import type { DmaeBenchmarkReport } from '../../memory/dmae/benchmark-types'
import { AppError } from '@shared/errors'

export interface DmaeHandlerDeps {
  logger: Logger
  /** null = memory.enabled=false 或 dmae.enabled=false（setup 未创建诊断服务） */
  diagnostics: DmaeDiagnosticsService | null
  getMemoryConfig: () => Readonly<MemoryConfig>
  /** M-26：写异常静音配置用 */
  configStore: {
    update(
      patch: { memory: { dmae: { anomaly: { muted: Record<string, number> } } } },
      opts?: { immediate?: boolean }
    ): Promise<unknown>
  }
}

/**
 * 注册 DMAE 面板 IPC handler（3 invoke）。
 * 在 main/index.ts 中调用，需在 configureIpcGuard 之后。
 */
export function registerDmaeHandlers(deps: DmaeHandlerDeps): void {
  const { logger, diagnostics, getMemoryConfig } = deps

  function disabled(): boolean {
    const cfg = getMemoryConfig()
    return diagnostics === null || !cfg.enabled || !cfg.dmae.enabled
  }

  // === companion:dmae:get-panel ===
  registerValidatedHandler(
    'companion:dmae:get-panel',
    async (_ctx, input): Promise<DmaePanelSnapshot> => {
      if (disabled()) {
        // disabled 时返回 enabled=false 的空快照（面板显示引导态）
        return {
          enabled: false,
          params: {
            maxScore: 100,
            promptThreshold: 30,
            userRewardBase: 20,
            wakeGamma: 0.5,
            modelRewardBase: 8,
            wakeLambda: 0.3,
            decayAlpha: 1.5,
            decayBeta: 0.3
          },
          maxActive: 15,
          currentTurn: 0,
          counts: { eligibleActive: 0, dormant: 0, archived: 0, l2Total: 0 },
          selection: {
            eligibleActiveCount: 0,
            lastRetrievalHits: 0,
            lastPromptSelectedCount: 0,
            lastPromptIncludedCount: null,
            lastPromptTrimmedCount: null,
            lastPromptSelectedIds: [],
            maxActive: 15
          },
          activeSet: [],
          nextEligibleCursor: null,
          activeSetPaginated: false,
          eligibleCursorReset: false,
          anomalies: [],
          lastBenchmark: null,
          lastQualitative: null,
          stateFile: {
            path: '',
            entries: 0,
            lastSaveOk: true,
            lastSaveAt: null,
            lastLoadReset: 'none',
            saveFailures7d: 0
          }
        }
      }
      return diagnostics!.getPanelSnapshot((input ?? {}) as DmaePanelRequest)
    }
  )

  // === companion:dmae:get-trend ===
  registerValidatedHandler(
    'companion:dmae:get-trend',
    async (_ctx, input): Promise<readonly DmaeDailyAggregate[]> => {
      if (disabled()) return []
      const days = (input as DmaeTrendRequest).days
      return diagnostics!.getDailyTrend(days)
    }
  )

  // === companion:dmae:explain ===
  registerValidatedHandler(
    'companion:dmae:explain',
    async (_ctx, input): Promise<DmaeTurnExplanation | null> => {
      if (disabled()) {
        throw new AppError({
          code: 'MEM_DISABLED',
          userMessage: '记忆功能未开启',
          severity: 'error',
          retryable: false
        })
      }
      const memoryId = (input as DmaeExplainRequest).memoryId
      return diagnostics!.explainLastTurn(memoryId)
    }
  )

  // === companion:dmae:run-benchmark（P2-34：参数体检 M1~M6）===
  registerValidatedHandler(
    'companion:dmae:run-benchmark',
    async (_ctx, input): Promise<DmaeBenchmarkReport> => {
      if (disabled()) {
        throw new AppError({
          code: 'MEM_DISABLED',
          userMessage: '记忆功能未开启',
          severity: 'error',
          retryable: false
        })
      }
      const windowDays = (input as DmaeBenchmarkRequest).windowDays
      return diagnostics!.runBenchmark(windowDays)
    }
  )

  // === companion:dmae:record-qualitative（P2-34：Q1~Q3 定性评分）===
  // 写操作：disabled 时返回 MEM_DISABLED，避免用户提交的评分被静默吞掉却 UI 以为成功（S-022 §3.3）。
  registerValidatedHandler(
    'companion:dmae:record-qualitative',
    async (_ctx, input): Promise<void> => {
      if (disabled()) {
        throw new AppError({
          code: 'MEM_DISABLED',
          userMessage: '记忆功能未开启',
          severity: 'error',
          retryable: false
        })
      }
      const { q1, q2, q3, note } = input as DmaeQualitativeRequest
      diagnostics!.recordQualitative({ q1, q2, q3, note, ts: Date.now() })
    }
  )

  // === companion:dmae:mute-anomaly（M-26：F5-002 §3.7 第 6 通道，S-005-补充 §1.7） ===
  // 静音某条异常规则 N 天：把"绝对解除时间戳"写入 config.memory.dmae.anomaly.muted[ruleId]。
  // 此前 muted 只有配置变更时被清零的路径、没有用户写入口，"忽略 7 天"功能形同虚设。
  registerValidatedHandler('companion:dmae:mute-anomaly', async (_ctx, input): Promise<void> => {
    if (disabled()) {
      throw new AppError({
        code: 'MEM_DISABLED',
        userMessage: '记忆功能未开启',
        severity: 'error',
        retryable: false
      })
    }
    const { ruleId, days } = input as import('@shared/memory/types').DmaeMuteRequest
    const muted = getMemoryConfig().dmae.anomaly.muted
    const nextMuted = { ...muted, [ruleId]: Date.now() + days * 24 * 3600 * 1000 }
    await deps.configStore.update(
      { memory: { dmae: { anomaly: { muted: nextMuted } } } },
      { immediate: true }
    )
    logger.info('dmae anomaly muted', {
      scope: 'dmae-ipc',
      tags: { ruleId, days: String(days) }
    })
  })

  logger.debug('dmae handlers registered', { scope: 'ipc' })
}
