// src/main/voice/listening-service.test.ts
// P3B-14：语音输入会话编排——start/停止/mic port/事件流。
// 假 engineManager + 假 VAD 管线 + 假 port；事件收集断言。
// P3V-09：主/备回退——启动期获取回退、识别期一次切换、不链式。

import { describe, expect, it, vi } from 'vitest'
import { createVoiceListeningService, type MicPortMainLike } from './listening-service'
import type { AsrEngineManager } from './asr/engine-manager'
import { createVadProcessor, type VadProcessor } from './vad/vad-processor'
import type { SileroVadRecognizer } from './vad/silero-binding'
import type { VoiceEvent } from '@shared/voice/voice-events'
import type { AsrEngineId } from '@shared/voice/asr-settings-types'
import type { AsrEngine } from '@shared/voice/asr-types'
import type { AsrStreamSession, AsrStreamingEngine } from '@shared/voice/asr-stream-types'
import { AsrEngineError } from './asr/engine-error'
import { makeSilentPcm16, makeSinePcm16 } from '../../../tests/helpers/silent-pcm'
import { createMetrics } from '../observability/metrics'

function makeFakePort(): {
  port: MicPortMainLike
  emitMessage: (data: unknown) => void
  emitClose: () => void
  closed: () => boolean
  started: () => boolean
} {
  const messageListeners: Array<(event: { data: unknown }) => void> = []
  const closeListeners: Array<() => void> = []
  const state = { closed: false, started: false }
  return {
    port: {
      on(event, listener) {
        if (event === 'message')
          messageListeners.push(listener as (event: { data: unknown }) => void)
        else closeListeners.push(listener as () => void)
      },
      start() {
        state.started = true
      },
      close() {
        state.closed = true
      }
    },
    emitMessage: (data) => {
      for (const l of [...messageListeners]) l({ data })
    },
    emitClose: () => {
      for (const l of [...closeListeners]) l()
    },
    closed: () => state.closed,
    started: () => state.started
  }
}

/** 脚本化流式会话：按顺序返回预设的 partial / final，供 P3V-09 流式路径测试。 */
export interface FakeStreamScript {
  /** 每次 feed 后 partial() 返回的文本；用完后返回 null。 */
  partials?: string[]
  /** takeFinalNow() 返回的文本（VAD 判定说完时）。 */
  finalText?: string
  /** 第 N 次 feed 后 takeFinalAtEndpoint() 命中（模拟长独白强制切段）。 */
  endpointAtFeed?: number
  /** finish() 冲刷出的尾巴。 */
  tailText?: string
  /** feed 抛错（模拟原生层解码失败）。 */
  feedError?: boolean
}

function makeFakeStreamSession(
  engineId: AsrEngineId,
  script: FakeStreamScript,
  trace: { feeds: number; disposed: boolean }
): AsrStreamSession {
  let partialIndex = 0
  return {
    engineId,
    localOnly: true,
    feed() {
      trace.feeds++
      if (script.feedError === true) {
        throw new AsrEngineError('recognize-failed', 'decode error')
      }
    },
    partial: () => {
      const text = script.partials?.[partialIndex]
      if (text === undefined) return null
      partialIndex++
      return { text }
    },
    takeFinalAtEndpoint: () =>
      script.endpointAtFeed !== undefined && trace.feeds === script.endpointAtFeed
        ? { text: '强制切段' }
        : null,
    takeFinalNow: () => (script.finalText === undefined ? null : { text: script.finalText }),
    finish: () => (script.tailText === undefined ? null : { text: script.tailText }),
    dispose: () => {
      trace.disposed = true
    }
  }
}

