// src/main/memory/extraction/sync-turn.test.ts
// P2-38 sync_turn 轻量提取 + P2-39 跨轮去重纯函数。
// 依据 S-Phase2 P2-38/P2-39 验收 + S-020 §1.5。
import { describe, it, expect } from 'vitest'
import { createFauxExtractionProvider } from './provider'
import { testNoopLogger } from '../../../../tests/helpers/test-db'
import {
  SYNC_TURN_MAX_OUTPUT_TOKENS,
  SYNC_TURN_TIMEOUT_MS,
  SYNC_TURN_JUDGE_EVERY_TURNS,
  JUDGE_QUEUE_THRESHOLD,
  buildSyncTurnRequest,
  createSyncTurnExtractor,
  dedupeDecisionsForDrain
} from './sync-turn'
import { defaultExtractionRequest } from './provider'
import type { MemoryCandidate, MemoryTargetLayer } from './candidate'
import type { L0FieldKey } from '../l0-store'
import type { JudgeDecision } from './judge'

// === 测试辅助 ===

function mkCandidate(
  candidateId: string,
  content: string,
  opts: {
    targetLayer?: MemoryTargetLayer
    field?: L0FieldKey
    confidence?: number
  } = {}
): MemoryCandidate {
  const layer = opts.targetLayer ?? 'l2'
  return {
    candidateId,
    targetLayer: layer,
    field: layer === 'l0' ? opts.field : undefined,
    content,
    confidence: opts.confidence ?? 0.8,
    certainty: 'explicit',
    attribution: 'user_explicit',
    evidence: [{ messageId: 'm_1', role: 'user', quote: content }],
    memoryType: layer === 'l2' ? 'stable' : undefined,
    importance: layer === 'l2' ? 'medium' : undefined,
    forbiddenOverclaims: []
  }
}

function acceptDecision(
  candidateId: string,
  content: string,
  opts: { targetLayer?: MemoryTargetLayer; field?: L0FieldKey; confidence?: number } = {}
): JudgeDecision {
  const accepted = mkCandidate(candidateId, content, opts)
  return { candidateId, action: 'accept', reason: 'ACCEPTED', accepted }
}

function rejectDecision(candidateId: string, reason: 'FORBIDDEN_OVERCLAIM'): JudgeDecision {
  return { candidateId, action: 'reject', reason }
}

/** 断言 decision 为 accept 并返回 accepted（TS 判别联合跨索引访问无法收窄，用 helper） */
function acceptedOf(d: JudgeDecision): MemoryCandidate {
  if (d.action !== 'accept') throw new Error(`expected accept, got ${d.reason}`)
  return d.accepted
}

// === P2-38 sync_turn 提取 ===

describe('P2-38 sync_turn 轻量提取', () => {
  it('buildSyncTurnRequest：temperature=0、低 maxOutputTokens（< P2-10 默认 800）、短超时', () => {
    const messages = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: '我叫小明' }
    ]
    const req = buildSyncTurnRequest(messages)
    expect(req.temperature).toBe(0)
    expect(req.maxOutputTokens).toBe(SYNC_TURN_MAX_OUTPUT_TOKENS)
    expect(SYNC_TURN_MAX_OUTPUT_TOKENS).toBeLessThan(
      defaultExtractionRequest(messages).maxOutputTokens
    )
    expect(req.timeoutMs).toBe(SYNC_TURN_TIMEOUT_MS)
    expect(req.jsonSchema).toBeDefined()
    expect(req.messages).toEqual(messages)
  })

  it('extractor 复用 P2-10 schema/parser：Faux 固定回复 -> 候选解析正确', async () => {
    const faux = createFauxExtractionProvider()
    faux.setResponses([
      JSON.stringify({
        schemaVersion: 1,
        candidates: [
          {
            targetLayer: 'l0',
            field: 'preferredName',
            content: '小明',
            confidence: 0.9,
            certainty: 'explicit',
            attribution: 'user_explicit',
            evidence: [{ messageId: 'msg_1', role: 'user', quote: '我叫小明' }],
            forbiddenOverclaims: []
          }
        ]
      })
    ])
    const svc = createSyncTurnExtractor({ provider: faux, logger: testNoopLogger })
    const out = await svc.extract({
      turnId: 'turn_1',
      userMessageId: 'msg_1',
      userContent: '我叫小明'
    })
    expect(out.candidates.length).toBe(1)
    expect(out.candidates[0].candidateId).toBe('turn_1:0')
    expect(out.candidates[0].content).toBe('小明')
    expect(out.parseResult.outcome).toBe('complete')
  })

  it('请求画像确实被用于 provider 调用（便宜预算 + temperature 0）', async () => {
    const faux = createFauxExtractionProvider()
    faux.setResponses([JSON.stringify({ schemaVersion: 1, candidates: [] })])
    const svc = createSyncTurnExtractor({ provider: faux, logger: testNoopLogger })
    await svc.extract({ turnId: 't', userMessageId: 'm', userContent: '你好' })
    const req = faux.calls()[0]
    expect(req.temperature).toBe(0)
    expect(req.maxOutputTokens).toBe(SYNC_TURN_MAX_OUTPUT_TOKENS)
    expect(req.timeoutMs).toBe(SYNC_TURN_TIMEOUT_MS)
  })

  it('provider 失败 -> 空候选、不 throw（失败静默不影响聊天）', async () => {
    const faux = createFauxExtractionProvider()
    // 队列耗尽 -> provider 抛错
    const svc = createSyncTurnExtractor({ provider: faux, logger: testNoopLogger })
    const out = await svc.extract({ turnId: 't', userMessageId: 'm', userContent: '你好' })
    expect(out.candidates).toEqual([])
    expect(out.parseResult.outcome).toBe('discarded')
  })

  it('截断 JSON -> 恢复完整前缀或安全丢弃，不 throw', async () => {
    const faux = createFauxExtractionProvider()
    faux.setResponses([
      '{"schemaVersion":1,"candidates":[{"targetLayer":"l0","field":"name","content":"小明","confidence":0.9,"certainty":"explicit","attribution":"user_explicit","evidence":[{"messageId":"m","role":"user","quote":"我叫小明"}],"forbiddenOverclaims":[]},{"targetLayer":"l0","field":"name","content":"截'
    ])
    const svc = createSyncTurnExtractor({ provider: faux, logger: testNoopLogger })
    const out = await svc.extract({ turnId: 't', userMessageId: 'm', userContent: '我叫小明' })
    expect(out.candidates.length).toBe(1) // 恢复前缀第一个
    expect(out.parseResult.outcome).toBe('recovered-prefix')
  })
})

