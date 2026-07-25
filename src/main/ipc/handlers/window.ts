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

  // 在窗口 maximize/unmaximize 时推送事件
  const win = getMainWindow()
  if (win) {
    win.on('maximize', () => {
      sendEvent(win.webContents, 'companion:event:window-state', { maximized: true })
    })
    win.on('unmaximize', () => {
      sendEvent(win.webContents, 'companion:event:window-state', { maximized: false })
    })
  }

  logger.debug('window handlers registered', { scope: 'ipc' })
}