/** 假 engineManager 的全部可注入行为（主/备按 engineId 分派）。 */
export interface FakeManagerConfig {
  vadReady?: boolean
  /** 旧开关：false = 主引擎获取抛 model-missing。 */
  modelReady?: boolean
  /** 主引擎 id。缺省：给了 streaming 脚本 → zipformer-bilingual，否则 sensevoice。 */
  selectedId?: AsrEngineId
  /** P3V-09：备用引擎 id（null = 不设备用）。 */
  fallbackId?: AsrEngineId | null
  /** 主引擎获取（ensure*）抛的错误。 */
  primaryAcquireError?: AsrEngineError
  /** 备用引擎获取抛的错误。 */
  fallbackAcquireError?: AsrEngineError
  /** 主离线引擎 recognize 行为。 */
  recognizeText?: string
  recognizeError?: boolean
  /** 主流式脚本（同时决定缺省 selectedId 走流式）。 */
  streaming?: FakeStreamScript
  streamTrace?: { feeds: number; disposed: boolean }
  /** 备用引擎的离线 recognize / 流式脚本。 */
  fallbackRecognizeText?: string
  fallbackStreaming?: FakeStreamScript
  fallbackStreamTrace?: { feeds: number; disposed: boolean }
  /** ensure* 调用记录（'streaming:<id>' / 'offline:<id>'）。 */
  ensureLog?: string[]
}

function makeFakeEngineManager(cfg: FakeManagerConfig = {}): AsrEngineManager {
  const selectedId: AsrEngineId =
    cfg.selectedId ??
    (cfg.streaming !== undefined ? 'zipformer-bilingual-zh-en' : 'sherpa-sensevoice')
  const fallbackId = cfg.fallbackId ?? null
  const primaryError =
    cfg.primaryAcquireError ??
    (cfg.modelReady === false ? new AsrEngineError('model-missing', 'no model') : undefined)
  const emptyTrace = { feeds: 0, disposed: false }

  function offlineEngine(
    engineId: AsrEngineId,
    options: { text?: string; error?: boolean }
  ): AsrEngine {
    return {
      id: engineId,
      localOnly: true as const,
      state: 'ready' as const,
      loadModel: async () => {},
      recognize: async () => {
        if (options.error === true) {
          throw new AsrEngineError('recognize-failed', 'decode error')
        }
        return { text: options.text ?? '你好世界', segments: [] }
      },
      onProgress: () => () => {}
    }
  }
  function streamingEngine(
    engineId: AsrEngineId,
    script: FakeStreamScript,
    trace: { feeds: number; disposed: boolean }
  ): AsrStreamingEngine {
    return {
      id: engineId,
      localOnly: true as const,
      streaming: true as const,
      state: 'ready' as const,
      loadModel: async () => {},
      startStream: () => makeFakeStreamSession(engineId, script, trace),
      dispose: () => {}
    }
  }
  /** 主备分派：给到 fallbackId 的调用走备用行为，其余走主引擎行为。 */
  function dispatch(engineId: AsrEngineId): {
    error?: AsrEngineError
    script?: FakeStreamScript
    trace?: { feeds: number; disposed: boolean }
    text?: string
    error2?: boolean
  } {
    if (engineId === fallbackId) {
      return {
        error: cfg.fallbackAcquireError,
        script: cfg.fallbackStreaming,
        trace: cfg.fallbackStreamTrace,
        text: cfg.fallbackRecognizeText
      }
    }
    return {
      error: primaryError,
      script: cfg.streaming,
      trace: cfg.streamTrace,
      text: cfg.recognizeText,
      error2: cfg.recognizeError
    }
  }

  return {
    getOverview: () => ({
      selectedEngineId: selectedId,
      fallbackEngineId: fallbackId,
      engines: [],
      vadModel: { state: 'ready' }
    }),
    selectedEngineId: () => selectedId,
    fallbackEngineId: () => fallbackId,
    ensureStreamingEngineReady: async (engineId: AsrEngineId) => {
      cfg.ensureLog?.push(`streaming:${engineId}`)
      const d = dispatch(engineId)
      if (d.error !== undefined) throw d.error
      return streamingEngine(engineId, d.script ?? {}, d.trace ?? { ...emptyTrace })
    },
    ensureEngineReady: async (engineId: AsrEngineId) => {
      cfg.ensureLog?.push(`offline:${engineId}`)
      const d = dispatch(engineId)
      if (d.error !== undefined) throw d.error
      return offlineEngine(engineId, { text: d.text, error: d.error2 })
    },
    selectEngine: async () => true,
    setFallbackEngine: async () => true,
    downloadModel: () => {},
    cancelDownload: () => false,
    pauseDownload: () => false,
    resumeDownload: () => false,
    deleteModel: async () => true,
    downloadVadModel: () => {},
    cancelVadDownload: () => false,
    vadModelPath: () => (cfg.vadReady === false ? null : '/fake/vad/silero_vad.onnx'),
    vadModelReady: () => cfg.vadReady !== false,
    dispose: () => {}
  }
}

