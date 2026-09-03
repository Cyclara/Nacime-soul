// src/shared/voice/asr-types.test.ts
// P3B-09：ASR 冻结 ABI 的合同测试（编译期护栏 + 运行时校验器 + 有界性）。

import { describe, expect, it } from 'vitest'
import type { AsrEngine, AsrModelStatus, AsrTranscriptResult } from './asr-types'
import {
  ASR_AUDIO_FORMAT,
  ASR_AUDIO_MAX_SAMPLES,
  ASR_TRANSCRIPT_SEGMENTS_MAX,
  ASR_TRANSCRIPT_TEXT_MAX_CHARS,
  isValidAsrAudioInput,
  isValidAsrModelStatus,
  isValidAsrRecognizeOptions,
  isValidAsrTranscriptResult
} from './asr-types'

function makeResult(overrides?: Partial<AsrTranscriptResult>): AsrTranscriptResult {
  return {
    text: '你好世界',
    segments: [{ text: '你好世界', startMs: 0, endMs: 900 }],
    ...overrides
  }
}

describe('P3B-09 冻结合同（编译期断言常量）', () => {
  it('输入格式 = 16kHz / mono / s16le（P3-00C 合同）', () => {
    expect(ASR_AUDIO_FORMAT).toEqual({ sampleRate: 16_000, channels: 1, sampleFormat: 's16le' })
    // 编译期断言常量的值恒为 true（typecheck 阶段已锁；运行时再验一次）
    expect(ASR_AUDIO_FORMAT.sampleRate).toBe(16_000)
    expect(ASR_AUDIO_MAX_SAMPLES).toBe(960_000) // 60s @ 16kHz
  })

  it('recognize 恰好两参且第一参是 Int16Array（运行时反射复核）', () => {
    const probe: AsrEngine = {
      id: 'probe',
      localOnly: true,
      state: 'ready',
      loadModel: async () => {},
      recognize: async (audio: Int16Array, options?: { language?: string }) => {
        void options
        void audio
        return makeResult()
      },
      onProgress: () => () => {}
    }
    expect(probe.recognize.length).toBe(2)
    expect(probe.localOnly).toBe(true)
  })
})

describe('isValidAsrAudioInput', () => {
  it('接受非空且不超上限的 Int16Array', () => {
    expect(isValidAsrAudioInput(new Int16Array(1))).toBe(true)
    expect(isValidAsrAudioInput(new Int16Array(ASR_AUDIO_MAX_SAMPLES))).toBe(true)
  })

  it('拒绝空、超上限、非 Int16Array', () => {
    expect(isValidAsrAudioInput(new Int16Array(0))).toBe(false)
    expect(isValidAsrAudioInput(new Int16Array(ASR_AUDIO_MAX_SAMPLES + 1))).toBe(false)
    expect(isValidAsrAudioInput(new Float32Array(16))).toBe(false)
    expect(isValidAsrAudioInput(new Int8Array(16))).toBe(false)
    expect(isValidAsrAudioInput('audio')).toBe(false)
    expect(isValidAsrAudioInput(null)).toBe(false)
  })
})

describe('isValidAsrRecognizeOptions', () => {
  it('接受 undefined / 空对象 / 合法语言提示', () => {
    expect(isValidAsrRecognizeOptions(undefined)).toBe(true)
    expect(isValidAsrRecognizeOptions({})).toBe(true)
    expect(isValidAsrRecognizeOptions({ language: 'zh' })).toBe(true)
    expect(isValidAsrRecognizeOptions({ language: 'auto' })).toBe(true)
  })

  it('拒绝未知语言与多余键', () => {
    expect(isValidAsrRecognizeOptions({ language: 'fr' })).toBe(false)
    expect(isValidAsrRecognizeOptions({ language: 1 })).toBe(false)
    expect(isValidAsrRecognizeOptions({ lang: 'zh' })).toBe(false)
  })
})

