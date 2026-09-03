// src/main/voice/playback/ack-gate.test.ts
// P3B-08：ChatRenderAckGate 合同--严格递增、有界跟踪、abort/forget 释放。
// P3B-15A：ChatRenderAckTracker（已知 requestId LRU + gate 喂入口）合同。

import { describe, expect, it } from 'vitest'
import { createChatRenderAckGate, createChatRenderAckTracker } from './ack-gate'

function makeSignal(): AbortSignal {
  return new AbortController().signal
}

function flush(ticks = 2): Promise<void> {
  return new Promise((resolve) => {
    void (async () => {
      for (let i = 0; i < ticks; i++) await Promise.resolve()
      resolve()
    })()
  })
}

describe('createChatRenderAckGate', () => {
  it('已观察到的 sequence 立即满足等待', async () => {
    const gate = createChatRenderAckGate({ now: () => 100 })
    expect(gate.observeAck('r1', 5)).toEqual({ requestId: 'r1', sequence: 5, paintedAt: 100 })
    const ack = await gate.waitForPainted('r1', 3, makeSignal())
    expect(ack.sequence).toBeGreaterThanOrEqual(3)
  })

  it('等待中的 waiter 在后续 ack 到达时被满足', async () => {
    const gate = createChatRenderAckGate({ now: () => 1 })
    const pending = gate.waitForPainted('r1', 4, makeSignal())
    expect(gate.observeAck('r1', 4)).not.toBeNull()
    const ack = await pending
    expect(ack.sequence).toBe(4)
  })

  it('一个 ack 可同时满足多个不同 sequence 的 waiter', async () => {
    const gate = createChatRenderAckGate()
    const w1 = gate.waitForPainted('r1', 2, makeSignal())
    const w2 = gate.waitForPainted('r1', 6, makeSignal())
    gate.observeAck('r1', 6)
    expect((await w1).sequence).toBe(6)
    expect((await w2).sequence).toBe(6)
  })

  it('逆序/重复 ack 拒绝且不推进最高值', () => {
    const gate = createChatRenderAckGate()
    expect(gate.observeAck('r1', 5)).not.toBeNull()
    expect(gate.observeAck('r1', 5)).toBeNull()
    expect(gate.observeAck('r1', 4)).toBeNull()
    // 5 之后的 6 仍合法
    expect(gate.observeAck('r1', 6)).not.toBeNull()
  })

  it('abort 立即拒绝等待', async () => {
    const gate = createChatRenderAckGate()
    const controller = new AbortController()
    const pending = gate.waitForPainted('r1', 9, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('forget 释放挂起 waiter 并清跟踪', async () => {
    const gate = createChatRenderAckGate()
    const pending = gate.waitForPainted('r1', 3, makeSignal())
    gate.forget('r1')
    await expect(pending).rejects.toMatchObject({ name: 'AckGateForgottenError' })
    expect(gate.trackedRequestCount).toBe(0)
    // forget 后同 requestId 重新从零观察
    expect(gate.observeAck('r1', 1)).not.toBeNull()
  })

  it('跟踪数有界：超过上限按最旧淘汰，被淘汰 request 的 waiter 释放', async () => {
    const gate = createChatRenderAckGate({ maxTrackedRequests: 2 })
    gate.observeAck('r1', 1)
    gate.observeAck('r2', 1)
    const stale = gate.waitForPainted('r1', 5, makeSignal())
    gate.observeAck('r3', 1) // 挤掉 r1
    expect(gate.trackedRequestCount).toBe(2)
    await expect(stale).rejects.toMatchObject({ name: 'AckGateForgottenError' })
    // r1 的后续 ack 视作新 request（从 -1 重新计数），仍可服务
    expect(gate.observeAck('r1', 0)).not.toBeNull()
  })

  it('已满足的 waiter 不受后续 forget 影响（幂等收尾）', async () => {
    const gate = createChatRenderAckGate()
    gate.observeAck('r1', 2)
    const ack = await gate.waitForPainted('r1', 1, makeSignal())
    expect(ack.sequence).toBe(2)
    gate.forget('r1')
    await flush()
    // 无 unhandled rejection 即通过
  })
})

describe('P3B-15A ChatRenderAckTracker', () => {
  it('未登记的 requestId 拒绝（旧/未知请求不喂 gate）', () => {
    const tracker = createChatRenderAckTracker()
    expect(tracker.acceptAck('ghost', 3)).toBeNull()
    expect(tracker.acceptAck('ghost', 1)).toBeNull()
    expect(tracker.issuedRequestCount).toBe(0)
  })

  it('登记后合法 ack 喂进 gate；gate 等待者被满足', async () => {
    const tracker = createChatRenderAckTracker()
    tracker.noteRequestIssued('r1')
    const pending = tracker.gate.waitForPainted('r1', 2, makeSignal())
    const ack = tracker.acceptAck('r1', 2)
    expect(ack).not.toBeNull()
    expect(ack!.sequence).toBe(2)
    await expect(pending).resolves.toMatchObject({ requestId: 'r1', sequence: 2 })
  })

  it('登记前到达的 ack 拒绝（防旧窗口在重发前抢跑）', () => {
    const tracker = createChatRenderAckTracker()
    expect(tracker.acceptAck('r1', 1)).toBeNull()
    tracker.noteRequestIssued('r1')
    expect(tracker.acceptAck('r1', 1)).not.toBeNull()
  })

  it('同 request 逆序/重复 ack 拒绝（gate 语义透传）', () => {
    const tracker = createChatRenderAckTracker()
    tracker.noteRequestIssued('r1')
    expect(tracker.acceptAck('r1', 5)).not.toBeNull()
    expect(tracker.acceptAck('r1', 5)).toBeNull() // 重复
    expect(tracker.acceptAck('r1', 3)).toBeNull() // 逆序
    expect(tracker.acceptAck('r1', 6)).not.toBeNull()
  })

  it('issued LRU 有界：被淘汰请求的 ack 拒绝且其 waiter 被遗忘', async () => {
    const tracker = createChatRenderAckTracker({ maxIssuedRequests: 2 })
    tracker.noteRequestIssued('r1')
    tracker.noteRequestIssued('r2')
    const stale = tracker.gate.waitForPainted('r1', 9, makeSignal())
    tracker.noteRequestIssued('r3') // 挤掉 r1
    expect(tracker.issuedRequestCount).toBe(2)
    expect(tracker.acceptAck('r1', 10)).toBeNull()
    await expect(stale).rejects.toMatchObject({ name: 'AckGateForgottenError' })
  })

  it('noteRequestIssued 幂等；坏形状（空/超长）拒绝', () => {
    const tracker = createChatRenderAckTracker()
    tracker.noteRequestIssued('r1')
    tracker.noteRequestIssued('r1')
    expect(tracker.issuedRequestCount).toBe(1)
    tracker.noteRequestIssued('')
    tracker.noteRequestIssued('x'.repeat(200))
    expect(tracker.issuedRequestCount).toBe(1)
  })
})
