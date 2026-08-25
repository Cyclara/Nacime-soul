// src/main/windows/window-state.ts
// 窗口尺寸/位置持久化（S-005 §3.7 ui.window 落地——schema/默认值早已就位，本文件负责接线）
//
// 语义：
//   - 启动：读 config.ui.window -> 宽高（钳到 schema 合法区间）+ x/y（过显示器存在性校验才用）+ maximized
//   - 运行：resize/move/maximize/unmaximize -> 防抖写（configStore.update immediate:false，内置 250ms 节流）
//   - 关闭：close -> 立即写（immediate:true），保证最终状态落盘
//   - 始终读 getNormalBounds()：最大化时拿到的是还原尺寸，恢复后用户调的大小不丢

import type { BrowserWindow, Display, Rectangle } from 'electron'

/** 与 shared config 类型 ui.window 同形状（x/y 可选：缺省 = 首次启动，由 Electron 居中） */
export interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized: boolean
}

// 与 config/schema/ui.ts WindowConfigSchema 对齐：超界值会让 config update 校验抛 CFG_INVALID
export const WINDOW_MIN_WIDTH = 480
export const WINDOW_MAX_WIDTH = 3840
export const WINDOW_MIN_HEIGHT = 600
export const WINDOW_MAX_HEIGHT = 2160

function clampInt(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** 把任意来源的尺寸钳进 schema 合法区间（防非法值触发校验失败） */
export function clampWindowState(s: WindowState): WindowState {
  return {
    width: clampInt(s.width, WINDOW_MIN_WIDTH, WINDOW_MAX_WIDTH),
    height: clampInt(s.height, WINDOW_MIN_HEIGHT, WINDOW_MAX_HEIGHT),
    ...(s.x !== undefined ? { x: Math.round(s.x) } : {}),
    ...(s.y !== undefined ? { y: Math.round(s.y) } : {}),
    maximized: s.maximized
  }
}

/**
 * 窗口左上角（标题栏锚点）是否落在某一显示器工作区内（S-005 §3.5 的运行时校验）。
 * 外接显示器拔掉/分辨率改小后，旧坐标可能在虚空中——恢复一个看不见的窗口等于丢窗口。
 * 容差 48px：允许标题栏少量探出，但保证有足够横边可拖拽。
 */
export function isOnScreen(x: number, y: number, displays: Display[]): boolean {
  return displays.some((d) => {
    const a = d.workArea
    return x >= a.x - 48 && x <= a.x + a.width - 48 && y >= a.y && y <= a.y + a.height - 48
  })
}

/**
 * 启动时解析初始 bounds：x/y 只有过显示器校验才带上；否则省略（Electron 自动居中）。
 */
export function resolveInitialBounds(
  saved: WindowState,
  displays: Display[]
): { width: number; height: number; x?: number; y?: number } {
  const { width, height } = clampWindowState(saved)
  if (
    saved.x !== undefined &&
    saved.y !== undefined &&
    displays.length > 0 &&
    isOnScreen(saved.x, saved.y, displays)
  ) {
    return { width, height, x: Math.round(saved.x), y: Math.round(saved.y) }
  }
  return { width, height }
}

/** 本模块需要的最小窗口接口——BrowserWindow 结构化满足，测试可注入假窗口 */
interface WindowStateSource {
  getNormalBounds(): Rectangle
  isMaximized(): boolean
  on(event: string, listener: () => void): unknown
}

/** 提取当前状态（normal bounds + maximized），钳到合法区间 */
export function captureWindowState(win: WindowStateSource): WindowState {
  const b = win.getNormalBounds()
  return clampWindowState({
    width: b.width,
    height: b.height,
    x: b.x,
    y: b.y,
    maximized: win.isMaximized()
  })
}

/**
 * 挂载状态追踪。persist 由调用方注入（index.ts 里 = configStore.update ui.window）。
 * 防抖不做在本层：configStore.update(immediate:false) 内置 250ms 节流合并。
 */
export function trackWindowState(
  win: BrowserWindow,
  persist: (state: WindowState, immediate: boolean) => void
): void {
  const debounced = (): void => persist(captureWindowState(win), false)
  win.on('resize', debounced)
  win.on('move', debounced)
  win.on('maximize', debounced)
  win.on('unmaximize', debounced)
  win.on('close', () => persist(captureWindowState(win), true))
}
