// src/renderer/src/voice/mic-worklet-processor.test.ts
// P3B-13：worklet 纯逻辑测试（直接 import public 资产里的 ES 模块；node 环境无
// AudioWorkletProcessor 全局，注册分支被 typeof 守卫跳过——这也是该守卫的
// 直接验证）。S-004：不碰真实麦克风/音频。
import { describe, expect, it } from 'vitest'
import {
  createMicFrameAccumulator,
  floatToInt16Frame,
  MIC_WORKLET_FRAME_SAMPLES,
  MIC_WORKLET_PROCESSOR_NAME
} from '../../public/voice/mic-worklet-processor.js'
import { MIC_FRAME_SAMPLES } from '@shared/voice/mic-types'

describe('P3B-13 worklet 常量与共享合同对齐', () => {
  it('帧尺寸 512 与 mic-types 一致；处理器名冻结', () => {
    expect(MIC_WORKLET_FRAME_SAMPLES).toBe(512)
    expect(MIC_WORKLET_FRAME_SAMPLES).toBe(MIC_FRAME_SAMPLES)
    expect(MIC_WORKLET_PROCESSOR_NAME).toBe('mic-frame-processor')
  })
})

describe('P3B-13 floatToInt16Frame', () => {
  it('[-1,1] 线性映射 ×32767 四舍五入；超界夹取', () => {
    // Math.round 向 +∞ 取半：-0.5×32767 = -16383.5 → -16383
    expect(floatToInt16Frame(new Float32Array([0, 0.5, -0.5, 1, -1]))).toEqual(
      new Int16Array([0, 16384, -16383, 32767, -32767])
    )
    expect(floatToInt16Frame(new Float32Array([2, -2]))).toEqual(new Int16Array([32767, -32767]))
    expect(floatToInt16Frame(new Float32Array([0.00001]))).toEqual(new Int16Array([0]))
  })
})

describe('P3B-13 createMicFrameAccumulator（128 样本量子 → 512 样本帧）', () => {
  it('4 个 128 块恰出 1 帧；内容按序拼接', () => {
    const acc = createMicFrameAccumulator()
    const block = new Float32Array(128).fill(0.25)
    expect(acc.push(block)).toHaveLength(0)
    expect(acc.push(block)).toHaveLength(0)
    expect(acc.push(block)).toHaveLength(0)
    const frames = acc.push(block)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toBeInstanceOf(Int16Array)
    expect(frames[0].length).toBe(512)
    expect(frames[0].every((v) => v === 8192)).toBe(true) // 0.25×32767≈8192
  })

  it('单块跨多帧：1024 样本块出 2 帧', () => {
    const acc = createMicFrameAccumulator()
    const big = new Float32Array(1024)
    for (let i = 0; i < 1024; i++) big[i] = i % 2 === 0 ? 0.5 : -0.5
    const frames = acc.push(big)
    expect(frames).toHaveLength(2)
    expect(frames[0].length).toBe(512)
    expect(frames[1].length).toBe(512)
    expect(frames[0][0]).toBe(16384)
    expect(frames[1][0]).toBe(16384)
  })

  it('跨块凑帧：128+256+128 = 512 出 1 帧且样本顺序正确', () => {
    const acc = createMicFrameAccumulator()
    const a = new Float32Array(128).fill(0.1)
    const b = new Float32Array(256).fill(0.2)
    const c = new Float32Array(128).fill(0.3)
    expect(acc.push(a)).toHaveLength(0)
    expect(acc.push(b)).toHaveLength(0)
    const frames = acc.push(c)
    expect(frames).toHaveLength(1)
    const f = frames[0]
    expect(f.slice(0, 128).every((v) => v === 3277)).toBe(true)
    expect(f.slice(128, 384).every((v) => v === 6553)).toBe(true)
    expect(f.slice(384).every((v) => v === 9830)).toBe(true)
  })

  it('reset 丢弃半满状态', () => {
    const acc = createMicFrameAccumulator()
    acc.push(new Float32Array(128).fill(0.5))
    acc.reset()
    const frames = acc.push(new Float32Array(128).fill(0.5))
    expect(frames).toHaveLength(0) // reset 后仍只有 128/512
  })
})
