// src/renderer/src/utils/ui-zoom.test.ts
// M-51: 缩放纯函数测试（边界、步进、浮点漂移）

import { describe, expect, it } from 'vitest'
import {
  clampZoom,
  roundZoom,
  stepZoom,
  zoomPercent,
  UI_ZOOM_MIN,
  UI_ZOOM_MAX,
  UI_ZOOM_STEP,
  UI_ZOOM_DEFAULT
} from './ui-zoom'

describe('M-51 ui-zoom 纯函数', () => {
  it('clampZoom 夹取到 0.8..1.5', () => {
    expect(clampZoom(0.5)).toBe(UI_ZOOM_MIN)
    expect(clampZoom(2)).toBe(UI_ZOOM_MAX)
    expect(clampZoom(1.2)).toBe(1.2)
  })

  it('roundZoom 收敛浮点漂移（0.8 + 0.1*3 ≠ 1.1 的原生浮点）', () => {
    expect(roundZoom(0.8 + 0.1 + 0.1 + 0.1)).toBe(1.1)
    expect(roundZoom(1.4999999)).toBe(1.5)
  })

  it('stepZoom 双向步进并在边界停住', () => {
    expect(stepZoom(1, 1)).toBe(1.1)
    expect(stepZoom(1, -1)).toBe(0.9)
    expect(stepZoom(UI_ZOOM_MAX, 1)).toBe(UI_ZOOM_MAX)
    expect(stepZoom(UI_ZOOM_MIN, -1)).toBe(UI_ZOOM_MIN)
    // 从任意值起步也收敛到步进网格
    expect(stepZoom(1.05, 1)).toBe(1.15)
  })

  it('连续步进不漂移（7 步从 0.8 到 1.5）', () => {
    let v = UI_ZOOM_MIN
    for (let i = 0; i < (UI_ZOOM_MAX - UI_ZOOM_MIN) / UI_ZOOM_STEP; i++) {
      v = stepZoom(v, 1)
    }
    expect(v).toBe(UI_ZOOM_MAX)
  })

  it('zoomPercent 显示取整百分比', () => {
    expect(zoomPercent(UI_ZOOM_DEFAULT)).toBe(100)
    expect(zoomPercent(1.3)).toBe(130)
    expect(zoomPercent(0.8)).toBe(80)
  })
})
