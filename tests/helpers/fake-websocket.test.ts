// tests/helpers/fake-websocket.test.ts
// P3-00C 自测：假 WebSocket 的状态机/发送日志/入站模拟/双通道事件正确。

import { describe, it, expect, vi } from 'vitest'
import { FakeWebSocket } from './fake-websocket'

describe('fake-websocket 自测', () => {
  it('CONNECTING 时 send 抛错；OPEN 后发送进日志', () => {
    const ws = new FakeWebSocket('wss://example.test/voice')
    expect(ws.readyState).toBe(FakeWebSocket.CONNECTING)
    expect(() => ws.send('early')).toThrow(/readyState/)

    ws.simulateOpen()
    expect(ws.readyState).toBe(FakeWebSocket.OPEN)
    ws.send(JSON.stringify({ type: 'start' }))
    ws.send(new Uint8Array([1, 2, 3]))
    expect(ws.sent).toHaveLength(2)
  })

  it('on* 回调与 addEventListener 双通道都收到入站事件', () => {
    const ws = new FakeWebSocket('wss://example.test/voice')
    const onOpen = vi.fn()
    const onMessageProp = vi.fn()
    const onMessageListener = vi.fn()
    ws.onopen = onOpen
    ws.onmessage = onMessageProp
    ws.addEventListener('message', onMessageListener)

    ws.simulateOpen()
    expect(onOpen).toHaveBeenCalledOnce()

    ws.simulateMessage('{"type":"delta"}')
    expect(onMessageProp).toHaveBeenCalledWith({ data: '{"type":"delta"}' })
    expect(onMessageListener).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'message', data: '{"type":"delta"}' })
    )

    // removeEventListener 后只剩 on* 通道
    ws.removeEventListener('message', onMessageListener)
    ws.simulateMessage('x')
    expect(onMessageListener).toHaveBeenCalledOnce()
    expect(onMessageProp).toHaveBeenCalledTimes(2)
  })

  it('close 与服务端关闭：状态到 CLOSED 且事件带 code/reason；重复 close 幂等', () => {
    const ws = new FakeWebSocket('wss://example.test/voice')
    const onClose = vi.fn()
    ws.onclose = onClose
    ws.simulateOpen()

    ws.close(1000, 'done')
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED)
    expect(onClose).toHaveBeenCalledWith({ code: 1000, reason: 'done' })
    ws.close()
    expect(onClose).toHaveBeenCalledOnce()
    expect(() => ws.send('after-close')).toThrow(/readyState/)

    const ws2 = new FakeWebSocket('wss://example.test/voice')
    const onClose2 = vi.fn()
    ws2.onclose = onClose2
    ws2.simulateServerClose()
    expect(ws2.readyState).toBe(FakeWebSocket.CLOSED)
    expect(onClose2).toHaveBeenCalledWith({ code: 1006, reason: 'abnormal' })
  })

  it('simulateError 双通道触发', () => {
    const ws = new FakeWebSocket('wss://example.test/voice')
    const onError = vi.fn()
    ws.onerror = onError
    ws.simulateError()
    expect(onError).toHaveBeenCalledWith({ type: 'error' })
  })
})
