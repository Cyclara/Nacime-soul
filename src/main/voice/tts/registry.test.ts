// src/main/voice/tts/registry.test.ts
// P3B-02：TTS Registry 合同--未注册 provider 安全错误 / voice-missing /
// 生产资格门（ETTS-C19）/ devTestOnly 交叉校验 / 实例生命周期可关闭。

import { describe, expect, it, vi } from 'vitest'
import { AppError, isAppError } from '@shared/errors'
import type { Logger } from '@shared/observability/types'
import type {
  BoundTtsProvider,
  PcmFormat,
  TtsProviderCapabilities,
  TtsProviderFactory,
  TtsStreamSession,
  TtsTextOnlyDecision
} from '@shared/voice/tts-types'
import {
  createTtsRegistry,
  type TtsProviderDescriptor,
  type TtsRegistryBindInput
} from './registry'

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

const FORMAT_24K: PcmFormat = {
  sampleRate: 24_000,
  channels: 1,
  sampleFormat: 'f32le',
  interleaved: true
}

const CAPS_BASE: TtsProviderCapabilities = {
  streamingText: false,
  streamingAudio: false,
  supportsCancel: true,
  devTestOnly: false,
  segmentCorrelation: false
}

const CAPS_EDGE: TtsProviderCapabilities = { ...CAPS_BASE, devTestOnly: true }

interface FakeProviderCalls {
  bindCount: number
  lastBindInput: unknown
  synthesizeArgs: Array<[string, string]>
  cancelReasons: string[]
  disposeCount: number
  openStreamCount: number
  healthCount: number
  cancelError?: Error
  disposeError?: Error
}

function makeCalls(): FakeProviderCalls {
  return {
    bindCount: 0,
    lastBindInput: undefined,
    synthesizeArgs: [],
    cancelReasons: [],
    disposeCount: 0,
    openStreamCount: 0,
    healthCount: 0
  }
}

interface FakeProviderSetup {
  id: string
  capabilities: TtsProviderCapabilities
  calls: FakeProviderCalls
  withOpenStream?: boolean
  returnTextOnly?: TtsTextOnlyDecision
}

function makeFakeProvider(setup: FakeProviderSetup): BoundTtsProvider {
  const session: TtsStreamSession = {
    append: async () => {},
    commit: async () => {},
    endInput: async () => {},
    audio: async function* () {
      /* empty stream: fake provider produces no audio events */
    },
    cancel: () => {},
    close: () => {}
  }
  return {
    id: setup.id,
    capabilities: setup.capabilities,
    format: FORMAT_24K,
    synthesize: async (text, voice) => {
      setup.calls.synthesizeArgs.push([text, voice])
      return new Float32Array(8)
    },
    ...(setup.withOpenStream === true
      ? {
          openStream: async () => {
            setup.calls.openStreamCount += 1
            return session
          }
        }
      : {}),
    health: async () => {
      setup.calls.healthCount += 1
      return { healthy: true, checkedAt: 0 }
    },
    cancel: async (reason: string) => {
      if (setup.calls.cancelError) throw setup.calls.cancelError
      setup.calls.cancelReasons.push(reason)
    },
    dispose: async () => {
      if (setup.calls.disposeError) throw setup.calls.disposeError
      setup.calls.disposeCount += 1
    }
  }
}

function makeFakeFactory(setup: FakeProviderSetup): TtsProviderFactory {
  return {
    bind: async (input) => {
      setup.calls.bindCount += 1
      setup.calls.lastBindInput = input
      if (setup.returnTextOnly) return setup.returnTextOnly
      return makeFakeProvider(setup)
    }
  }
}

function makeDescriptor(setup: FakeProviderSetup): TtsProviderDescriptor {
  return { id: setup.id, capabilities: setup.capabilities, factory: makeFakeFactory(setup) }
}

function bindInput(
  providerId: string,
  opts?: { voiceId?: string; runtime?: 'dev' | 'test' | 'packaged-production' }
): TtsRegistryBindInput {
  return {
    providerId,
    options: {
      voiceId: opts?.voiceId ?? 'nacime-custom',
      speed: 1,
      pitch: 0,
      volume: 1,
      requestedSampleRate: 24_000 as const
    },
    turnId: 'turn-1',
    requestId: 'req-1',
    signal: new AbortController().signal,
    runtime: opts?.runtime ?? ('dev' as const)
  }
}

