// src/main/compliance/hook.ts
// turn.end 合规审计 hook（F5-001 §3.6 + 开工裁定 1.6；P3C1-06 落地）。
//
// 定位（F5-001 §「挂在哪里」裁定）：在线门控不是 hook（流循环内直接协作）；
// **离线审计才是 hook**——TURN_END、priority 350、failOpen: true，
// 落在 hooks/types.ts 注释「300+ = 可观测性/审计」分带内，排在 extraction(250)、dmae(300) 之后。
//
// 硬门（与 extraction hook 同一纪律）：
//   1. audit.enabled=false → 不得读取 SessionStore、不得调用 auditor，直接返回
//      （samples 批写在硬门之前执行——那是门控遥测，不走 SessionStore，不违反本门）
//   2. status!=='completed'（failed/cancelled）→ 不送审
//   3. hook 只装配输入 + 入队后立即返回，不 await 网络调用（消费者后台串行跑）
//
// 文本来源（任务表验收 + §3.6 集成点）：审计所需全文经
//   `SessionStore.getTurnMessages(sessionId, turnId)` 在 hook 时点装配——
//   **不扩展 TurnEndData 携带全文**（那会让全文在 hook 总线上传播）。
//   C1/C2 无真 block（裁定 1.6），被"拦"候选即放行文本，正常 SessionStore 即可审到正确对象；
//   C3 的 attempt 0 被拦文本走 BlockedCandidateReview 内存队列（C1/C2 不建，本文件不含）。
//
// would-block 必审（裁定 1.6）：TurnEndData.complianceRecords 中存在
//   wouldBlockUnderFirstSegmentPolicy=true 命中 → 无视采样率强制送审。
//   （records 由 P3C1-08 ChatService 装配；此前 hook 读到空数组，走纯采样。）
//
// gateOutcome 对齐：TurnEndData.complianceGate 字段由 P3C1-08 添加（F5-001 集成点
//   「门控结论 → TurnEndData.complianceGate → 审计 hook」）；本 hook 按该名可选读取。
//
// 结果投递：onAuditResult 由接线层（P3C1-08 setupCompliance）注入写库 sink；
//   unavailable 空壳同样投递（§3.11：audit_unavailable=1 也要入账，分母排除是统计侧的事）。
//   「provider 不可用 / 无 API key → 不注册审计 hook」是接线层决策，不在本模块。
//
// fail-open：hook 本身 failOpen:true；消费者内 auditor 合同不抛（unavailable 空壳），
//   sink 抛错只记元数据继续后续任务；stopConsumer 中止 in-flight 且结果不再投递（退出时不写）。

import type { Logger } from '@shared/observability/types'
import type { ComplianceAuditConfig } from '@shared/config/types'
import type { ChatMessage } from '@shared/chat/types'
import type { HookFn, HookResult } from '../hooks/types'
import type { TurnEndData } from '../chat/service'
import type { SessionStore } from '../chat/session-store'
import type { ComplianceDecisionRecord } from '@shared/compliance/types'
import type {
  ComplianceAuditor,
  ComplianceAuditInput,
  ComplianceAuditResult
} from './auditor'
import {
  createComplianceAuditQueue,
  type ComplianceAuditQueue,
  type ComplianceAuditTask
} from './audit-queue'
import { decideComplianceAudit } from './audit-decision'

/** 人设摘要上限（§3.6：≤400 字，从 identity + soul 层截取）。防御截断在 hook 侧。 */
const PERSONA_SUMMARY_MAX_CHARS = 400

