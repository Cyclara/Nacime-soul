// src/main/voice/mic/mic-input-session.test.ts
// P3B-13：main 侧 mic 输入会话合同——帧转发/协议违规计数/close 冲刷/幂等收尾。
// 假 port + 假 processor（S-004：不碰真原生件/真端口）。

import { describe, expect, it, vi } from 'vitest'
import { createMicInputSession, type MicPortMainLike } from './mic-input-session'
import type { VadEvent } from '../vad/vad'
import type { VadProcessor } from '../vad/vad-processor'

function makeFakePort(): {
  port: MicPortMainLike
  emitMessage: (data: unknown) => void
  emitClose: () => void
  started: () => boolean
  closed: () => boolean
  listeners: { message: number; close: number }
} {
  const messageListeners: Array<(event: { data: unknown }) => void> = []
  const closeListeners: Array<() => void> = []
  const state = { started: false, closed: false }
  const port: MicPortMainLike = {
    on(event, listener) {
      if (event === 'message') {
        messageListeners.push(listener as (event: { data: unknown }) => void)
      } else {
        closeListeners.push(listener as () => void)
      }
    },
    start() {
      state.started = true
    },
    close() {
      state.closed = true
    }
  }
  return {
    port,
    emitMessage: (data) => {
      for (const l of messageListeners) l({ data })
    },
    emitClose: () => {
      for (const l of closeListeners) l()
    },
    started: () => state.started,
    closed: () => state.closed,
    listeners: { message: messageListeners.length, close: closeListeners.length }
  }
}

function makeFakeProcessor(): {
  processor: VadProcessor
  processChunk: ReturnType<typeof vi.fn>
  flush: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
} {
  const processChunk = vi.fn((): VadEvent[] => [])
  const flush = vi.fn((): VadEvent | null => null)
  const close = vi.fn()
  const processor: VadProcessor = {
    get state() {
      return 'idle' as const
    },
    processChunk,
    flush,
    reset: vi.fn(),
    close
  }
  return { processor, processChunk, flush, close }
}

describe('P3B-13 mic-input-session：帧转发', () => {
  it('attach 后 start 被调用；合法帧原样进 processor，事件回调给消费者', () => {
    const fake = makeFakeProcessor()
    const events: VadEvent[] = []
    const speechEnd: VadEvent = {
      type: 'speech_end',
      audio: new Int16Array(512),
      reason: 'silence'
    }
    fake.processChunk.mockReturnValueOnce([speechEnd])
    const session = createMicInputSession({
      processor: fake.processor,
      onEvent: (e) => events.push(e)
    })
    const p = makeFakePort()
    session.attach(p.port)
    expect(p.started()).toBe(true)
    expect(session.attached).toBe(true)

    const samples = new Int16Array(512)
    p.emitMessage({ type: 'mic-frame', samples })
    expect(fake.processChunk).toHaveBeenCalledWith(samples)
    expect(session.frames).toBe(1)
    expect(events).toEqual([speechEnd])
  })

  it('合法帧先产 VAD 事件、再按原引用转发给流式 ASR', () => {
    const fake = makeFakeProcessor()
    const order: string[] = []
    const samples = new Int16Array(512)
    fake.processChunk.mockImplementationOnce(() => {
      order.push('vad')
      return [{ type: 'speech_start' }]
    })
    const onFrame = vi.fn((frame: Int16Array) => {
      order.push('asr')
      expect(frame).toBe(samples)
    })
    const session = createMicInputSession({
      processor: fake.processor,
      onEvent: () => order.push('event'),
      onFrame
    })
    const p = makeFakePort()
    session.attach(p.port)
    p.emitMessage({ type: 'mic-frame', samples })

    expect(order).toEqual(['vad', 'event', 'asr'])
    expect(onFrame).toHaveBeenCalledTimes(1)
  })

  it('onFrame 抛错不杀采集会话，下一帧继续进入 VAD 和流式回调', () => {
    const fake = makeFakeProcessor()
    const onFrame = vi.fn(() => {
      throw new Error('decode failed')
    })
    const session = createMicInputSession({
      processor: fake.processor,
      onEvent: () => {},
      onFrame
    })
    const p = makeFakePort()
    session.attach(p.port)
    p.emitMessage({ type: 'mic-frame', samples: new Int16Array(512) })
    p.emitMessage({ type: 'mic-frame', samples: new Int16Array(512) })
    expect(session.frames).toBe(2)
    expect(fake.processChunk).toHaveBeenCalledTimes(2)
    expect(onFrame).toHaveBeenCalledTimes(2)
  })

  it('协议违规：非帧消息与超限帧丢弃 + 计数 + 上报，会话存活', () => {
    const fake = makeFakeProcessor()
    const protocolErrors: string[] = []
    const session = createMicInputSession({
      processor: fake.processor,
      onEvent: () => {},
      onProtocolError: (detail) => protocolErrors.push(detail)
    })
    const p = makeFakePort()
    session.attach(p.port)
    p.emitMessage({ type: 'other', samples: new Int16Array(4) })
    p.emitMessage('hello')
    p.emitMessage({ type: 'mic-frame', samples: new Int16Array(2049) })
    p.emitMessage({ type: 'mic-frame', samples: new Int16Array(0) })
    expect(session.protocolErrors).toBe(4)
    expect(session.frames).toBe(0)
    expect(fake.processChunk).not.toHaveBeenCalled()
    // 会话仍存活：合法帧继续流动
    p.emitMessage({ type: 'mic-frame', samples: new Int16Array(512) })
    expect(session.frames).toBe(1)
    expect(protocolErrors).toHaveLength(4)
  })
})

