// src/main/memory/extraction/service.ts
// ExtractionService：独立 LLM 调用 + 64KiB 上限 + 空失败。
// 依据 S-010 §1.1 责任边界、§1.5 ExtractionProvider 窄适配。
//
// 责任边界：
//   - ExtractionService 只负责"让模型提出候选"，没有写权限
//   - 以本轮 user 消息为唯一提取/evidence 数据；assistant 仅用于 eligibility 完整性检查
//   - 失败/超时/schema 解析失败均返回空结果；聊天主流程不受影响
//
// 安全红线（F5-011 LogFields 白名单）：
//   - 日志只记 turnId、candidateCount、accepted/rejected/downgraded 数、reason code 计数、
//     duration、outputChars、parse outcome 枚举
//   - 不得记 candidate content、quote、完整模型输出、user/assistant 正文

import type { ErrorCode } from '@shared/errors'
import type { Logger } from '@shared/observability/types'
import { isAppError } from '@shared/errors'
import type { LlmMessage } from '../../llm/types'
import type { MemoryCandidate } from './candidate'
import { parseCandidateEnvelope, type CandidateParseResult } from './parse'
import { buildExtractionMessages } from './prompt'
import {
  defaultExtractionRequest,
  type ExtractionProvider,
  type ExtractionRequest
} from './provider'

export interface ExtractionInput {
  turnId: string
  /** 当前 turn 的 user message ID（用于 evidence 回查） */
  userMessageId: string
  /** 当前 turn 的 user message 正文（已 sanitize） */
  userContent: string
}

export interface ExtractionOutput {
  candidates: MemoryCandidate[]
  parseResult: CandidateParseResult
  durationMs: number
}

export interface ExtractionServiceDeps {
  provider: ExtractionProvider
  logger: Logger
  /** 注入时钟（测试确定性）。默认 performance.now */
  now?: () => number
  /**
   * 请求构建器。默认 defaultExtractionRequest（P2-10 画像：maxOutputTokens=800）。
   * P2-38 sync_turn 用 buildSyncTurnRequest 覆盖为便宜画像（低 maxOutputTokens）。
   */
  buildRequest?: (messages: readonly LlmMessage[]) => ExtractionRequest
}

/** ExtractionService 接口：extract(input) -> ExtractionOutput */
export interface ExtractionService {
  extract(input: ExtractionInput): Promise<ExtractionOutput>
}

/**
 * 创建 ExtractionService。
 *
 * extract() 调用 provider 获取模型输出，再用 parseCandidateEnvelope 解析。
 * 失败/超时/解析失败均返回空候选（fail-closed），不 throw。
 */
export function createExtractionService(deps: ExtractionServiceDeps): ExtractionService {
  const { provider, logger, buildRequest } = deps
  const now = deps.now ?? (() => performance.now())
  const buildReq = buildRequest ?? defaultExtractionRequest

  async function extract(input: ExtractionInput): Promise<ExtractionOutput> {
    const start = now()
    const { turnId, userMessageId, userContent } = input

    // 构建提取 messages（assistant 正文不发送）
    const messages = buildExtractionMessages(userMessageId, userContent)
    const request = buildReq(messages)

    let rawOutput: string
    try {
      rawOutput = await provider.complete(request, new AbortController().signal)
    } catch (e) {
      // 提取调用失败 -> 空候选，聊天主流程不受影响
      const durationMs = Math.round(now() - start)
      const code: ErrorCode = isAppError(e) ? e.code : 'UNKNOWN'
      logger.warn('extraction provider failed; returning empty candidates', {
        scope: 'memory',
        turnId,
        code,
        metrics: { durationMs, outputChars: 0 }
      })
      const parseResult: CandidateParseResult = {
        candidates: [],
        outcome: 'discarded',
        droppedCount: 0,
        outputChars: 0
      }
      return { candidates: [], parseResult, durationMs }
    }

    // 解析模型输出
    const parseResult = parseCandidateEnvelope(turnId, rawOutput)
    const durationMs = Math.round(now() - start)

    // 日志只记元数据，不记正文（F5-011 LogFields 白名单）
    logger.info('extraction completed', {
      scope: 'memory',
      turnId,
      metrics: {
        candidateCount: parseResult.candidates.length,
        outputChars: parseResult.outputChars,
        durationMs,
        droppedCount: parseResult.droppedCount
      },
      tags: { outcome: parseResult.outcome }
    })

    return { candidates: parseResult.candidates, parseResult, durationMs }
  }

  return { extract }
}
