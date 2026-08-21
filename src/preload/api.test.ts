// src/preload/api.test.ts
// P1-26: Preload subscribe 退订测试
// 依据：S-004 #35（unsubscribe 移除包装 listener，无泄漏）
//       S-003 §3.7（subscribe/unsubscribe 模式）
//       S-001 P1-17 验收标准（事件退订后不再触发）

import { describe, it, expect, vi, beforeEach } from 'vitest'

// 动态 mock electron 模块。
// mock 维护 channel -> Set<listener> 映射，并提供 __emit 方法
// 让测试能验证"退订后事件不再触发 listener"的真实行为。
vi.mock('electron', () => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  return {
    ipcRenderer: {
      invoke: vi.fn(),
      on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
        if (!listeners.has(channel)) {
          listeners.set(channel, new Set())
        }
        listeners.get(channel)!.add(listener)
      }),
      removeListener: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
        const set = listeners.get(channel)
        if (set) {
          set.delete(listener)
        }
      }),
      /** 测试辅助：模拟 IPC 事件分发，只触发当前仍在 Set 中的 listener */
      __emit(channel: string, ...args: unknown[]): void {
        const set = listeners.get(channel)
        if (set) {
          for (const l of [...set]) l(...args)
        }
      }
    },
    IpcRendererEvent: class {}
  }
})

// 模拟 contextBridge（preload 在主世界暴露 API 时需要）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).contextBridge = {
  exposeInMainWorld: vi.fn()
}

import { companionApi } from './api'
import { ipcRenderer } from 'electron'

const mockIpc = vi.mocked(ipcRenderer)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockEmit = (ipcRenderer as any).__emit as (channel: string, ...args: unknown[]) => void

describe('S-004 #35: Preload subscribe 退订', () => {
  beforeEach(() => {
    mockIpc.invoke.mockClear()
    mockIpc.on.mockClear()
    mockIpc.removeListener.mockClear()
  })

  describe('事件订阅', () => {
    it('app.onError 注册 listener 到 ipcRenderer', () => {
      const listener = vi.fn()
      companionApi.app.onError(listener)

      expect(mockIpc.on).toHaveBeenCalledWith('companion:event:app-error', expect.any(Function))
    })

    it('chat.onStream 注册 listener 到 ipcRenderer', () => {
      const listener = vi.fn()
      companionApi.chat.onStream(listener)

      expect(mockIpc.on).toHaveBeenCalledWith('companion:event:chat-stream', expect.any(Function))
    })

    it('window.onState 注册 listener 到 ipcRenderer', () => {
      const listener = vi.fn()
      companionApi.window.onState(listener)

      expect(mockIpc.on).toHaveBeenCalledWith('companion:event:window-state', expect.any(Function))
    })
  })

  describe('unsubscribe 移除包装 listener', () => {
    it('调用 unsubscribe 后 ipcRenderer.removeListener 被调用', () => {
      const listener = vi.fn()
      const unsubscribe = companionApi.app.onError(listener)

      // 获取注册时传入的包装函数
      const wrappedListener = mockIpc.on.mock.calls[0][1] as (...args: unknown[]) => void

      unsubscribe()

      // removeListener 应该用相同的包装函数引用被调用
      expect(mockIpc.removeListener).toHaveBeenCalledWith(
        'companion:event:app-error',
        wrappedListener
      )
    })

    it('chat.onStream unsubscribe 移除正确的 listener', () => {
      const listener = vi.fn()
      const unsubscribe = companionApi.chat.onStream(listener)

      const wrappedListener = mockIpc.on.mock.calls[0][1] as (...args: unknown[]) => void

      unsubscribe()

      expect(mockIpc.removeListener).toHaveBeenCalledWith(
        'companion:event:chat-stream',
        wrappedListener
      )
    })

    it('window.onState unsubscribe 移除正确的 listener', () => {
      const listener = vi.fn()
      const unsubscribe = companionApi.window.onState(listener)

      const wrappedListener = mockIpc.on.mock.calls[0][1] as (...args: unknown[]) => void

      unsubscribe()

      expect(mockIpc.removeListener).toHaveBeenCalledWith(
        'companion:event:window-state',
        wrappedListener
      )
    })
  })

  describe('退订后不再触发回调', () => {
    it('unsubscribe 后 IPC 事件不再触发 listener', () => {
      const received: unknown[] = []
      const unsubscribe = companionApi.chat.onStream((event) => {
        received.push(event)
      })

      const testEvent = {
        type: 'chunk' as const,
        requestId: 'r1',
        sequence: 1,
        delta: 'hello'
      }

      // 退订前：分发事件，listener 应收到
      mockEmit('companion:event:chat-stream', {}, testEvent)
      expect(received.length).toBe(1)

      // 退订
      unsubscribe()

      // removeListener 被调用，传入相同的包装函数引用
      const wrappedListener = mockIpc.on.mock.calls[0][1] as (...args: unknown[]) => void
      expect(mockIpc.removeListener).toHaveBeenCalledWith(
        'companion:event:chat-stream',
        wrappedListener
      )

      // 退订后：再次分发事件，listener 不应收到（Set 中已移除）
      mockEmit('companion:event:chat-stream', {}, testEvent)
      expect(received.length).toBe(1) // 仍是 1，未增加到 2
    })
  })

  describe('多个订阅独立退订', () => {
    it('退订一个不影响另一个', () => {
      const received1: unknown[] = []
      const received2: unknown[] = []

      const unsub1 = companionApi.chat.onStream((event) => {
        received1.push(event)
      })
      companionApi.chat.onStream((event) => {
        received2.push(event)
      })

      const testEvent = {
        type: 'chunk' as const,
        requestId: 'r1',
        sequence: 1,
        delta: 'hello'
      }

      // 退订第一个之前：两者都收到
      mockEmit('companion:event:chat-stream', {}, testEvent)
      expect(received1.length).toBe(1)
      expect(received2.length).toBe(1)

      // 退订第一个
      unsub1()

      // removeListener 只被调用一次（针对 wrapped1）
      expect(mockIpc.removeListener).toHaveBeenCalledTimes(1)
      const wrapped1 = mockIpc.on.mock.calls[0][1] as (...args: unknown[]) => void
      expect(mockIpc.removeListener).toHaveBeenCalledWith('companion:event:chat-stream', wrapped1)

      // 再次分发：第一个不再收到，第二个仍收到
      mockEmit('companion:event:chat-stream', {}, testEvent)
      expect(received1.length).toBe(1) // 未增加
      expect(received2.length).toBe(2) // 增加了 1
    })
  })
})

