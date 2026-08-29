// @vitest-environment jsdom
// src/renderer/src/live2d/motion/saccade.test.ts
// P3A-18：边界 clamp、Lerp 与交互暂停。

import { describe, expect, it } from 'vitest'
import type { ILive2DRenderer } from '../ILive2DRenderer'
import { createSaccadeController } from './saccade'

function fakeRenderer(): { renderer: ILive2DRenderer; values: Array<{ id: string; value: number }> } {
  const values: Array<{ id: string; value: number }> = []
  const renderer = {
    attach() { /* noop */ }, load: async () => { /* noop */ }, unload() { /* noop */ }, resize() { /* noop */ }, setZoom() { /* noop */ }, setOffset() { /* noop */ }, pause() { /* noop */ }, resume() { /* noop */ }, setFrameDriver() { /* noop */ },
    setExpression: async () => true, playMotion: async () => true, setParameter(update: { id: string; value: number }) {
      values.push(update); return true
    }, setMouthOpen: () => true, setEyeOpen: () => true, hitTest: () => [],
    getMetrics: () => ({ fps: 0, frameCount: 0, modelLoadMs: null, contextLossCount: 0, paused: false, hasModel: true }), dispose() { /* noop */ }
  } satisfies ILive2DRenderer
  return { renderer, values }
}

describe('P3A-18 saccade controller', () => {
  it('目标在 interval 后采样，值逐步 lerp 且始终在 [-1,1]', () => {
    const { renderer, values } = fakeRenderer()
    const saccade = createSaccadeController({ renderer, random: () => 1, targetIntervalMs: 100 })
    saccade.update(99)
    expect(saccade.targetX).toBe(0)
    saccade.update(1)
    expect(saccade.targetX).toBe(1)
    expect(saccade.targetY).toBe(1)
    saccade.update(16)
    expect(saccade.x).toBeGreaterThan(0)
    expect(saccade.x).toBeLessThan(1)
    expect(values.every((entry) => entry.value >= -1 && entry.value <= 1)).toBe(true)
  })

  it('用户交互期间不改变目标也不跳变，恢复后继续追踪', () => {
    const { renderer } = fakeRenderer()
    const saccade = createSaccadeController({ renderer, random: () => 1, targetIntervalMs: 1, interactionPauseMs: 500 })
    saccade.update(1)
    const before = { x: saccade.x, y: saccade.y, targetX: saccade.targetX }
    saccade.pauseForInteraction()
    saccade.update(100)
    expect(saccade.targetX).toBe(before.targetX)
    expect(saccade.x).toBe(before.x)
    saccade.update(500)
    expect(saccade.x).toBeGreaterThan(before.x)
  })

  it('reset/dispose 将视线归中', () => {
    const { renderer } = fakeRenderer()
    const saccade = createSaccadeController({ renderer, random: () => 1, targetIntervalMs: 1 })
    saccade.update(100)
    saccade.dispose()
    expect(saccade.x).toBe(0)
    expect(saccade.y).toBe(0)
    expect(saccade.targetX).toBe(0)
  })
})
