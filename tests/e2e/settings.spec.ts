// P2-46：真实设置抽屉 E2E。
// 覆盖四个正式分区、模型配置 UI 保存与重启持久化、API Key 脱敏输入、
// 记忆总开关的重启提示，以及安全配置保存。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, _electron as electron, type Page } from '@playwright/test'
import {
  createTmpUserData,
  writeDefaultConfig,
  writeMemoryConfig,
  writeFakeApiKey,
  cleanupTmpDir,
  shutdownApp,
  createElectronEnv
} from './helpers'

function fauxEnv(tmpDir: string): Record<string, string> {
  return createElectronEnv({
    COMPANION_TEST_MODE: 'faux',
    COMPANION_USER_DATA: tmpDir
  })
}

async function openSettings(page: Page): Promise<void> {
  await page.waitForSelector('textarea', { timeout: 30_000 })
  await page.click('.settings-entry')
  await page.waitForSelector('.settings-drawer', { timeout: 10_000 })
}

async function openSection(
  page: Page,
  label: '模型' | '记忆' | '外观' | '角色' | '安全'
): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`^\\d{2} ${label}`) }).click()
}

// P3A-24 在外观与安全之间插入「04 角色」，其后分区编号整体后移一位。
test('P2-46/P3A-24: 五个正式设置分区可达，高级分区不展示', async () => {
  const tmpDir = createTmpUserData()
  writeDefaultConfig(tmpDir)
  writeFakeApiKey(tmpDir)

  const app = await electron.launch({ args: ['out/main/index.js'], env: fauxEnv(tmpDir) })
  try {
    const page = await app.firstWindow()
    await openSettings(page)

    await expect(page.getByRole('button', { name: /01 模型/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /02 记忆/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /03 外观/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /04 角色/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /05 安全/ })).toBeVisible()
    await expect(page.getByText('高级', { exact: true })).toHaveCount(0)

    await openSection(page, '模型')
    await expect(page.getByRole('heading', { name: '决定她如何回应你' })).toBeVisible()
    await openSection(page, '记忆')
    await expect(page.getByRole('heading', { name: '决定她如何记住与淡忘' })).toBeVisible()
    await openSection(page, '外观')
    await expect(page.getByRole('heading', { name: '让光线顺着你的时间呼吸' })).toBeVisible()
    await openSection(page, '角色')
    await expect(page.getByRole('heading', { name: 'Live2D 形象' })).toBeVisible()
    await openSection(page, '安全')
    await expect(page.getByRole('heading', { name: '让边界清楚，也让诊断可控' })).toBeVisible()
  } finally {
    await shutdownApp(app)
    cleanupTmpDir(tmpDir)
  }
})

test('P2-46: 模型设置经 UI 保存并跨重启持久化，API Key 不回填', async () => {
  const tmpDir = createTmpUserData()
  writeDefaultConfig(tmpDir)
  writeFakeApiKey(tmpDir)

  const launch = (): ReturnType<typeof electron.launch> =>
    electron.launch({ args: ['out/main/index.js'], env: fauxEnv(tmpDir) })

  let app: Awaited<ReturnType<typeof electron.launch>> | null = null
  try {
    app = await launch()
    let page = await app.firstWindow()
    await openSettings(page)
    await openSection(page, '模型')

    const provider = page.getByLabel('服务商标识')
    const displayName = page.getByLabel('显示名称')
    const apiKey = page.getByLabel('API Key')
    await provider.fill('faux-provider')
    await displayName.fill('星河模型')
    await apiKey.fill('sk-e2e-settings-secret')
    await page.getByRole('button', { name: '保存模型设置' }).click()
    await expect(page.getByText('模型配置已保存', { exact: true })).toBeVisible()
    await expect(apiKey).toHaveValue('')
    await expect(apiKey).toHaveAttribute('placeholder', '已安全保存；输入可替换')

    const configText = readFileSync(join(tmpDir, 'config.json'), 'utf8')
    expect(configText).toContain('faux-provider')
    expect(configText).toContain('星河模型')
    expect(configText).not.toContain('sk-e2e-settings-secret')

    await shutdownApp(app)
    app = null

    app = await launch()
    page = await app.firstWindow()
    await openSettings(page)
    await openSection(page, '模型')
    await expect(page.getByLabel('服务商标识')).toHaveValue('faux-provider')
    await expect(page.getByLabel('显示名称')).toHaveValue('星河模型')
    await expect(page.getByLabel('API Key')).toHaveValue('')
    await expect(page.getByLabel('API Key')).toHaveAttribute(
      'placeholder',
      '已安全保存；输入可替换'
    )
  } finally {
    if (app) await shutdownApp(app)
    cleanupTmpDir(tmpDir)
  }
})

test('P2-46: 空画像九个 chips、放弃草稿关闭、记忆重启提示与安全保存', async () => {
  const tmpDir = createTmpUserData()
  writeMemoryConfig(tmpDir)
  writeFakeApiKey(tmpDir)

  const app = await electron.launch({ args: ['out/main/index.js'], env: fauxEnv(tmpDir) })
  try {
    const page = await app.firstWindow()
    await openSettings(page)
    await openSection(page, '记忆')

    const memoryToggle = page.getByLabel('启用记忆')
    await expect(memoryToggle).toBeChecked()
    await memoryToggle.uncheck()
    await expect(page.getByText(/需要重启 Nacime/)).toBeVisible()
    await page.getByRole('button', { name: '保存基础设置' }).click()
    await expect(page.getByText('记忆设置已保存', { exact: true })).toBeVisible()
    const reenabled = await page.evaluate(async () => {
      const current = await window.companion.config.get()
      if (!current.ok) return false
      const updated = await window.companion.config.update({
        expectedSchemaVersion: current.data.schemaVersion,
        domains: { memory: { enabled: true } }
      })
      return updated.ok
    })
    expect(reenabled).toBe(true)
    await page.getByLabel('Embedding 服务商').fill('discard-me')
    await page.getByRole('button', { name: '关闭设置' }).click()
    const discardDialog = page.getByRole('alertdialog')
    await expect(discardDialog).toBeVisible()
    await discardDialog.getByRole('button', { name: '放弃修改' }).click()
    await expect(page.locator('.settings-drawer')).toHaveCount(0)
    await page.click('.memory-entry')
    await page.waitForSelector('.l0-card', { timeout: 10_000 })
    await expect(page.locator('.l0-field')).toHaveCount(0)
    await expect(page.locator('.unknown-chip')).toHaveCount(9)
    await expect(page.getByText('她还不了解', { exact: true })).toBeVisible()
    await expect(page.getByText('待发现', { exact: true })).toHaveCount(0)

    await page.getByRole('button', { name: '返回聊天' }).click()
    await openSettings(page)
    await openSection(page, '安全')
    await page.getByLabel('日志保留天数').fill('9')
    await page.getByRole('button', { name: '保存安全设置' }).click()
    await expect(page.getByText('安全与诊断设置已保存', { exact: true })).toBeVisible()

    const config = JSON.parse(readFileSync(join(tmpDir, 'config.json'), 'utf8')) as {
      memory: { enabled: boolean }
      security: { diagnostics: { retentionDays: number } }
    }
    expect(config.memory.enabled).toBe(false)
    expect(config.security.diagnostics.retentionDays).toBe(9)
  } finally {
    await shutdownApp(app)
    cleanupTmpDir(tmpDir)
  }
})
