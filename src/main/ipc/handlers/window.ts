// src/main/ipc/handlers/window.ts
// Window IPC handlers：minimize/toggle-maximize/close/get-state
// 依据：S-001 P1-16、S-003 §3.2

import type { BrowserWindow } from 'electron'
import type { Logger } from '@shared/observability/types'
import { registerValidatedHandler, sendEvent } from '../register'

/** Window handler 依赖 */
export interface WindowHandlerDeps {
  /** 获取当前主窗口的函数（窗口可能被重建，所以用函数而非直接引用） */
  getMainWindow: () => BrowserWindow | null
  logger: Logger
}

/**
 * 在指定窗口上挂 maximize/unmaximize 状态监听。
 * 独立导出：窗口可能被 CrashGuard 重建（renderer 崩溃）或 macOS activate 重建，
 * 每次重建后必须重新挂载——修复前监听器只挂初始窗口，重建后 window-state 事件永久失效。
 */
export function attachWindowStateListeners(win: BrowserWindow): void {
  win.on('maximize', () => {
    sendEvent(win.webContents, 'companion:event:window-state', { maximized: true })
  })
  win.on('unmaximize', () => {
    sendEvent(win.webContents, 'companion:event:window-state', { maximized: false })
  })
}

/**
 * 注册所有 window IPC handler。
 * 在 main/index.ts 中调用，需在 configureIpcGuard 之后。
 */
export function registerWindowHandlers(deps: WindowHandlerDeps): void {
  const { getMainWindow, logger } = deps

  const getWindow = (): BrowserWindow => {
    const win = getMainWindow()
    if (!win) {
      throw new Error('no main window available')
    }
    return win
  }

  // === companion:window:minimize ===
  registerValidatedHandler('companion:window:minimize', async () => {
    const win = getWindow()
    win.minimize()
  })

  // === companion:window:toggle-maximize ===
  registerValidatedHandler('companion:window:toggle-maximize', async () => {
    const win = getWindow()
    if (win.isMaximized()) {
      win.unmaximize()
    } else {
      win.maximize()
    }
    return { maximized: win.isMaximized() }
  })

  // === companion:window:close ===
  registerValidatedHandler('companion:window:close', async () => {
    const win = getWindow()
    win.close()
  })

  // === companion:window:get-state ===
  registerValidatedHandler('companion:window:get-state', async () => {
    const win = getWindow()
    return { maximized: win.isMaximized() }
  })

  // 初始窗口挂载状态监听（重建路径由 index.ts 在 CrashGuard/activate 处重新调用）
  const win = getMainWindow()
  if (win) {
    attachWindowStateListeners(win)
  }

  logger.debug('window handlers registered', { scope: 'ipc' })
}
