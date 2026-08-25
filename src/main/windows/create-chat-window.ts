// src/main/windows/create-chat-window.ts
// P1-10: 聊天窗口创建 - BrowserWindow 安全配置 + CSP + 导航守卫
// 依据：S-001 §3.1（计划文件）、P1-10（安全窗体/CSP）
//
// 职责：
//   1. 创建 BrowserWindow（含安全 webPreferences）
//   2. 注册 CSP（session 级，幂等）
//   3. 注册导航守卫 + 权限拒绝
//   4. 加载 renderer（dev: HMR URL / 生产: 本地 HTML）
//
// 独立文件的目的：Phase 2+ 新增窗口类型（设置窗口、记忆查看器等）时，
// 每种窗口一个文件放在 src/main/windows/ 下，index.ts 不膨胀。

import { BrowserWindow, screen, session } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import icon from '../../../resources/icon.png?asset'
import { registerCsp } from '../security/csp'
import { WINDOW_WEB_PREFERENCES } from '../security/window-config'
import { registerNavigationGuard, registerPermissionDenial } from '../security/navigation'
import {
  resolveInitialBounds,
  WINDOW_MIN_HEIGHT,
  WINDOW_MIN_WIDTH,
  type WindowState
} from './window-state'

/**
 * 创建聊天窗口。
 * 包含 CSP 注册、安全 webPreferences、导航守卫和权限拒绝。
 * 幂等：CSP 和权限拒绝的注册函数再次调用会替换旧监听器，重建窗口时安全。
 *
 * windowState（S-005 §3.7）：传入上次持久化的 config.ui.window 时还原宽高/位置/最大化；
 * 不传（或位置已不在任何显示器上）回退默认 900x720 居中。
 */
export function createChatWindow(opts?: { windowState?: WindowState }): BrowserWindow {
  // 注册 CSP（幂等：onHeadersReceived 再次调用会替换旧监听器，重建窗口时安全）
  registerCsp(session.defaultSession, is.dev)
  const isAutomatedTest = process.env['COMPANION_TEST_MODE'] === 'faux'

  const initial = opts?.windowState
    ? resolveInitialBounds(opts.windowState, screen.getAllDisplays())
    : { width: 900, height: 720 }

  const win = new BrowserWindow({
    title: isAutomatedTest ? 'Nacime [自动化测试 · 临时数据]' : 'Nacime',
    width: initial.width,
    height: initial.height,
    // 与 schema/ui.ts WindowConfigSchema 下限对齐：从源头防住非法尺寸进 config 校验
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    ...(initial.x !== undefined ? { x: initial.x, y: initial.y } : {}),
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      // __dirname 运行时是 out/main/（electron-vite 将所有 main 代码打包为单个 index.js），
      // 与源码目录深度无关。preload 在 out/preload/、renderer 在 out/renderer/。
      preload: join(__dirname, '../preload/index.js'),
      // P1-10 安全底座：不可关闭的硬件常量（从 window-config.ts 注入，可被 S-004 #13 测试断言）
      ...WINDOW_WEB_PREFERENCES
    }
  })

  if (opts?.windowState?.maximized) {
    win.maximize()
  }

  registerNavigationGuard(win)
  registerPermissionDenial(win)
  // 右键菜单在 renderer（AppContextMenu.vue，验收反馈⑤ 主题化；M-38 原生菜单已被替代）

  win.on('ready-to-show', () => {
    win.show()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const rendererUrl = isAutomatedTest
      ? `${process.env['ELECTRON_RENDERER_URL']}?automation-test=1`
      : process.env['ELECTRON_RENDERER_URL']
    win.loadURL(rendererUrl)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: isAutomatedTest ? { 'automation-test': '1' } : undefined
    })
  }

  return win
}
