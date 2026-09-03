// src/renderer/src/voice/mic-capture-session.test.ts
// P3B-13：renderer 侧采集会话合同——全依赖注入，node 环境跑（S-004：不碰真
// getUserMedia/AudioContext/麦克风）。验收对位：权限失败可恢复、设备拔出、
// 停止后 track 关闭、帧 transferable 转发不复制。

import { describe, expect, it, vi } from 'vitest'
import {
  classifyCaptureError,
  createMicCaptureSession,
  frameLevel,
  type MicCaptureContextLike,
  type MicCaptureSessionDeps,
  type MicPortLike,
  type MicStreamLike,
  type MicTrackLike
} from './mic-capture-session'

function makeFakeTrack(): {
  track: MicTrackLike
  endedListeners: Array<() => void>
  stopped: () => boolean
  emitEnded: () => void
} {
  const endedListeners: Array<() => void> = []
  const state = { stopped: false }
  const track: MicTrackLike = {
    stop() {
      state.stopped = true
    },
    addEventListener(type, listener) {
      if (type === 'ended') endedListeners.push(listener)
    }
  }
  return {
    track,
    endedListeners,
    stopped: () => state.stopped,
    emitEnded: () => {
      for (const l of endedListeners) l()
    }
  }
}

function makeFakePort(): {
  port: MicPortLike
  posted: Array<{ message: unknown; transfer?: Transferable[] }>
  closed: () => boolean
  emit: (data: unknown) => void
  listenerCount: () => number
} {
  const posted: Array<{ message: unknown; transfer?: Transferable[] }> = []
  const listeners: Array<(event: { data: unknown }) => void> = []
  const state = { closed: false }
  const port: MicPortLike = {
    postMessage(message, transfer) {
      posted.push({ message, transfer })
    },
    close() {
      state.closed = true
    },
    addEventListener(_type, listener) {
      listeners.push(listener)
    },
    removeEventListener(_type, listener) {
      const idx = listeners.indexOf(listener)
      if (idx >= 0) listeners.splice(idx, 1)
    }
  }
  return {
    port,
    posted,
    closed: () => state.closed,
    emit: (data) => {
      for (const l of [...listeners]) l({ data })
    },
    listenerCount: () => listeners.length
  }
}

function makeDeps(overrides?: {
  getUserMedia?: MicCaptureSessionDeps['getUserMedia']
  addModuleError?: Error
}): {
  deps: MicCaptureSessionDeps
  fakeTrack: ReturnType<typeof makeFakeTrack>
  nodePort: ReturnType<typeof makeFakePort>
  outputPort: ReturnType<typeof makeFakePort>
  contextClosed: () => boolean
  statuses: string[]
  errors: Array<{ kind: string; message: string }>
  levels: number[]
} {
  const fakeTrack = makeFakeTrack()
  const nodePort = makeFakePort()
  const outputPort = makeFakePort()
  const ctxState = { closed: false }
  const context: MicCaptureContextLike = {
    audioWorklet: {
      addModule: async () => {
        if (overrides?.addModuleError) throw overrides.addModuleError
      }
    },
    createWorkletNode: () => nodePort.port,
    close: async () => {
      ctxState.closed = true
    }
  }
  const stream: MicStreamLike = { getAudioTracks: () => [fakeTrack.track] }
  const statuses: string[] = []
  const errors: Array<{ kind: string; message: string }> = []
  const levels: number[] = []
  const deps: MicCaptureSessionDeps = {
    getUserMedia: overrides?.getUserMedia ?? vi.fn(async () => stream),
    createAudioContext: () => context,
    workletUrl: 'http://localhost:5173/voice/mic-worklet-processor.js',
    outputPort: outputPort.port,
    onStatusChange: (s) => statuses.push(s),
    onError: (e) => errors.push({ kind: e.kind, message: e.message }),
    onLevel: (l) => levels.push(l)
  }
  return {
    deps,
    fakeTrack,
    nodePort,
    outputPort,
    contextClosed: () => ctxState.closed,
    statuses,
    errors,
    levels
  }
}

describe('P3B-13 capture：正常采集流', () => {
  it('start → capturing；worklet 帧原样 transfer 转发到输出 port；电平回调', async () => {
    const h = makeDeps()
    const session = createMicCaptureSession(h.deps)
    await session.start()
    expect(session.status).toBe('capturing')
    expect(h.statuses).toEqual(['starting', 'capturing'])

    const samples = new Int16Array(512).fill(16_384)
    const buffer = samples.buffer
    h.nodePort.emit({ type: 'mic-frame', samples })
    expect(h.outputPort.posted).toHaveLength(1)
    expect(h.outputPort.posted[0]!.message).toEqual({ type: 'mic-frame', samples })
    // transferable 零拷贝：transfer 列表携带同一 buffer
    expect(h.outputPort.posted[0]!.transfer).toEqual([buffer])
    // 电平：全 0.5 幅值 → RMS 0.5
    expect(h.levels).toEqual([0.5])

    await session.stop()
    expect(h.fakeTrack.stopped()).toBe(true)
    expect(h.contextClosed()).toBe(true)
    expect(h.outputPort.closed()).toBe(true)
    expect(session.status).toBe('idle')
  })

  it('非帧消息（worklet 异常输出）被忽略，不转发', async () => {
    const h = makeDeps()
    const session = createMicCaptureSession(h.deps)
    await session.start()
    h.nodePort.emit({ type: 'other' })
    h.nodePort.emit(null)
    expect(h.outputPort.posted).toHaveLength(0)
    await session.stop()
  })

  it('stop 幂等；idle 下 stop 也关输出 port（会话独占语义）', async () => {
    const h = makeDeps()
    const session = createMicCaptureSession(h.deps)
    await session.stop() // 从未 start
    expect(h.outputPort.closed()).toBe(true)
    await session.start() // 未 start 过的会话可正常启动
    await session.stop()
    await session.stop()
    expect(h.fakeTrack.stopped()).toBe(true)
    expect(h.statuses).toEqual(['starting', 'capturing', 'idle'])
  })

  it('start 期间 busy：重复 start 拒绝', async () => {
    const base = makeDeps()
    const release = { fn: null as null | (() => void) }
    const stream: MicStreamLike = { getAudioTracks: () => [base.fakeTrack.track] }
    const deps: MicCaptureSessionDeps = {
      ...base.deps,
      getUserMedia: () =>
        new Promise((resolve) => {
          release.fn = () => resolve(stream)
        })
    }
    const session = createMicCaptureSession(deps)
    const starting = session.start()
    await expect(session.start()).rejects.toThrow(/busy/)
    release.fn?.()
    await starting
    expect(session.status).toBe('capturing')
    await session.stop()
  })
})