function makeFakeProcessor(): VadProcessor {
  return {
    get state() {
      return 'idle' as const
    },
    processChunk: () => [],
    flush: () => null,
    reset: () => {},
    close: () => {}
  }
}

function makeScriptedRecognizer(flags: boolean[]): SileroVadRecognizer {
  const accepted: Float32Array[] = []
  return {
    acceptWaveform(samples) {
      accepted.push(samples)
    },
    isDetected() {
      return flags[accepted.length - 1] ?? false
    },
    isEmpty: () => true,
    pop() {
      /* noop */
    },
    reset() {
      /* noop */
    },
    close() {
      /* noop */
    }
  }
}

function makeService(
  cfg: FakeManagerConfig & {
    onFrame?: (data: Int16Array) => void
    createVadError?: boolean
    /** 给了就用真 VadProcessor + 脚本化 isDetected（驱动 speech_start/end）。 */
    vadFlags?: boolean[]
  } = {}
): {
  service: ReturnType<typeof createVoiceListeningService>
  events: VoiceEvent[]
  getProcessor: () => VadProcessor | null
  engineManager: AsrEngineManager
  metrics: ReturnType<typeof createMetrics>
} {
  const engineManager = makeFakeEngineManager(cfg)
  const events: VoiceEvent[] = []
  const metrics = createMetrics()
  let processor: VadProcessor | null = null
  const service = createVoiceListeningService({
    engineManager,
    createVadProcessor: (modelPath) => {
      expect(modelPath).toBe('/fake/vad/silero_vad.onnx')
      if (cfg.createVadError === true) throw new Error('VAD init failed')
      if (cfg.vadFlags !== undefined) {
        processor = createVadProcessor({ recognizer: makeScriptedRecognizer(cfg.vadFlags) })
      } else {
        processor = makeFakeProcessor()
      }
      if (cfg.onFrame) {
        const orig = processor.processChunk
        processor.processChunk = (chunk) => {
          cfg.onFrame?.(chunk)
          return orig(chunk)
        }
      }
      return processor
    },
    emitEvent: (event) => events.push(event),
    metrics,
    processRssBytes: () => 256 * 1024 * 1024
  })
  return { service, events, getProcessor: () => processor, engineManager, metrics }
}

describe('P3B-14 listening-service：启动', () => {
  it('就绪后 start → listening-started，vad-state idle 投影', async () => {
    const h = makeService()
    await h.service.start()
    expect(h.service.active).toBe(true)
    expect(h.events).toEqual([{ type: 'listening-started' }])
    expect(h.service.vadState).toBe('idle')
    expect(h.metrics.snapshot()['asr.processRssMb']).toBe(256)
  })

  it('VAD 模型缺失 → AppError(ASR_MODEL_MISSING)，不进入 active', async () => {
    const h = makeService({ vadReady: false })
    await expect(h.service.start()).rejects.toMatchObject({ code: 'ASR_MODEL_MISSING' })
    expect(h.service.active).toBe(false)
  })

  it('引擎模型缺失 → AppError(ASR_MODEL_MISSING)', async () => {
    const h = makeService({ modelReady: false })
    await expect(h.service.start()).rejects.toMatchObject({ code: 'ASR_MODEL_MISSING' })
    expect(h.metrics.snapshot()['asr.errors']).toBe(1)
  })

  it('重复 start 幂等（只发一次 listening-started）', async () => {
    const h = makeService()
    await h.service.start()
    await h.service.start()
    expect(h.events.filter((e) => e.type === 'listening-started')).toHaveLength(1)
  })

  it('流式模型缺失仍映射 ASR_MODEL_MISSING', async () => {
    const h = makeService({ streaming: {}, modelReady: false })
    await expect(h.service.start()).rejects.toMatchObject({ code: 'ASR_MODEL_MISSING' })
    expect(h.service.active).toBe(false)
    expect(h.metrics.snapshot()['asr.errors']).toBe(1)
  })

  it('流式 session 已创建但 VAD 初始化失败 → 释放 session 并映射 ASR_INIT_FAIL', async () => {
    const trace = { feeds: 0, disposed: false }
    const h = makeService({ streaming: {}, streamTrace: trace, createVadError: true })
    await expect(h.service.start()).rejects.toMatchObject({ code: 'ASR_INIT_FAIL' })
    expect(trace.disposed).toBe(true)
    expect(h.service.active).toBe(false)
    expect(h.events).not.toContainEqual({ type: 'listening-started' })
    expect(h.metrics.snapshot()['asr.errors']).toBe(1)
  })
})

