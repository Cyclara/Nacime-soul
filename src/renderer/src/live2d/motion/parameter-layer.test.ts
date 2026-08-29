// @vitest-environment jsdom
// src/renderer/src/live2d/motion/parameter-layer.test.ts
// P3A-21：activeLastFrame/activeThisFrame 逐帧交换，无旧参数残留。

import { describe, expect, it } from 'vitest'
import type { ILive2DRenderer } from '../ILive2DRenderer'
import { createParameterLayer } from './parameter-layer'

function makeRenderer(): {
  renderer: ILive2DRenderer
  updates: Array<{ id: string; value: number }>
} {
  const updates: Array<{ id: string; value: number }> = []
  const result = {
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
      updates.push(update)
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
  return { renderer: result, updates }
}

describe('P3A-21 ParameterLayer', () => {
  it('本帧写入成为 activeLastFrame，下一帧不自动复制', () => {
    const { renderer, updates } = makeRenderer()
    const layer = createParameterLayer(renderer)
    layer.set({ id: 'ParamCheek', value: 0.8 })
    expect(layer.activeThisFrame).toEqual(['ParamCheek'])
    layer.apply()
    expect(layer.activeLastFrame).toEqual(['ParamCheek'])
    expect(layer.activeThisFrame).toEqual([])
    layer.apply()
    expect(updates).toEqual([{ id: 'ParamCheek', value: 0.8, blend: 'set' }])
  })

  it('同一帧后写覆盖前写，避免多个插件对同一参数重复抖动', () => {
    const { renderer, updates } = makeRenderer()
    const layer = createParameterLayer(renderer)
    layer.multiply({ id: 'ParamCheek', value: 0.2 })
    layer.multiply({ id: 'ParamCheek', value: 0.4, weight: 0.5 })
    layer.apply()
    expect(updates).toEqual([{ id: 'ParamCheek', value: 0.4, weight: 0.5, blend: 'multiply' }])
  })
})