describe('P3B-13 capture：权限失败可恢复', () => {
  it('NotAllowedError → kind=permission-denied，资源清理，可再次 start', async () => {
    let denied = true
    const stream: MicStreamLike = { getAudioTracks: () => [makeFakeTrack().track] }
    const h = makeDeps({
      getUserMedia: async () => {
        if (denied) {
          throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })
        }
        return stream
      }
    })
    const session = createMicCaptureSession(h.deps)
    await expect(session.start()).rejects.toThrow(/permission-denied/)
    expect(session.lastError?.kind).toBe('permission-denied')
    expect(session.status).toBe('idle')
    expect(h.outputPort.closed()).toBe(true)
    expect(h.errors).toEqual([{ kind: 'permission-denied', message: 'Permission denied' }])

    // 用户授权后重试：新会话（新 port 由编排层建）或同会话重跑——同会话的 port
    // 已关，重跑需新 port；这里验证「状态可恢复到能再次 start」
    denied = false
    const h2 = makeDeps({ getUserMedia: async () => stream })
    const session2 = createMicCaptureSession(h2.deps)
    await session2.start()
    expect(session2.status).toBe('capturing')
    await session2.stop()
  })

  it('NotFoundError → kind=not-found', async () => {
    const h = makeDeps({
      getUserMedia: async () => {
        throw Object.assign(new Error('no device'), { name: 'NotFoundError' })
      }
    })
    const session = createMicCaptureSession(h.deps)
    await expect(session.start()).rejects.toThrow(/not-found/)
    expect(session.lastError?.kind).toBe('not-found')
  })

  it('worklet 加载失败 → kind=failed，track 已开则先关（灯灭）', async () => {
    const h = makeDeps({ addModuleError: new Error('worklet load failed') })
    const session = createMicCaptureSession(h.deps)
    await expect(session.start()).rejects.toThrow(/failed/)
    expect(session.lastError?.kind).toBe('failed')
    expect(h.fakeTrack.stopped()).toBe(true)
    expect(h.outputPort.closed()).toBe(true)
    expect(session.status).toBe('idle')
  })
})

describe('P3B-13 capture：设备拔出', () => {
  it('采集中 track ended → 清理 + device-lost + 回 idle', async () => {
    const h = makeDeps()
    const session = createMicCaptureSession(h.deps)
    await session.start()
    h.fakeTrack.emitEnded()
    expect(session.status).toBe('idle')
    expect(session.lastError?.kind).toBe('device-lost')
    expect(h.fakeTrack.stopped()).toBe(true)
    expect(h.contextClosed()).toBe(true)
    expect(h.outputPort.closed()).toBe(true)
    expect(h.statuses).toEqual(['starting', 'capturing', 'idle'])
  })

  it('stop 之后再触发 ended（迟到事件）不产生新错误', async () => {
    const h = makeDeps()
    const session = createMicCaptureSession(h.deps)
    await session.start()
    await session.stop()
    h.fakeTrack.emitEnded()
    expect(h.errors).toHaveLength(0)
  })
})

describe('P3B-13 纯函数', () => {
  it('classifyCaptureError 错误名映射', () => {
    const mk = (name: string): Error => Object.assign(new Error('x'), { name })
    expect(classifyCaptureError(mk('NotAllowedError'))).toBe('permission-denied')
    expect(classifyCaptureError(mk('SecurityError'))).toBe('permission-denied')
    expect(classifyCaptureError(mk('NotFoundError'))).toBe('not-found')
    expect(classifyCaptureError(mk('OverconstrainedError'))).toBe('not-found')
    expect(classifyCaptureError(mk('AbortError'))).toBe('failed')
    expect(classifyCaptureError(new Error('plain'))).toBe('failed')
    expect(classifyCaptureError('str')).toBe('failed')
  })

  it('frameLevel：静音 0、半幅正弦 ≈ 0.5×0.707', () => {
    expect(frameLevel(new Int16Array(512))).toBe(0)
    const sine = new Int16Array(512)
    for (let i = 0; i < 512; i++) {
      sine[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / 16_000) * 0.5 * 32_767)
    }
    expect(frameLevel(sine)).toBeGreaterThan(0.3)
    expect(frameLevel(sine)).toBeLessThan(0.4)
  })
})
