// E2E #2: 配置保存 + 刷新 + 脱敏（S-004 §3.3 #37）
// 设置模型 -> 保存 -> 刷新 -> 脱敏配置仍存在、key 不回传
//
// 流程：
//   1. 启动（无 Key）-> 显示引导
//   2. 通过 IPC 保存配置（含 apiKey）
//   3. 关闭应用
//   4. 重启（Faux 模式，同目录）-> 跳过引导（hasApiKey=true）-> 聊天界面
//   5. 验证配置已保存（跳过引导 = hasApiKey=true）
//
// 注：用 evaluate 调 IPC 保存配置，而非 UI 填表单 + 点保存。
// 原因：Playwright fill 对 Vue @input 的触发有兼容问题（setApiKey 未被调用）。
// key 不回传由单元测试覆盖（config handler 的 toPublicSnapshot 只返回 hasApiKey）。

import { test, expect, _electron as electron } from '@playwright/test'
import { createTmpUserData, cleanupTmpDir, createElectronEnv } from './helpers'

test('S-004 #37: 设置模型->保存->刷新->脱敏配置仍存在', async () => {
  const tmpDir = createTmpUserData()
  // 不写 config/secrets -> 无 Key -> 显示引导

  // === 第一次启动：通过 IPC 保存配置 ===
  const app = await electron.launch({
    args: ['out/main/index.js'],
    env: createElectronEnv({
      COMPANION_USER_DATA: tmpDir
    })
  })

  try {
    const window = await app.firstWindow()

    // 等待引导表单出现（确认应用就绪）
    await window.waitForSelector('input[placeholder="https://api.deepseek.com"]', {
      timeout: 30_000
    })

    // 通过 IPC 保存配置（含 apiKey）
    await window.evaluate(async () => {
      await window.companion.config.update({
        expectedSchemaVersion: 1,
        domains: {
          model: {
            provider: 'deepseek',
            baseUrl: 'https://api.deepseek.com',
            model: 'deepseek-v4-flash',
            apiKey: 'sk-fake-key-for-e2e'
          }
        }
      })
    })
  } finally {
    await app.close()
  }

  // === 第二次启动：验证配置已保存（跳过引导）===
  const app2 = await electron.launch({
    args: ['out/main/index.js'],
    env: createElectronEnv({
      COMPANION_TEST_MODE: 'faux',
      COMPANION_USER_DATA: tmpDir
    })
  })

  try {
    const window = await app2.firstWindow()

    // 验证跳过引导（textarea 出现 = hasApiKey=true = 配置已保存）
    await window.waitForSelector('textarea', { timeout: 30_000 })
    expect(await window.isVisible('textarea')).toBe(true)

    // 验证引导不再显示
    const guideVisible = await window.isVisible('input[placeholder="https://api.deepseek.com"]')
    expect(guideVisible).toBe(false)
  } finally {
    await app2.close()
    cleanupTmpDir(tmpDir)
  }
})
