// V-01：file:// 加载路径下的 CSP 兜底 E2E。
// E2E 通过 out/main/index.js 启动（无 ELECTRON_RENDERER_URL），与生产一致
// 走 loadFile(file://)。onHeadersReceived 对 file:// 不触发（Electron 官方行为），
// 因此此处生效的 CSP 只能来自构建期注入的 <meta>（electron.vite.config.ts injectCspMeta）。
// 两层断言：
//   1. 机制断言——构建产物带 CSP meta 且策略正确；
//   2. 行为断言——connect-src 'self' 真实拦下渲染进程发起的跨域 fetch
//      （以控制台 CSP 违规信息为准，区分"被 CSP 拦截"与"普通网络失败"）。

import { test, expect, _electron as electron } from '@playwright/test'
import {
  createTmpUserData,
  writeDefaultConfig,
  writeFakeApiKey,
  cleanupTmpDir,
  shutdownApp,
  createElectronEnv
} from './helpers'

test('V-01: file:// 下 CSP meta 存在且真实拦截跨域请求', async () => {
  const tmpDir = createTmpUserData()
  writeDefaultConfig(tmpDir)
  writeFakeApiKey(tmpDir)

  const app = await electron.launch({
    args: ['out/main/index.js'],
    env: createElectronEnv({
      COMPANION_TEST_MODE: 'faux',
      COMPANION_USER_DATA: tmpDir
    })
  })
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('textarea', { timeout: 30_000 })

    // 1. 机制断言：构建期注入的 meta 存在且策略为生产版严格 CSP
    const cspMeta = page.locator('meta[http-equiv="Content-Security-Policy"]')
    await expect(cspMeta).toHaveCount(1)
    const content = await cspMeta.getAttribute('content')
    expect(content).toContain("default-src 'self'")
    expect(content).toContain("connect-src 'self'")
    expect(content).not.toContain('ws://localhost') // 生产策略不含 dev HMR 放宽

    // 2. 行为断言：跨域 fetch 被 CSP 拦截（CSP 检查先于网络，离线也能复现）
    const cspViolations: string[] = []
    page.on('console', (msg) => {
      if (msg.text().includes('Content Security Policy')) cspViolations.push(msg.text())
    })
    const result = await page.evaluate(() =>
      fetch('https://example.com/csp-probe').then(
        () => 'allowed',
        () => 'blocked'
      )
    )
    expect(result).toBe('blocked')
    expect(cspViolations.length).toBeGreaterThan(0)
    expect(cspViolations[0]).toContain('connect-src')
  } finally {
    await shutdownApp(app)
    cleanupTmpDir(tmpDir)
  }
})
