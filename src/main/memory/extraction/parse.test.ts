// src/main/memory/extraction/parse.test.ts
// P2-10 parseCandidateEnvelope：截断恢复、代码块剥离、schema 校验、非法输入安全丢弃。
// 依据 S-020 §3.2 J-02a/b/c, J-03, J-09。
import { describe, it, expect } from 'vitest'
import { parseCandidateEnvelope } from './parse'

const VALID_CANDIDATE = {
  targetLayer: 'l0' as const,
  field: 'preferredName' as const,
  content: '小明',
  confidence: 0.9,
  certainty: 'explicit' as const,
  attribution: 'user_explicit' as const,
  evidence: [{ messageId: 'msg_1', role: 'user' as const, quote: '我叫小明' }],
  forbiddenOverclaims: []
}

function envelope(candidates: unknown[]): string {
  return JSON.stringify({ schemaVersion: 1, candidates })
}

describe('P2-10 parseCandidateEnvelope', () => {
  it('complete: valid envelope parses all candidates with sequential IDs', () => {
    const raw = envelope([
      VALID_CANDIDATE,
      { ...VALID_CANDIDATE, field: 'name', content: '小明明' }
    ])
    const result = parseCandidateEnvelope('turn_1', raw)
    expect(result.outcome).toBe('complete')
    expect(result.candidates.length).toBe(2)
    expect(result.candidates[0].candidateId).toBe('turn_1:0')
    expect(result.candidates[1].candidateId).toBe('turn_1:1')
    expect(result.droppedCount).toBe(0)
  })

  it('empty candidates array -> complete with zero candidates', () => {
    const result = parseCandidateEnvelope('turn_1', envelope([]))
    expect(result.outcome).toBe('complete')
    expect(result.candidates).toEqual([])
  })

  it('J-02a: two complete objects + third truncated -> recovered-prefix with first two', () => {
    const raw =
      envelope([VALID_CANDIDATE, { ...VALID_CANDIDATE, content: '小红' }]).slice(0, -2) +
      ',{"targetLayer":"l0","field":"name","content":"截断'
    const result = parseCandidateEnvelope('turn_1', raw)
    expect(result.outcome).toBe('recovered-prefix')
    expect(result.candidates.length).toBe(2)
    expect(result.candidates[0].content).toBe('小明')
    expect(result.candidates[1].content).toBe('小红')
  })

  it('J-02b: first object truncated -> discarded, no throw', () => {
    const raw =
      '{"schemaVersion":1,"candidates":[{"targetLayer":"l0","field":"name","content":"截断'
    const result = parseCandidateEnvelope('turn_1', raw)
    expect(result.outcome).toBe('discarded')
    expect(result.candidates).toEqual([])
  })

  it('J-02b: illegal escape -> discarded (not recovered)', () => {
    const raw =
      '{"schemaVersion":1,"candidates":[{"targetLayer":"l0","field":"name","content":"\\x"}]}'
    const result = parseCandidateEnvelope('turn_1', raw)
    expect(result.outcome).toBe('discarded')
    expect(result.candidates).toEqual([])
  })

  it('J-02b: schemaVersion missing -> discarded', () => {
    const raw = '{"candidates":[]}'
    const result = parseCandidateEnvelope('turn_1', raw)
    expect(result.outcome).toBe('discarded')
  })

  it('J-02c: ```json code block wraps valid envelope -> parsed', () => {
    const raw = '```json\n' + envelope([VALID_CANDIDATE]) + '\n```'
    const result = parseCandidateEnvelope('turn_1', raw)
    expect(result.outcome).toBe('complete')
    expect(result.candidates.length).toBe(1)
  })

  it('J-02c: text outside code block -> discarded', () => {
    const raw = '解释文字\n```json\n' + envelope([VALID_CANDIDATE]) + '\n```'
    const result = parseCandidateEnvelope('turn_1', raw)
    expect(result.outcome).toBe('discarded')
  })

  it('J-09: L0 candidate without field -> envelope discarded (schema violation)', () => {
    const invalid = { ...VALID_CANDIDATE, field: undefined }
    const result = parseCandidateEnvelope('turn_1', envelope([invalid]))
    expect(result.outcome).toBe('discarded')
    expect(result.droppedCount).toBe(1)
  })

  it('J-09: L2 candidate with field -> envelope discarded', () => {
    const invalid = {
      targetLayer: 'l2',
      field: 'name',
      content: 'x',
      confidence: 0.5,
      certainty: 'inferred',
      attribution: 'assistant_inferred',
      evidence: [{ messageId: 'm', role: 'user', quote: 'x' }],
      memoryType: 'stable',
      forbiddenOverclaims: []
    }
    const result = parseCandidateEnvelope('turn_1', envelope([invalid]))
    expect(result.outcome).toBe('discarded')
  })

  it('J-09: L2 without memoryType -> discarded', () => {
    const invalid = {
      targetLayer: 'l2',
      content: 'x',
      confidence: 0.5,
      certainty: 'inferred',
      attribution: 'assistant_inferred',
      evidence: [{ messageId: 'm', role: 'user', quote: 'x' }],
      forbiddenOverclaims: []
    }
    const result = parseCandidateEnvelope('turn_1', envelope([invalid]))
    expect(result.outcome).toBe('discarded')
  })

  it('input exceeds 64 KiB -> discarded, outputChars recorded', () => {
    const huge = 'x'.repeat(64 * 1024 + 1)
    const result = parseCandidateEnvelope('turn_1', huge)
    expect(result.outcome).toBe('discarded')
    expect(result.outputChars).toBe(64 * 1024 + 1)
  })

  it('candidates exceeds maxItems 8 -> discarded', () => {
    const arr = Array.from({ length: 9 }, () => VALID_CANDIDATE)
    const result = parseCandidateEnvelope('turn_1', envelope(arr))
    expect(result.outcome).toBe('discarded')
  })

  it('recovered-prefix: candidate with invalid shape in prefix is dropped, valid ones kept', () => {
    // 第一个合法，第二个 shape 非法（L0 无 field），第三个截断
    const valid1 = VALID_CANDIDATE
    const invalid = { ...VALID_CANDIDATE, field: undefined }
    const raw =
      '{"schemaVersion":1,"candidates":[' +
      JSON.stringify(valid1) +
      ',' +
      JSON.stringify(invalid) +
      ',{"targetLayer":"l0","field":"name","content":"截断'
    const result = parseCandidateEnvelope('turn_1', raw)
    expect(result.outcome).toBe('recovered-prefix')
    expect(result.candidates.length).toBe(1) // 只保留第一个合法的
    expect(result.candidates[0].content).toBe('小明')
  })
})
