// src/shared/live2d/performance.test.ts

import { describe, expect, it } from 'vitest'
import { evaluateLive2dPerformance, failedLive2dPerformanceChecks } from './performance'

describe('P3A-28 Live2D performance budget', () => {
  it('达到 fps/内存/首帧/CPU 预算才通过', () => {
    expect(
      evaluateLive2dPerformance({
        fps: 60,
        idleCpuPercent: 2,
        renderMemoryMb: 120,
        firstFrameMs: 1_200,
        visible: true,
        modelsLoadedThisSession: 1
      }).ok
    ).toBe(true)
    expect(
      evaluateLive2dPerformance({
        fps: 20,
        idleCpuPercent: 2,
        renderMemoryMb: 120,
        firstFrameMs: 1_200,
        visible: true,
        modelsLoadedThisSession: 1
      }).ok
    ).toBe(false)
  })

  it('未测量指标显式为 null，不伪造 0；隐藏窗口不以低 fps 判失败', () => {
    const result = evaluateLive2dPerformance({
      fps: 0,
      idleCpuPercent: null,
      renderMemoryMb: null,
      firstFrameMs: null,
      visible: false,
      modelsLoadedThisSession: 1
    })
    expect(result.checks).toEqual({ fps: null, memory: null, firstFrame: null, idleCpu: null })
    expect(result.ok).toBe(false)
  })

  it('未达标项可列举，供 main 落一条 warn；未测量项不算未达标', () => {
    const breached = evaluateLive2dPerformance({
      fps: 12,
      idleCpuPercent: 41,
      renderMemoryMb: 260,
      firstFrameMs: 5_400,
      visible: true,
      modelsLoadedThisSession: 1
    })
    expect(failedLive2dPerformanceChecks(breached)).toEqual([
      'fps',
      'memory',
      'firstFrame',
      'idleCpu'
    ])

    const hidden = evaluateLive2dPerformance({
      fps: 0,
      idleCpuPercent: null,
      renderMemoryMb: 90,
      firstFrameMs: null,
      visible: false,
      modelsLoadedThisSession: 1
    })
    expect(failedLive2dPerformanceChecks(hidden)).toEqual([])

    const healthy = evaluateLive2dPerformance({
      fps: 60,
      idleCpuPercent: 1,
      renderMemoryMb: 90,
      firstFrameMs: 800,
      visible: true,
      modelsLoadedThisSession: 1
    })
    expect(failedLive2dPerformanceChecks(healthy)).toEqual([])
  })

  // 2026-08-29 用户裁定：内存口径为「**单模型稳态** ≤150MB」。换过模型后常驻会包含上一个
  // 模型延迟释放的纹理与不可收缩的 Cubism WASM 堆（实测稳态 131–132MB / 切换 8 次后 175MB），
  // 既非回归也无从修复；按原「任意时刻」口径会在每次换装时长期误报、把真回归淹掉。
  it('换过模型后内存记为「未测量」而非「未达标」，其余项照常判定', () => {
    const afterSwitch = evaluateLive2dPerformance({
      fps: 58,
      idleCpuPercent: 2,
      renderMemoryMb: 191,
      firstFrameMs: 900,
      visible: true,
      modelsLoadedThisSession: 4
    })
    expect(afterSwitch.checks.memory).toBeNull()
    expect(failedLive2dPerformanceChecks(afterSwitch)).toEqual([])
    expect(afterSwitch.ok).toBe(true)

    // 同样的内存值在单模型稳态下必须判失败——不是把这一项废掉。
    const steady = evaluateLive2dPerformance({
      fps: 58,
      idleCpuPercent: 2,
      renderMemoryMb: 191,
      firstFrameMs: 900,
      visible: true,
      modelsLoadedThisSession: 1
    })
    expect(steady.checks.memory).toBe(false)
    expect(failedLive2dPerformanceChecks(steady)).toEqual(['memory'])

    // 换过模型也不会掩盖 fps/CPU/首帧的真实回归。
    const switchedButSlow = evaluateLive2dPerformance({
      fps: 11,
      idleCpuPercent: 44,
      renderMemoryMb: 191,
      firstFrameMs: 6_000,
      visible: true,
      modelsLoadedThisSession: 4
    })
    expect(failedLive2dPerformanceChecks(switchedButSlow)).toEqual(['fps', 'firstFrame', 'idleCpu'])
  })
})
