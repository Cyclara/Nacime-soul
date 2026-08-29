// tests/helpers/fake-websocket.ts
// P3-00C：假 WebSocket——内存内模拟 DOM WebSocket 表面，测试不开真实网络连接。
//
// 用途：
//   - 语音/TTS 流式通路测试（P3B lane）
//   - 任何以 WebSocket 为传输的模块单测
//
// 只模拟消费者用到的表面：readyState 常量与状态机、send/close、
// onopen/onmessage/onerror/onclose 与 addEventListener 双通道。
// 服务端行为由测试用 simulate* 方法显式驱动（确定时序，无真实异步竞态）。

type FakeWsListener = (event: {
  type: string
  data?: unknown
  code?: number
  reason?: string
}) => void

export class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3

  readonly url: string
  readyState = FakeWebSocket.CONNECTING

  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: { type: string }) => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null

  /** 已发送帧日志（测试断言出站协议） */
  readonly sent: unknown[] = []

  private readonly listeners = new Map<string, Set<FakeWsListener>>()

  constructor(url: string) {
    this.url = url
  }

  send(data: unknown): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error(`fake ws: send in readyState ${this.readyState}`)
    }
    this.sent.push(data)
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSING
    this.readyState = FakeWebSocket.CLOSED
    const event = { type: 'close', code, reason }
    this.onclose?.({ code, reason })
    this.dispatch(event)
  }

  addEventListener(type: string, listener: FakeWsListener): void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
  }

  removeEventListener(type: string, listener: FakeWsListener): void {
    this.listeners.get(type)?.delete(listener)
  }

  // === 服务端模拟（测试驱动入站） ===

  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
    this.dispatch({ type: 'open' })
  }

  simulateMessage(data: unknown): void {
    this.onmessage?.({ data })
    this.dispatch({ type: 'message', data })
  }

  simulateError(): void {
    this.onerror?.({ type: 'error' })
    this.dispatch({ type: 'error' })
  }

  simulateServerClose(code = 1006, reason = 'abnormal'): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code, reason })
    this.dispatch({ type: 'close', code, reason })
  }

  private dispatch(event: { type: string; data?: unknown; code?: number; reason?: string }): void {
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) {
      listener(event)
    }
  }
}
