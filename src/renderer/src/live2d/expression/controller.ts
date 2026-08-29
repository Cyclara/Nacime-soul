// src/renderer/src/live2d/expression/controller.ts
// P3A-20/21/22：表情生命周期、平滑过渡、参数归位与 3 分钟 neutral 复位。

import type { ILive2DRenderer } from '../ILive2DRenderer'
import { createParameterLayer, type ParameterLayer } from '../motion/parameter-layer'
import {
  DEFAULT_EXPRESSION_ALIASES,
  resolveExpression,
  type ExpressionAliasMap,
  type SemanticEmotion
} from './map'

/** 最后一次表情更新后多久平滑回 neutral（2026-08-29 用户定为 15 秒）。 */
export const DEFAULT_EXPRESSION_RESET_MS = 15_000

export interface ExpressionController {
  readonly current: SemanticEmotion
  readonly activeExpression: string
  setEmotion(emotion: SemanticEmotion, nowMs?: number): Promise<boolean>
  refresh(nowMs?: number): void
  update(deltaMs: number, nowMs?: number): void
  dispose(): void
}

export interface ExpressionControllerOptions {
  readonly renderer: ILive2DRenderer
  readonly expressionNames: readonly string[]
  readonly aliases?: ExpressionAliasMap
  readonly parameterLayer?: ParameterLayer
  readonly resetAfterMs?: number
  readonly transitionMs?: number
  readonly now?: () => number
  /** 情绪解析不到任何 expression 时回调；只传枚举与名单，不含用户内容。 */
  readonly onUnresolved?: (emotion: SemanticEmotion, available: readonly string[]) => void
}

export function createExpressionController(
  options: ExpressionControllerOptions
): ExpressionController {
  const aliases = options.aliases ?? DEFAULT_EXPRESSION_ALIASES
  const layer = options.parameterLayer ?? createParameterLayer(options.renderer)
  /**
   * 表情回 neutral 的静默时长。S-Phase3 P3A-22 原写 3 分钟，2026-08-29 用户真机体验后
   * 明确要求改为 **15 秒**（3 分钟太久，一句话的情绪会挂在脸上不散）。以用户指令为准。
   */
  const resetAfterMs = options.resetAfterMs ?? DEFAULT_EXPRESSION_RESET_MS
  const transitionMs = Math.max(1, options.transitionMs ?? 300)
  const now = options.now ?? Date.now
  let current: SemanticEmotion = 'neutral'
  let activeExpression = ''
  let targetExpression = ''
  let elapsedSinceRefresh = 0
  let transitionElapsed = transitionMs
  let disposed = false

  const setEmotion = async (emotion: SemanticEmotion, nowMs = now()): Promise<boolean> => {
    if (disposed) return false
    const resolved = resolveExpression(emotion, options.expressionNames, aliases)
    current = emotion
    targetExpression = resolved.resolved
    transitionElapsed = 0
    elapsedSinceRefresh = 0
    if (targetExpression.length === 0) {
      // S-006-补充 §1.7.4：「模型缺某表情时只回 neutral + debug warn」。此前只是静默返回
      // false——正是它让「表情整条链路都对、就是看不见」查了两轮才定位。
      options.onUnresolved?.(emotion, options.expressionNames)
      current = 'neutral'
      return false
    }
    // Smooth transition is represented by a bounded transition window; the fork performs its
    // own expression fade using configured duration, while we never hold stale parameters.
    await options.renderer.setExpression(targetExpression)
    activeExpression = targetExpression
    transitionElapsed = transitionMs
    void nowMs
    return true
  }

  const refresh = (): void => {
    elapsedSinceRefresh = 0
  }

  const update = (deltaMs: number, nowMs = now()): void => {
    if (disposed) return
    const delta = Math.max(0, Number.isFinite(deltaMs) ? deltaMs : 0)
    elapsedSinceRefresh += delta
    transitionElapsed = Math.min(transitionMs, transitionElapsed + delta)
    if (elapsedSinceRefresh >= resetAfterMs && current !== 'neutral') {
      void setEmotion('neutral', nowMs)
    }
    // Apply the parameter layer after native expression/motion output. Unused values are not
    // copied from a previous frame, so switching expressions cannot retain old overrides.
    layer.apply()
  }

  return {
    get current() {
      return current
    },
    get activeExpression() {
      return activeExpression
    },
    setEmotion,
    refresh,
    update,
    dispose() {
      if (disposed) return
      disposed = true
      layer.clear()
    }
  }
}
