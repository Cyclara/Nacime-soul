// src/main/memory/extraction/service.test.ts
// P2-10 ExtractionService：独立 provider 调用、64KiB 上限、空失败。
// 依据 S-020 §3.2 J-10, J-12。
import { describe, it, expect } from 'vitest'
import { createExtractionService } from './service'
import { createFauxExtractionProvider } from './provider'
import { testNoopLogger } from '../../../../tests/helpers/test-db'

describe('P2-10 ExtractionService', () => {
  it('J-12: fixed response -> candidates parsed correctly', async () => {
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
    const svc = createExtractionService({ provider: faux, logger: testNoopLogger })
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

  it('J-10: provider throws -> empty candidates, no throw', async () => {
    const faux = createFauxExtractionProvider()
    // 队列耗尽 -> provider 抛错
    const svc = createExtractionService({ provider: faux, logger: testNoopLogger })
    const out = await svc.extract({
      turnId: 'turn_1',
      userMessageId: 'msg_1',
      userContent: '你好'
    })
    expect(out.candidates).toEqual([])
    expect(out.parseResult.outcome).toBe('discarded')
  })

  it('J-12: truncated JSON -> recovered-prefix or discarded, no throw', async () => {
    const faux = createFauxExtractionProvider()
    faux.setResponses([
      '{"schemaVersion":1,"candidates":[{"targetLayer":"l0","field":"name","content":"小明","confidence":0.9,"certainty":"explicit","attribution":"user_explicit","evidence":[{"messageId":"msg_1","role":"user","quote":"我叫小明"}],"forbiddenOverclaims":[]},{"targetLayer":"l0","field":"name","content":"截'
    ])
    const svc = createExtractionService({ provider: faux, logger: testNoopLogger })
    const out = await svc.extract({
      turnId: 'turn_1',
      userMessageId: 'msg_1',
      userContent: '我叫小明'
    })
    expect(out.candidates.length).toBe(1) // 恢复前缀第一个
    expect(out.parseResult.outcome).toBe('recovered-prefix')
  })

  it('assistant content not sent to provider (only user message in request)', async () => {
    const faux = createFauxExtractionProvider()
    faux.setResponses([JSON.stringify({ schemaVersion: 1, candidates: [] })])
    const svc = createExtractionService({ provider: faux, logger: testNoopLogger })
    await svc.extract({
      turnId: 'turn_1',
      userMessageId: 'msg_1',
      userContent: '我叫小明'
    })
    const calls = faux.calls()
    expect(calls.length).toBe(1)
    const messages = calls[0].messages
    // system + user only; no assistant message
    expect(messages.some((m) => m.role === 'assistant')).toBe(false)
    // user message contains the user content
    const userMsg = messages.find((m) => m.role === 'user')
    expect(userMsg?.content).toContain('我叫小明')
  })

  it('temperature is 0 and maxOutputTokens within limits', async () => {
    const faux = createFauxExtractionProvider()
    faux.setResponses([JSON.stringify({ schemaVersion: 1, candidates: [] })])
    const svc = createExtractionService({ provider: faux, logger: testNoopLogger })
    await svc.extract({
      turnId: 'turn_1',
      userMessageId: 'msg_1',
      userContent: '你好'
    })
    const req = faux.calls()[0]
    expect(req.temperature).toBe(0)
    expect(req.maxOutputTokens).toBeLessThanOrEqual(1200)
    expect(req.maxOutputTokens).toBeGreaterThanOrEqual(1)
  })
})