// === P2-39 跨轮去重纯函数 ===

describe('P2-39 dedupeDecisionsForDrain', () => {
  it('不同事实 -> 全部保留', () => {
    const input: JudgeDecision[] = [
      acceptDecision('t1:0', '喜欢咖啡'),
      acceptDecision('t1:1', '喜欢下雨')
    ]
    const out = dedupeDecisionsForDrain(input)
    expect(out).toHaveLength(2)
    expect(out.filter((d) => d.action === 'accept')).toHaveLength(2)
  })

  it('同事实（同层/同字段/同内容）、后者 confidence 低 -> 保留前者，后者标记 DUPLICATE_CANDIDATE', () => {
    const input: JudgeDecision[] = [
      acceptDecision('t1:0', '小明', {
        targetLayer: 'l0',
        field: 'preferredName',
        confidence: 0.8
      }),
      acceptDecision('t2:0', '小明', { targetLayer: 'l0', field: 'preferredName', confidence: 0.6 })
    ]
    const out = dedupeDecisionsForDrain(input)
    expect(out).toHaveLength(2)
    expect(out[0].action).toBe('accept')
    expect(acceptedOf(out[0]).confidence).toBe(0.8)
    expect(out[1].action).toBe('reject')
    expect(out[1].reason).toBe('DUPLICATE_CANDIDATE')
  })

  it('同事实、后者 confidence 更高 -> 保留后者（合并取高），前者标记 DUPLICATE_CANDIDATE', () => {
    const input: JudgeDecision[] = [
      acceptDecision('t1:0', '小明', {
        targetLayer: 'l0',
        field: 'preferredName',
        confidence: 0.6
      }),
      acceptDecision('t2:0', '小明', {
        targetLayer: 'l0',
        field: 'preferredName',
        confidence: 0.95
      })
    ]
    const out = dedupeDecisionsForDrain(input)
    expect(out).toHaveLength(2)
    expect(out[0].action).toBe('reject')
    expect(out[0].reason).toBe('DUPLICATE_CANDIDATE')
    expect(out[1].action).toBe('accept')
    expect(acceptedOf(out[1]).confidence).toBe(0.95)
  })

  it('同内容但不同 targetLayer（l0 vs l2）-> 不去重', () => {
    const input: JudgeDecision[] = [
      acceptDecision('t1:0', '小明', {
        targetLayer: 'l0',
        field: 'preferredName',
        confidence: 0.9
      }),
      acceptDecision('t2:0', '小明', { targetLayer: 'l2', confidence: 0.9 })
    ]
    const out = dedupeDecisionsForDrain(input)
    expect(out.filter((d) => d.action === 'accept')).toHaveLength(2)
  })

  it('reject 原样透传（不参与去重、不改写）', () => {
    const input: JudgeDecision[] = [
      rejectDecision('t1:0', 'FORBIDDEN_OVERCLAIM'),
      acceptDecision('t2:0', '喜欢咖啡'),
      rejectDecision('t3:0', 'FORBIDDEN_OVERCLAIM')
    ]
    const out = dedupeDecisionsForDrain(input)
    expect(out).toHaveLength(3)
    expect(out[0]).toEqual(input[0])
    expect(out[2]).toEqual(input[2])
  })

  it('输入输出 1:1（每条输入恰好产生一条决策，保序）', () => {
    const input: JudgeDecision[] = [
      acceptDecision('t1:0', '事实A', { confidence: 0.5 }),
      acceptDecision('t2:0', '事实A', { confidence: 0.9 }),
      acceptDecision('t2:1', '事实B'),
      rejectDecision('t3:0', 'FORBIDDEN_OVERCLAIM')
    ]
    const out = dedupeDecisionsForDrain(input)
    expect(out).toHaveLength(input.length)
  })

  it('常量：SYNC_TURN_JUDGE_EVERY_TURNS=6、JUDGE_QUEUE_THRESHOLD=12（S-020 §1.5 钉死）', () => {
    expect(SYNC_TURN_JUDGE_EVERY_TURNS).toBe(6)
    expect(JUDGE_QUEUE_THRESHOLD).toBe(12)
  })
})
