// src/main/security/navigation.ts
// 导航/新窗口拦截 + 权限请求拒绝
// 依据：S-005 §3.6、S-001 P1-10

import type { BrowserWindow, HandlerDetails } from 'electron'
import { shell } from 'electron'

/**
 * 注册窗口导航拦截器：
 *  - 禁止所有内部导航（will-navigate → preventDefault）
 *  - 禁止重定向到外部 URL（will-redirect → 拒绝）
 *  - 新窗口/弹出窗口 → 默认浏览器打开，内部 deny
 *
 * 依据 S-005 §3.6：外链不可在内部导航。
 */
export function registerNavigationGuard(window: BrowserWindow): void {
  const webContents = window.webContents

  // 禁止所有页面内导航（单页应用不需要 navigate）
  webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })

  // 禁止重定向到其他 URL
  webContents.on('will-redirect', (event) => {
    event.preventDefault()
  })

  // 新窗口/弹出窗口 → 系统浏览器打开，内部 deny
  webContents.setWindowOpenHandler((details: HandlerDetails) => {
    // 只允许 http/https 协议的 URL 在外部浏览器打开
    const url = details.url
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url).catch(() => {
        /* shell.openExternal 失败静默忽略 */
      })
    }
    return { action: 'deny' }
  })
}

/**
 * 拒绝（几乎）所有权限请求。
 * 桌面 AI 伴侣不需要摄像头、麦克风、通知、midi 等权限。
 * 唯一的 "权限" 即用户点击链接 → 系统浏览器打开，此由 navigation guard 处理。
 *
 * 例外（第一方功能白名单）：
 *   - clipboard-read / clipboard-sanitized-write——验收反馈⑤主题化右键菜单的
 *     复制/粘贴/剪切走 renderer navigator.clipboard，被全拒策略会静默失败。
 *
 * 依据 S-005 §3.6：权限请求拒绝策略。
 */

/** 第一方功能需要的权限白名单；其余一律拒绝 */
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  'clipboard-read',
  'clipboard-sanitized-write'
])

export function registerPermissionDenial(window: BrowserWindow): void {
  const webContents = window.webContents
  const session = webContents.session

  session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission))
  })

  // 审计 B-4：RequestHandler 只覆盖"异步弹窗式"权限请求。
  // 同步检查路径（navigator.permissions.query、部分 getUserMedia 前置检查、
  // Notification.permission 等）走 CheckHandler；不设的话 Electron 用默认策略，
  // 等于权限防护只做了一半。两个 handler 必须成对出现。
  session.setPermissionCheckHandler((_webContents, permission) =>
    ALLOWED_PERMISSIONS.has(permission)
  )
}