describe('P3B-02 TtsRegistry：注册与元信息', () => {
  it('register/list/has 按注册顺序暴露 id + capabilities，不泄漏 factory 引用', () => {
    const registry = createTtsRegistry(noopLogger())
    registry.register(
      makeDescriptor({ id: 'gpt-sovits', capabilities: CAPS_BASE, calls: makeCalls() })
    )
    registry.register(makeDescriptor({ id: 'edge', capabilities: CAPS_EDGE, calls: makeCalls() }))

    expect(registry.has('gpt-sovits')).toBe(true)
    expect(registry.has('edge')).toBe(true)
    expect(registry.has('nope')).toBe(false)
    const list = registry.list()
    expect(list.map((p) => p.id)).toEqual(['gpt-sovits', 'edge'])
    expect(list[1].capabilities.devTestOnly).toBe(true)
    for (const info of list) {
      expect(Object.keys(info).sort()).toEqual(['capabilities', 'id'])
    }
  })

  it('重复 id / 畸形 descriptor 直接抛错，不静默覆盖（防占位 provider 顶掉正式 provider）', () => {
    const registry = createTtsRegistry(noopLogger())
    registry.register(makeDescriptor({ id: 'edge', capabilities: CAPS_EDGE, calls: makeCalls() }))
    expect(() =>
      registry.register(makeDescriptor({ id: 'edge', capabilities: CAPS_EDGE, calls: makeCalls() }))
    ).toThrow(/already registered/)

    expect(() =>
      registry.register({
        id: '',
        capabilities: CAPS_BASE,
        factory: makeFakeFactory({ id: 'x', capabilities: CAPS_BASE, calls: makeCalls() })
      })
    ).toThrow(/id/)
    expect(() =>
      registry.register({
        id: 'broken',
        capabilities: { ...CAPS_BASE, devTestOnly: 1 } as unknown as TtsProviderCapabilities,
        factory: makeFakeFactory({ id: 'x', capabilities: CAPS_BASE, calls: makeCalls() })
      })
    ).toThrow(/malformed/)
    expect(() =>
      registry.register({
        id: 'broken2',
        capabilities: CAPS_BASE,
        factory: {} as TtsProviderFactory
      })
    ).toThrow(/factory/)
    expect(registry.has('broken')).toBe(false)
    expect(registry.has('broken2')).toBe(false)
  })
})

