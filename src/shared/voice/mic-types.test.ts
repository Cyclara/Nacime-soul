// src/shared/voice/mic-types.test.ts
// P3B-13：mic port 消息合同测试。

import { describe, expect, it } from 'vitest'
import {
  isMicFrameMessage,
  isValidMicFrameSamples,
  MIC_FRAME_SAMPLES,
  MIC_MAX_FRAME_SAMPLES,
  MIC_SAMPLE_RATE
} from './mic-types'

describe('P3B-13 mic-types 常量', () => {
  it('帧 512 样本（= VAD 窗口 32ms）、上限 2048、采样率 16k', () => {
    expect(MIC_FRAME_SAMPLES).toBe(512)
    expect(MIC_MAX_FRAME_SAMPLES).toBe(2048)
    expect(MIC_SAMPLE_RATE).toBe(16_000)
  })
})

describe('P3B-13 isMicFrameMessage', () => {
  it('合法消息通过', () => {
    expect(isMicFrameMessage({ type: 'mic-frame', samples: new Int16Array(512) })).toBe(true)
  })

  it('非对象 / 缺字段 / 错类型 / Float32 全拒绝', () => {
    expect(isMicFrameMessage(null)).toBe(false)
    expect(isMicFrameMessage(undefined)).toBe(false)
    expect(isMicFrameMessage('mic-frame')).toBe(false)
    expect(isMicFrameMessage({})).toBe(false)
    expect(isMicFrameMessage({ type: 'mic-frame' })).toBe(false)
    expect(isMicFrameMessage({ type: 'other', samples: new Int16Array(8) })).toBe(false)
    expect(isMicFrameMessage({ type: 'mic-frame', samples: new Float32Array(8) })).toBe(false)
    expect(isMicFrameMessage({ type: 'mic-frame', samples: [1, 2, 3] })).toBe(false)
  })
})

describe('P3B-13 isValidMicFrameSamples', () => {
  it('空帧与超限帧拒绝；正常 512 通过', () => {
    expect(isValidMicFrameSamples(new Int16Array(0))).toBe(false)
    expect(isValidMicFrameSamples(new Int16Array(MIC_MAX_FRAME_SAMPLES + 1))).toBe(false)
    expect(isValidMicFrameSamples(new Int16Array(MIC_FRAME_SAMPLES))).toBe(true)
    expect(isValidMicFrameSamples(new Int16Array(128))).toBe(true)
  })
})
