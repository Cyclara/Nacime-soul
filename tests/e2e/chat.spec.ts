// E2E #1: 基本聊天链路（S-004 §3.3 #36）
// 启动 -> 输入 -> Faux 流式回复 -> 完成
//
// 用 COMPANION_TEST_MODE=faux 让 main 进程用 Faux Provider（不调真实 API）
// 预写 config.json + secrets.json 让应用跳过引导直接进聊天界面

import { readFileSync } from 'node:fs'
import { test, expect, _electron as electron } from '@playwright/test'
import {
  createTmpUserData,
  writeDefaultConfig,
  writeFakeApiKey,
  cleanupTmpDir,
  shutdownApp,
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
    await shutdownApp(app)
    cleanupTmpDir(tmpDir)
  }
})

test('P2-43: 关闭并重启 Electron 后恢复最近会话与历史消息', async () => {
  const tmpDir = createTmpUserData()
  writeDefaultConfig(tmpDir)
  writeFakeApiKey(tmpDir)
  const launch = (): ReturnType<typeof electron.launch> =>
    electron.launch({
      args: ['out/main/index.js'],
      env: createElectronEnv({
        COMPANION_TEST_MODE: 'faux',
        COMPANION_USER_DATA: tmpDir
      })
    })

  let app: Awaited<ReturnType<typeof electron.launch>> | null = null
  try {
    // 第一次进程：创建会话并写入一轮完整消息
    app = await launch()
    let window = await app.firstWindow()
    await window.waitForSelector('textarea', { timeout: 30_000 })
    await window.fill('textarea', 'P2-43 跨重启消息')
    await window.click('button:text("发送")')
    await window.waitForFunction(
      () => {
        const el = document.querySelector('.message-row.assistant .content')
        return el?.textContent?.includes('Nacime') === true
      },
      { timeout: 20_000 }
    )
    await expect(window.locator('button.stop-btn')).toHaveCount(0)

    // 真正关闭 main 进程，再用同一 userData 启动（不是刷新 renderer）
    await shutdownApp(app)
    app = null

    // 第二次进程：renderer 没有 state.sessionId，必须走 getLastSession -> SQLite list
    app = await launch()
    window = await app.firstWindow()
    await window.waitForSelector('textarea', { timeout: 30_000 })

    await expect(window.locator('.message-row.user .content')).toContainText('P2-43 跨重启消息')
    await expect(window.locator('.message-row.assistant .content')).toContainText('Nacime')
    await expect(window.locator('.message-row.user')).toHaveCount(1)
    await expect(window.locator('.message-row.assistant')).toHaveCount(1)
  } finally {
    if (app) await shutdownApp(app)
    cleanupTmpDir(tmpDir)
  }
})

test('P2-43: 完成态 clientRequestId 跨 Electron 重启重放原 ACK 且不重复写消息', async () => {
  const tmpDir = createTmpUserData()
  writeDefaultConfig(tmpDir)
  writeFakeApiKey(tmpDir)
  const launch = (): ReturnType<typeof electron.launch> =>
    electron.launch({
      args: ['out/main/index.js'],
      env: createElectronEnv({
        COMPANION_TEST_MODE: 'faux',
        COMPANION_USER_DATA: tmpDir
      })
    })
  const text = 'P2-43 固定幂等请求'
  const clientRequestId = 'p2-43-e2e-fixed-request'

  let app: Awaited<ReturnType<typeof electron.launch>> | null = null
  try {
    app = await launch()
    let page = await app.firstWindow()
    await page.waitForSelector('textarea', { timeout: 30_000 })

    const first = await page.evaluate(
      async ({ requestText, requestKey }) => {
        const api = window.companion.chat
        const last = await api.getLastSession()
        if (!last.ok || !last.data.sessionId) throw new Error('missing hydrated session')

        let targetRequestId: string | null = null
        const terminalIds = new Set<string>()
        let resolveDone!: () => void
        const done = new Promise<void>((resolve) => {
          resolveDone = resolve
        })
        const unsubscribe = api.onStream((event) => {
          if (event.type === 'completed' || event.type === 'failed' || event.type === 'cancelled') {
            terminalIds.add(event.requestId)
            if (event.requestId === targetRequestId) resolveDone()
          }
        })

        try {
          const sent = await api.send({
            sessionId: last.data.sessionId,
            text: requestText,
            clientRequestId: requestKey
          })
          if (!sent.ok) throw new Error(sent.error.message)
          targetRequestId = sent.data.requestId
          if (terminalIds.has(targetRequestId)) resolveDone()
          await Promise.race([
            done,
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('stream terminal timeout')), 20_000)
            )
          ])
          return { sessionId: last.data.sessionId, ack: sent.data }
        } finally {
          unsubscribe()
        }
      },
      { requestText: text, requestKey: clientRequestId }
    )

    // 真正落到生产 wiring 的 data/chat-idempotency.json，且不重复存聊天明文。
    const ledgerText = readFileSync(`${tmpDir}/data/chat-idempotency.json`, 'utf8')
    expect(ledgerText).toContain(clientRequestId)
    expect(ledgerText).not.toContain(text)

    await shutdownApp(app)
    app = null

    app = await launch()
    page = await app.firstWindow()
    await page.waitForSelector('textarea', { timeout: 30_000 })

    const replay = await page.evaluate(
      async ({ sessionId, requestText, requestKey }) => {
        const api = window.companion.chat
        const sent = await api.send({
          sessionId,
          text: requestText,
          clientRequestId: requestKey
        })
        if (!sent.ok) throw new Error(sent.error.message)
        const history = await api.list({ sessionId, limit: 500 })
        if (!history.ok) throw new Error(history.error.message)
        return { ack: sent.data, messages: history.data.messages }
      },
      {
        sessionId: first.sessionId,
        requestText: text,
        requestKey: clientRequestId
      }
    )

    expect(replay.ack).toEqual(first.ack)
    expect(
      replay.messages.filter((message) => message.role === 'user' && message.content === text)
    ).toHaveLength(1)
    expect(replay.messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
  } finally {
    if (app) await shutdownApp(app)
    cleanupTmpDir(tmpDir)
  }
})
