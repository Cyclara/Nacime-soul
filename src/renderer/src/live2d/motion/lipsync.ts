// src/renderer/src/live2d/motion/lipsync.ts
// P3B-17（F5-007 §1.14 / S-Phase3）：音频电平 → 口型的平滑与单写者纪律。
//
// 设计要点：
//   - attack/release 200ms 线性包络（全程标定）：上升/下降每帧最多走
//     `deltaMs / 200`，任何电平跳变都被拉成 200ms 的坡，无跳变。
//   - 单写者：live2d 进程里 ParamMouthOpenY 只有本插件会周期性写（blink/眼跳/呼吸
//     各写眼睛与呼吸参数；expression-controller 在 priority 130 final 写 MouthForm
//     一类形状参数）。本插件 priority 140 final——说话时覆盖一切；而**沉默时停写**，
//     让 idle motion / 表情重新接管口部（fork 的 save/load 语义：停写后基准即闭嘴 0）。
//   - 模型缺 ParamMouthOpenY（setMouthOpen 返回 false）时只禁 lip-sync：不再写参数，
//     音频照常播放（sink 与参数写入完全解耦）。插件随每次模型加载重建，新模型有
//     参数则自动恢复。
//   - 电平来源（LipSyncSource）由 audio-player 的 readLevel 提供；本模块不做任何
//     音频工作（S-004：测试不加载真实声音设备）。

import type { ILive2DRenderer } from '../ILive2DRenderer'
import type { MotionPlugin } from './pipeline'

/** 200ms attack/release（S-Phase3 P3B-17 冻结值）。 */
export const LIP_SYNC_ATTACK_MS = 200
export const LIP_SYNC_RELEASE_MS = 200

/** 口型电平来源；audio-player 满足此形状。 */
export interface LipSyncSource {
  /** 当前开口度目标（0..1）。 */
  readLevel(): number
}

export interface LipSyncController {
  /** 当前平滑后的开口度（0..1）。 */
  readonly level: number
  /** 是否在写参数（说话中或闭合中）；false = 静默交还 motion，或因缺参数禁用。 */
  readonly active: boolean
  /** 模型缺 ParamMouthOpenY 导致 lip-sync 被禁（音频不受影响）。 */
  readonly disabled: boolean
  update(deltaMs: number): void
  dispose(): void
}

export interface LipSyncOptions {
  readonly renderer: ILive2DRenderer
  readonly source: LipSyncSource
  readonly attackMs?: number
  readonly releaseMs?: number
  /**
   * P3A-22（S-006-补充 §1.7.5）：每个「正在说话」的帧（level > 0）回调一次——
   * stage-controller 用它刷新表情复位期限，说话中表情不掉回 neutral。
   */
  readonly onSpeakingFrame?: () => void
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

export function createLipSyncController(options: LipSyncOptions): LipSyncController {
  const attackMs = Math.max(1, options.attackMs ?? LIP_SYNC_ATTACK_MS)
  const releaseMs = Math.max(1, options.releaseMs ?? LIP_SYNC_RELEASE_MS)
  let level = 0
  let active = false
  let disabled = false

  return {
    get level() {
      return level
    },
    get active() {
      return active
    },
    get disabled() {
      return disabled
    },

    update(deltaMs) {
      if (disabled) return
      const delta = Math.max(0, Number.isFinite(deltaMs) ? deltaMs : 0)
      const target = clamp01(options.source.readLevel())
      // 线性 attack/release：每帧最大步长 delta/attack（或 release），坡长恒为全量程时长。
      if (target > level) {
        level = Math.min(target, level + delta / attackMs)
      } else {
        level = Math.max(target, level - delta / releaseMs)
      }
      if (level > 0) {
        active = true
        if (!options.renderer.setMouthOpen(level)) disabled = true
        options.onSpeakingFrame?.()
        return
      }
      if (active) {
        // 收敛到 0：补写一次 0（fork 的 save/load 使其成为闭嘴基准），随后停写，
        // 静默期口型交还 idle motion / expression（「说话覆盖、沉默回归 motion」）。
        if (!options.renderer.setMouthOpen(0)) disabled = true
        if (!disabled) active = false
      }
    },

    dispose() {
      if (disabled || !active) return
      options.renderer.setMouthOpen(0)
      active = false
    }
  }
}

export function createLipSyncPlugin(
  options: LipSyncOptions
): MotionPlugin & { readonly controller: LipSyncController } {
  const controller = createLipSyncController(options)
  return {
    id: 'audio-lipsync',
    // expression-controller(130, final) 之后：说话时 MouthOpenY 以本插件为准；
    // 停写后表情/motion 的口部参数不受影响（不破坏 expression mouth form）。
    priority: 140,
    phases: ['final'],
    onFrame: (context) => controller.update(context.frame.deltaMs),
    dispose: () => controller.dispose(),
    controller
  }
}
