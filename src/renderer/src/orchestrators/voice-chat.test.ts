// src/renderer/src/orchestrators/voice-chat.test.ts
// P3B-18/19（S-006-补充 §1.7.6）：语音输入闭环——transcript → draft（默认）/ send；
// start/stop 顺序合同（startListening → openMicPort → 采集）；采集错误静默停止；
// interruptSpeech 只停 TTS。全假件：不开 getUserMedia / worklet / IPC。

// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { nextTick, reactive } from 'vue'
import type { MicCaptureSessionDeps } from '../voice/mic-capture-session'
import { createVoiceChatOrchestrator, type VoiceSendMode } from './voice-chat'

interface Harness {
  orchestrator: ReturnType<typeof createVoiceChatOrchestrator>
  voiceState: { lastTranscript: string; micPermission: string; listening: boolean }
  chatState: { draft: string }
  sendCalls: number
  setSendable: (value: boolean) => void
  ipc: {
    startListening: ReturnType<typeof vi.fn>
    stopListening: ReturnType<typeof vi.fn>
    openMicPort: ReturnType<typeof vi.fn>
    cancelSpeaking: ReturnType<typeof vi.fn>
  }
  captureDeps: MicCaptureSessionDeps[]
  captureStarted: string[]
  captureStopped: number
  setMode: (mode: VoiceSendMode) => void
}

function makeHarness(opts?: { startOk?: boolean; startError?: string }): Harness {
  const voiceState = reactive({ lastTranscript: '', micPermission: 'unknown', listening: false })
  const chatState = reactive({ draft: '' })
  let sendable = true
  let sendCalls = 0
  let mode: VoiceSendMode = 'draft'
  const ipc = {
    startListening: vi.fn(async () =>
      opts?.startOk === false
        ? { ok: false as const, error: { code: opts.startError ?? 'ASR_MODEL_MISSING' } }
        : { ok: true as const, data: { ok: true as const } }
    ),
    stopListening: vi.fn(async () => ({ ok: true as const, data: { ok: true as const } })),
    openMicPort: vi.fn(),
    cancelSpeaking: vi.fn(async () => ({ ok: true as const, data: undefined }))
  }
  ;(globalThis as { window: unknown }).window = Object.assign(window, {
    companion: { voice: ipc }
  })
  const captureDeps: MicCaptureSessionDeps[] = []
  const captureStarted: string[] = []
  let captureStopped = 0
  const orchestrator = createVoiceChatOrchestrator({
    voice: {
      state: voiceState,
      setMicPermission: (next: string) => {
        voiceState.micPermission = next
      },
      setMicLevel: () => {},
      cancelSpeaking: async () => {
        await ipc.cancelSpeaking()
      }
    } as never,
    chat: {
      state: chatState,
      get canSend() {
        return sendable && chatState.draft.length > 0
      },
      setDraft: (value: string) => {
        chatState.draft = value
      },
      send: async () => {
        sendCalls += 1
        chatState.draft = ''
      }
    } as never,
    getSendMode: () => mode,
    workletUrl: () => 'about:blank',
    waitForMicPort: async () => ({ postMessage: () => {}, close: () => {} }) as never,
    createCapture: (deps) => {
      captureDeps.push(deps)
      return {
        start: async (deviceId?: string) => {
          captureStarted.push(deviceId ?? '(default)')
        },
        stop: async () => {
          captureStopped += 1
        },
        status: 'capturing',
        lastError: null
      } as never
    }
  })
  return {
    orchestrator,
    voiceState,
    chatState,
    get sendCalls() {
      return sendCalls
    },
    setSendable: (value) => {
      sendable = value
    },
    ipc,
    captureDeps,
    captureStarted,
    get captureStopped() {
      return captureStopped
    },
    setMode: (next) => {
      mode = next
    }
  }
}