describe('P3B-02 TtsRegistry：bind 三道判定', () => {
  it('未注册 provider 抛 AppError(CFG_INVALID) 安全错误：无 stack/正文泄漏、不可重试', async () => {
    const registry = createTtsRegistry(noopLogger())
    let caught: unknown
    try {
      await registry.bind(bindInput('not-registered'))
    } catch (err) {
      caught = err
    }
    expect(isAppError(caught)).toBe(true)
    const appErr = caught as AppError
    expect(appErr.code).toBe('CFG_INVALID')
    expect(appErr.retryable).toBe(false)
    const pub = appErr.toPublic()
    expect(pub.code).toBe('CFG_INVALID')
    expect(JSON.stringify(pub)).not.toContain('stack')
    expect(JSON.stringify(pub)).not.toContain('not-registered')
  })

  it('voiceId 为空：不自动挑系统 voice，判 voice-missing 且不触碰 factory', async () => {
    const registry = createTtsRegistry(noopLogger())
    const calls = makeCalls()
    registry.register(makeDescriptor({ id: 'gpt-sovits', capabilities: CAPS_BASE, calls }))
    const result = await registry.bind(bindInput('gpt-sovits', { voiceId: '' }))
    expect(result).toEqual({ textOnly: true, reason: 'voice-missing' })
    expect(calls.bindCount).toBe(0)
  })

  it('ETTS-C19：packaged-production + devTestOnly -> 永不实例化 Edge，直接 text-only', async () => {
    const registry = createTtsRegistry(noopLogger())
    const calls = makeCalls()
    registry.register(makeDescriptor({ id: 'edge', capabilities: CAPS_EDGE, calls }))

    const result = await registry.bind(bindInput('edge', { runtime: 'packaged-production' }))
    expect(result).toEqual({ textOnly: true, reason: 'provider-unhealthy' })
    // Factory 完全没被调用--Edge 连构造机会都没有，renderer 也没有 override 可谈。
    expect(calls.bindCount).toBe(0)
    expect(registry.activeCount()).toBe(0)
  })

  it('dev / test 运行时同一 devTestOnly provider 正常可用（占位语义）', async () => {
    const registry = createTtsRegistry(noopLogger())
    const calls = makeCalls()
    registry.register(makeDescriptor({ id: 'edge', capabilities: CAPS_EDGE, calls }))
    const result = await registry.bind(bindInput('edge', { runtime: 'dev' }))
    expect(result).not.toHaveProperty('textOnly')
    expect(calls.bindCount).toBe(1)
    expect(registry.activeCount()).toBe(1)
  })

  it('factory 自行退避（如 GPT-SoVITS 服务未起）时原样透传 textOnly 决定', async () => {
    const registry = createTtsRegistry(noopLogger())
    const calls = makeCalls()
    registry.register(
      makeDescriptor({
        id: 'gpt-sovits',
        capabilities: CAPS_BASE,
        calls,
        returnTextOnly: { textOnly: true, reason: 'provider-unhealthy' }
      })
    )
    const result = await registry.bind(bindInput('gpt-sovits'))
    expect(result).toEqual({ textOnly: true, reason: 'provider-unhealthy' })
    expect(registry.activeCount()).toBe(0)
  })

  it('descriptor 与 bound 的 devTestOnly 不一致：立即 dispose 该实例并退纯文字', async () => {
    const registry = createTtsRegistry(noopLogger())
    const boundCalls = makeCalls()
    // descriptor 声称生产可用，factory 造出来的却自称 dev-only：有人撒谎，安全侧处置。
    const factory: TtsProviderFactory = {
      bind: async () => makeFakeProvider({ id: 'liar', capabilities: CAPS_EDGE, calls: boundCalls })
    }
    registry.register({ id: 'liar', capabilities: CAPS_BASE, factory })

    const result = await registry.bind(bindInput('liar'))
    expect(result).toEqual({ textOnly: true, reason: 'provider-unhealthy' })
    expect(boundCalls.disposeCount).toBe(1)
    expect(registry.activeCount()).toBe(0)
  })

  it('bind 透传的 options/signal/runtime 原样到达 factory（冻结发生在 bind 时刻）', async () => {
    const registry = createTtsRegistry(noopLogger())
    const calls = makeCalls()
    registry.register(makeDescriptor({ id: 'gpt-sovits', capabilities: CAPS_BASE, calls }))
    const input = bindInput('gpt-sovits', { runtime: 'test' })
    await registry.bind(input)
    expect(calls.lastBindInput).toEqual({
      options: input.options,
      turnId: 'turn-1',
      requestId: 'req-1',
      signal: input.signal,
      runtime: 'test'
    })
  })
})

