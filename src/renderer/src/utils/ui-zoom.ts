// src/renderer/src/utils/ui-zoom.ts
// M-51: UI 缩放纯函数（可单测）。状态源 = config.ui.fontScale（0.8..1.5，schema/IPC 校验已有）。
// 参考 stablyai/orca 的 UIZoomControl/ZoomOverlay 思路，按本项目既有 fontScale 合同落地。

export const UI_ZOOM_MIN = 0.8
export const UI_ZOOM_MAX = 1.5
export const UI_ZOOM_STEP = 0.1
export const UI_ZOOM_DEFAULT = 1

/** 浮点误差收敛：0.8 + 0.1*3 这类累加必须先取整再比较 */
export function roundZoom(value: number): number {
  return Math.round(value * 100) / 100
}

export function clampZoom(value: number): number {
  return Math.min(UI_ZOOM_MAX, Math.max(UI_ZOOM_MIN, roundZoom(value)))
}

/** direction: 1 放大 / -1 缩小。已在边界时返回原值（调用方据此禁用按钮） */
export function stepZoom(current: number, direction: 1 | -1): number {
  return clampZoom(roundZoom(current + direction * UI_ZOOM_STEP))
}

export function zoomPercent(value: number): number {
  return Math.round(value * 100)
}
