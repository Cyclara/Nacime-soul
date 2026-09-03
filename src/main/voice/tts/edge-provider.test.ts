// src/main/voice/tts/edge-provider.test.ts
// P3B-03：Edge dev/test 占位 provider 合同。
// 核心：ETTS-C19（生产资格门，真 descriptor 全链路）+ bind 冻结 + WAV 归一路径 +
// 取消语义。合成层全部注入假 WAV（S-004：测试不真发声、不 spawn PowerShell）。

import { describe, expect, it } from 'vitest'
import { AppError, isAppError } from '@shared/errors'
import type { Logger } from '@shared/observability/types'
import type { TtsProviderFactory } from '@shared/voice/tts-types'
import { makeWavBuffer } from '../../../../tests/helpers/wav-fixture'
import { createTtsRegistry } from './registry'
import {
  createEdgeTtsProviderFactory,
  EDGE_TTS_CAPABILITIES,
  EDGE_TTS_PROVIDER_ID,
  sapiRateFromSpeed,
  sanitizeSapiVoiceName,
  type EdgeSapiSynthesisInput
} from './edge-provider'

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

function makeFakeWav(sampleRate = 22_050): Buffer {
  const samples = new Float32Array(2_205) // 100ms @ 22.05k
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 0.5
  }
  return makeWavBuffer({ sampleRate, channels: 1, sampleFormat: 's16', samples })
}

interface DepCalls {
  inputs: EdgeSapiSynthesisInput[]
  response: () => Promise<Buffer>
}

function makeDeps(overrides?: Partial<DepCalls>): { calls: DepCalls; factory: TtsProviderFactory } {
  const calls: DepCalls = {
    inputs: [],
    response: async () => makeFakeWav(),
    ...overrides
  }
  const factory = createEdgeTtsProviderFactory({
    logger: noopLogger(),
    synthesizeToWav: async (input) => {
      calls.inputs.push(input)
      return calls.response()
    }
  })
  return { calls, factory }
}

type FactoryBindInput = Parameters<TtsProviderFactory['bind']>[0]

function bindOpts(opts?: {
  voiceId?: string
  speed?: number
  runtime?: 'dev' | 'test' | 'packaged-production'
  signal?: AbortSignal
}): FactoryBindInput {
  return {
    options: {
      voiceId: opts?.voiceId ?? 'Microsoft Huihui Desktop',
      speed: opts?.speed ?? 1,
      pitch: 0,
      volume: 1,
      requestedSampleRate: 24_000 as const
    },
    turnId: 'turn-1',
    requestId: 'req-1',
    signal: opts?.signal ?? new AbortController().signal,
    runtime: opts?.runtime ?? ('dev' as const)
  }
}

describe('P3B-03 纯函数：speed/voice 换算', () => {
  it('sapiRateFromSpeed：1x=0、2x=+10、0.5x=-10、越界 clamp', () => {
    expect(sapiRateFromSpeed(1)).toBe(0)
    expect(sapiRateFromSpeed(2)).toBe(10)
    expect(sapiRateFromSpeed(0.5)).toBe(-10)
    expect(sapiRateFromSpeed(10)).toBe(10)
    expect(sapiRateFromSpeed(0.1)).toBe(-10)
    expect(sapiRateFromSpeed(1.4)).toBe(5) // log2(1.4)*10 ≈ 4.96
  })

  it('sanitizeSapiVoiceName：安全字符集放行，引号/脚本/超长/空拒绝', () => {
    expect(sanitizeSapiVoiceName('Microsoft Huihui Desktop')).toBe('Microsoft Huihui Desktop')
    expect(sanitizeSapiVoiceName('zh-CN-Xiaoxiao')).toBe('zh-CN-Xiaoxiao')
    expect(sanitizeSapiVoiceName('')).toBeNull()
    expect(sanitizeSapiVoiceName("a'; rm -rf C:\\")).toBeNull()
    expect(sanitizeSapiVoiceName('a'.repeat(65))).toBeNull()
  })
})

