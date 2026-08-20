// src/main/security/csp.ts
// CSP 生成与 Electron 会话注册
// 依据：S-005 §3.6（不可关闭的安全常量）、S-001 P1-10

import type { Session } from 'electron'

/**
 * CSP 策略（不可配置的安全常量）。
 *  - 所有模型流量由 main 进程发出，renderer connect-src 只需 'self'。
 *  - media-src 'none'：Phase 3b 前无音频视频。
 *  - object-src 'none'：禁止 Flash/Java 等插件。
 *  - frame-src 'none'：禁止内嵌框架。
 *  - font-src 'self'：字体只从本地加载。
 *  - script-src 不含 'unsafe-eval' 和 'unsafe-inline'。
 *  - style-src 'unsafe-inline'：Vue SFC 样式 + 开发 HMR 需要。
 *  - img-src 'self' data:：渲染进程只需本地图片和 data URI。
 */
export const CSP_HEADER_VALUE =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "font-src 'self'; " +
  "connect-src 'self'; " +
  "media-src 'none'; " +
  "object-src 'none'; " +
  "frame-src 'none'; " +
  "child-src 'none'; " +
  "worker-src 'self'; " +
  "form-action 'none'; " +
  "base-uri 'self'"

/**
 * 开发环境 CSP（放宽 HMR 连接）。
 * electron-vite HMR 需要 ws:// 连接到 localhost。
 */
export const CSP_HEADER_VALUE_DEV =
  "default-src 'self'; " +
  "script-src 'self'; " +
  // HMR 可能需要 eval（Vue devtools 热重载）
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "font-src 'self'; " +
  // 开发环境放开 ws:// 和 localhost 连接（HMR）
  "connect-src 'self' ws://localhost:* http://localhost:*; " +
  "media-src 'none'; " +
  "object-src 'none'; " +
  "frame-src 'none'; " +
  "child-src 'none'; " +
  "worker-src 'self'; " +
  "form-action 'none'; " +
  "base-uri 'self'"

/**
 * 注册 CSP 到 Electron 会话。
 * 使用 session.webRequest.onHeadersReceived 设置 CSP 头，
 * 比 HTML meta 标签更安全（无法被 DOM 移除）。
 *
 * ⚠️ 生效范围：onHeadersReceived 只对 http(s) 请求触发。
 * 生产环境主文档走 loadFile(file://)，此回调不会触发（Electron 官方行为，
 * 见 electron/electron#23485）——生产 CSP 由构建期注入的 <meta> 兜底
 *（V-01，见 electron.vite.config.ts 的 injectCspMeta）。
 * 本函数实际覆盖：开发环境（http://localhost HMR URL）+ 页面发起的 http(s) 子资源响应。
 *
 * 生产环境用严格 CSP；开发环境放宽 ws://localhost HMR 连接。
 */
export function registerCsp(session: Session, isDev: boolean): void {
  const cspValue = isDev ? CSP_HEADER_VALUE_DEV : CSP_HEADER_VALUE

  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [cspValue]
      }
    })
  })
}
