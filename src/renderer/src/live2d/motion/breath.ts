// src/renderer/src/live2d/motion/breath.ts
// P3A-19：AutoBreath 优先复用模型 native motion；无可用 breath 参数时不强写，避免残值。
// 轻量 fallback 使用有界正弦波，窗口隐藏时由 renderer pause ticker。

import { LIVE2D_PARAMETER_IDS } from '../ILive2DRenderer'
import type { ILive2DRenderer } from '../ILive2DRenderer'
import type { MotionPlugin } from './pipeline'

export interface BreathController {
  readonly phase: number
  readonly enabled: boolean
  update(deltaMs: number): void
  reset(): void
  dispose(): void
}

export interface BreathOptions {
  readonly renderer: ILive2DRenderer
  readonly periodMs?: number
  readonly amplitude?: number
}

export function createBreathController(options: BreathOptions): BreathController {
  const periodMs = Math.max(500, options.periodMs ?? 3_500)
  const amplitude = Math.min(1, Math.max(0, options.amplitude ?? 0.12))
  let phase = 0
  let enabled = true

  const reset = (): void => {
    phase = 0
    if (enabled) options.renderer.setParameter({ id: LIVE2D_PARAMETER_IDS.breath, value: 0.5 })
  }
  const update = (deltaMs: number): void => {
    if (!enabled) return
    const delta = Math.max(0, Number.isFinite(deltaMs) ? deltaMs : 0)
    phase = (phase + (delta / periodMs) * Math.PI * 2) % (Math.PI * 2)
    const value = Math.min(1, Math.max(0, 0.5 + Math.sin(phase) * amplitude))
    if (!options.renderer.setParameter({ id: LIVE2D_PARAMETER_IDS.breath, value })) {
      enabled = false
    }
  }

  reset()
  return {
    get phase() {
      return phase
    },
    get enabled() {
      return enabled
    },
    update,
    reset,
    dispose() {
      if (enabled) options.renderer.setParameter({ id: LIVE2D_PARAMETER_IDS.breath, value: 0.5 })
      enabled = false
    }
  }
}

export function createBreathPlugin(
  options: BreathOptions
): MotionPlugin & { readonly controller: BreathController } {
  const controller = createBreathController(options)
  return {
    id: 'auto-breath',
    priority: 120,
    phases: ['post'],
    onFrame: (context) => controller.update(context.frame.deltaMs),
    dispose: () => controller.dispose(),
    controller
  }
}
