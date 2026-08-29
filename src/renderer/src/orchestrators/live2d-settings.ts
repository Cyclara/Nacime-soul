// src/renderer/src/orchestrators/live2d-settings.ts
// P3A-25：Live2D 设置与 config 的跨域编排边界。
// 当前 zoom/alwaysOnTop 合同已有 config.ui.live2d 字段；stage 应用由 main 订阅 config 后
// 投影回 live2d state，组件不直接操作 BrowserWindow 或另一 store。

import type { ConfigState } from '../stores/config'
import type { Live2dState } from '../stores/live2d'
import type { UiConfig } from '@shared/config/types'

/**
 * 取景预设。归一化基准是「zoom=1 时模型约两倍视口高、底边居中」，因此 zoom=1/offsetY=0
 * 自然是半身；全身需要缩到约一屏高（zoom 0.5）并把模型抬到视口中线（offsetY 50）。
 */
export const LIVE2D_FRAMING_PRESETS = {
  'upper-body': { zoom: 1, offsetX: 0, offsetY: 0 },
  'full-body': { zoom: 0.5, offsetX: 0, offsetY: 50 }
} as const

export type Live2dFramingPreset = keyof typeof LIVE2D_FRAMING_PRESETS

export interface Live2dSettingsOrchestrator {
  patchZoom(value: number): void
  patchOffset(offsetX: number, offsetY: number): void
  patchAlwaysOnTop(value: boolean): void
  applyFraming(preset: Live2dFramingPreset): void
  resetFraming(): void
  saveAndApply(): Promise<void>
  discard(): void
  /** 离开设置面板时必须调用，否则 stage 会停在未保存的草稿构图上。 */
  endPreview(): void
}

const clampZoom = (value: number): number => Math.min(3, Math.max(0.25, value))
const clampOffset = (value: number): number => Math.min(100, Math.max(-100, value))

export function createLive2dSettingsOrchestrator(deps: {
  readonly config: {
    readonly state: Pick<ConfigState, 'draft'>
    patch<K extends 'ui'>(domain: K, patch: Partial<UiConfig>): void
    save(): Promise<boolean>
    discard(): void
  }
  readonly live2d: {
    readonly state: Pick<Live2dState, 'window'>
    hydrate(): Promise<void>
    previewFraming(
      framing: { zoom: number; offsetX: number; offsetY: number } | null
    ): Promise<void>
  }
  /** 合并同一帧内的连续滑动；缺省用 rAF，测试注入同步实现。 */
  readonly scheduleFrame?: (callback: () => void) => void
}): Live2dSettingsOrchestrator {
  const scheduleFrame =
    deps.scheduleFrame ??
    ((callback: () => void) => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(callback)
      else callback()
    })
  let previewQueued = false
  let previewActive = false

  // 拖动滑块每秒可产生上百次事件；每帧只向 main 发一次最新草稿构图。
  const queuePreview = (): void => {
    if (previewQueued) return
    previewQueued = true
    scheduleFrame(() => {
      previewQueued = false
      const current = deps.config.state.draft?.ui.live2d
      if (current === undefined) return
      previewActive = true
      void deps.live2d.previewFraming({
        zoom: clampZoom(current.zoom),
        offsetX: clampOffset(current.offsetX),
        offsetY: clampOffset(current.offsetY)
      })
    })
  }

  // 结束预览让 main 按已保存的 config 归位；重复调用是幂等的。
  const stopPreview = (): void => {
    previewQueued = false
    if (!previewActive) return
    previewActive = false
    void deps.live2d.previewFraming(null)
  }

  // 始终展开当前 live2d 草稿：只写变化的键，避免 patch 覆盖掉同域其他字段。
  const patchLive2d = (changes: Partial<UiConfig['live2d']>): void => {
    const current = deps.config.state.draft?.ui.live2d
    if (current === undefined) return
    deps.config.patch('ui', { live2d: { ...current, ...changes } })
  }

  return {
    patchZoom(value) {
      patchLive2d({ zoom: clampZoom(value) })
      queuePreview()
    },
    patchOffset(offsetX, offsetY) {
      patchLive2d({ offsetX: clampOffset(offsetX), offsetY: clampOffset(offsetY) })
      queuePreview()
    },
    patchAlwaysOnTop(value) {
      // 置顶是窗口属性而非取景，不参与预览。
      patchLive2d({ alwaysOnTop: value })
    },
    applyFraming(preset) {
      patchLive2d(LIVE2D_FRAMING_PRESETS[preset])
      queuePreview()
    },
    resetFraming() {
      patchLive2d(LIVE2D_FRAMING_PRESETS['upper-body'])
      queuePreview()
    },
    async saveAndApply() {
      const saved = await deps.config.save()
      if (!saved) {
        deps.config.discard()
        // 保存失败：先撤预览再抛错，stage 立刻退回落盘构图，不留下"看起来生效了"的假象。
        stopPreview()
        throw new Error('Live2D 配置保存失败')
      }
      // 保存成功后 main 的 config 订阅会应用新构图；结束预览让后续 config 变更重新生效。
      stopPreview()
      await deps.live2d.hydrate()
    },
    discard() {
      deps.config.discard()
      stopPreview()
    },
    endPreview: stopPreview
  }
}
