// tests/helpers/fake-asr.test.ts
// P3-00C 自测：假 ASR 引擎的状态机/脚本/失败注入/进度回调正确。

import { describe, it, expect, vi } from 'vitest'
import type { AsrEngine } from '@shared/voice/asr-types'
import { createFakeAsrEngine } from './fake-asr'
import { makeSilentPcm16 } from './silent-pcm'

describe('fake-asr 自测', () => {
  it('未加载模型时 recognize 抛错；loadModel 后按脚本顺序返回', async () => {
    const asr = createFakeAsrEngine([
      { text: '你好', segments: [{ text: '你好', startMs: 0, endMs: 800 }] },
      { text: '今天天气不错' }
    ])
    expect(asr.state).toBe('not-downloaded')
    await expect(asr.recognize(makeSilentPcm16(100))).rejects.toThrow(/not-downloaded/)

    const onProgress = vi.fn()
    const off = asr.onProgress(onProgress)
    await asr.loadModel({ progressSteps: 4 })
    expect(asr.state).toBe('ready')
    expect(onProgress).toHaveBeenCalledTimes(4)
    expect(onProgress).toHaveBeenLastCalledWith(1)
    off()

    const first = await asr.recognize(makeSilentPcm16(100))
    expect(first.text).toBe('你好')
    expect(first.segments[0]).toEqual({ text: '你好', startMs: 0, endMs: 800 })

    const second = await asr.recognize(makeSilentPcm16(100))
    expect(second.text).toBe('今天天气不错')
    // 缺省 segments 自动补一条
    expect(second.segments).toHaveLength(1)

    // 脚本耗尽返回空文本
    const third = await asr.recognize(makeSilentPcm16(100))
    expect(third.text).toBe('')
    // recognizeCalls 计"尝试次数"（含开头未就绪被拒的那次）
    expect(asr.recognizeCalls).toBe(4)
  })

  it('failNextRecognize 注入一次失败后恢复；failLoad 落 error 态', async () => {
    const asr = createFakeAsrEngine([{ text: 'x' }])
    await asr.loadModel()

    asr.failNextRecognize(new Error('decoder exploded'))
    await expect(asr.recognize(makeSilentPcm16(10))).rejects.toThrow('decoder exploded')
    await expect(asr.recognize(makeSilentPcm16(10))).resolves.toMatchObject({ text: 'x' })

    const asr2 = createFakeAsrEngine()
    asr2.failLoad(new Error('model file missing'))
    await expect(asr2.loadModel()).rejects.toThrow('model file missing')
    expect(asr2.state).toBe('error')
  })
})

describe('fake-asr 对齐 P3B-09 冻结 ABI', () => {
  it('结构满足 AsrEngine（编译期 + localOnly 恒 true）', async () => {
    const asr: AsrEngine = createFakeAsrEngine([{ text: '对齐' }])
    expect(asr.localOnly).toBe(true)
    expect(asr.id).toBe('fake-asr')
    await asr.loadModel()
    const result = await asr.recognize(makeSilentPcm16(50), { language: 'zh' })
    expect(result.text).toBe('对齐')
  })

  it('observations 透传 audio 长度与语言提示', async () => {
    const asr = createFakeAsrEngine([])
    await asr.loadModel()
    await asr.recognize(makeSilentPcm16(20), { language: 'en' }) // 20ms@16k = 320 样本
    expect(asr.observations.lastAudioSamples).toBe(320)
    expect(asr.observations.lastLanguage).toBe('en')
    await asr.recognize(makeSilentPcm16(20))
    expect(asr.observations.lastLanguage).toBeUndefined()
  })
})
