// src/renderer/src/live2d/motion/saccade.ts
// P3A-18：低频随机眼跳。目标采样、lerp、[-1,1] clamp；交互短暂冻结目标。

import { LIVE2D_PARAMETER_IDS } from '../ILive2DRenderer'
import type { ILive2DRenderer } from '../ILive2DRenderer'
import type { MotionPlugin } from './pipeline'

export interface SaccadeController {
  readonly targetX: number
  readonly targetY: number
  readonly x: number
  readonly y: number
  update(deltaMs: number): void
  pauseForInteraction(durationMs?: number): void
  reset(): void
  dispose(): void
}

export interface SaccadeOptions {
  readonly renderer: ILive2DRenderer
  readonly random?: () => number
  readonly targetIntervalMs?: number
  readonly interactionPauseMs?: number
  readonly lerpPerFrame?: number
}

function clamp(value: number): number {
  return Math.min(1, Math.max(-1, Number.isFinite(value) ? value : 0))
}

function sample(random: () => number): number {
  return clamp(random() * 2 - 1)
}

export function createSaccadeController(options: SaccadeOptions): SaccadeController {
  const random = options.random ?? Math.random
  const targetIntervalMs = options.targetIntervalMs ?? 1_200
  const interactionPauseMs = options.interactionPauseMs ?? 600
  const lerpPerFrame = clamp(options.lerpPerFrame ?? 0.08)
  let targetX = 0
  let targetY = 0
  let x = 0
  let y = 0
  let elapsed = 0
  let pausedFor = 0

  const write = (): void => {
    options.renderer.setParameter({ id: LIVE2D_PARAMETER_IDS.eyeBallX, value: x })
    options.renderer.setParameter({ id: LIVE2D_PARAMETER_IDS.eyeBallY, value: y })
  }
  const reset = (): void => {
    targetX = 0
    targetY = 0
    x = 0
    y = 0
    elapsed = 0
    pausedFor = 0
    write()
  }
  const update = (deltaMs: number): void => {
    const delta = Math.max(0, Number.isFinite(deltaMs) ? deltaMs : 0)
    if (pausedFor > 0) pausedFor = Math.max(0, pausedFor - delta)
    if (pausedFor === 0) {
      elapsed += delta
      if (elapsed >= targetIntervalMs) {
        targetX = sample(random)
        targetY = sample(random)
        elapsed = 0
      }
    }
    // use a frame-independent enough factor with a bounded maximum to prevent jumps after resume
    const factor = pausedFor > 0 ? 0 : Math.min(1, lerpPerFrame * Math.max(1, delta / 16.67))
    x = clamp(x + (targetX - x) * factor)
    y = clamp(y + (targetY - y) * factor)
    write()
  }

  reset()
  return {
    get targetX() { return targetX },
    get targetY() { return targetY },
    get x() { return x },
    get y() { return y },
    update,
    pauseForInteraction(durationMs = interactionPauseMs) {
      pausedFor = Math.max(pausedFor, durationMs)
    },
    reset,
    dispose: reset
  }
}

export function createSaccadePlugin(options: SaccadeOptions): MotionPlugin & { readonly controller: SaccadeController } {
  const controller = createSaccadeController(options)
  return {
    id: 'saccade',
    priority: 110,
    phases: ['post'],
    onFrame: (context) => controller.update(context.frame.deltaMs),
    dispose: () => controller.dispose(),
    controller
  }
}
