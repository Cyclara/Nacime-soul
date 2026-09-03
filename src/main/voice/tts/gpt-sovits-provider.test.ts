// src/main/voice/tts/gpt-sovits-provider.test.ts
// P3B-06：GPT-SoVITS adapter 合同。HTTP 层全部注入假 fetch、服务管理器用 stub
// （真进程/真 HTTP 已分别在 P3B-04/05 覆盖）；WAV 用 fixture 构造。
// 覆盖验收：空/NaN/Inf/坏容器拒绝（wav.test 已穷尽，这里走 adapter 全链）/
// 22.05k->24k 不变速变调 / PCM 有界 / 无 API key 外泄（永不带凭据头）。

import { describe, expect, it } from 'vitest'
import { AppError, isAppError } from '@shared/errors'
import type { Logger } from '@shared/observability/types'
import type { TtsProviderFactory } from '@shared/voice/tts-types'
import { makeWavBuffer } from '../../../../tests/helpers/wav-fixture'
import type { GptSovitsService } from './gpt-sovits-service'
import {
  createGptSovitsProviderFactory,
  type GptSovitsHttpResponse,
  type GptSovitsVoiceConfig
} from './gpt-sovits-provider'

function noopLogger(): Logger {
  const l: Logger = {
    fatal() {
      /* noop */
    },
    error() {
      /* noop */
    },
    warn() {
      /* noop */
    },
    info() {
      /* noop */
    },
    debug() {
      /* noop */
    },
    child: () => l
  }
  return l
}

const VOICE = {
  refAudioPath: 'D:/voices/nacime/ref.wav',
  promptText: '我是参考音频里的话。',
  promptLang: 'zh',
  defaultTextLang: 'zh'
}

function makeWavResponse(sampleRate = 22_050): GptSovitsHttpResponse {
  const samples = new Float32Array(2_205) // 100ms
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 0.5
  }
  const wav = makeWavBuffer({ sampleRate, channels: 1, sampleFormat: 's16', samples })
  const ab = new ArrayBuffer(wav.byteLength)
  new Uint8Array(ab).set(wav)
  return {
    status: 200,
    headers: { get: () => String(wav.length) },
    arrayBuffer: async () => ab
  }
}

interface FetchCall {
  url: string
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
}

interface Harness {
  factory: TtsProviderFactory
  calls: FetchCall[]
  setRunning: (baseUrl: string | null) => void
  /** P3V-19：模拟 api_v2 自动重启（重启后按 yaml 重载默认权重，已加载记账作废）。 */
  setRestartCount: (count: number) => void
  ensureReadyCalls: () => number
  response: () => Promise<GptSovitsHttpResponse>
  setResponse: (
    r: (
      url?: string,
      init?: {
        method?: string
        headers?: Record<string, string>
        body?: string
        signal?: AbortSignal
      }
    ) => Promise<GptSovitsHttpResponse>
  ) => void
}

function makeHarness(opts?: {
  resolveVoice?: (voiceId: string) => GptSovitsVoiceConfig | null
  requestTimeoutMs?: number
  maxResponseBytes?: number
}): Harness {
  const calls: FetchCall[] = []
  let currentBaseUrl: string | null = 'http://127.0.0.1:20001'
  let responseFn: (
    url?: string,
    init?: {
      method?: string
      headers?: Record<string, string>
      body?: string
      signal?: AbortSignal
    }
  ) => Promise<GptSovitsHttpResponse> = async () => makeWavResponse()
  let ensureReadyCalls = 0
  let restartCount = 0

  const service: GptSovitsService = {
    state: () => (currentBaseUrl !== null ? 'running' : 'idle'),
    baseUrl: () => currentBaseUrl,
    ensureReady: () => {
      ensureReadyCalls++
      return currentBaseUrl !== null
        ? Promise.resolve(currentBaseUrl)
        : Promise.reject(new AppError({ code: 'TTS_ENGINE_DOWN', severity: 'error' }))
    },
    checkHealth: async () => currentBaseUrl !== null,
    restartCount: () => restartCount,
    beginSynthesis: () => {},
    endSynthesis: () => {},
    reset: () => {},
    shutdown: async () => {}
  }

  const factory = createGptSovitsProviderFactory({
    logger: noopLogger(),
    service,
    fetch: (url, init) => {
      calls.push({ url, init })
      return responseFn(url, init)
    },
    resolveVoice: opts?.resolveVoice ?? ((voiceId) => (voiceId === 'nacime' ? VOICE : null)),
    requestTimeoutMs: opts?.requestTimeoutMs ?? 60_000,
    maxResponseBytes: opts?.maxResponseBytes ?? 64 * 1024 * 1024
  })

  return {
    factory,
    calls,
    ensureReadyCalls: () => ensureReadyCalls,
    setRunning: (url) => (currentBaseUrl = url),
    setRestartCount: (count) => (restartCount = count),
    response: () => responseFn(),
    setResponse: (fn) => (responseFn = fn)
  }
}

