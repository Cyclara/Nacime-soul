// E2E E-01 / E-02：记忆系统验收（S-004-补充 §3.1，P2-45 验收）
//
// E-01：对话写入 L0（Faux 固定提取）→ 关 app → 重启 → 记忆面板显示该字段（跨重启持久化）
// E-02：记忆面板基础操作——L0 卡片显示 + L2 列表 → 打开详情 → pin → 刷新后仍 pinned
//
// 用 COMPANION_TEST_MODE=faux + COMPANION_FAUX_EXTRACTION 让提取 provider 返回脚本化候选
// （evidence.messageId 用 "current-user" 占位，setup.ts 的 faux 路径替换为真实 messageId）。

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, _electron as electron, type Page } from '@playwright/test'
import {
  createTmpUserData,
  writeMemoryConfig,
  writeFakeApiKey,
  cleanupTmpDir,
  createElectronEnv,
  FAUX_EXTRACTION_ENVELOPE,
  E2E_TEST_NAME
} from './helpers'

function fauxEnv(tmpDir: string): Record<string, string> {
  return createElectronEnv({
    COMPANION_TEST_MODE: 'faux',
    COMPANION_FAUX_EXTRACTION: FAUX_EXTRACTION_ENVELOPE,
    COMPANION_USER_DATA: tmpDir
  })
}

/** 等待 data/l0-profile.json 包含指定值（提取 hook 后台异步写盘） */
async function waitForL0Value(tmpDir: string, value: string, timeoutMs = 20_000): Promise<void> {
  const file = join(tmpDir, 'data', 'l0-profile.json')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const raw = readFileSync(file, 'utf8')
      if (raw.includes(value)) return
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`l0-profile.json 未在 ${timeoutMs}ms 内写入 "${value}"`)
}

/** 点击记忆入口按钮，进入 /memory 面板 */
async function openMemoryPanel(win: Page): Promise<void> {
  await win.click('.memory-entry', { timeout: 10_000 })
  await win.waitForSelector('.l0-card, .l2-list', { timeout: 10_000 })
}

test('E-01: 对话写入 L0（Faux 提取）→ 重启 → 记忆面板显示该字段', async () => {
  const tmpDir = createTmpUserData()
  writeMemoryConfig(tmpDir)
  writeFakeApiKey(tmpDir)

  // ── 第一次启动：发消息 → 提取写 L0/L2 ──
  const app1 = await electron.launch({ args: ['out/main/index.js'], env: fauxEnv(tmpDir) })
  try {
    const win = await app1.firstWindow()
    await win.waitForSelector('textarea', { timeout: 30_000 })
    await win.fill('textarea', `请叫我${E2E_TEST_NAME}，我喜欢收集虚构的蓝色月票`)
    await win.click('button:text("发送")')
    // 等待提取后台写盘（Faux provider 返回 envelope → judge → L0 落盘）
    await waitForL0Value(tmpDir, E2E_TEST_NAME)
    // 记忆面板显示该字段
    await openMemoryPanel(win)
    await win.waitForFunction(
      (expectedName) => document.body.textContent?.includes(expectedName) ?? false,
      E2E_TEST_NAME,
      { timeout: 10_000 }
    )
  } finally {
    await app1.close()
  }

  // ── 第二次启动（同 userData）：L0 持久化仍在 ──
  const app2 = await electron.launch({ args: ['out/main/index.js'], env: fauxEnv(tmpDir) })
  try {
    const win = await app2.firstWindow()
    await win.waitForSelector('textarea', { timeout: 30_000 })
    await openMemoryPanel(win)
    await win.waitForFunction(
      (expectedName) => document.body.textContent?.includes(expectedName) ?? false,
      E2E_TEST_NAME,
      { timeout: 10_000 }
    )
    const body = await win.textContent('body')
    expect(body).toContain(E2E_TEST_NAME)
  } finally {
    await app2.close()
    cleanupTmpDir(tmpDir)
  }
})

test('E-02: 记忆面板——L0 卡片 + L2 列表 + pin 后刷新仍固定', async () => {
  const tmpDir = createTmpUserData()
  writeMemoryConfig(tmpDir)
  writeFakeApiKey(tmpDir)

  const app = await electron.launch({ args: ['out/main/index.js'], env: fauxEnv(tmpDir) })
  try {
    const win = await app.firstWindow()
    await win.waitForSelector('textarea', { timeout: 30_000 })
    await win.fill('textarea', `请叫我${E2E_TEST_NAME}，我喜欢收集虚构的蓝色月票`)
    await win.click('button:text("发送")')
    await waitForL0Value(tmpDir, E2E_TEST_NAME)

    // 打开记忆面板：L0 卡片显示 + L2 列表含明显虚构的测试偏好
    await openMemoryPanel(win)
    await win.waitForSelector('.l2-item', { timeout: 10_000 })
    const l2Content = await win.textContent('.l2-item .item-content')
    expect(l2Content).toContain('虚构的蓝色月票')

    // 打开详情抽屉 → pin（:has-text 对含 emoji 的按钮更稳；pin 是 footer 第一个非 danger action-btn）
    await win.click('.l2-item')
    await win.waitForSelector('.drawer', { timeout: 10_000 })
    await win.click('.drawer .action-btn:not(.danger):has-text("固定")')
    await win.waitForSelector('.drawer .pin-mark', { timeout: 10_000 })
    // 抽屉按钮变为"取消固定"
    const pinBtn = await win.textContent('.drawer .action-btn:not(.danger)')
    expect(pinBtn).toContain('取消固定')

    // 刷新（reload）→ hash 路由恢复 #/memory → pin 持久化仍在（直接在记忆面板验证）
    await win.reload()
    await win.waitForSelector('.l2-item', { timeout: 30_000 })
    await win.click('.l2-item')
    await win.waitForSelector('.drawer', { timeout: 10_000 })
    const afterReload = await win.textContent('.drawer .action-btn:not(.danger)')
    expect(afterReload).toContain('取消固定')
  } finally {
    await app.close()
    cleanupTmpDir(tmpDir)
  }
})
