// src/main/windows/create-live2d-window.ts
// P3A-04：独立透明 Live2D stage 窗口。
//
// 安全合同：独立 stage preload；nodeIntegration=false / contextIsolation=true / sandbox=true
// 来自不可关闭的 WINDOW_WEB_PREFERENCES；导航、弹窗与权限策略复用聊天窗口。

import { BrowserWindow, session } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { registerCsp } from '../security/csp'
import { registerNavigationGuard, registerPermissionDenial } from '../security/navigation'
import { WINDOW_WEB_PREFERENCES } from '../security/window-config'

export interface CreateLive2dWindowOptions {
  readonly alwaysOnTop: boolean
}

/**
 * 创建但不 show 的 stage 窗口。
 *
 * manager 只能在 stage 报告首帧 ready 后调用 show()；避免透明空窗口劫持鼠标、看起来像
 * 什么也没发生。具体模型、WebGL 与可见 UI 均在独立 stage renderer 内，不进入聊天窗口。
 */
export function createLive2dWindow(options: CreateLive2dWindowOptions): BrowserWindow {
  registerCsp(session.defaultSession, is.dev)

  const win = new BrowserWindow({
    title: 'Nacime Live2D',
    width: 520,
    height: 720,
    minWidth: 240,
    minHeight: 320,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: options.alwaysOnTop,
    skipTaskbar: true,
    autoHideMenuBar: true,
    webPreferences: {
      // 独立 bundle，绝不复用 ../preload/index.js（后者暴露完整 window.companion）。
      preload: join(__dirname, '../preload/live2d-stage.js'),
      // 此窗在首帧 ready 前以 show:false 启动。保持其 ticker/rAF 活跃才能测量真实首帧
      // 和持续 idle 动画；隐藏/关闭时仍由 stage command 明确 stop，避免后台空转。
      backgroundThrottling: false,
      ...WINDOW_WEB_PREFERENCES
    }
  })

  registerNavigationGuard(win)
  registerPermissionDenial(win)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const stageUrl = new URL(process.env['ELECTRON_RENDERER_URL'])
    stageUrl.pathname = '/live2d.html'
    win.loadURL(stageUrl.toString())
  } else {
    win.loadFile(join(__dirname, '../renderer/live2d.html'))
  }

  return win
}
