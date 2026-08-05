// src/main/memory/extraction/queue.test.ts
// P2-10 有界单消费者队列：同 turnId 幂等、满时丢最旧、关闭后不入队。
import { describe, it, expect } from 'vitest'
import { createExtractionQueue } from './queue'
import { testNoopLogger } from '../../../../tests/helpers/test-db'

describe('P2-10 ExtractionQueue', () => {
  it('enqueue + dequeue FIFO', () => {
    const q = createExtractionQueue({ logger: testNoopLogger })
    q.enqueue({ turnId: 't1', sessionId: 's', userMessageId: 'm1', userContent: 'a' })
    q.enqueue({ turnId: 't2', sessionId: 's', userMessageId: 'm2', userContent: 'b' })
    expect(q.pending()).toBe(2)
    const first = q.dequeue()
    expect(first?.turnId).toBe('t1')
    const second = q.dequeue()
    expect(second?.turnId).toBe('t2')
    expect(q.dequeue()).toBeNull()
  })

  it('same turnId enqueued twice -> second is no-op', () => {
    const q = createExtractionQueue({ logger: testNoopLogger })
    expect(q.enqueue({ turnId: 't1', sessionId: 's', userMessageId: 'm1', userContent: 'a' })).toBe(
      true
    )
    expect(q.enqueue({ turnId: 't1', sessionId: 's', userMessageId: 'm1', userContent: 'a' })).toBe(
      false
    )
    expect(q.pending()).toBe(1)
  })

  it('queue full -> drops oldest, increments overflow counter', () => {
    const q = createExtractionQueue({ maxPending: 2, logger: testNoopLogger })
    q.enqueue({ turnId: 't1', sessionId: 's', userMessageId: 'm1', userContent: 'a' })
    q.enqueue({ turnId: 't2', sessionId: 's', userMessageId: 'm2', userContent: 'b' })
    q.enqueue({ turnId: 't3', sessionId: 's', userMessageId: 'm3', userContent: 'c' })
    expect(q.pending()).toBe(2)
    expect(q.droppedOverflow()).toBe(1)
    // t1 was dropped, t2 is now first
    const first = q.dequeue()
    expect(first?.turnId).toBe('t2')
  })

  it('close -> no more enqueue', () => {
    const q = createExtractionQueue({ logger: testNoopLogger })
    q.close()
    expect(q.isClosed()).toBe(true)
    expect(q.enqueue({ turnId: 't1', sessionId: 's', userMessageId: 'm1', userContent: 'a' })).toBe(
      false
    )
  })

  it('dequeue after close returns remaining then null', () => {
    const q = createExtractionQueue({ logger: testNoopLogger })
    q.enqueue({ turnId: 't1', sessionId: 's', userMessageId: 'm1', userContent: 'a' })
    q.close()
    // close clears tasks
    expect(q.dequeue()).toBeNull()
  })

  it('enqueueSequence is monotonic', () => {
    const q = createExtractionQueue({ maxPending: 10, logger: testNoopLogger })
    q.enqueue({ turnId: 't1', sessionId: 's', userMessageId: 'm1', userContent: 'a' })
    q.enqueue({ turnId: 't2', sessionId: 's', userMessageId: 'm2', userContent: 'b' })
    const a = q.dequeue()
    const b = q.dequeue()
    expect(b?.enqueueSequence).toBeGreaterThan(a?.enqueueSequence ?? 0)
  })
})