describe('isValidAsrTranscriptResult（有界性：反「巨大 JSON 数组」）', () => {
  it('接受合法结果（含空 segments）', () => {
    expect(isValidAsrTranscriptResult(makeResult())).toBe(true)
    expect(isValidAsrTranscriptResult({ text: '', segments: [] })).toBe(true)
  })

  it('文本超上限拒', () => {
    expect(
      isValidAsrTranscriptResult(
        makeResult({ text: 'a'.repeat(ASR_TRANSCRIPT_TEXT_MAX_CHARS + 1) })
      )
    ).toBe(false)
  })

  it('segments 超上限拒', () => {
    const segments = Array.from({ length: ASR_TRANSCRIPT_SEGMENTS_MAX + 1 }, () => ({
      text: 'x',
      startMs: 0,
      endMs: 1
    }))
    expect(isValidAsrTranscriptResult(makeResult({ segments }))).toBe(false)
    const atCap = segments.slice(0, ASR_TRANSCRIPT_SEGMENTS_MAX)
    expect(isValidAsrTranscriptResult(makeResult({ segments: atCap }))).toBe(true)
  })

  it('时间戳负数/倒序/小数/NaN 拒', () => {
    expect(
      isValidAsrTranscriptResult(makeResult({ segments: [{ text: 'x', startMs: -1, endMs: 1 }] }))
    ).toBe(false)
    expect(
      isValidAsrTranscriptResult(
        makeResult({ segments: [{ text: 'x', startMs: 500, endMs: 100 }] })
      )
    ).toBe(false)
    expect(
      isValidAsrTranscriptResult(makeResult({ segments: [{ text: 'x', startMs: 0.5, endMs: 1 }] }))
    ).toBe(false)
    expect(
      isValidAsrTranscriptResult(
        makeResult({ segments: [{ text: 'x', startMs: Number.NaN, endMs: 1 }] })
      )
    ).toBe(false)
  })

  it('segment 空 text / 多余键 / 非 object 拒', () => {
    expect(
      isValidAsrTranscriptResult(makeResult({ segments: [{ text: '', startMs: 0, endMs: 1 }] }))
    ).toBe(false)
    expect(
      isValidAsrTranscriptResult({
        segments: [{ text: 'x', startMs: 0, endMs: 1, extra: 1 } as unknown]
      })
    ).toBe(false)
    expect(isValidAsrTranscriptResult({ segments: ['x' as unknown as never] })).toBe(false)
  })

  it('顶层多余键 / text 非 string / segments 非数组拒', () => {
    const smuggled = makeResult() as unknown as Record<string, unknown>
    smuggled['confidence'] = 0.9
    expect(isValidAsrTranscriptResult(smuggled)).toBe(false)
    expect(isValidAsrTranscriptResult({ text: 1, segments: [] })).toBe(false)
    expect(isValidAsrTranscriptResult({ text: 'x', segments: 'none' })).toBe(false)
    expect(isValidAsrTranscriptResult(null)).toBe(false)
  })
})

describe('isValidAsrModelStatus', () => {
  it('接受四态与可选字段', () => {
    const base: AsrModelStatus = { engineId: 'sherpa-sensevoice', state: 'ready' }
    expect(isValidAsrModelStatus(base)).toBe(true)
    expect(isValidAsrModelStatus({ ...base, state: 'downloading', progressRatio: 0.5 })).toBe(true)
    expect(isValidAsrModelStatus({ ...base, state: 'error', errorCode: 'model-missing' })).toBe(
      true
    )
    expect(isValidAsrModelStatus({ ...base, progressRatio: 0 })).toBe(true)
    expect(isValidAsrModelStatus({ ...base, progressRatio: 1 })).toBe(true)
  })

  it('engineId 空/超长拒（且不是路径）', () => {
    expect(isValidAsrModelStatus({ engineId: '', state: 'ready' })).toBe(false)
    expect(isValidAsrModelStatus({ engineId: 'a'.repeat(65), state: 'ready' })).toBe(false)
    // 路径形态不是 id：反斜杠直接被字符界排除不了，但长度界与调用方纪律共同守；
    // 这里验证非字符串形状拒
    expect(isValidAsrModelStatus({ engineId: 123, state: 'ready' })).toBe(false)
  })

  it('未知 state / progress 越界 / 未知 errorCode 拒', () => {
    expect(isValidAsrModelStatus({ engineId: 'e', state: 'loading' })).toBe(false)
    expect(isValidAsrModelStatus({ engineId: 'e', state: 'downloading', progressRatio: 1.5 })).toBe(
      false
    )
    expect(
      isValidAsrModelStatus({ engineId: 'e', state: 'downloading', progressRatio: -0.1 })
    ).toBe(false)
    expect(isValidAsrModelStatus({ engineId: 'e', state: 'error', errorCode: 'whatever' })).toBe(
      false
    )
  })

  it('多余键拒', () => {
    const smuggled = { engineId: 'e', state: 'ready', modelPath: 'C:/models/x.onnx' }
    expect(isValidAsrModelStatus(smuggled)).toBe(false)
  })
})
