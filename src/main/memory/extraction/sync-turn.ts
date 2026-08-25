// src/main/memory/extraction/sync-turn.ts
// P2-38 sync_turn 轻量提取 + P2-39 批量终审策略。依据 S-020 §1.5、S-Phase2 P2-38/P2-39。
//
// P2-38：每轮 turn.end 便宜模型调用（低 maxTokens、temperature 低），产出候选事实，
//        与 P2-10 管线共用同一 schema/parser/queue。复用 ExtractionService（fail-silent、
//        64KiB 上限、日志白名单），仅替换请求画像为便宜预算。失败静默不影响聊天。
//        与 P2-10 不注册两个重复 extractor：P2-10 交付能力与测试用 hook，生产 wiring
//        由 P2-38 切到每轮便宜模型。
//
// P2-39：sync_turn 产候选入队 -> MemoryJudge 终审（每 6 轮或队列阈值触发）、
//        去重（同事实候选合并 confidence 取高）。单消费者 FIFO，排序 (enqueueSequence,
//        candidateId)。阈值常量 JUDGE_QUEUE_THRESHOLD=12（S-020 §1.5 钉死，不得留给实现者猜）。

import type { LlmMessage } from '../../llm/types'
import type { Logger } from '@shared/observability/types'
import { CANDIDATE_ENVELOPE_SCHEMA } from './candidate'
import type { ExtractionProvider, ExtractionRequest } from './provider'
import {
  createExtractionService,
  type ExtractionService,
  type ExtractionServiceDeps
} from './service'
import type { JudgeDecision } from './judge'

/** P2-38：sync_turn 便宜请求画像。P2-10 默认 maxOutputTokens=800，此处取半价预算。 */
export const SYNC_TURN_MAX_OUTPUT_TOKENS = 400
/** P2-38：sync_turn 超时（便宜模型更快，无需 P2-10 的 30s）。 */
export const SYNC_TURN_TIMEOUT_MS = 20_000

/** P2-39：累计 N 个 eligible turn 触发一次 MemoryJudge 终审（S-020 §1.5「每 6 轮」）。 */
export const SYNC_TURN_JUDGE_EVERY_TURNS = 6
/** P2-39：队列候选数达到该阈值即触发终审（S-020 §1.5 钉死）。 */
export const JUDGE_QUEUE_THRESHOLD = 12

/** 构建 sync_turn 便宜请求。temperature=0（确定性），低 maxOutputTokens，短超时。 */
export function buildSyncTurnRequest(messages: readonly LlmMessage[]): ExtractionRequest {
  return {
    messages,
    temperature: 0,
    maxOutputTokens: SYNC_TURN_MAX_OUTPUT_TOKENS,
    jsonSchema: CANDIDATE_ENVELOPE_SCHEMA as unknown as object,
    timeoutMs: SYNC_TURN_TIMEOUT_MS
  }
}

/**
 * 创建 sync_turn 提取器。
 * 复用 P2-10 ExtractionService（解析/截断恢复/日志白名单/空失败），
 * 仅用便宜请求画像替换默认画像。返回类型仍是 ExtractionService，
 * hook 无需区分它是哪个 extractor。
 */
export function createSyncTurnExtractor(deps: {
  provider: ExtractionProvider
  logger: Logger
  now?: ExtractionServiceDeps['now']
}): ExtractionService {
  return createExtractionService({
    provider: deps.provider,
    logger: deps.logger,
    now: deps.now,
    buildRequest: buildSyncTurnRequest
  })
}

/**
 * P2-39 跨轮去重：同事实（targetLayer|field|NFC(trim content)）候选合并 confidence 取高。
 *
 * 与 judgeBatch 的同批次去重互补：
 *   - judgeBatch 只去重单次调用内的候选（同一轮）
 *   - 本函数去重跨轮/跨组累积的候选（P2-39「同事实候选合并 confidence 取高」）
 *     ——L2 的 extractionKey 含 sourceMessageId，跨轮同事实会得到不同 key，必须在此合并。
 *
 * 被合并者标记为 DUPLICATE_CANDIDATE（reject），保持相对顺序（enqueueSequence, candidateId）。
 * 输入输出 1:1（每条输入恰好产生一条决策，reject 原样透传），调用方可按原组长度切回。
 */
export function dedupeDecisionsForDrain(decisions: readonly JudgeDecision[]): JudgeDecision[] {
  const seen = new Map<string, number>()
  const out: JudgeDecision[] = []
  for (const d of decisions) {
    if (d.action === 'reject') {
      out.push(d)
      continue
    }
    const key = `${d.accepted.targetLayer}|${d.accepted.field ?? ''}|${d.accepted.content.trim().normalize('NFC')}`
    const existingIdx = seen.get(key)
    if (existingIdx === undefined) {
      seen.set(key, out.length)
      out.push(d)
      continue
    }
    const existing = out[existingIdx]
    if (existing.action !== 'reject' && d.accepted.confidence > existing.accepted.confidence) {
      // 新候选 confidence 更高 -> 替换；旧的降为 DUPLICATE_CANDIDATE
      out[existingIdx] = {
        candidateId: existing.candidateId,
        action: 'reject',
        reason: 'DUPLICATE_CANDIDATE'
      }
      seen.set(key, out.length)
      out.push(d)
    } else {
      out.push({
        candidateId: d.candidateId,
        action: 'reject',
        reason: 'DUPLICATE_CANDIDATE'
      })
    }
  }
  return out
}
