// src/main/security/window-config.ts
// P1-10: BrowserWindow webPreferences 安全常量（不可关闭）
// 依据：S-005 §3.6（不可关闭的安全常量）、S-001 P1-10 验收标准
//
// 这些值是安全底座，不可配置、不可关闭：
//   - contextIsolation=true   隔离 preload 与 renderer 上下文
//   - nodeIntegration=false   renderer 无 Node API
//   - sandbox=true            preload 也运行在沙箱中
//   - webSecurity=true        强制同源策略
//   - allowRunningInsecureContent=false  禁止 HTTPS 页面加载 HTTP 资源
//   - experimentalFeatures=false         关闭 Chromium 实验特性
//
// 提取为独立常量是为了让 S-004 #13 测试能直接断言实际值，
// 而非测试字面量（避免假测试）。

/**
 * BrowserWindow webPreferences 中不可关闭的安全字段。
 * index.ts createWindow() 通过展开此对象注入 webPreferences。
 * Object.freeze 确保运行时也不可篡改（安全底座）。
 */
export const WINDOW_WEB_PREFERENCES: Readonly<{
  contextIsolation: true
  nodeIntegration: false
  sandbox: true
  webSecurity: true
  allowRunningInsecureContent: false
  experimentalFeatures: false
}> = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false
})