describe('P3B-03 Edge provider：资格门与降级', () => {
  it('factory 自检：packaged-production 绝不实例化（F5-007 原文），返回 provider-unhealthy', async () => {
    const { calls, factory } = makeDeps()
    const result = await factory.bind(bindOpts({ runtime: 'packaged-production' }))
    expect(result).toEqual({ textOnly: true, reason: 'provider-unhealthy' })
    expect(calls.inputs.length).toBe(0)
  })

  it('factory 自检：voiceId 为空 -> voice-missing（不自动挑系统 voice）', async () => {
    const { calls, factory } = makeDeps()
    const result = await factory.bind(bindOpts({ voiceId: '' }))
    expect(result).toEqual({ textOnly: true, reason: 'voice-missing' })
    expect(calls.inputs.length).toBe(0)
  })

  it('ETTS-C19 全链路（真 descriptor + 真 registry）：持久配置 provider=edge 时生产只能 text-only', async () => {
    // 模拟出厂默认/旧配置：tts.enabled=true、provider='edge'，但 runtime 是打包生产
    const { calls, factory } = makeDeps()
    const registry = createTtsRegistry(noopLogger())
    registry.register({
      id: EDGE_TTS_PROVIDER_ID,
      capabilities: EDGE_TTS_CAPABILITIES,
      factory
    })

    const result = await registry.bind({
      providerId: 'edge',
      options: {
        voiceId: 'zh-CN-XiaoxiaoNeural',
        speed: 1,
        pitch: 0,
        volume: 1,
        requestedSampleRate: 24_000
      },
      turnId: 'turn-1',
      requestId: 'req-1',
      signal: new AbortController().signal,
      runtime: 'packaged-production'
    })
    expect(result).toEqual({ textOnly: true, reason: 'provider-unhealthy' })
    expect(calls.inputs.length).toBe(0) // Edge 从未被实例化
    expect(registry.activeCount()).toBe(0)
  })
})

describe('P3B-03 Edge provider：dev 合成路径（假 WAV）', () => {
  it('synthesize：WAV 解码 + 22.05k->24k 重采样，format 与 PCM 一致，speed 冻结为 rate', async () => {
    const { calls, factory } = makeDeps()
    const bound = await factory.bind(bindOpts({ speed: 2 }))
    if ('textOnly' in bound) throw new Error('expected provider')

    expect(bound.id).toBe(EDGE_TTS_PROVIDER_ID)
    expect(bound.capabilities.devTestOnly).toBe(true)
    expect(bound.capabilities.streamingText).toBe(false)
    expect(bound.format).toEqual({
      sampleRate: 24_000,
      channels: 1,
      sampleFormat: 'f32le',
      interleaved: true
    })

    const pcm = await bound.synthesize('今天辛苦啦。', 'Microsoft Huihui Desktop')
    // 100ms @22.05k -> 24000 个样本每秒 -> 2400 样本
    expect(pcm.length).toBe(2_400)
    for (const sample of pcm) {
      expect(Math.abs(sample)).toBeLessThanOrEqual(1)
      expect(Number.isFinite(sample)).toBe(true)
    }
    expect(calls.inputs.length).toBe(1)
    expect(calls.inputs[0].text).toBe('今天辛苦啦。')
    expect(calls.inputs[0].voice).toBe('Microsoft Huihui Desktop')
    expect(calls.inputs[0].rate).toBe(10) // speed=2 冻结在 bind 时刻
  })

  it('空文本返回空 PCM 且不启动合成；空 voice 是调用方缺陷，直接抛错', async () => {
    const { calls, factory } = makeDeps()
    const bound = await factory.bind(bindOpts())
    if ('textOnly' in bound) throw new Error('expected provider')

    expect((await bound.synthesize('', 'v')).length).toBe(0)
    expect(calls.inputs.length).toBe(0)
    await expect(bound.synthesize('text', '')).rejects.toThrow(/voice must not be empty/)
  })

  it('坏 WAV -> AppError(TTS_DECODE) 原样传播；未知异常 -> 包装 TTS_ENGINE_DOWN(retryable)', async () => {
    const bad = makeDeps({ response: async () => Buffer.from('not a wav at all') })
    const badBound = await bad.factory.bind(bindOpts())
    if ('textOnly' in badBound) throw new Error('expected provider')
    let decodeErr: unknown
    try {
      await badBound.synthesize('t', 'v')
    } catch (err) {
      decodeErr = err
    }
    expect(isAppError(decodeErr)).toBe(true)
    expect((decodeErr as AppError).code).toBe('TTS_DECODE')

    const boom = makeDeps({
      response: async () => {
        throw new Error('engine exploded')
      }
    })
    const boomBound = await boom.factory.bind(bindOpts())
    if ('textOnly' in boomBound) throw new Error('expected provider')
    let caught: unknown
    try {
      await boomBound.synthesize('t', 'v')
    } catch (err) {
      caught = err
    }
    expect(isAppError(caught)).toBe(true)
    expect((caught as AppError).code).toBe('TTS_ENGINE_DOWN')
    expect((caught as AppError).retryable).toBe(true)
  })

  it('health：占位 provider 恒健康（真实可用性由每次 synthesize 兑现）', async () => {
    const { factory } = makeDeps()
    const bound = await factory.bind(bindOpts())
    if ('textOnly' in bound) throw new Error('expected provider')
    const health = await bound.health()
    expect(health.healthy).toBe(true)
    expect(health.checkedAt).toBeGreaterThan(0)
  })
})

