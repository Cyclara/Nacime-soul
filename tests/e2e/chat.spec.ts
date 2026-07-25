// E2E #1: 基本聊天链路（S-004 §3.3 #36）
// 启动 -> 输入 -> Faux 流式回复 -> 完成
//
// 用 COMPANION_TEST_MODE=faux 让 main 进程用 Faux Provider（不调真实 API）
// 预写 config.json + secrets.json 让应用跳过引导直接进聊天界面

import { test, expect, _electron as electron } from '@playwright/test'
import {
  createTmpUserData,
  writeDefaultConfig,
  writeFakeApiKey,
  cleanupTmpDir,
  createElectronEnv
} from './helpers'

test('S-004 #36: 启动->输入->Faux 流式回复->完成', async () => {
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
    const window = await app.firstWindow()

    // 等待聊天界面就绪（textarea 出现 = 跳过引导，hasApiKey=true）
    await window.waitForSelector('textarea', { timeout: 30_000 })

    // 输入消息
    await window.fill('textarea', '你好')

    // 点发送
    await window.click('button:text("发送")')

    // 等待 assistant 消息行出现（占位消息）
    await window.waitForSelector('.message-row.assistant', { timeout: 10_000 })

    // 等待 content 有文本（Faux 返回 "你好！我是 Nacime，很高兴认识你。"）
    await window.waitForFunction(
      () => {
        const el = document.querySelector('.message-row.assistant .content')
        return el && el.textContent && el.textContent.length > 0
      },
      { timeout: 20_000 }
    )

    // 验证回复包含 Faux 预设文本
    const reply = await window.textContent('.message-row.assistant .content')
    expect(reply).toContain('Nacime')

    // 验证用户消息也显示
    const userMsg = await window.textContent('.message-row.user .content')
    expect(userMsg).toContain('你好')
  } finally {
    await app.close()
    cleanupTmpDir(tmpDir)
  }
})
