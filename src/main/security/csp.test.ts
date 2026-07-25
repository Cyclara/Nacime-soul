// src/main/security/csp.test.ts
// P1-26: CSP/窗口安全配置测试
// 依据：S-004 #13（contextIsolation=true, nodeIntegration=false, sandbox=true）
//       S-005 §3.6（不可关闭的安全常量）

import { describe, it, expect } from 'vitest'
import type { Session } from 'electron'
import { CSP_HEADER_VALUE, CSP_HEADER_VALUE_DEV, registerCsp } from './csp'
import { WINDOW_WEB_PREFERENCES } from './window-config'

describe('S-004 #13: CSP 安全配置', () => {
  describe('生产环境 CSP', () => {
    it('script-src 禁止 unsafe-eval 和 unsafe-inline', () => {
      expect(CSP_HEADER_VALUE).toContain("script-src 'self'")
      // script-src 不能有 unsafe-eval（防止动态代码执行）
      expect(CSP_HEADER_VALUE).not.toMatch(/script-src[^;]*'unsafe-eval'/)
      // script-src 不能有 unsafe-inline（防止内联脚本注入）
      expect(CSP_HEADER_VALUE).not.toMatch(/script-src[^;]*'unsafe-inline'/)
    })

    it('禁止 object-src（Flash/Java 插件）', () => {
      expect(CSP_HEADER_VALUE).toContain("object-src 'none'")
    })

    it('禁止 frame-src（内嵌框架）', () => {
      expect(CSP_HEADER_VALUE).toContain("frame-src 'none'")
    })

    it('禁止 child-src', () => {
      expect(CSP_HEADER_VALUE).toContain("child-src 'none'")
    })

    it('禁止 form-action', () => {
      expect(CSP_HEADER_VALUE).toContain("form-action 'none'")
    })

    it('禁止 media-src（Phase 3b 前无音频视频）', () => {
      expect(CSP_HEADER_VALUE).toContain("media-src 'none'")
    })

    it('connect-src 只允许 self（模型流量由 main 发出）', () => {
      expect(CSP_HEADER_VALUE).toContain("connect-src 'self'")
      expect(CSP_HEADER_VALUE).not.toContain('ws://')
      expect(CSP_HEADER_VALUE).not.toContain('http://')
    })

    it('img-src 只允许 self + data:（本地图片和 data URI）', () => {
      expect(CSP_HEADER_VALUE).toContain("img-src 'self' data:")
      // 不允许外部图片
      expect(CSP_HEADER_VALUE).not.toMatch(/img-src.*https?:/)
    })

    it('font-src 只允许 self', () => {
      expect(CSP_HEADER_VALUE).toContain("font-src 'self'")
    })

    it('worker-src 只允许 self', () => {
      expect(CSP_HEADER_VALUE).toContain("worker-src 'self'")
    })

    it('base-uri 只允许 self', () => {
      expect(CSP_HEADER_VALUE).toContain("base-uri 'self'")
    })

    it('default-src 为 self', () => {
      expect(CSP_HEADER_VALUE).toContain("default-src 'self'")
    })
  })

  describe('开发环境 CSP', () => {
    it('允许 ws://localhost 和 http://localhost（HMR）', () => {
      expect(CSP_HEADER_VALUE_DEV).toContain('ws://localhost:')
      expect(CSP_HEADER_VALUE_DEV).toContain('http://localhost:')
    })

    it('script-src 仍不含 unsafe-eval', () => {
      expect(CSP_HEADER_VALUE_DEV).not.toContain("'unsafe-eval'")
    })

    it('style-src 允许 unsafe-inline（Vue SFC + HMR）', () => {
      expect(CSP_HEADER_VALUE_DEV).toContain("style-src 'self' 'unsafe-inline'")
    })
  })
})

describe('S-004 #13: 窗口安全配置', () => {
  // 测试实际的 WINDOW_WEB_PREFERENCES 常量（index.ts createWindow() 展开此对象注入 webPreferences），
  // 而非测试字面量。若有人改 window-config.ts 关闭安全项，这些测试会失败。
  it('webPreferences 必须使用 contextIsolation=true', () => {
    expect(WINDOW_WEB_PREFERENCES.contextIsolation).toBe(true)
  })

  it('webPreferences 必须使用 nodeIntegration=false', () => {
    expect(WINDOW_WEB_PREFERENCES.nodeIntegration).toBe(false)
  })

  it('webPreferences 必须使用 sandbox=true', () => {
    expect(WINDOW_WEB_PREFERENCES.sandbox).toBe(true)
  })

  it('webPreferences 必须使用 webSecurity=true', () => {
    expect(WINDOW_WEB_PREFERENCES.webSecurity).toBe(true)
  })

  it('webPreferences 必须使用 allowRunningInsecureContent=false', () => {
    expect(WINDOW_WEB_PREFERENCES.allowRunningInsecureContent).toBe(false)
  })

  it('webPreferences 必须使用 experimentalFeatures=false', () => {
    expect(WINDOW_WEB_PREFERENCES.experimentalFeatures).toBe(false)
  })

  it('安全常量对象不可变（as const + 防篡改）', () => {
    // 确保运行时也无法篡改这些安全值
    expect(Object.isFrozen(WINDOW_WEB_PREFERENCES)).toBe(true)
  })
})

describe('registerCsp', () => {
  it('生产环境注册生产 CSP', () => {
    const capturedHeaders: string[] = []
    const mockSession = {
      webRequest: {
        onHeadersReceived(
          callback: (
            details: { responseHeaders?: Record<string, string[]> },
            cb: (opts: { responseHeaders: Record<string, string[]> }) => void
          ) => void
        ): void {
          // 模拟首次请求，触发 CSP 注入
          callback({ responseHeaders: { 'content-type': ['text/html'] } }, (opts) => {
            capturedHeaders.push(opts.responseHeaders['Content-Security-Policy']?.[0] ?? '')
          })
        }
      }
    }

    registerCsp(mockSession as Session, false)
    expect(capturedHeaders.length).toBe(1)
    expect(capturedHeaders[0]).toBe(CSP_HEADER_VALUE)
  })

  it('开发环境注册开发 CSP', () => {
    const capturedHeaders: string[] = []
    const mockSession = {
      webRequest: {
        onHeadersReceived(
          callback: (
            details: { responseHeaders?: Record<string, string[]> },
            cb: (opts: { responseHeaders: Record<string, string[]> }) => void
          ) => void
        ): void {
          callback({ responseHeaders: { 'content-type': ['text/html'] } }, (opts) => {
            capturedHeaders.push(opts.responseHeaders['Content-Security-Policy']?.[0] ?? '')
          })
        }
      }
    }

    registerCsp(mockSession as Session, true)
    expect(capturedHeaders.length).toBe(1)
    expect(capturedHeaders[0]).toBe(CSP_HEADER_VALUE_DEV)
  })
})