export interface ComplianceAuditHookDeps {
  readonly logger: Logger
  readonly sessionStore: SessionStore
  readonly auditor: ComplianceAuditor
  /** 配置获取器；hook 每次检查 audit.enabled 与 sampleRate/recentTurnWindow（live config）。 */
  readonly getAuditConfig: () => Readonly<ComplianceAuditConfig>
  /** 人设摘要（identity + soul 层截取）；hook 侧防御截断到 400 字。抛错按空串降级。 */
  readonly getPersonaSummary: () => string
  /** L0 已知事实键名列表（只给键名不给值）；抛错按空列表降级。 */
  readonly getKnownFactKeys: () => readonly string[]
  /**
   * P3C1-08：门控遥测总开关（裁定 1.8：enabled=false / scope='off' 时全管线关闭）。
   * 缺省 true 保持 P3C1-06 单测与独立 hook 使用的原有语义；生产接线必须注入 live getter。
   */
  readonly shouldCollect?: () => boolean
  /** 队列（测试可注入）；默认新建容量 16 有界队列。 */
  /**
   * P3C1-08（裁定 1.4 #4：本 hook 第一步批写 samples）：
   * TurnEndData.complianceRecords -> compliance_samples + 快照态更新。
   * **先于一切硬门执行**——samples 是门控遥测（裁定 1.8：gate.enabled 才是遥测总开关，
   * audit.enabled=false 只关离线 LLM 轨道，不得丢 gate 数据）。gate 关闭时 records
   * 恒空，天然 no-op。合同永不抛（接线层内部吞错 warn）。
   */
  readonly writeSamples: (
    turnId: string,
    records: readonly ComplianceDecisionRecord[],
    occurredAt: number
  ) => void
  readonly queue?: ComplianceAuditQueue
  /** 结果 sink（P3C1-08 注入写库）；缺省丢弃结果（仅审计指标仍发）。 */
  readonly onAuditResult?: (
    task: ComplianceAuditTask,
    result: ComplianceAuditResult
  ) => void | Promise<void>
  /** 采样 RNG（测试注入）；默认 Math.random。 */
  readonly rng?: () => number
}

/**
 * 装配最近 N 轮对话（§3.6 recentTurns：user+assistant 成对，判 topic-jump/persona-drift 用）。
 * 只取 assistant 已 complete 的轮；排除当前 turn；按时间升序返回最后 window 轮。
 */
export function buildRecentTurns(
  messages: readonly ChatMessage[],
  currentTurnId: string,
  window: number
): { user: string; assistant: string }[] {
  const byTurn = new Map<string, { user?: ChatMessage; assistant?: ChatMessage }>()
  for (const m of messages) {
    if (m.turnId === undefined || m.turnId === currentTurnId) continue
    if (m.role !== 'user' && m.role !== 'assistant') continue
    let pair = byTurn.get(m.turnId)
    if (!pair) {
      pair = {}
      byTurn.set(m.turnId, pair)
    }
    if (m.role === 'user') pair.user = m
    else pair.assistant = m
  }
  const turns: { user: string; assistant: string }[] = []
  for (const pair of byTurn.values()) {
    if (!pair.user || !pair.assistant) continue
    if (pair.assistant.status !== 'complete') continue
    turns.push({ user: pair.user.content, assistant: pair.assistant.content })
  }
  return turns.slice(-window)
}

/**
 * 创建 turn.end 合规审计 hook。
 * 返回注册描述（name/event/priority/fn/failOpen）+ 队列与消费者控制（同 extraction hook 形状）。
 */
