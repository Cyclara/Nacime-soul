// src/renderer/src/live2d/motion/pipeline.ts
// P3A-16：每帧插件协议。稳定 priority + pre/native/post/final 四阶段，异常插件 fail-open。

import type { Live2DRendererFrame } from '../ILive2DRenderer'

export type MotionPipelinePhase = 'pre' | 'post' | 'final'

export interface MotionPluginContext {
  readonly frame: Live2DRendererFrame
  readonly phase: MotionPipelinePhase
  /** 插件可短路后续插件，但不能跳过 renderer 的 native model update。 */
  readonly handled: boolean
  markHandled(): void
}

export interface MotionPlugin {
  readonly id: string
  readonly priority: number
  readonly phases: readonly MotionPipelinePhase[]
  onFrame(context: MotionPluginContext): void
  dispose?(): void
}

export interface MotionPipeline {
  add(plugin: MotionPlugin): void
  remove(id: string): boolean
  run(frame: Live2DRendererFrame, nativeUpdate: () => void): void
  dispose(): void
  readonly pluginIds: readonly string[]
}

export function createMotionPipeline(options?: {
  readonly onPluginError?: (pluginId: string) => void
}): MotionPipeline {
  const plugins = new Map<string, MotionPlugin>()

  const ordered = (): MotionPlugin[] =>
    [...plugins.values()].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))

  const runPhase = (frame: Live2DRendererFrame, phase: MotionPipelinePhase): void => {
    let handled = false
    for (const plugin of ordered()) {
      if (!plugin.phases.includes(phase) || handled) continue
      const context: MotionPluginContext = {
        frame,
        phase,
        get handled() {
          return handled
        },
        markHandled() {
          handled = true
        }
      }
      try {
        plugin.onFrame(context)
      } catch {
        options?.onPluginError?.(plugin.id)
      }
    }
  }

  return {
    add(plugin) {
      if (plugins.has(plugin.id)) throw new Error(`motion plugin already exists: ${plugin.id}`)
      plugins.set(plugin.id, plugin)
    },
    remove(id) {
      const plugin = plugins.get(id)
      if (plugin === undefined) return false
      plugins.delete(id)
      try {
        plugin.dispose?.()
      } catch {
        options?.onPluginError?.(id)
      }
      return true
    },
    run(frame, nativeUpdate) {
      runPhase(frame, 'pre')
      try {
        nativeUpdate()
      } catch {
        // renderer owns native update failure handling; post/final still run to release params.
      }
      runPhase(frame, 'post')
      runPhase(frame, 'final')
    },
    dispose() {
      for (const id of [...plugins.keys()]) this.remove(id)
    },
    get pluginIds() {
      return ordered().map((plugin) => plugin.id)
    }
  }
}
