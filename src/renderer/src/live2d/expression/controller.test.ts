// @vitest-environment jsdom
// src/renderer/src/live2d/expression/controller.test.ts
// P3A-22：表情刷新、平滑期限与 neutral 回归（默认 15s，可注入覆盖）。

import { describe, expect, it } from 'vitest'
import type { ILive2DRenderer } from '../ILive2DRenderer'
import { DEFAULT_EXPRESSION_RESET_MS, createExpressionController } from './controller'

function makeRenderer(): { renderer: ILive2DRenderer; expressions: string[] } {
  const expressions: string[] = []
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
    setExpression: async (name: string) => {
      expressions.push(name)
      return true
    },
    playMotion: async () => true,
    setParameter: () => true,
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
  return { renderer: result, expressions }
}

describe('P3A-22 ExpressionController', () => {
  it('至少三种情绪可触发表情，缺失情绪回 neutral alias', async () => {
    const { renderer, expressions } = makeRenderer()
    const controller = createExpressionController({
      renderer,
      expressionNames: ['normal', 'smile', 'sad']
    })
    await controller.setEmotion('smile')
    await controller.setEmotion('sad')
    await controller.setEmotion('angry')
    expect(expressions).toEqual(['smile', 'sad', 'normal'])
    expect(controller.activeExpression).toBe('normal')
  })

  it('刷新期限在 179s 不回 neutral，180s 后回 neutral；刷新可延长期限', async () => {
    const { renderer, expressions } = makeRenderer()
    const controller = createExpressionController({
      renderer,
      expressionNames: ['neutral', 'smile'],
      resetAfterMs: 180_000
    })
    await controller.setEmotion('smile')
    controller.update(179_000, 179_000)
    expect(controller.current).toBe('smile')
    controller.refresh()
    controller.update(179_000, 358_000)
    expect(controller.current).toBe('smile')
    controller.update(1_000, 359_000)
    expect(controller.current).toBe('neutral')
    expect(expressions.at(-1)).toBe('neutral')
  })

  // S-Phase3 P3A-22 原写 3 分钟；2026-08-29 用户真机体验后改为 15 秒（情绪挂脸上太久不自然）。
  it('默认静默 15 秒后回 neutral：14.9s 仍保持，15s 到点复位', async () => {
    const { renderer } = makeRenderer()
    const controller = createExpressionController({
      renderer,
      expressionNames: ['neutral', 'smile']
    })
    expect(DEFAULT_EXPRESSION_RESET_MS).toBe(15_000)
    await controller.setEmotion('smile')
    controller.update(14_900, 14_900)
    expect(controller.current).toBe('smile')
    controller.update(100, 15_000)
    expect(controller.current).toBe('neutral')
  })

  it('dispose 后不再触发表情切换', async () => {
    const { renderer, expressions } = makeRenderer()
    const controller = createExpressionController({ renderer, expressionNames: ['smile'] })
    controller.dispose()
    expect(await controller.setEmotion('smile')).toBe(false)
    expect(expressions).toEqual([])
  })
})