describe('P3B-14 listening-service：帧 → 事件流（真 VadProcessor + 脚本化 recognizer）', () => {
  const SINE = (): Int16Array => makeSinePcm16(220, 32, 0.6)
  const SILENT = (): Int16Array => makeSilentPcm16(32)

  it('正弦帧 3 命中 → vad-state active；48 静音帧 → speech_end → transcript', async () => {
    const h = makeService({
      recognizeText: '测试转写',
      vadFlags: [...Array(12).fill(true)]
    })
    await h.service.start()
    const p = makeFakePort()
    h.service.acceptMicPort(p.port)
    expect(p.started()).toBe(true)

    // 10 帧语音位（第 3 帧触发 speech_start），之后静音
    for (let i = 0; i < 10; i++) p.emitMessage({ type: 'mic-frame', samples: SINE() })
    expect(h.events).toContainEqual({ type: 'vad-state', state: 'active' })
    for (let i = 0; i < 48; i++) p.emitMessage({ type: 'mic-frame', samples: SILENT() })
    await vi.waitFor(() => {
      expect(h.events).toContainEqual({ type: 'transcript', text: '测试转写' })
    })
    // 识别完成后回 idle
    expect(h.events).toContainEqual({ type: 'vad-state', state: 'idle' })
    const snapshot = h.metrics.snapshot()
    expect(snapshot['asr.latencyMs.count']).toBe(1)
    expect(snapshot['asr.processRssMb']).toBe(256)
    await h.service.stop()
  })

  it('识别失败 → asr-error，会话继续（无备用时就是终态）', async () => {
    const h = makeService({
      recognizeError: true,
      vadFlags: [...Array(12).fill(true)]
    })
    await h.service.start()
    const p = makeFakePort()
    h.service.acceptMicPort(p.port)
    for (let i = 0; i < 10; i++) p.emitMessage({ type: 'mic-frame', samples: SINE() })
    for (let i = 0; i < 48; i++) p.emitMessage({ type: 'mic-frame', samples: SILENT() })
    await vi.waitFor(() => {
      expect(h.events).toContainEqual({ type: 'asr-error', code: 'recognize-failed' })
    })
    const snapshot = h.metrics.snapshot()
    expect(snapshot['asr.errors']).toBe(1)
    expect(snapshot['asr.latencyMs.count']).toBe(1)
    expect(h.service.active).toBe(true) // 会话继续
    await h.service.stop()
  })

  it('流式：每个合法帧进入 session；partial 只做预览，不冒充 final', async () => {
    const trace = { feeds: 0, disposed: false }
    const h = makeService({ streaming: { partials: ['你', '你好'] }, streamTrace: trace })
    await h.service.start()
    const p = makeFakePort()
    h.service.acceptMicPort(p.port)

    p.emitMessage({ type: 'mic-frame', samples: SINE() })
    p.emitMessage({ type: 'mic-frame', samples: SINE() })

    expect(trace.feeds).toBe(2)
    expect(h.events).toContainEqual({ type: 'transcript-partial', text: '你' })
    expect(h.events).toContainEqual({ type: 'transcript-partial', text: '你好' })
    expect(h.events.some((event) => event.type === 'transcript')).toBe(false)
    await h.service.stop()
  })

  it('流式：recognizer endpoint 命中时强制切段，当前帧不再发 partial', async () => {
    const trace = { feeds: 0, disposed: false }
    const h = makeService({
      streaming: { partials: ['不应在 endpoint 同帧出现'], endpointAtFeed: 1 },
      streamTrace: trace
    })
    await h.service.start()
    const p = makeFakePort()
    h.service.acceptMicPort(p.port)
    p.emitMessage({ type: 'mic-frame', samples: SINE() })

    expect(h.events).toContainEqual({ type: 'transcript', text: '强制切段' })
    expect(h.events.some((event) => event.type === 'transcript-partial')).toBe(false)
    await h.service.stop()
  })

  it('流式：VAD speech_end 用 takeFinalNow 定稿并记录延迟，会话继续', async () => {
    const trace = { feeds: 0, disposed: false }
    const h = makeService({
      streaming: { finalText: '流式定稿' },
      streamTrace: trace,
      vadFlags: [...Array(12).fill(true)]
    })
    await h.service.start()
    const p = makeFakePort()
    h.service.acceptMicPort(p.port)
    for (let i = 0; i < 10; i++) p.emitMessage({ type: 'mic-frame', samples: SINE() })
    for (let i = 0; i < 48; i++) p.emitMessage({ type: 'mic-frame', samples: SILENT() })

    expect(h.events).toContainEqual({ type: 'transcript', text: '流式定稿' })
    expect(trace.feeds).toBe(58)
    expect(h.service.active).toBe(true)
    expect(h.metrics.snapshot()['asr.latencyMs.count']).toBe(1)
    await h.service.stop()
  })

  it('流式：单帧 decode 失败发 asr-error，但采集会话继续消费后续帧', async () => {
    const trace = { feeds: 0, disposed: false }
    const h = makeService({ streaming: { feedError: true }, streamTrace: trace })
    await h.service.start()
    const p = makeFakePort()
    h.service.acceptMicPort(p.port)
    p.emitMessage({ type: 'mic-frame', samples: SINE() })
    p.emitMessage({ type: 'mic-frame', samples: SINE() })

    expect(trace.feeds).toBe(2)
    expect(h.events.filter((event) => event.type === 'asr-error')).toHaveLength(2)
    expect(h.events).toContainEqual({ type: 'asr-error', code: 'recognize-failed' })
    expect(h.service.active).toBe(true)
    expect(h.metrics.snapshot()['asr.errors']).toBe(2)
    await h.service.stop()
  })

  it('流式：stop 冲刷尾巴并 dispose；重复 stop 不重复冲刷', async () => {
    const trace = { feeds: 0, disposed: false }
    const h = makeService({ streaming: { tailText: '未完尾巴' }, streamTrace: trace })
    await h.service.start()
    await h.service.stop()
    await h.service.stop()

    expect(h.events.filter((event) => event.type === 'transcript')).toEqual([
      { type: 'transcript', text: '未完尾巴' }
    ])
    expect(trace.disposed).toBe(true)
    expect(h.events.filter((event) => event.type === 'listening-stopped')).toEqual([
      { type: 'listening-stopped', reason: 'user' }
    ])
  })

  it('流式：对端 close 同样冲刷尾巴、dispose 并允许重新 start', async () => {
    const trace = { feeds: 0, disposed: false }
    const h = makeService({ streaming: { tailText: '关闭尾巴' }, streamTrace: trace })
    await h.service.start()
    const p = makeFakePort()
    h.service.acceptMicPort(p.port)
    p.emitClose()

    expect(h.events).toContainEqual({ type: 'transcript', text: '关闭尾巴' })
    expect(h.events).toContainEqual({ type: 'listening-stopped', reason: 'mic-closed' })
    expect(trace.disposed).toBe(true)
    expect(h.service.active).toBe(false)
    await h.service.start()
    expect(h.service.active).toBe(true)
    await h.service.stop()
  })

  it('stop → listening-stopped(user)；vadState 复位', async () => {
    const h = makeService()
    await h.service.start()
    await h.service.stop()
    expect(h.events).toContainEqual({ type: 'listening-stopped', reason: 'user' })
    expect(h.service.active).toBe(false)
  })

  it('mic port 在非活跃时到达 → 立即关闭', async () => {
    const h = makeService()
    const p = makeFakePort()
    h.service.acceptMicPort(p.port)
    expect(p.closed()).toBe(true)
  })

  it('对端 close → mic-closed 事件 + 会话复位，可再次 start', async () => {
    const h = makeService()
    await h.service.start()
    const p = makeFakePort()
    h.service.acceptMicPort(p.port)
    p.emitClose()
    expect(h.events).toContainEqual({ type: 'listening-stopped', reason: 'mic-closed' })
    expect(h.service.active).toBe(false)
    // 复位后可重开
    await h.service.start()
    expect(h.service.active).toBe(true)
    const p2 = makeFakePort()
    h.service.acceptMicPort(p2.port)
    expect(p2.started()).toBe(true)
    await h.service.stop()
  })
})