describe('P3B-02 TtsRegistry：turn-bound 实例生命周期', () => {
  it('返回的包装 provider 纯委托冻结 ABI，PCM format 始终可知', async () => {
    const registry = createTtsRegistry(noopLogger())
    const calls = makeCalls()
    registry.register(
      makeDescriptor({ id: 'gpt-sovits', capabilities: CAPS_BASE, calls, withOpenStream: true })
    )
    const bound = await registry.bind(bindInput('gpt-sovits'))
    if ('textOnly' in bound) throw new Error('expected provider')

    expect(bound.format).toEqual(FORMAT_24K)
    expect(bound.synthesize.length).toBe(2)
    await bound.synthesize('你好。', 'nacime-custom')
    expect(calls.synthesizeArgs).toEqual([['你好。', 'nacime-custom']])
    await bound.health()
    expect(calls.healthCount).toBe(1)
    expect(typeof bound.openStream).toBe('function')
    await bound.openStream?.()
    expect(calls.openStreamCount).toBe(1)
    expect(registry.activeCount()).toBe(1)
  })

  it('无流式能力的 provider 不带 openStream（可选能力不伪装存在）', async () => {
    const registry = createTtsRegistry(noopLogger())
    const calls = makeCalls()
    registry.register(makeDescriptor({ id: 'gpt-sovits', capabilities: CAPS_BASE, calls }))
    const bound = await registry.bind(bindInput('gpt-sovits'))
    if ('textOnly' in bound) throw new Error('expected provider')
    expect(bound.openStream).toBeUndefined()
  })

  it('wrapper.dispose 出册且幂等：重复 dispose 不再触达原 provider', async () => {
    const registry = createTtsRegistry(noopLogger())
    const calls = makeCalls()
    registry.register(makeDescriptor({ id: 'gpt-sovits', capabilities: CAPS_BASE, calls }))
    const bound = await registry.bind(bindInput('gpt-sovits'))
    if ('textOnly' in bound) throw new Error('expected provider')

    await bound.dispose()
    await bound.dispose()
    expect(calls.disposeCount).toBe(1)
    expect(registry.activeCount()).toBe(0)
  })

  it('disposeAll：先 cancel(reason) 再 dispose，逐个清理、幂等、迟到 dispose 不双清', async () => {
    const registry = createTtsRegistry(noopLogger())
    const a = makeCalls()
    const b = makeCalls()
    registry.register(makeDescriptor({ id: 'a', capabilities: CAPS_BASE, calls: a }))
    registry.register(makeDescriptor({ id: 'b', capabilities: CAPS_BASE, calls: b }))
    const pa = await registry.bind({ ...bindInput('a'), turnId: 't-a' })
    const pb = await registry.bind({ ...bindInput('b'), turnId: 't-b' })
    expect(registry.activeCount()).toBe(2)

    await registry.disposeAll('app-quit')
    expect(a.cancelReasons).toEqual(['app-quit'])
    expect(b.cancelReasons).toEqual(['app-quit'])
    expect(a.disposeCount).toBe(1)
    expect(b.disposeCount).toBe(1)
    expect(registry.activeCount()).toBe(0)

    // app quit 之后 controller 才收尾：不再二次 cancel/dispose
    await registry.disposeAll('app-quit')
    if ('textOnly' in pa) throw new Error('expected provider')
    await pa.dispose()
    expect(a.disposeCount).toBe(1)
    expect(a.cancelReasons).toEqual(['app-quit'])
    if ('textOnly' in pb) throw new Error('expected provider')
  })

  it('disposeAll 对 cancel/dispose 抛错的 provider 容错：不中断、仍清理其余', async () => {
    const registry = createTtsRegistry(noopLogger())
    const bad: FakeProviderCalls = {
      ...makeCalls(),
      cancelError: new Error('cancel boom'),
      disposeError: new Error('dispose boom')
    }
    const good = makeCalls()
    registry.register(makeDescriptor({ id: 'bad', capabilities: CAPS_BASE, calls: bad }))
    registry.register(makeDescriptor({ id: 'good', capabilities: CAPS_BASE, calls: good }))
    await registry.bind(bindInput('bad'))
    await registry.bind(bindInput('good'))

    await expect(registry.disposeAll('window-destroyed')).resolves.toBeUndefined()
    expect(good.disposeCount).toBe(1)
    expect(registry.activeCount()).toBe(0)
  })

  it('wrapper 自身 dispose 抛错：出册已完成，错误不外泄、activeCount 归零', async () => {
    const logger = noopLogger()
    const warn = vi.spyOn(logger, 'warn')
    const registry = createTtsRegistry(logger)
    const calls: FakeProviderCalls = { ...makeCalls(), disposeError: new Error('late boom') }
    registry.register(makeDescriptor({ id: 'gpt-sovits', capabilities: CAPS_BASE, calls }))
    const bound = await registry.bind(bindInput('gpt-sovits'))
    if ('textOnly' in bound) throw new Error('expected provider')

    await expect(bound.dispose()).resolves.toBeUndefined()
    expect(registry.activeCount()).toBe(0)
    expect(warn).toHaveBeenCalledOnce()
  })
})
