// @vitest-environment jsdom
// src/renderer/src/live2d/motion/blink.test.ts
// P3A-17：fake clock 覆盖 idle/closing/closed/opening 的时间边界。

import { describe, expect, it } from 'vitest'
import type { ILive2DRenderer } from '../ILive2DRenderer'
import { createBlinkController } from './blink'

function fakeRenderer(): {
  renderer: ILive2DRenderer
  values: number[]
  updates: Array<{ id: string; value: number; blend?: string }>
} {
  const values: number[] = []
  const updates: Array<{ id: string; value: number; blend?: string }> = []
  const renderer = {
    attach() {
      /* noop */
    },
    load: async () => {
      /* noop */
    },
    unload() {
      /* noop */
    },
    resize() {
      /* noop */
    },
    setZoom() {
      /* noop */
    },
    setOffset() {
      /* noop */
    },
    pause() {
      /* noop */
    },
    resume() {
      /* noop */
    },
    setFrameDriver() {
      /* noop */
    },
    setExpression: async () => true,
    playMotion: async () => true,
    setParameter(update: { id: string; value: number; blend?: 'set' | 'multiply' }) {
      values.push(update.value)
      updates.push({
        id: update.id,
        value: update.value,
        ...(update.blend === undefined ? {} : { blend: update.blend })
      })
      return true
    },
    setMouthOpen: () => true,
    setEyeOpen: () => true,
    hitTest: () => [],
    getMetrics: () => ({
      fps: 0,
      frameCount: 0,
      modelLoadMs: null,
      contextLossCount: 0,
      paused: false,
      hasModel: true
    }),
    dispose() {
      /* noop */
    }
  } satisfies ILive2DRenderer
  return { renderer, values, updates }
}

describe('P3A-17 blink controller', () => {
  it('idle 3s 后 closing 75ms，closed 一帧，再 opening 150ms 完成', () => {
    const { renderer, values } = fakeRenderer()
    const blink = createBlinkController({ renderer, random: () => 0 })
    expect(blink.state).toBe('idle')
    blink.update(2_999)
    expect(blink.state).toBe('idle')
    blink.update(1)
    expect(blink.state).toBe('closing')
    blink.update(75)
    expect(blink.state).toBe('closed')
    blink.update(1)
    expect(blink.state).toBe('opening')
    blink.update(149)
    expect(blink.state).toBe('opening')
    blink.update(1)
    expect(blink.state).toBe('idle')
    expect(values.some((value) => value === 0)).toBe(true)
    expect(values.at(-1)).toBe(1)
  })

  // 2026-08-29 真机回归：眨眼必须写**绝对值**，绝不能改成 multiply。
  // 插件跑在 post 阶段，而 fork 在帧末才 loadParameters()，我们的写入会被下一帧
  // saveParameters() 固化成新基准——乘性写入逐帧复利，某帧乘 0 之后 `0×1` 恒为 0，
  // 眼睛永久闭合（当天实测复现过）。表情侧的 Multiply 负责在此基准上叠加。
  it('眼睛写绝对值而非 multiply，避免逐帧复利把眼睛永久乘成 0', () => {
    const { renderer, updates } = fakeRenderer()
    const blink = createBlinkController({ renderer, random: () => 0 })
    blink.update(3_000)
    blink.update(75)
    blink.update(1)
    const eyeUpdates = updates.filter((u) => u.id === 'ParamEyeLOpen' || u.id === 'ParamEyeROpen')
    expect(eyeUpdates.length).toBeGreaterThan(0)
    expect(eyeUpdates.every((u) => u.blend === undefined)).toBe(true)
    // 左右眼都要写，否则只有一只眼睛会眨。
    expect(new Set(eyeUpdates.map((u) => u.id))).toEqual(
      new Set(['ParamEyeLOpen', 'ParamEyeROpen'])
    )
    // 张开状态必须能回到 1；复利 bug 的特征就是再也回不到 1。
    blink.update(5_000)
    expect(updates.filter((u) => u.id === 'ParamEyeLOpen').at(-1)?.value).toBe(1)
  })

  it('随机 interval 受 3–8s 约束，reduceMotion 延长但不完全禁用', () => {
    const { renderer } = fakeRenderer()
    const blink = createBlinkController({ renderer, random: () => 1, reduceMotion: () => true })
    expect(blink.nextBlinkInMs).toBe(12_000)
    blink.update(12_000)
    expect(blink.state).toBe('closing')
  })

  it('非法 delta/random 不产生 NaN 参数', () => {
    const { renderer, values } = fakeRenderer()
    const blink = createBlinkController({ renderer, random: () => Number.NaN })
    blink.update(Number.NaN)
    blink.update(3_000)
    expect(values.every(Number.isFinite)).toBe(true)
  })
})