describe('P3B-13 mic-input-session：生命周期收尾', () => {
  it('对端 close：冲刷未完话语 + 关 port + processor.close', () => {
    const fake = makeFakeProcessor()
    const events: VadEvent[] = []
    fake.flush.mockReturnValueOnce({
      type: 'speech_end',
      audio: new Int16Array(1024),
      reason: 'flush'
    })
    const session = createMicInputSession({
      processor: fake.processor,
      onEvent: (e) => events.push(e)
    })
    const p = makeFakePort()
    session.attach(p.port)
    p.emitClose()
    expect(events.map((e) => e.type)).toEqual(['speech_end'])
    expect(fake.close).toHaveBeenCalledTimes(1)
    expect(p.closed()).toBe(true)
    expect(session.attached).toBe(false)
    // close 后帧不再消费
    p.emitMessage({ type: 'mic-frame', samples: new Int16Array(512) })
    expect(session.frames).toBe(0)
  })

  it('main 主动 dispose：同样冲刷 + 幂等', () => {
    const fake = makeFakeProcessor()
    const session = createMicInputSession({
      processor: fake.processor,
      onEvent: () => {}
    })
    const p = makeFakePort()
    session.attach(p.port)
    session.dispose()
    expect(fake.flush).toHaveBeenCalledTimes(1)
    expect(fake.close).toHaveBeenCalledTimes(1)
    expect(p.closed()).toBe(true)
    // 幂等：再 dispose 不再触发 flush/close
    session.dispose()
    expect(fake.flush).toHaveBeenCalledTimes(1)
    expect(fake.close).toHaveBeenCalledTimes(1)
  })

  it('attach 二次或 dispose 后 attach 都拒绝', () => {
    const fake = makeFakeProcessor()
    const session = createMicInputSession({
      processor: fake.processor,
      onEvent: () => {}
    })
    const p1 = makeFakePort()
    session.attach(p1.port)
    expect(() => session.attach(makeFakePort().port)).toThrow(/already attached/)
    session.dispose()
    expect(() => session.attach(makeFakePort().port)).toThrow(/already attached/)
  })
})
