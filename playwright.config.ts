// Playwright 配置（Electron E2E 测试）
// 依据：S-004 §3.2 "E2E | Playwright Electron（打包前 smoke）"
//
// 用法：npm run test:e2e（先 build 生成 out/，再跑 E2E）
// E2E 测试启动 out/main/index.js（真实 Electron 进程），不是浏览器。

import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  retries: 1,
  use: {
    trace: 'on-first-retry'
  }
})