export function createComplianceAuditHook(deps: ComplianceAuditHookDeps): {
  hook: { name: string; event: string; priority: number; fn: HookFn; failOpen: true }
  queue: ComplianceAuditQueue
  /** 启动后台消费者（幂等）。 */
  startConsumer: () => void
  /** 停止消费者：不再处理新任务，中止 in-flight 审计且其结果不再投递。 */
  stopConsumer: () => void
  /**
   * 动态撤销采集：abort in-flight、清空待处理任务，但**不关闭**队列；
   * 用户随后重新启用 collection 时可自然恢复入队（裁定 1.8 的 revocation 语义）。
   */
  revokeCollection: () => void
  /** 测试辅助：等待消费者处理完当前队列后 resolve。生产中不调用。 */
  flush: () => Promise<void>
} {
  const { logger, sessionStore, auditor, getAuditConfig } = deps
  const queue = deps.queue ?? createComplianceAuditQueue({ logger })
  let consumerRunning = false
  let consumerStopRequested = false
  let currentRun: Promise<void> | null = null
  let inFlight: AbortController | null = null
  /** 每次动态撤销递增；撤销前已启动的任务即使 provider 忽略 abort 也不得投递。 */
  let collectionEpoch = 0

  /**
   * 裁定 1.8 live kill switch。getter 失败按 fail-open（不采集）处理：
   * 不因配置读取失败把既有全文再发到审计 provider。
   */
  function collectionEnabled(turnId?: string): boolean {
    try {
      return deps.shouldCollect?.() ?? true
    } catch (e) {
      try {
        logger.warn('compliance collection gate unavailable; skipping audit (fail-open)', {
          scope: 'compliance',
          ...(turnId !== undefined ? { turnId } : {}),
          tags: { reason: e instanceof Error ? e.name : 'unknown' }
        })
      } catch {
        /* logger 抛错不影响审计 */
      }
      return false
    }
  }

  async function processQueue(): Promise<void> {
    if (consumerRunning) return
    consumerRunning = true
    try {
      while (!consumerStopRequested && !queue.isClosed()) {
        const task = queue.dequeue()
        if (!task) break
        // 动态撤销边界①：队列里早于关闭动作入队的正文，不得再发给 provider。
        if (!collectionEnabled(task.turnId)) continue
        const taskEpoch = collectionEpoch
        const controller = new AbortController()
        inFlight = controller
        try {
          const result = await auditor.audit(task.input, controller.signal)
          // stopConsumer 中止的 in-flight：空壳结果不投递（退出时不写无意义行）。
          // 动态撤销边界②：关闭发生在 provider 返回期间时，丢弃结果，不更新 DB/快照。
          if (consumerStopRequested && controller.signal.aborted) break
          // epoch 防御：revoke 后即便 provider 无视 AbortSignal 并在后来重新启用前返回，
          // 该撤销前任务仍永久丢弃（不得把过期正文结果写回 DB/快照）。
          if (taskEpoch !== collectionEpoch) continue
          if (!collectionEnabled(task.turnId)) continue
          if (deps.onAuditResult) await deps.onAuditResult(task, result)
        } catch (e) {
          // 防御：auditor 合同不抛（unavailable 空壳）；sink 抛错只记元数据，继续后续任务
          try {
            logger.warn('compliance audit consumer failed for turn', {
              scope: 'compliance',
              turnId: task.turnId,
              metrics: { pending: queue.pending() },
              tags: { reason: e instanceof Error ? e.name : 'unknown' }
            })
          } catch {
            /* logger 抛错不影响消费者 */
          }
        } finally {
          inFlight = null
        }
      }
    } finally {
      consumerRunning = false
    }
  }

  function startConsumer(): void {
    consumerStopRequested = false
    if (!currentRun) {
      currentRun = processQueue().finally(() => {
        currentRun = null
      })
    }
  }

  function stopConsumer(): void {
    consumerStopRequested = true
    queue.close()
    inFlight?.abort()
  }

  function revokeCollection(): void {
    // 不置 consumerStopRequested、不 close：重新开启开关后新的任务可正常被消费。
    // epoch 使已在飞的任务即使 provider 无视 abort 也不能再投递。
    collectionEpoch++
    queue.clearPending()
    inFlight?.abort()
  }

  /** 等待消费者处理完当前队列（含后台运行中的任务）后 resolve。测试用。 */
  async function flush(): Promise<void> {
    for (;;) {
      startConsumer()
      const run = currentRun
      if (run) await run
      if (queue.pending() === 0) break
    }
  }

  function safePersonaSummary(): string {
    try {
      return deps.getPersonaSummary().slice(0, PERSONA_SUMMARY_MAX_CHARS)
    } catch (e) {
      try {
        logger.warn('compliance audit: personaSummary unavailable; auditing with empty summary', {
          scope: 'compliance',
          tags: { reason: e instanceof Error ? e.name : 'unknown' }
        })
      } catch {
        /* logger 抛错不影响 hook */
      }
      return ''
    }
  }

  function safeKnownFactKeys(): readonly string[] {
    try {
      return deps.getKnownFactKeys()
    } catch (e) {
      try {
        logger.warn('compliance audit: knownFactKeys unavailable; auditing with empty keys', {
          scope: 'compliance',
          tags: { reason: e instanceof Error ? e.name : 'unknown' }
        })
      } catch {
        /* logger 抛错不影响 hook */
      }
      return []
    }
  }

  const hookFn: HookFn = (_ctx, data): HookResult => {
    const turnEnd = data as TurnEndData

    // 裁定 1.8：总开关先于 samples 第一步。关闭时不读正文/不入队/不写任何合规数据。
    if (!collectionEnabled(turnEnd.turnId)) return { data }

    // P3C1-08（裁定 1.4 #4）：第一步批写 samples——先于 audit/status 硬门（见 deps.writeSamples 注释）。
    // writeSamples 合同永不抛；此 try 为防御性双保险（本 hook failOpen）。
    const records = turnEnd.complianceRecords ?? []
    if (records.length > 0) {
      try {
        deps.writeSamples(turnEnd.turnId, records, Date.now())
      } catch (e) {
        try {
          logger.warn('compliance samples write failed (defensive catch)', {
            scope: 'compliance',
            turnId: turnEnd.turnId,
            tags: { reason: e instanceof Error ? e.name : 'unknown' }
          })
        } catch {
          /* logger 抛错不影响 hook */
        }
      }
    }

    const config = getAuditConfig()

    // 硬门 1：audit.enabled=false → 全旁路（不读 SessionStore、不调 auditor）
    if (!config.enabled) return { data }

    // 硬门 2：turn 未正常完成（failed/cancelled）→ 不送审
    if (turnEnd.status !== 'completed') return { data }

    // would-block 必审（裁定 1.6）：records 由 P3C1-08 ChatService 装配；空数组走纯采样
    const wouldBlockHit = records.some((r) => r.wouldBlockUnderFirstSegmentPolicy)

    const decision = decideComplianceAudit({
      enabled: config.enabled,
      sampleRate: config.sampleRate,
      wouldBlockHit,
      rng: deps.rng
    })
    if (!decision.audit) return { data }

    // 文本来自正常 SessionStore（不扩展 TurnEndData 携带全文）
    const pair = sessionStore.getTurnMessages(turnEnd.sessionId, turnEnd.turnId)
    if (!pair) {
      try {
        logger.debug('compliance audit hook: turn messages not found', {
          scope: 'compliance',
          turnId: turnEnd.turnId
        })
      } catch {
        /* logger 抛错不影响 hook */
      }
      return { data }
    }
    if (pair.assistant.content.length === 0) return { data } // 空回复无可审对象

    const input: ComplianceAuditInput = {
      turnId: turnEnd.turnId,
      sessionId: turnEnd.sessionId,
      personaSummary: safePersonaSummary(),
      recentTurns: buildRecentTurns(
        sessionStore.getMessages(turnEnd.sessionId, (config.recentTurnWindow + 1) * 2),
        turnEnd.turnId,
        config.recentTurnWindow
      ),
      userText: pair.user.content,
      candidateText: pair.assistant.content,
      gateOutcome: turnEnd.complianceGate,
      knownFactKeys: safeKnownFactKeys()
    }

    const enqueued = queue.enqueue({
      turnId: turnEnd.turnId,
      sessionId: turnEnd.sessionId,
      input,
      reason: decision.reason
    })
    if (enqueued) {
      startConsumer()
    }

    return { data }
  }

  return {
    hook: {
      name: 'compliance-audit',
      event: 'turn.end',
      priority: 350, // F5-001：300+ 可观测性/审计分带，extraction(250)、dmae(300) 之后
      fn: hookFn,
      failOpen: true
    },
    queue,
    startConsumer,
    stopConsumer,
    revokeCollection,
    flush
  }
}
