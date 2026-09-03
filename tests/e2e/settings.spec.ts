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
  label: '模型' | '记忆' | '外观' | '角色' | '语音' | '安全'
): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`^\\d{2} ${label}`) }).click()
}

// P3A-24 插入「04 角色」、P3B-14 插入「05 语音」，其后分区编号顺延（安全=06）。
test('P2-46/P3A-24/P3B-14: 六个正式设置分区可达，高级分区不展示', async () => {
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
    await expect(page.getByRole('button', { name: /05 语音/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /06 安全/ })).toBeVisible()
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

test('M-51/2026-09-02：窗口化 + 125% UI 缩放时主页面与设置抽屉仍以窗口居中', async () => {
  const tmpDir = createTmpUserData()
  writeDefaultConfig(tmpDir)
  writeFakeApiKey(tmpDir)

  const app = await electron.launch({ args: ['out/main/index.js'], env: fauxEnv(tmpDir) })
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('textarea', { timeout: 30_000 })
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.getTitle() === 'Nacime'
      )
      win?.setSize(1180, 780)
      win?.center()
    })
    await page.evaluate(() => window.companion.ui.setZoomFactor(1.25))
    await page.waitForTimeout(250)

    // 主页面两个宽内容锚（header/composer）都围绕 CSS viewport 中线，不随 zoom 右偏。
    const mainCenters = await page.evaluate(() => {
      const center = (selector: string): number => {
        const rect = document.querySelector(selector)!.getBoundingClientRect()
        return rect.left + rect.width / 2
      }
      return {
        viewport: window.innerWidth / 2,
        header: center('.header-inner'),
        composer: center('.composer')
      }
    })
    expect(Math.abs(mainCenters.header - mainCenters.viewport)).toBeLessThanOrEqual(2)
    expect(Math.abs(mainCenters.composer - mainCenters.viewport)).toBeLessThanOrEqual(2)

    await openSettings(page)
    // 等抽屉 300ms 入场动画结束；动画本身有 translateX(36px)，测动画中间值没有意义。
    await page.waitForTimeout(400)
    const drawer = await page.evaluate(() => {
      const rect = document.querySelector('.settings-drawer')!.getBoundingClientRect()
      return { center: rect.left + rect.width / 2, viewport: window.innerWidth / 2 }
    })
    expect(Math.abs(drawer.center - drawer.viewport)).toBeLessThanOrEqual(2)
  } finally {
    await shutdownApp(app)
    cleanupTmpDir(tmpDir)
  }
})

test('2026-09-02：四主题设置文字使用语义色，切主题不关闭已显示的 Live2D', async () => {
  const tmpDir = createTmpUserData()
  writeDefaultConfig(tmpDir)
  writeFakeApiKey(tmpDir)

  const app = await electron.launch({ args: ['out/main/index.js'], env: fauxEnv(tmpDir) })
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('textarea', { timeout: 30_000 })
    await openSettings(page)

    // ROOT CAUSE 回归：live2d:set-visible 由 main 直接持久化 enabled=true，renderer config
    // 快照仍可能是旧 false；之后切主题只能发 `{ui:{theme}}`，不得全量回写 false。
    await page.evaluate(async () => {
      await window.companion.live2d.setVisible({ visible: true })
    })
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const state = await window.companion.live2d.getState()
            return state.ok && state.data.window.visible
          }),
        { timeout: 30_000 }
      )
      .toBe(true)

    await openSection(page, '外观')
    const themes = [
      { id: 'light', label: '浅色' },
      { id: 'dark', label: '深色' },
      { id: 'light2', label: '浅色2号' },
      { id: 'dark2', label: '深色2号' }
    ] as const
    for (const theme of themes) {
      const radio = page.getByRole('radio', { name: new RegExp(`^${theme.label}主题`) })
      const alreadySelected = (await radio.getAttribute('aria-checked')) === 'true'
      await radio.click()
      await page.waitForFunction((id) => document.documentElement.dataset.theme === id, theme.id)
      if (!alreadySelected) {
        await expect(page.getByText(`${theme.label}主题已保存`, { exact: true })).toBeVisible()
      }

      const configEnabled = await page.evaluate(async () => {
        const config = await window.companion.config.get()
        return config.ok ? config.data.ui.live2d.enabled : null
      })
      expect(configEnabled).toBe(true)
      await expect
        .poll(
          async () =>
            page.evaluate(async () => {
              const state = await window.companion.live2d.getState()
              return state.ok && state.data.window.visible
            }),
          { timeout: 30_000 }
        )
        .toBe(true)

      await openSection(page, '语音')
      const voiceColors = await page.evaluate(() => {
        const resolveColor = (token: string): string => {
          const probe = document.createElement('span')
          probe.style.color = `var(${token})`
          document.body.append(probe)
          const color = getComputedStyle(probe).color
          probe.remove()
          return color
        }
        return {
          section: getComputedStyle(document.querySelector('.voice-settings')!).color,
          hint: getComputedStyle(document.querySelector('.tts-field__hint')!).color,
          textToken: resolveColor('--color-text'),
          secondaryToken: resolveColor('--color-text-secondary'),
          mutedToken: resolveColor('--color-text-muted')
        }
      })
      expect(voiceColors.section).toBe(voiceColors.textToken)
      // TTS 总开关关闭时 deliberately 提升到 secondary；开启时用 muted，两者都达 4.5:1。
      expect([voiceColors.secondaryToken, voiceColors.mutedToken]).toContain(voiceColors.hint)

      await openSection(page, '角色')
      const roleColors = await page.evaluate(() => {
        const resolveColor = (token: string): string => {
          const probe = document.createElement('span')
          probe.style.color = `var(${token})`
          document.body.append(probe)
          const color = getComputedStyle(probe).color
          probe.remove()
          return color
        }
        const modelName = document.querySelector('.model-item__body strong')
        const validation = document.querySelector('.validation:not(.validation--error)')
        return {
          model: modelName ? getComputedStyle(modelName).color : '',
          validation: validation ? getComputedStyle(validation).color : '',
          textToken: resolveColor('--color-text'),
          successToken: resolveColor('--color-success')
        }
      })
      expect(roleColors.model).toBe(roleColors.textToken)
      if (roleColors.validation) expect(roleColors.validation).toBe(roleColors.successToken)

      await openSection(page, '外观')
    }
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
    // main 在 279-282 行被外部重启链 re-enable 为 true；安全分区只改 retentionDays，
    // 最小 config patch 不应把 renderer 的 stale memory=false 全量回写覆盖 main 真值。
    expect(config.memory.enabled).toBe(true)
    expect(config.security.diagnostics.retentionDays).toBe(9)
  } finally {
    await shutdownApp(app)
    cleanupTmpDir(tmpDir)
  }
})
