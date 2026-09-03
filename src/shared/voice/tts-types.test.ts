// src/shared/voice/tts-types.test.ts
// P3B-01：冻结基础 ABI 的合同测试。文件里的 `: BoundTtsProvider` / `: TtsProviderFactory`
// 标注本身就是断言的一部分--两种 provider（流式 / 非流式）都必须能原样满足接口，
// 多一个第三参数、少一个可选方法都无法通过 typecheck。

import { describe, expect, it } from 'vitest'
import {
  isTtsTextOnly,
  type BoundTtsProvider,
  type PcmFormat,
  type TtsProviderFactory,
  type TtsStreamSession,
  type TtsTextOnlyDecision
} from './tts-types'

function makeFormat(sampleRate: number): PcmFormat {
  return { sampleRate, channels: 1, sampleFormat: 'f32le', interleaved: true }
}

/** 非流式 provider（GPT-SoVITS 单段合成形态）：没有 openStream 也必须满足接口。 */
function makeNonStreamingProvider(): BoundTtsProvider {
  return {
    id: 'gpt-sovit-local',
    capabilities: {
      streamingText: false,
      streamingAudio: false,
      supportsCancel: true,
      devTestOnly: false,
      segmentCorrelation: false
    },
    format: makeFormat(24_000),
    synthesize: async (text, voice) => {
      expect(text.length).toBeGreaterThan(0)
      expect(voice).not.toBe('')
      return new Float32Array(16)
    },
    health: async () => ({ healthy: true, checkedAt: Date.now() }),
    cancel: () => {},
    dispose: () => {}
  }
}

/** 流式 provider：openStream 是叠加能力，capabilities 必须如实声明。 */
function makeStreamingProvider(): BoundTtsProvider {
  const provider = makeNonStreamingProvider()
  const session: TtsStreamSession = {
    append: async () => {},
    commit: async () => {},
    endInput: async () => {},
    audio: async function* () {
      /* empty stream: fake session produces no audio events */
    },
    cancel: () => {},
    close: () => {}
  }
  return {
    ...provider,
    id: 'streaming-fake',
    capabilities: { ...provider.capabilities, streamingText: true, streamingAudio: true },
    openStream: async () => session
  }
}

describe('P3B-01 TTS 冻结基础 ABI', () => {
  it('synthesize 恰好两个参数（text, voice）--运行时与编译期双重锁死', () => {
    // 编译期护栏在 tts-types.ts 的 *Assertion 常量；这里锁运行时长度，
    // 防止实现侧用 rest/默认参等绕过 Parameters<...> 元组推导。
    expect(makeNonStreamingProvider().synthesize.length).toBe(2)
    expect(makeStreamingProvider().synthesize.length).toBe(2)
  })

  it('openStream 是可选能力：无 openStream 的 provider 同样满足合同', () => {
    const nonStreaming = makeNonStreamingProvider()
    expect(nonStreaming.openStream).toBeUndefined()
    const streaming = makeStreamingProvider()
    expect(typeof streaming.openStream).toBe('function')
  })

  it('PcmFormat 归一为 mono / f32le / interleaved，仅采样率可变', () => {
    const format = makeFormat(16_000)
    expect(format.channels).toBe(1)
    expect(format.sampleFormat).toBe('f32le')
    expect(format.interleaved).toBe(true)
    // @ts-expect-error channels 不接受 2--字面量类型拒绝立体声
    makeFormat(16_000).channels = 2
  })

  it('Factory 可返回 provider 或 textOnly 判别结果，isTtsTextOnly 正确分流', async () => {
    const bindTextOnly: TtsProviderFactory = {
      bind: async () => ({ textOnly: true, reason: 'provider-unhealthy' })
    }
    const bindProvider: TtsProviderFactory = {
      bind: async () => makeNonStreamingProvider()
    }

    const textOnly = await bindTextOnly.bind({
      options: {
        voiceId: 'nacime',
        speed: 1,
        pitch: 1,
        volume: 1,
        requestedSampleRate: 24_000
      },
      turnId: 'turn-1',
      requestId: 'req-1',
      signal: new AbortController().signal,
      runtime: 'dev'
    })
    const provider = await bindProvider.bind({
      options: {
        voiceId: 'nacime',
        speed: 1,
        pitch: 1,
        volume: 1,
        requestedSampleRate: 24_000
      },
      turnId: 'turn-2',
      requestId: 'req-2',
      signal: new AbortController().signal,
      runtime: 'packaged-production'
    })

    expect(isTtsTextOnly(textOnly)).toBe(true)
    if (isTtsTextOnly(textOnly)) {
      const decision: TtsTextOnlyDecision = textOnly
      expect(decision.reason).toBe('provider-unhealthy')
    }
    expect(isTtsTextOnly(provider)).toBe(false)
    if (!isTtsTextOnly(provider)) {
      expect(provider.capabilities.devTestOnly).toBe(false)
    }
  })

  it('synthesize 输出为 Float32Array PCM，与声明的 format 呼应', async () => {
    const provider = makeNonStreamingProvider()
    const pcm = await provider.synthesize('今天辛苦啦。', 'nacime')
    expect(pcm).toBeInstanceOf(Float32Array)
    expect(Number.isFinite(provider.format.sampleRate)).toBe(true)
    // 容器解码/重采样后的样本必须在 [-1, 1] 内（f32le 归一）。
    for (const sample of pcm) {
      expect(Math.abs(sample)).toBeLessThanOrEqual(1)
    }
  })
})