describe('P3V-09 listening-service：主/备回退', () => {
  const SINE = (): Int16Array => makeSinePcm16(220, 32, 0.6)
  const SILENT = (): Int16Array => makeSilentPcm16(32)

  it('启动期：主引擎缺失 → asr-error + 备用接管，转写来自备用', async () => {
    const ensureLog: string[] = []
    const h = makeService({
      primaryAcquireError: new AsrEngineError('model-missing', 'no model'),
      fallbackId: 'funasr-paraformer',
      fallbackRecognizeText: '备用转写',
      vadFlags: [...Array(12).fill(true)],
      ensureLog
    })
    await h.service.start()
    expect(h.service.active).toBe(true)
    expect(h.events).toContainEqual({ type: 'asr-error', code: 'model-missing' })

    const p = makeFakePort()
    h.service.acceptMicPort(p.port)
    for (let i = 0; i < 10; i++) p.emitMessage({ type: 'mic-frame', samples: SINE() })
    for (let i = 0; i < 48; i++) p.emitMessage({ type: 'mic-frame', samples: SILENT() })
    await vi.waitFor(() => {
      expect(h.events).toContainEqual({ type: 'transcript', text: '备用转写' })
    })
    // 主引擎先试过、备用后接管（顺序可证）
    expect(ensureLog.indexOf('offline:sherpa-sensevoice')).toBeLessThan(
      ensureLog.indexOf('offline:funasr-paraformer')
    )
    await h.service.stop()
  })

  it('启动期：主备都缺失 → 两条 asr-error + AppError(ASR_MODEL_MISSING)', async () => {
    const h = makeService({
      primaryAcquireError: new AsrEngineError('model-missing', 'no model'),
      fallbackId: 'funasr-paraformer',
      fallbackAcquireError: new AsrEngineError('model-missing', 'no model either')
    })
    await expect(h.service.start()).rejects.toMatchObject({ code: 'ASR_MODEL_MISSING' })
    expect(h.events.filter((e) => e.type === 'asr-error')).toHaveLength(2)
    expect(h.metrics.snapshot()['asr.errors']).toBe(2)
    expect(h.service.active).toBe(false)
  })

  it('启动期：主离线缺失 → 备流式接管（帧进备用 session，partial 照发）', async () => {
    const fallbackTrace = { feeds: 0, disposed: false }
    const h = makeService({
      primaryAcquireError: new AsrEngineError('model-missing', 'no model'),
      fallbackId: 'zipformer-streaming-zh-14m',
      fallbackStreaming: { partials: ['备', '备用'] },
      fallbackStreamTrace: fallbackTrace
    })
    await h.service.start()
    const p = makeFakePort()
    h.service.acceptMicPort(p.port)
    p.emitMessage({ type: 'mic-frame', samples: SINE() })
    p.emitMessage({ type: 'mic-frame', samples: SINE() })

    expect(fallbackTrace.feeds).toBe(2)
    expect(h.events).toContainEqual({ type: 'transcript-partial', text: '备' })
    expect(h.events).toContainEqual({ type: 'asr-error', code: 'model-missing' })
    await h.service.stop()
  })

  it('识别期：离线主引擎识别失败 → 异步切流式备用，下一句从备用流出', async () => {
    const ensureLog: string[] = []
    const fallbackTrace = { feeds: 0, disposed: false }
    const h = makeService({
      recognizeError: true,
      fallbackId: 'zipformer-streaming-zh-14m',
      fallbackStreaming: { partials: ['备用半成品'] },
      fallbackStreamTrace: fallbackTrace,
      vadFlags: [...Array(12).fill(true)],
      ensureLog
    })
    await h.service.start()
    const p = makeFakePort()
    h.service.acceptMicPort(p.port)
    // 第一句：speech_end → 主引擎 recognize 失败 → asr-error + 异步切换
    for (let i = 0; i < 10; i++) p.emitMessage({ type: 'mic-frame', samples: SINE() })
    for (let i = 0; i < 48; i++) p.emitMessage({ type: 'mic-frame', samples: SILENT() })
    await vi.waitFor(() => {
      expect(h.events).toContainEqual({ type: 'asr-error', code: 'recognize-failed' })
    })
    // 切换完成（备用引擎已加载）后，后续帧进备用流
    await vi.waitFor(() => {
      expect(ensureLog).toContainEqual('streaming:zipformer-streaming-zh-14m')
    })
    p.emitMessage({ type: 'mic-frame', samples: SINE() })
    await vi.waitFor(() => {
      expect(fallbackTrace.feeds).toBe(1)
    })
    expect(h.events).toContainEqual({ type: 'transcript-partial', text: '备用半成品' })
    expect(h.service.active).toBe(true) // 会话继续
    await h.service.stop()
  })

  it('识别期：主流式 feed 失败 → 切离线备用，下一句走离线 recognize', async () => {
    const primaryTrace = { feeds: 0, disposed: false }
    const ensureLog: string[] = []
    const h = makeService({
      streaming: { feedError: true },
      streamTrace: primaryTrace,
      fallbackId: 'sherpa-sensevoice',
      fallbackRecognizeText: '离线备用转写',
      vadFlags: [...Array(12).fill(true)],
      ensureLog
    })
    await h.service.start()
    const p = makeFakePort()
    h.service.acceptMicPort(p.port)
    // 第 1 帧失败触发异步切换；等切换落地再继续，避免帧序竞争。
    // 完成信号是主 session 被 dispose（ensureLog 在切换的同步前缀就写入，等它不算落地）
    p.emitMessage({ type: 'mic-frame', samples: SINE() })
    expect(h.events).toContainEqual({ type: 'asr-error', code: 'recognize-failed' })
    await vi.waitFor(() => {
      expect(primaryTrace.disposed).toBe(true)
    })
    expect(ensureLog).toContainEqual('offline:sherpa-sensevoice')
    for (let i = 0; i < 9; i++) p.emitMessage({ type: 'mic-frame', samples: SINE() })
    for (let i = 0; i < 48; i++) p.emitMessage({ type: 'mic-frame', samples: SILENT() })
    await vi.waitFor(() => {
      expect(h.events).toContainEqual({ type: 'transcript', text: '离线备用转写' })
    })
    expect(h.service.active).toBe(true)
    await h.service.stop()
  })

  it('识别期：备用只试一次——备用也失败后不再重复尝试，会话继续', async () => {
    const ensureLog: string[] = []
    const h = makeService({
      streaming: { feedError: true },
      fallbackId: 'sherpa-sensevoice',
      fallbackAcquireError: new AsrEngineError('engine-init-failed', 'fallback broken'),
      ensureLog
    })
    await h.service.start()
    const p = makeFakePort()
    h.service.acceptMicPort(p.port)
    p.emitMessage({ type: 'mic-frame', samples: SINE() })
    p.emitMessage({ type: 'mic-frame', samples: SINE() })
    // 2 条帧错误 + 1 条备用失败错误
    await vi.waitFor(() => {
      expect(h.events.filter((e) => e.type === 'asr-error')).toHaveLength(3)
    })
    // 后续帧继续失败（主 session 还在），但不再发起第二次备用尝试
    p.emitMessage({ type: 'mic-frame', samples: SINE() })
    p.emitMessage({ type: 'mic-frame', samples: SINE() })
    await vi.waitFor(() => {
      expect(h.events.filter((e) => e.type === 'asr-error')).toHaveLength(5)
    })
    expect(ensureLog.filter((entry) => entry === 'offline:sherpa-sensevoice')).toHaveLength(1)
    expect(h.service.active).toBe(true)
    await h.service.stop()
  })
})