describe('P3B-03 Edge provider：取消与释放', () => {
  it('cancel 后 synthesize 抛 AbortError（未被包装成 AppError）', async () => {
    const { factory } = makeDeps()
    const bound = await factory.bind(bindOpts())
    if ('textOnly' in bound) throw new Error('expected provider')
    bound.cancel('user-cancel')
    let caught: unknown
    try {
      await bound.synthesize('t', 'v')
    } catch (err) {
      caught = err
    }
    expect((caught as Error).name).toBe('AbortError')
    expect(isAppError(caught)).toBe(false)
  })

  it('外层 turn signal abort -> 合成中的请求以 AbortError 终止', async () => {
    const outer = new AbortController()
    const deps = makeDeps({
      response: () =>
        new Promise<Buffer>((_resolve, reject) => {
          outer.signal.addEventListener('abort', () => {
            const err = new Error('killed')
            err.name = 'AbortError'
            reject(err)
          })
        })
    })
    const bound = await deps.factory.bind(bindOpts({ signal: outer.signal }))
    if ('textOnly' in bound) throw new Error('expected provider')
    const pending = bound.synthesize('t', 'v')
    outer.abort()
    let caught: unknown
    try {
      await pending
    } catch (err) {
      caught = err
    }
    expect((caught as Error).name).toBe('AbortError')
    expect(isAppError(caught)).toBe(false)
  })

  it('dispose 与 cancel 等效中断；已在飞行中的合成同样终止', async () => {
    let release: ((err: Error) => void) | undefined
    const deps = makeDeps({
      response: () =>
        new Promise<Buffer>((_resolve, reject) => {
          release = (err) => {
            const e = err ?? new Error('aborted')
            e.name = 'AbortError'
            reject(e)
          }
        })
    })
    const bound = await deps.factory.bind(bindOpts())
    if ('textOnly' in bound) throw new Error('expected provider')
    const pending = bound.synthesize('t', 'v')
    bound.dispose()
    release?.(new Error('dispose'))
    let caught: unknown
    try {
      await pending
    } catch (err) {
      caught = err
    }
    expect((caught as Error).name).toBe('AbortError')
    let second: unknown
    try {
      await bound.synthesize('t2', 'v')
    } catch (err) {
      second = err
    }
    expect((second as Error).name).toBe('AbortError')
  })
})
