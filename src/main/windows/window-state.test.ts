// src/main/windows/window-state.test.ts
// 窗口尺寸/位置持久化（S-005 §3.7 接线）纯逻辑测试：
//   - clampWindowState：钳到 schema 区间（480..3840 / 600..2160），防 CFG_INVALID
//   - isOnScreen：外接显示器拔掉后旧坐标不得复活（虚空窗口 = 丢窗口）
//   - resolveInitialBounds：x/y 过校验才带上，否则省略（Electron 居中）
//   - captureWindowState：最大化时取 normal bounds（还原尺寸），不被最大化态覆盖
//   - trackWindowState：resize/move 防抖写、close 立即写

import { describe, it, expect, vi } from 'vitest'
import type { Display, Rectangle } from 'electron'
import {
  clampWindowState,
  isOnScreen,
  resolveInitialBounds,
  captureWindowState,
  trackWindowState
} from './window-state'

const PRIMARY = {
  workArea: { x: 0, y: 0, width: 1920, height: 1040 }
} as Display

describe('clampWindowState（schema 区间钳制）', () => {
  it('正常值原样通过', () => {
    expect(clampWindowState({ width: 1260, height: 1040, x: 10, y: 10, maximized: false })).toEqual(
      { width: 1260, height: 1040, x: 10, y: 10, maximized: false }
    )
  })

  it('过小/过大钳到边界；小数取整', () => {
    expect(clampWindowState({ width: 100, height: 9999, maximized: false })).toEqual({
      width: 480,
      height: 2160,
      maximized: false
    })
    expect(
      clampWindowState({ width: 1260.6, height: 799.4, x: 10.4, y: 9.6, maximized: true })
    ).toEqual({ width: 1261, height: 799, x: 10, y: 10, maximized: true })
  })
})

describe('isOnScreen（显示器存在性校验）', () => {
  it('左上角在主屏工作区内 -> true', () => {
    expect(isOnScreen(10, 10, [PRIMARY])).toBe(true)
  })

  it('外接显示器坐标（x=2560）在拔掉后 -> false', () => {
    expect(isOnScreen(2560, 100, [PRIMARY])).toBe(false)
  })

  it('负坐标虚空 -> false；但允许标题栏少量探出（48px 容差）', () => {
    expect(isOnScreen(-500, 100, [PRIMARY])).toBe(false)
    expect(isOnScreen(-20, 100, [PRIMARY])).toBe(true)
  })

  it('多显示器：落在第二块屏 -> true', () => {
    const second = { workArea: { x: 1920, y: 0, width: 2560, height: 1440 } } as Display
    expect(isOnScreen(2560, 100, [PRIMARY, second])).toBe(true)
  })
})

describe('resolveInitialBounds（启动还原）', () => {
  it('有合法 x/y -> 带上位置', () => {
    expect(
      resolveInitialBounds({ width: 1260, height: 1040, x: 10, y: 10, maximized: true }, [PRIMARY])
    ).toEqual({ width: 1260, height: 1040, x: 10, y: 10 })
  })

  it('x/y 在虚空中 -> 省略位置（交给 Electron 居中），宽高仍还原', () => {
    expect(
      resolveInitialBounds({ width: 1260, height: 1040, x: 2560, y: 10, maximized: false }, [PRIMARY])
    ).toEqual({ width: 1260, height: 1040 })
  })

  it('无 x/y（首次启动默认值）-> 省略位置', () => {
    expect(resolveInitialBounds({ width: 900, height: 720, maximized: false }, [PRIMARY])).toEqual({
      width: 900,
      height: 720
    })
  })
})

function fakeWin(
  bounds: Rectangle,
  maximized = false
): {
  getNormalBounds: () => Rectangle
  isMaximized: () => boolean
  on: (event: string, cb: () => void) => void
  emit: (event: string) => void
} {
  const handlers = new Map<string, Array<() => void>>()
  return {
    getNormalBounds: () => bounds,
    isMaximized: () => maximized,
    on(event: string, cb: () => void): void {
      handlers.set(event, [...(handlers.get(event) ?? []), cb])
    },
    emit(event: string): void {
      for (const cb of handlers.get(event) ?? []) cb()
    }
  }
}

describe('captureWindowState / trackWindowState', () => {
  it('最大化时 capture 取 normal bounds（还原尺寸）+ maximized=true', () => {
    const win = fakeWin({ x: 100, y: 80, width: 1200, height: 800 }, true)
    expect(captureWindowState(win)).toEqual({
      width: 1200,
      height: 800,
      x: 100,
      y: 80,
      maximized: true
    })
  })

  it('resize/move/maximize/unmaximize -> 防抖写（immediate=false）；close -> 立即写（immediate=true）', () => {
    const win = fakeWin({ x: 10, y: 10, width: 1000, height: 700 })
    const persist = vi.fn()
    // trackWindowState 形参是 BrowserWindow；假窗口结构化满足运行行为，测试用 as 断言
    trackWindowState(win as never, persist)

    win.emit('resize')
    win.emit('move')
    win.emit('maximize')
    win.emit('unmaximize')
    expect(persist).toHaveBeenCalledTimes(4)
    expect(persist.mock.calls.every(([, immediate]) => immediate === false)).toBe(true)

    win.emit('close')
    expect(persist).toHaveBeenCalledTimes(5)
    expect(persist.mock.calls[4][1]).toBe(true)
    expect(persist.mock.calls[4][0]).toEqual({
      width: 1000,
      height: 700,
      x: 10,
      y: 10,
      maximized: false
    })
  })
})