describe('S-004 #35: API 只暴露固定通道', () => {
  it('companionApi 不包含 invoke/on/send 通用方法', () => {
    expect(companionApi).not.toHaveProperty('invoke')
    expect(companionApi).not.toHaveProperty('on')
    expect(companionApi).not.toHaveProperty('send')
  })

  it('每个 API 方法固定通道（编译时锁定）', () => {
    expect(companionApi.app).toBeDefined()
    expect(companionApi.window).toBeDefined()
    expect(companionApi.config).toBeDefined()
    expect(companionApi.chat).toBeDefined()
    expect(companionApi.debug).toBeDefined()
    expect(companionApi.memory).toBeDefined()
    expect(companionApi.growth).toBeDefined()

    expect(typeof companionApi.app.getInfo).toBe('function')
    expect(typeof companionApi.window.minimize).toBe('function')
    expect(typeof companionApi.config.get).toBe('function')
    expect(typeof companionApi.chat.send).toBe('function')
    expect(typeof companionApi.chat.getLastSession).toBe('function')
    expect(typeof companionApi.debug.getSnapshot).toBe('function')

    expect(typeof companionApi.app.onError).toBe('function')
    expect(typeof companionApi.chat.onStream).toBe('function')
    expect(typeof companionApi.window.onState).toBe('function')
  })

  it('chat namespace 恰好 7 invoke 方法 + onStream（P2-43 增 getLastSession，验收反馈⑥增 deleteTurn）', () => {
    expect(Object.keys(companionApi.chat).sort()).toEqual(
      ['cancel', 'createSession', 'deleteTurn', 'getLastSession', 'list', 'onStream', 'retry', 'send'].sort()
    )
  })

  it('chat.deleteTurn 固定调用 companion:chat:delete-turn', async () => {
    mockIpc.invoke.mockResolvedValue({ ok: true, data: { deletedIds: ['u1', 'a1'] } })
    const result = await companionApi.chat.deleteTurn({ sessionId: 's1', messageId: 'a1' })
    expect(mockIpc.invoke).toHaveBeenCalledWith('companion:chat:delete-turn', {
      sessionId: 's1',
      messageId: 'a1'
    })
    expect(result).toEqual({ ok: true, data: { deletedIds: ['u1', 'a1'] } })
  })

  it('chat.getLastSession 固定调用 companion:chat:get-last-session', async () => {
    mockIpc.invoke.mockResolvedValue({ ok: true, data: { sessionId: null } })
    await companionApi.chat.getLastSession()
    expect(mockIpc.invoke).toHaveBeenCalledWith('companion:chat:get-last-session', undefined)
  })

  it('memory namespace 恰好 11 invoke 方法 + onUpdated（S-003-补充 §3.6 + M-44 编辑 2 方法）', () => {
    const memoryKeys = Object.keys(companionApi.memory).sort()
    expect(memoryKeys).toEqual(
      [
        'getDmaeHistory',
        'getDmaeSnapshot',
        'getDetail',
        'getL0',
        'getOverview',
        'listL2',
        'onUpdated',
        'restore',
        'setL0Field',
        'setPinned',
        'softDelete',
        'updateContent'
      ].sort()
    )
    for (const k of memoryKeys) {
      expect(typeof (companionApi.memory as Record<string, unknown>)[k]).toBe('function')
    }
  })

  it('growth namespace 恰好 3 invoke 方法（无订阅，S-003-补充 §3.6）', () => {
    const growthKeys = Object.keys(companionApi.growth).sort()
    expect(growthKeys).toEqual(['getProfile', 'getTimeline', 'getTrend'])
    for (const k of growthKeys) {
      expect(typeof (companionApi.growth as Record<string, unknown>)[k]).toBe('function')
    }
  })
})