describe('P3B-18 voice-chat orchestrator', () => {
  it('start：startListening → openMicPort → 采集（设备 id 透传）；stop 逆序收尾', async () => {
    const h = makeHarness()
    await h.orchestrator.start('mic-2')
    expect(h.orchestrator.listening).toBe(true)
    expect(h.ipc.startListening).toHaveBeenCalledTimes(1)
    expect(h.ipc.openMicPort).toHaveBeenCalledTimes(1)
    expect(h.captureStarted).toEqual(['mic-2'])
    expect(h.voiceState.micPermission).toBe('granted')
    // 幂等
    await h.orchestrator.start('mic-2')
    expect(h.captureStarted).toHaveLength(1)

    await h.orchestrator.stop()
    expect(h.orchestrator.listening).toBe(false)
    expect(h.captureStopped).toBe(1)
    expect(h.ipc.stopListening).toHaveBeenCalledTimes(1)
    await h.orchestrator.stop() // 幂等
    expect(h.ipc.stopListening).toHaveBeenCalledTimes(1)
  })

  it('main 拒绝（模型缺失）：不开 port、不采集、lastError 给设置页引导', async () => {
    const h = makeHarness({ startOk: false, startError: 'ASR_MODEL_MISSING' })
    await h.orchestrator.start()
    expect(h.orchestrator.listening).toBe(false)
    expect(h.ipc.openMicPort).not.toHaveBeenCalled()
    expect(h.captureStarted).toEqual([])
    expect(h.orchestrator.lastError).toContain('设置')
  })

  it('transcript → draft（默认「确认后发送」）：追加到已有草稿，不自动发送', async () => {
    const h = makeHarness()
    h.chatState.draft = '我想说'
    h.voiceState.lastTranscript = '今天天气不错'
    await nextTick()
    expect(h.chatState.draft).toBe('我想说今天天气不错')
    expect(h.sendCalls).toBe(0)

    // 同一段转写重复到达不重复写入
    h.voiceState.lastTranscript = '今天天气不错'
    await nextTick()
    expect(h.chatState.draft).toBe('我想说今天天气不错')

    // 新的一句照常追加
    h.voiceState.lastTranscript = '你觉得呢'
    await nextTick()
    expect(h.chatState.draft).toBe('我想说今天天气不错你觉得呢')
  })

  it('send 模式：写 draft 后直接 chat.send；活跃轮（canSend=false）退为 draft 不丢字', async () => {
    const h = makeHarness()
    h.setMode('send')
    h.voiceState.lastTranscript = '直接发出去'
    await nextTick()
    expect(h.sendCalls).toBe(1)
    expect(h.chatState.draft).toBe('')

    h.setSendable(false)
    h.voiceState.lastTranscript = '她还在回答时说的'
    await nextTick()
    expect(h.sendCalls).toBe(1)
    expect(h.chatState.draft).toBe('她还在回答时说的')
  })

  it('空白转写忽略；acceptTranscript 公开口径与订阅一致', async () => {
    const h = makeHarness()
    await h.orchestrator.acceptTranscript('   ', 'draft')
    expect(h.chatState.draft).toBe('')
    await h.orchestrator.acceptTranscript('  手动重提  ', 'draft')
    expect(h.chatState.draft).toBe('手动重提')
  })

  it('采集错误（权限拒绝）：自动停止 + micPermission + lastError；不抛', async () => {
    const h = makeHarness()
    await h.orchestrator.start()
    const deps = h.captureDeps[0]!
    deps.onError?.({ kind: 'permission-denied', message: 'denied' } as never)
    await Promise.resolve()
    expect(h.orchestrator.listening).toBe(false)
    expect(h.voiceState.micPermission).toBe('denied')
    expect(h.orchestrator.lastError).toContain('权限')
    expect(h.ipc.stopListening).toHaveBeenCalled()
  })

  it('interruptSpeech 只停 TTS（cancel-speaking），不碰采集/LLM', async () => {
    const h = makeHarness()
    await h.orchestrator.interruptSpeech()
    expect(h.ipc.cancelSpeaking).toHaveBeenCalledTimes(1)
    expect(h.ipc.stopListening).not.toHaveBeenCalled()
  })

  it('dispose：停订阅（后续 transcript 不再进 draft）+ 停采集', async () => {
    const h = makeHarness()
    await h.orchestrator.start()
    h.orchestrator.dispose()
    await Promise.resolve()
    h.voiceState.lastTranscript = '销毁后到达'
    await nextTick()
    expect(h.chatState.draft).toBe('')
    expect(h.captureStopped).toBe(1)
  })
})
