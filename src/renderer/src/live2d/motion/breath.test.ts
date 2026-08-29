// @vitest-environment jsdom
// src/renderer/src/live2d/motion/breath.test.ts
// P3A-19：正弦呼吸的有界性、缺参自动降级、reset/dispose。

import { describe, expect, it } from 'vitest'
import type { ILive2DRenderer } from '../ILive2DRenderer'
import { createBreathController } from './breath'

function fakeRenderer(hasBreath: boolean): { renderer: ILive2DRenderer; values: number[] } {
  const values: number[] = []
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
    setParameter(update: { id: string; value: number }) {
      if (update.id === 'ParamBreath' && !hasBreath) return false
      values.push(update.value)
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
  return { renderer, values }
}

describe('P3A-19 breath controller', () => {
  it('持续输出 0..1 有界正弦呼吸', () => {
    const { renderer, values } = fakeRenderer(true)
    const breath = createBreathController({ renderer, periodMs: 1_000, amplitude: 0.2 })
    for (let i = 0; i < 100; i++) breath.update(16)
    expect(values.length).toBeGreaterThan(1)
    expect(values.every((value) => value >= 0 && value <= 1)).toBe(true)
    expect(breath.enabled).toBe(true)
  })

  it('模型缺少 ParamBreath 时只禁用 fallback，不抛异常', () => {
    const { renderer } = fakeRenderer(false)
    const breath = createBreathController({ renderer })
    breath.update(16)
    expect(breath.enabled).toBe(false)
  })

  it('reset 归一、dispose 停止后续写入', () => {
    const { renderer, values } = fakeRenderer(true)
    const breath = createBreathController({ renderer })
    breath.update(100)
    breath.reset()
    expect(breath.phase).toBe(0)
    const count = values.length
    breath.dispose()
    breath.update(100)
    expect(values.length).toBe(count + 1)
    expect(breath.enabled).toBe(false)
  })
})
