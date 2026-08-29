// src/renderer/src/live2d/motion/blink.ts
// P3A-17：可注入时钟/RNG 的自动眨眼状态机。
// idle 3–8s → closing 75ms → closed → opening 150–300ms；reduceMotion 只降频，不静止。

import { LIVE2D_PARAMETER_IDS } from '../ILive2DRenderer'
import type { ILive2DRenderer } from '../ILive2DRenderer'
import type { MotionPlugin } from './pipeline'

export type BlinkState = 'idle' | 'closing' | 'closed' | 'opening'

export interface BlinkController {
  readonly state: BlinkState
  readonly nextBlinkInMs: number
  update(deltaMs: number): void
  reset(): void
  dispose(): void
}

export interface BlinkOptions {
  readonly renderer: ILive2DRenderer
  readonly random?: () => number
  readonly reduceMotion?: () => boolean
  readonly minIdleMs?: number
  readonly maxIdleMs?: number
  readonly closingMs?: number
  readonly minOpeningMs?: number
  readonly maxOpeningMs?: number
}

function unitRandom(random: () => number): number {
  const value = random()
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}

export function createBlinkController(options: BlinkOptions): BlinkController {
  const random = options.random ?? Math.random
  const minIdleMs = options.minIdleMs ?? 3_000
  const maxIdleMs = options.maxIdleMs ?? 8_000
  const closingMs = options.closingMs ?? 75
  const minOpeningMs = options.minOpeningMs ?? 150
  const maxOpeningMs = options.maxOpeningMs ?? 300
  let state: BlinkState = 'idle'
  let elapsed = 0
  let nextBlinkInMs = minIdleMs
  let scheduledIntervalMs = minIdleMs
  let openingDuration = minOpeningMs

  const schedule = (): void => {
    const span = Math.max(0, maxIdleMs - minIdleMs)
    scheduledIntervalMs = minIdleMs + unitRandom(random) * span
    nextBlinkInMs = options.reduceMotion?.() === true
      ? Math.max(scheduledIntervalMs, 12_000)
      : scheduledIntervalMs
    elapsed = 0
  }

  /**
   * 眨眼写**绝对值**，由 `.exp3.json` 里 `ParamEyeLOpen/ROpen` 的 `Multiply` 去叠加它——
   * 眨眼提供睁眼基准，表情在基准上乘系数，这正是 Cubism 表情用 Multiply 混合的本意。
   *
   * 这里**不能**改成 multiply（2026-08-29 曾这样改过，导致眼睛永久闭合）：插件写完之后
   * 渲染库才 `saveParameters()`，并在帧末 `loadParameters()` 把它恢复回去——我们的写入因此
   * 成为下一帧的基准。乘性写入会逐帧复利，一旦某帧乘 0，之后 `0 × 任何值` 恒为 0，
   * 眼睛再也睁不开。同日把插件位置从 ticker 迁到 native motion 求值处也不改变这一点：
   * `saveParameters()` 仍排在插件之后。
   */
  const setEyes = (value: number): void => {
    options.renderer.setParameter({ id: LIVE2D_PARAMETER_IDS.eyeLeftOpen, value })
    options.renderer.setParameter({ id: LIVE2D_PARAMETER_IDS.eyeRightOpen, value })
  }

  const reset = (): void => {
    state = 'idle'
    setEyes(1)
    schedule()
  }

  const update = (deltaMs: number): void => {
    if (options.reduceMotion?.() === true) {
      // 保留眨眼但降低频率：延长当前 idle interval 一次；不要在每帧继续重置 elapsed。
      if (state === 'idle' && scheduledIntervalMs < 12_000) nextBlinkInMs = 12_000
    }
    const delta = Math.max(0, Number.isFinite(deltaMs) ? deltaMs : 0)
    elapsed += delta
    switch (state) {
      case 'idle':
        if (elapsed >= nextBlinkInMs) {
          state = 'closing'
          elapsed = 0
        }
        return
      case 'closing': {
        const progress = Math.min(1, elapsed / closingMs)
        setEyes(1 - progress)
        if (progress >= 1) {
          state = 'closed'
          elapsed = 0
          openingDuration = minOpeningMs + unitRandom(random) * Math.max(0, maxOpeningMs - minOpeningMs)
        }
        return
      }
      case 'closed':
        setEyes(0)
        state = 'opening'
        elapsed = 0
        return
      case 'opening': {
        const progress = Math.min(1, elapsed / openingDuration)
        setEyes(progress)
        if (progress >= 1) reset()
      }
    }
  }

  reset()
  return {
    get state() { return state },
    get nextBlinkInMs() { return Math.max(0, nextBlinkInMs - elapsed) },
    update,
    reset,
    dispose() {
      setEyes(1)
    }
  }
}

export function createBlinkPlugin(options: BlinkOptions): MotionPlugin & { readonly controller: BlinkController } {
  const controller = createBlinkController(options)
  return {
    id: 'auto-blink',
    priority: 100,
    phases: ['post'],
    onFrame: (context) => controller.update(context.frame.deltaMs),
    dispose: () => controller.dispose(),
    controller
  }
}