function bindOpts(opts?: {
  voiceId?: string
  speed?: number
}): Parameters<TtsProviderFactory['bind']>[0] {
  return {
    options: {
      voiceId: opts?.voiceId ?? 'nacime',
      speed: opts?.speed ?? 1,
      pitch: 0,
      volume: 1,
      requestedSampleRate: 24_000 as const
    },
    turnId: 'turn-1',
    requestId: 'req-1',
    signal: new AbortController().signal,
    runtime: 'packaged-production' as const
  }
}

async function boundProvider(
  h: Harness,
  voiceId?: string
): Promise<Exclude<Awaited<ReturnType<TtsProviderFactory['bind']>>, { textOnly: true }>> {
  const result = await h.factory.bind(voiceId === undefined ? bindOpts() : bindOpts({ voiceId }))
  if ('textOnly' in result) throw new Error(`expected provider, got ${JSON.stringify(result)}`)
  return result
}

function expectAppError(promise: Promise<unknown>, code: string): Promise<void> {
  return promise.then(
    () => {
      throw new Error('expected rejection')
    },
    (err: unknown) => {
      expect(isAppError(err)).toBe(true)
      expect((err as AppError).code).toBe(code)
    }
  )
}

describe('P3B-06 GPT-SoVITS adapter：bind 与资格', () => {
  it('voiceId 为空 / 未配置音色 -> voice-missing；不触碰服务', async () => {
    const h = makeHarness()
    expect(await h.factory.bind(bindOpts({ voiceId: '' }))).toEqual({
      textOnly: true,
      reason: 'voice-missing'
    })
    expect(await h.factory.bind(bindOpts({ voiceId: 'ghost' }))).toEqual({
      textOnly: true,
      reason: 'voice-missing'
    })
    expect(h.ensureReadyCalls()).toBe(0)
  })

  it('服务未就绪（冷启动）-> 本轮 textOnly 并后台预热，不阻塞 turn', async () => {
    const h = makeHarness()
    h.setRunning(null)
    const result = await h.factory.bind(bindOpts())
    expect(result).toEqual({ textOnly: true, reason: 'provider-unhealthy' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(h.ensureReadyCalls()).toBe(1) // 预热被触发
  })

  it('生产 runtime 直接可用（devTestOnly=false 的正式定制音色 provider）', async () => {
    const h = makeHarness()
    const bound = await boundProvider(h)
    expect(bound.capabilities.devTestOnly).toBe(false)
    expect(bound.capabilities.streamingText).toBe(false)
    expect(bound.format).toEqual({
      sampleRate: 24_000,
      channels: 1,
      sampleFormat: 'f32le',
      interleaved: true
    })
  })
})

describe('P3B-06 GPT-SoVITS adapter：synthesize 全链', () => {
  it('POST /tts 请求形制正确（api_v2 字段名、无凭据头），22.05k->24k 归一', async () => {
    const h = makeHarness()
    const bound = await boundProvider(h)
    const pcm = await bound.synthesize('今天辛苦啦。', 'nacime')

    expect(h.calls.length).toBe(1)
    expect(h.calls[0]!.url).toBe('http://127.0.0.1:20001/tts')
    expect(h.calls[0]!.init?.method).toBe('POST')
    expect(h.calls[0]!.init?.headers).toEqual({ 'content-type': 'application/json' })
    expect(Object.keys(h.calls[0]!.init?.headers ?? {})).not.toContain('authorization')
    expect(JSON.parse(h.calls[0]!.init?.body ?? '{}')).toEqual({
      text: '今天辛苦啦。',
      text_lang: 'zh',
      ref_audio_path: VOICE.refAudioPath,
      prompt_text: VOICE.promptText,
      prompt_lang: 'zh',
      speed_factor: 1,
      media_type: 'wav',
      streaming_mode: false
    })

    // 100ms @22.05k -> 2400 样本 @24k；有界且有限
    expect(pcm.length).toBe(2_400)
    for (const sample of pcm) {
      expect(Math.abs(sample)).toBeLessThanOrEqual(1)
      expect(Number.isFinite(sample)).toBe(true)
    }
  })

  it('speed 在 bind 冻结进 speed_factor；prompt_text 缺省时省略字段', async () => {
    const h = makeHarness({
      resolveVoice: (voiceId) =>
        voiceId === 'bare'
          ? { refAudioPath: 'x.wav', promptLang: 'zh', defaultTextLang: 'zh' }
          : null
    })
    const bound = await h.factory.bind({
      ...bindOpts({ voiceId: 'bare' }),
      options: { ...bindOpts().options, voiceId: 'bare', speed: 1.5 }
    })
    if ('textOnly' in bound) throw new Error('expected provider')
    await bound.synthesize('t', 'bare')
    const body = JSON.parse(h.calls[0]!.init?.body ?? '{}')
    expect(body.speed_factor).toBe(1.5)
    expect('prompt_text' in body).toBe(false)
  })

  it('空文本不发起请求；空 voice 直接抛错', async () => {
    const h = makeHarness()
    const bound = await boundProvider(h)
    expect((await bound.synthesize('', 'nacime')).length).toBe(0)
    expect(h.calls.length).toBe(0)
    await expect(bound.synthesize('t', '')).rejects.toThrow(/voice must not be empty/)
  })

  it('合成时服务不在（中途崩溃）-> TTS_ENGINE_DOWN(retryable)', async () => {
    const h = makeHarness()
    const bound = await boundProvider(h)
    h.setRunning(null)
    await expectAppError(bound.synthesize('t', 'nacime'), 'TTS_ENGINE_DOWN')
    expect(h.calls.length).toBe(0)
  })

  it('合成时 voice 与 bind 时不一致（未配置）-> TTS_ENGINE_DOWN 不可重试', async () => {
    const h = makeHarness()
    const bound = await boundProvider(h)
    let caught: unknown
    try {
      await bound.synthesize('t', 'not-configured')
    } catch (err) {
      caught = err
    }
    expect(isAppError(caught)).toBe(true)
    expect((caught as AppError).code).toBe('TTS_ENGINE_DOWN')
    expect((caught as AppError).retryable).toBe(false)
    expect(h.calls.length).toBe(0)
  })

  it('HTTP 400 -> TTS_ENGINE_DOWN，cause 携带服务端消息（有界）', async () => {
    const h = makeHarness()
    h.setResponse(async () => ({
      status: 400,
      arrayBuffer: async () =>
        new TextEncoder().encode('{"message": "ref audio missing"}').buffer as ArrayBuffer
    }))
    const bound = await boundProvider(h)
    let caught: unknown
    try {
      await bound.synthesize('t', 'nacime')
    } catch (err) {
      caught = err
    }
    expect(isAppError(caught)).toBe(true)
    expect((caught as AppError).code).toBe('TTS_ENGINE_DOWN')
    expect((caught as AppError).retryable).toBe(true)
    expect(String((caught as AppError).cause)).toContain('http 400')
  })

  it('网络错误 -> TTS_ENGINE_DOWN；超时 -> TTS_TIMEOUT', async () => {
    const h = makeHarness()
    h.setResponse(async () => {
      throw new TypeError('fetch failed: ECONNREFUSED')
    })
    const bound = await boundProvider(h)
    await expectAppError(bound.synthesize('t', 'nacime'), 'TTS_ENGINE_DOWN')

    const slow = makeHarness({ requestTimeoutMs: 40 })
    slow.setResponse(
      (_url, init) =>
        new Promise<GptSovitsHttpResponse>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
    )
    const slowBound = await boundProvider(slow)
    await expectAppError(slowBound.synthesize('t', 'nacime'), 'TTS_TIMEOUT')
  })

  it('坏容器（200 + 非 WAV）-> TTS_DECODE；响应超界 -> TTS_DECODE', async () => {
    const bad = makeHarness()
    bad.setResponse(async () => ({
      status: 200,
      arrayBuffer: async () =>
        new TextEncoder().encode('this is not a wav file').buffer as ArrayBuffer
    }))
    const badBound = await boundProvider(bad)
    await expectAppError(badBound.synthesize('t', 'nacime'), 'TTS_DECODE')

    const huge = makeHarness({ maxResponseBytes: 100 })
    huge.setResponse(async () => makeWavResponse())
    const hugeBound = await boundProvider(huge)
    await expectAppError(hugeBound.synthesize('t', 'nacime'), 'TTS_DECODE')
  })

  it('取消：cancel 后 -> AbortError；请求飞行中 cancel -> AbortError 穿透（非 AppError）', async () => {
    const h = makeHarness()
    const bound = await boundProvider(h)
    bound.cancel('user-cancel')
    let caught: unknown
    try {
      await bound.synthesize('t', 'nacime')
    } catch (err) {
      caught = err
    }
    expect((caught as Error).name).toBe('AbortError')
    expect(isAppError(caught)).toBe(false)

    // 飞行中取消：fetch 在 signal abort 时抛 AbortError
    const mid = makeHarness()
    mid.setResponse(
      (_url, init) =>
        new Promise<GptSovitsHttpResponse>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
    )
    const midBound = await boundProvider(mid)
    const pending = midBound.synthesize('t', 'nacime')
    midBound.cancel('barge-in')
    let midCaught: unknown
    try {
      await pending
    } catch (err) {
      midCaught = err
    }
    expect((midCaught as Error).name).toBe('AbortError')
    expect(isAppError(midCaught)).toBe(false)
  })

  it('abort 监听器不跨请求累积：12 次合成无 MaxListeners 警告', async () => {
    const warnings: Error[] = []
    const onWarning = (w: Error): void => {
      warnings.push(w)
    }
    process.on('warning', onWarning)
    try {
      const h = makeHarness()
      const bound = await boundProvider(h)
      for (let i = 0; i < 12; i++) {
        await bound.synthesize(`t${i}`, 'nacime')
      }
      expect(h.calls.length).toBe(12)
      await new Promise((resolve) => setTimeout(resolve, 30))
      // finally 清理生效时不会有监听器堆积告警；若 Node 对 AbortSignal 不发警告，
      // 此断言空过，重复合成本身仍是回归防线
      expect(warnings.filter((w) => w.name === 'MaxListenersExceededWarning')).toEqual([])
    } finally {
      process.off('warning', onWarning)
    }
  })

  it('health 委托服务管理器探测', async () => {
    const h = makeHarness()
    const bound = await boundProvider(h)
    expect((await bound.health()).healthy).toBe(true)
    h.setRunning(null)
    expect((await bound.health()).healthy).toBe(false)
  })
})

// ── P3V-19：多音色动态权重切换（/set_gpt_weights + /set_sovits_weights）──

const VOICE_A: GptSovitsVoiceConfig = {
  refAudioPath: 'D:/voices/a/ref.wav',
  promptText: '甲的参考句。',
  promptLang: 'zh',
  defaultTextLang: 'zh',
  gptWeightsPath: 'D:/weights/甲-e15.ckpt',
  sovitsWeightsPath: 'D:/weights/甲-e8.pth'
}

const VOICE_B: GptSovitsVoiceConfig = {
  refAudioPath: 'D:/voices/b/ref.wav',
  promptText: 'おはよう。',
  promptLang: 'ja',
  defaultTextLang: 'ja',
  gptWeightsPath: 'D:/weights/乙-e10.ckpt',
  sovitsWeightsPath: 'D:/weights/乙-e4.pth'
}

function multiVoiceHarness(): Harness {
  return makeHarness({
    resolveVoice: (voiceId) => (voiceId === 'a' ? VOICE_A : voiceId === 'b' ? VOICE_B : null)
  })
}

function paths(h: Harness): string[] {
  return h.calls.map((c) => c.url.replace('http://127.0.0.1:20001', ''))
}

describe('P3V-19 GPT-SoVITS 动态权重切换', () => {
  it('合成前串行切两条权重（GPT 先、SoVITS 后），路径 URL 编码', async () => {
    const h = multiVoiceHarness()
    const bound = await boundProvider(h, 'a')
    await bound.synthesize('你好', 'a')
    expect(paths(h)).toEqual([
      `/set_gpt_weights?weights_path=${encodeURIComponent('D:/weights/甲-e15.ckpt')}`,
      `/set_sovits_weights?weights_path=${encodeURIComponent('D:/weights/甲-e8.pth')}`,
      '/tts'
    ])
    expect(h.calls[0]?.init?.method).toBe('GET')
    // 本地服务无鉴权：切权重请求同样不带任何凭据头
    expect(h.calls[0]?.init?.headers).toBeUndefined()
  })

  it('同一音色再合成不重复切；换音色才切；服务重启后即使同音色也重切', async () => {
    const h = multiVoiceHarness()
    const bound = await boundProvider(h, 'a')
    await bound.synthesize('一', 'a')
    await bound.synthesize('二', 'a')
    expect(paths(h).filter((p) => p.startsWith('/set_'))).toHaveLength(2)

    await bound.synthesize('三', 'b')
    expect(paths(h).filter((p) => p.startsWith('/set_'))).toHaveLength(4)
    expect(paths(h).at(-3)).toContain(encodeURIComponent('D:/weights/乙-e10.ckpt'))

    // api_v2 崩溃自动重启：按 tts_infer.yaml 重载默认权重 → 记账作废，必须重切
    h.setRestartCount(1)
    await bound.synthesize('四', 'b')
    expect(paths(h).filter((p) => p.startsWith('/set_'))).toHaveLength(6)
  })

  it('未声明权重的音色（P3B 单音色老行为）不发任何 set_* 请求', async () => {
    const h = makeHarness()
    const bound = await boundProvider(h)
    await bound.synthesize('你好', 'nacime')
    expect(paths(h)).toEqual(['/tts'])
  })

  it('切权重失败 -> TTS_ENGINE_DOWN 且不发 /tts；下一次重试重新切（不拿半套权重发声）', async () => {
    const h = multiVoiceHarness()
    let failNext = true
    h.setResponse(async (url) => {
      if (url?.includes('set_gpt_weights') === true && failNext) {
        failNext = false
        return {
          status: 400,
          headers: { get: () => null },
          arrayBuffer: async () =>
            new TextEncoder().encode(JSON.stringify({ message: 'change gpt weight failed' })).buffer
        }
      }
      return makeWavResponse()
    })
    const bound = await boundProvider(h, 'a')
    await expectAppError(bound.synthesize('你好', 'a'), 'TTS_ENGINE_DOWN')
    expect(paths(h)).toEqual([
      `/set_gpt_weights?weights_path=${encodeURIComponent('D:/weights/甲-e15.ckpt')}`
    ])

    await bound.synthesize('你好', 'a')
    expect(paths(h).filter((p) => p.startsWith('/set_gpt_weights'))).toHaveLength(2)
    expect(paths(h).at(-1)).toBe('/tts')
  })

  it('与合成互斥：并发两轮不会把切权重插进别人的合成中间', async () => {
    const h = multiVoiceHarness()
    let releaseTts = (): void => undefined
    const ttsGate = new Promise<void>((resolve) => {
      releaseTts = resolve
    })
    let firstTts = true
    h.setResponse(async (url) => {
      if (url?.endsWith('/tts') === true && firstTts) {
        firstTts = false
        await ttsGate
      }
      return makeWavResponse()
    })
    const bound = await boundProvider(h, 'a')
    const first = bound.synthesize('甲说的话', 'a')
    const second = bound.synthesize('乙说的话', 'b')
    // 第一轮的 /tts 还挂着：第二轮不能已经把权重切走
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(paths(h)).toEqual([
      `/set_gpt_weights?weights_path=${encodeURIComponent('D:/weights/甲-e15.ckpt')}`,
      `/set_sovits_weights?weights_path=${encodeURIComponent('D:/weights/甲-e8.pth')}`,
      '/tts'
    ])
    releaseTts()
    await first
    await second
    expect(paths(h)).toEqual([
      `/set_gpt_weights?weights_path=${encodeURIComponent('D:/weights/甲-e15.ckpt')}`,
      `/set_sovits_weights?weights_path=${encodeURIComponent('D:/weights/甲-e8.pth')}`,
      '/tts',
      `/set_gpt_weights?weights_path=${encodeURIComponent('D:/weights/乙-e10.ckpt')}`,
      `/set_sovits_weights?weights_path=${encodeURIComponent('D:/weights/乙-e4.pth')}`,
      '/tts'
    ])
  })
})
