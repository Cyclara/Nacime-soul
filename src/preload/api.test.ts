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
      // P3B-14：mic port 转交（postMessage 带 transfer）
      postMessage: vi.fn(),
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
    IpcRendererEvent: class {},
    // M-51：ui.setZoomFactor 直连 webFrame（沙箱 preload 可用）
    webFrame: {
      getZoomFactor: vi.fn(() => 1),
      setZoomFactor: vi.fn()
    }
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

  it('chat namespace 恰好 12 invoke 方法 + onStream（P2-43 增 getLastSession，⑥增 deleteTurn，⑥c 增 deleteMessage，⑦增 deleteSelected/clearSession，P2-44 增 search，P3C1-07 增 feedback，P3B-15A 增 ackRendered）', () => {
    expect(Object.keys(companionApi.chat).sort()).toEqual(
      [
        'ackRendered',
        'cancel',
        'clearSession',
        'createSession',
        'deleteMessage',
        'deleteSelected',
        'deleteTurn',
        'feedback',
        'getLastSession',
        'list',
        'onStream',
        'retry',
        'search',
        'send'
      ].sort()
    )
  })

  it('chat.feedback 固定调用 companion:chat:feedback（P3C1-07）', async () => {
    mockIpc.invoke.mockResolvedValue({ ok: true, data: { ok: true } })
    const result = await companionApi.chat.feedback({
      sessionId: 's1',
      turnId: 't1',
      messageId: 'm1',
      kind: 'dislike'
    })
    expect(mockIpc.invoke).toHaveBeenCalledWith('companion:chat:feedback', {
      sessionId: 's1',
      turnId: 't1',
      messageId: 'm1',
      kind: 'dislike'
    })
    expect(result).toEqual({ ok: true, data: { ok: true } })
  })

  // P3B-15A：paint ack 固定走 companion:chat:ack-rendered（F5-007 §1.5）
  it('chat.ackRendered 固定调用 companion:chat:ack-rendered', async () => {
    mockIpc.invoke.mockResolvedValue({ ok: true, data: undefined })
    const result = await companionApi.chat.ackRendered({ requestId: 'req_1', sequence: 42 })
    expect(mockIpc.invoke).toHaveBeenCalledWith('companion:chat:ack-rendered', {
      requestId: 'req_1',
      sequence: 42
    })
    expect(result).toEqual({ ok: true, data: undefined })
  })

  it('compliance namespace 恰好 1 invoke 方法（P3C1-08；无 event 通道--审查不可见原则）', () => {
    expect(Object.keys(companionApi.compliance).sort()).toEqual(['getSnapshot'])
  })

  it('compliance.getSnapshot 固定调用 companion:compliance:get-snapshot（P3C1-08）', async () => {
    mockIpc.invoke.mockResolvedValue({
      ok: true,
      data: { gateEnabled: true, gateScope: 'observe' }
    })
    const result = await companionApi.compliance.getSnapshot()
    expect(mockIpc.invoke).toHaveBeenCalledWith('companion:compliance:get-snapshot', undefined)
    expect(result).toEqual({ ok: true, data: { gateEnabled: true, gateScope: 'observe' } })
  })

  it('chat.deleteSelected 固定调用 companion:chat:delete-selected', async () => {
    mockIpc.invoke.mockResolvedValue({ ok: true, data: { deletedIds: ['u1', 'a1'] } })
    const result = await companionApi.chat.deleteSelected({
      sessionId: 's1',
      messageIds: ['u1', 'a1']
    })
    expect(mockIpc.invoke).toHaveBeenCalledWith('companion:chat:delete-selected', {
      sessionId: 's1',
      messageIds: ['u1', 'a1']
    })
    expect(result).toEqual({ ok: true, data: { deletedIds: ['u1', 'a1'] } })
  })

  it('chat.clearSession 固定调用 companion:chat:clear-session', async () => {
    mockIpc.invoke.mockResolvedValue({ ok: true, data: { removed: 6 } })
    const result = await companionApi.chat.clearSession({ sessionId: 's1' })
    expect(mockIpc.invoke).toHaveBeenCalledWith('companion:chat:clear-session', {
      sessionId: 's1'
    })
    expect(result).toEqual({ ok: true, data: { removed: 6 } })
  })

  it('chat.deleteMessage 固定调用 companion:chat:delete-message', async () => {
    mockIpc.invoke.mockResolvedValue({ ok: true, data: { deletedIds: ['a1'] } })
    const result = await companionApi.chat.deleteMessage({ sessionId: 's1', messageId: 'a1' })
    expect(mockIpc.invoke).toHaveBeenCalledWith('companion:chat:delete-message', {
      sessionId: 's1',
      messageId: 'a1'
    })
    expect(result).toEqual({ ok: true, data: { deletedIds: ['a1'] } })
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

  it('memory namespace 含 P3G 回收站三通道与固定白名单方法', () => {
    const memoryKeys = Object.keys(companionApi.memory).sort()
    expect(memoryKeys).toEqual(
      [
        'getDmaeHistory',
        'getDmaeSnapshot',
        'getDetail',
        'getL0',
        'getOverview',
        'listL2',
        'listRecycleBin',
        'onUpdated',
        'restore',
        'restoreFromRecycleBin',
        'emptyRecycleBin',
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

  // ── M-50：自动更新 API 面 ──
  it('app.checkForUpdates / getUpdateStatus / quitAndInstall 固定通道 + undefined 载荷', async () => {
    mockIpc.invoke.mockResolvedValue({ ok: true, data: undefined })
    await companionApi.app.checkForUpdates()
    expect(mockIpc.invoke).toHaveBeenCalledWith('companion:app:check-for-updates', undefined)

    mockIpc.invoke.mockResolvedValue({ ok: true, data: { state: 'idle' } })
    const status = await companionApi.app.getUpdateStatus()
    expect(mockIpc.invoke).toHaveBeenCalledWith('companion:app:get-update-status', undefined)
    expect(status).toEqual({ ok: true, data: { state: 'idle' } })

    mockIpc.invoke.mockResolvedValue({ ok: true, data: undefined })
    await companionApi.app.quitAndInstall()
    expect(mockIpc.invoke).toHaveBeenCalledWith('companion:app:quit-and-install', undefined)
  })

  it('app.onUpdateStatus 订阅 update-status 事件，非法载荷被 validator 拦截', () => {
    const received: unknown[] = []
    const unsubscribe = companionApi.app.onUpdateStatus((s) => received.push(s))

    mockEmit('companion:event:update-status', {}, { state: 'downloaded', version: '1.1.0' })
    mockEmit('companion:event:update-status', {}, { state: 'evil' })
    expect(received).toEqual([{ state: 'downloaded', version: '1.1.0' }])

    unsubscribe()
    mockEmit('companion:event:update-status', {}, { state: 'idle' })
    expect(received).toHaveLength(1)
  })

  // ── M-51：UI 缩放直连 webFrame ──
  it('ui.setZoomFactor / getZoomFactor 透传 webFrame，不走 IPC', async () => {
    // 本 describe 无 mockClear 的 beforeEach，先清掉前面用例累积的 invoke 记录
    mockIpc.invoke.mockClear()
    const { webFrame } = await import('electron')
    companionApi.ui.setZoomFactor(1.2)
    expect(vi.mocked(webFrame.setZoomFactor)).toHaveBeenCalledWith(1.2)
    vi.mocked(webFrame.getZoomFactor).mockReturnValue(1.2)
    expect(companionApi.ui.getZoomFactor()).toBe(1.2)
    expect(mockIpc.invoke).not.toHaveBeenCalled()
  })
})

describe('P3B-14 voice preload API', () => {
  beforeEach(() => {
    mockIpc.invoke.mockReset()
    mockIpc.postMessage.mockReset()
  })

  it('voice 命名空间方法固定通道（编译时锁定）', () => {
    expect(companionApi.voice).toBeDefined()
    expect(typeof companionApi.voice.getAsrOverview).toBe('function')
    expect(typeof companionApi.voice.downloadAsrModel).toBe('function')
    expect(typeof companionApi.voice.cancelAsrDownload).toBe('function')
    expect(typeof companionApi.voice.pauseAsrDownload).toBe('function')
    expect(typeof companionApi.voice.resumeAsrDownload).toBe('function')
    expect(typeof companionApi.voice.deleteAsrModel).toBe('function')
    expect(typeof companionApi.voice.selectAsrEngine).toBe('function')
    // P3V-11：备用引擎 + 大资源根目录四通道
    expect(typeof companionApi.voice.setAsrFallbackEngine).toBe('function')
    expect(typeof companionApi.voice.getAssetRoot).toBe('function')
    expect(typeof companionApi.voice.chooseAssetRoot).toBe('function')
    expect(typeof companionApi.voice.resetAssetRoot).toBe('function')
    expect(typeof companionApi.voice.startListening).toBe('function')
    expect(typeof companionApi.voice.stopListening).toBe('function')
    // P3B-18：TTS 编排三通道
    expect(typeof companionApi.voice.getVoiceState).toBe('function')
    expect(typeof companionApi.voice.testTts).toBe('function')
    expect(typeof companionApi.voice.cancelSpeaking).toBe('function')
    expect(typeof companionApi.voice.onAsrOverview).toBe('function')
    expect(typeof companionApi.voice.onVoiceState).toBe('function')
    expect(typeof companionApi.voice.openMicPort).toBe('function')
    // P3V-16：GPT runtime 一键安装六通道 + 大资产下载事件
    expect(typeof companionApi.voice.getGptRuntime).toBe('function')
    expect(typeof companionApi.voice.installGptRuntime).toBe('function')
    expect(typeof companionApi.voice.pauseGptRuntimeDownload).toBe('function')
    expect(typeof companionApi.voice.resumeGptRuntimeDownload).toBe('function')
    expect(typeof companionApi.voice.cancelGptRuntimeDownload).toBe('function')
    expect(typeof companionApi.voice.deleteGptRuntime).toBe('function')
    expect(typeof companionApi.voice.onAssetDownload).toBe('function')
    // P3V-17：选择/清除已有安装目录
    expect(typeof companionApi.voice.chooseGptRuntimeDir).toBe('function')
    expect(typeof companionApi.voice.clearGptRuntimeDir).toBe('function')
    // P3V-20：本地导入音色
    expect(typeof companionApi.voice.pickGptVoiceFile).toBe('function')
    expect(typeof companionApi.voice.importGptVoice).toBe('function')
    expect(typeof companionApi.voice.deleteGptVoice).toBe('function')
  })

  it('P3V-16：GPT runtime 六通道走固定通道（入参只有闭集变体，无路径）', async () => {
    mockIpc.invoke.mockResolvedValue({ ok: true, data: { ok: true } })
    await companionApi.voice.getGptRuntime()
    expect(mockIpc.invoke).toHaveBeenCalledWith('companion:voice:get-gpt-runtime', undefined)

    await companionApi.voice.installGptRuntime({ variant: 'rtx50' })
    expect(mockIpc.invoke).toHaveBeenCalledWith('companion:voice:gpt-runtime-install', {
      variant: 'rtx50'
    })

    await companionApi.voice.pauseGptRuntimeDownload({ variant: 'standard' })
    expect(mockIpc.invoke).toHaveBeenCalledWith('companion:voice:gpt-runtime-pause-download', {
      variant: 'standard'
    })
    await companionApi.voice.resumeGptRuntimeDownload({ variant: 'standard' })
    expect(mockIpc.invoke).toHaveBeenCalledWith('companion:voice:gpt-runtime-resume-download', {
      variant: 'standard'
    })
    await companionApi.voice.cancelGptRuntimeDownload({ variant: 'standard' })
    expect(mockIpc.invoke).toHaveBeenCalledWith('companion:voice:gpt-runtime-cancel-download', {
      variant: 'standard'
    })

    await companionApi.voice.deleteGptRuntime()
    expect(mockIpc.invoke).toHaveBeenCalledWith('companion:voice:gpt-runtime-delete', undefined)

    // P3V-17：目录选择在 main 侧完成，入参与回参都不带路径
    await companionApi.voice.chooseGptRuntimeDir()
    expect(mockIpc.invoke).toHaveBeenCalledWith('companion:voice:choose-gpt-runtime-dir', undefined)
    await companionApi.voice.clearGptRuntimeDir()
    expect(mockIpc.invoke).toHaveBeenCalledWith('companion:voice:clear-gpt-runtime-dir', undefined)

    // P3V-20：导入音色三通道（入参只有 kind / 元信息 / voiceId，无路径）
    await companionApi.voice.pickGptVoiceFile({ kind: 'ref-audio' })
    expect(mockIpc.invoke).toHaveBeenCalledWith('companion:voice:pick-gpt-voice-file', {
      kind: 'ref-audio'
    })
    const importRequest = {
      displayName: '樱羽艾玛1.0',
      version: 'v2ProPlus',
      promptText: 'おはようございます',
      promptLang: 'ja',
      defaultTextLang: 'ja'
    }
    await companionApi.voice.importGptVoice(importRequest)
    expect(mockIpc.invoke).toHaveBeenCalledWith('companion:voice:import-gpt-voice', importRequest)
    await companionApi.voice.deleteGptVoice({ voiceId: 'gpt-sovits:abc' })
    expect(mockIpc.invoke).toHaveBeenCalledWith('companion:voice:delete-gpt-voice', {
      voiceId: 'gpt-sovits:abc'
    })
  })

  it('P3B-18：getVoiceState / testTts / cancelSpeaking 走对应通道', async () => {
    mockIpc.invoke.mockResolvedValueOnce({ ok: true, data: { ttsEnabled: true } })
    await companionApi.voice.getVoiceState()
    expect(mockIpc.invoke).toHaveBeenCalledWith('companion:voice:get-state', undefined)

    mockIpc.invoke.mockResolvedValueOnce({ ok: true, data: undefined })
    await companionApi.voice.testTts({ text: '试听' })
    expect(mockIpc.invoke).toHaveBeenCalledWith('companion:voice:test-tts', { text: '试听' })

    mockIpc.invoke.mockResolvedValueOnce({ ok: true, data: undefined })
    await companionApi.voice.cancelSpeaking()
    expect(mockIpc.invoke).toHaveBeenCalledWith('companion:voice:cancel-speaking', undefined)
  })

  it('getAsrOverview / startListening / stopListening 走对应通道', async () => {
    mockIpc.invoke.mockResolvedValueOnce({ ok: true, data: { x: 1 } })
    await companionApi.voice.getAsrOverview()
    expect(mockIpc.invoke).toHaveBeenCalledWith('companion:voice:get-asr-overview', undefined)

    mockIpc.invoke.mockResolvedValueOnce({ ok: true, data: { ok: true } })
    await companionApi.voice.startListening()
    expect(mockIpc.invoke).toHaveBeenCalledWith('companion:voice:start-listening', undefined)

    mockIpc.invoke.mockResolvedValueOnce({ ok: true, data: { ok: true } })
    await companionApi.voice.stopListening()
    expect(mockIpc.invoke).toHaveBeenCalledWith('companion:voice:stop-listening', undefined)
  })

  it('P3V-11/13/15：下载控制/删除/备用 + 资源根走固定通道（入参无路径）', async () => {
    mockIpc.invoke.mockResolvedValue({ ok: true, data: { ok: true } })
    await companionApi.voice.pauseAsrDownload({ engineId: 'zipformer-bilingual-zh-en' })
    expect(mockIpc.invoke).toHaveBeenCalledWith('companion:voice:asr-pause-download', {
      engineId: 'zipformer-bilingual-zh-en'
    })
    await companionApi.voice.resumeAsrDownload({ engineId: 'zipformer-bilingual-zh-en' })
    expect(mockIpc.invoke).toHaveBeenCalledWith('companion:voice:asr-resume-download', {
      engineId: 'zipformer-bilingual-zh-en'
    })

    await companionApi.voice.deleteAsrModel({ engineId: 'sherpa-sensevoice' })
    expect(mockIpc.invoke).toHaveBeenCalledWith('companion:voice:asr-delete-model', {
      engineId: 'sherpa-sensevoice'
    })

    mockIpc.invoke.mockResolvedValue({ ok: true, data: { ok: true } })
    await companionApi.voice.setAsrFallbackEngine({ engineId: 'sherpa-sensevoice' })
    expect(mockIpc.invoke).toHaveBeenCalledWith('companion:voice:asr-set-fallback-engine', {
      engineId: 'sherpa-sensevoice'
    })
    await companionApi.voice.setAsrFallbackEngine({ engineId: null })
    expect(mockIpc.invoke).toHaveBeenCalledWith('companion:voice:asr-set-fallback-engine', {
      engineId: null
    })

    await companionApi.voice.getAssetRoot()
    expect(mockIpc.invoke).toHaveBeenCalledWith('companion:voice:get-asset-root', undefined)
    await companionApi.voice.chooseAssetRoot()
    expect(mockIpc.invoke).toHaveBeenCalledWith('companion:voice:choose-asset-root', undefined)
    await companionApi.voice.resetAssetRoot()
    expect(mockIpc.invoke).toHaveBeenCalledWith('companion:voice:reset-asset-root', undefined)
  })

  it('openMicPort：port2 经 postMessage 转交 main，port1 经 window.postMessage 交给页面', () => {
    // node 环境无 window：stub（preload 只在 openMicPort 运行时碰 window）
    const postMessageSpy = vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).window = { postMessage: postMessageSpy }
    companionApi.voice.openMicPort()
    expect(mockIpc.postMessage).toHaveBeenCalledTimes(1)
    const [channel, msg, transfer] = mockIpc.postMessage.mock.calls[0] as unknown as [
      string,
      null,
      MessagePort[]
    ]
    expect(channel).toBe('voice:mic-port')
    expect(msg).toBeNull()
    expect(transfer).toHaveLength(1)
    expect(transfer[0]).toBeInstanceOf(MessagePort)
    expect(postMessageSpy).toHaveBeenCalledWith(
      'voice:mic-port',
      '*',
      expect.arrayContaining([expect.any(Object)])
    )
  })
})
