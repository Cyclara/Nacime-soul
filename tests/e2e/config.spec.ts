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
import { createTmpUserData, cleanupTmpDir, createElectronEnv, shutdownApp } from './helpers'

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
    const win = await app.firstWindow()

    // 等待引导表单出现（确认应用就绪）
    await win.waitForSelector('input[placeholder="https://api.deepseek.com"]', {
      timeout: 30_000
    })

    // 通过 IPC 保存配置（含 apiKey）
    await win.evaluate(async () => {
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
    await shutdownApp(app)
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
    const win = await app2.firstWindow()

    // S-014 之后「有 Key」不再等于「直接进聊天」：本例用 IPC 直存配置、没走引导 UI，
    // 因此引导阶段仍是 provider-setup，重启后 resolver 判为 configured-empty-history，
    // 落在「第一次见面」。真正要守的不变量是——配置跨重启仍在，且不再要求重填连接表单。
    await win.waitForSelector('.first-conversation', { timeout: 30_000 })
    const guideVisible = await win.isVisible('input[placeholder="https://api.deepseek.com"]')
    expect(guideVisible).toBe(false)

    const persisted = await win.evaluate(async () => {
      const current = await window.companion.config.get()
      if (!current.ok) return null
      return {
        hasApiKey: current.data.model.hasApiKey,
        baseUrl: current.data.model.baseUrl,
        model: current.data.model.model
      }
    })
    expect(persisted).toEqual({
      hasApiKey: true,
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash'
    })
  } finally {
    await shutdownApp(app2)
    cleanupTmpDir(tmpDir)
  }
})
