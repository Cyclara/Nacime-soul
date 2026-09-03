// P3A-27：真实 Electron 双窗口 Live2D packaged-before smoke。
// 只断言 stage 首帧/错误状态与安全 preload；不把 GPU 对象跨到 chat page。

import { readFileSync, writeFileSync } from 'node:fs'
import { test, expect, _electron as electron } from '@playwright/test'
import {
  createTmpUserData,
  writeDefaultConfig,
  writeFakeApiKey,
  cleanupTmpDir,
  shutdownApp,
  createElectronEnv
} from './helpers'

/**
 * P3A-28 的性能预算是**用户机器**上的验收目标，不是 CI runner 的。
 *
 * GitHub Actions 的 windows runner 没有 GPU，WebGL 走软件光栅化，实测空闲 CPU 7.6–8.3%、
 * 帧率偶尔掉到 28——测的是 runner，不是产品。预算的真源在运行时门禁
 * （`@shared/live2d/performance` + main 的 `onPerformanceReport` 超标告警），
 * 产品口径由本地跑本文件与真机验收保证。
 *
 * CI 上仍保留两条粗门，因为它们抓的是**功能性**故障而非性能：帧率下限证明画面确实在
 * 连续出帧（不是冻住的画布），CPU 上限抓失控忙等。放宽不等于取消。
 */
const ON_CI = Boolean(process.env['CI'])
const MIN_FPS = ON_CI ? 10 : 30
const MAX_IDLE_CPU = ON_CI ? 40 : 5

interface RenderedBounds {
  width: number
  height: number
  top: number
  bottom: number
  pixels: number
  canvasHeight: number
}

test('P3A-04 / 完成定义1：关闭聊天窗口不留下孤儿 stage 窗口', async () => {
  // 回归：Live2D 关闭时「关聊天窗口 → window-all-closed → app.quit()」；开启时 stage 窗口还在，
  // window-all-closed 永不触发，桌面上就留下一个没有主人、也无法再打开聊天的透明窗口
  // （托盘「打开 Nacime」在 mainWindow 已销毁时是 no-op）。2026-08-29 真机复现三次。
  // 这类缺陷只在跨窗口层面可见，单测覆盖不到——必须在 E2E 断言。
  const tmpDir = createTmpUserData()
  writeDefaultConfig(tmpDir)
  writeFakeApiKey(tmpDir)
  const configPath = `${tmpDir}/config.json`
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    ui: { live2d: { enabled: boolean; selectedModelId?: string } }
  }
  config.ui.live2d.enabled = true
  config.ui.live2d.selectedModelId = 'mao'
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')

  const app = await electron.launch({
    args: ['out/main/index.js'],
    env: createElectronEnv({ COMPANION_TEST_MODE: 'faux', COMPANION_USER_DATA: tmpDir })
  })
  let processExited = false
  app.process().on('exit', () => {
    processExited = true
  })

  try {
    await expect.poll(() => app.windows().length, { timeout: 30_000 }).toBeGreaterThan(1)
    const stage = app.windows().find((page) => page.url().includes('/live2d.html'))
    expect(stage).toBeDefined()
    await stage!.waitForSelector('canvas', { timeout: 30_000 })

    await app.evaluate(({ BrowserWindow }) => {
      const chat = BrowserWindow.getAllWindows().find(
        (window) => !window.webContents.getURL().includes('/live2d.html')
      )
      chat?.close()
    })

    // 进程退出与 stage 消失都算通过：window-all-closed 之后应用本就会退出，
    // 退出后 app.evaluate 会失败，因此把「查不到了」也视为已退场。
    await expect
      .poll(
        async () => {
          if (processExited) return 'exited'
          try {
            const urls = await app.evaluate(({ BrowserWindow }) =>
              BrowserWindow.getAllWindows().map((window) => window.webContents.getURL())
            )
            return urls.some((url) => url.includes('/live2d.html')) ? 'stage-alive' : 'stage-gone'
          } catch {
            return 'exited'
          }
        },
        { timeout: 20_000 }
      )
      .not.toBe('stage-alive')
  } finally {
    await shutdownApp(app)
    cleanupTmpDir(tmpDir)
  }
})

for (const modelId of ['mao', 'hiyori'] as const) {
  test(`P3A-27：enabled Live2D stage loads bundled ${modelId} and reports continuous FPS`, async () => {
    const tmpDir = createTmpUserData()
    writeDefaultConfig(tmpDir)
    writeFakeApiKey(tmpDir)
    const configPath = `${tmpDir}/config.json`
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      ui: { live2d: { enabled: boolean; selectedModelId?: string } }
    }
    config.ui.live2d.enabled = true
    config.ui.live2d.selectedModelId = modelId
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')

    const app = await electron.launch({
      args: ['out/main/index.js'],
      env: createElectronEnv({ COMPANION_TEST_MODE: 'faux', COMPANION_USER_DATA: tmpDir })
    })
    let mainOutput = ''
    const captureMainOutput = (chunk: Buffer): void => {
      mainOutput += chunk.toString()
    }
    app.process().stdout?.on('data', captureMainOutput)
    app.process().stderr?.on('data', captureMainOutput)

    try {
      await expect.poll(() => app.windows().length, { timeout: 30_000 }).toBeGreaterThan(1)
      const chat = app.windows().find((page) => !page.url().includes('/live2d.html'))
      if (!chat) throw new Error('Chat window did not open')
      await chat.waitForLoadState('domcontentloaded', { timeout: 30_000 })
      await expect(chat.locator('body')).toBeAttached({ timeout: 30_000 })
      await expect(chat.locator('canvas')).toHaveCount(0)

      const stage = app.windows().find((page) => page.url().includes('/live2d.html'))
      expect(stage).toBeDefined()
      if (!stage) throw new Error('Live2D stage window did not open')
      const stageRuntimeErrors: string[] = []
      stage.on('pageerror', (error) => stageRuntimeErrors.push(error.stack ?? error.message))
      stage.on('console', (message) => {
        if (message.type() === 'error') stageRuntimeErrors.push(message.text())
      })

      await stage.waitForSelector('canvas', { timeout: 30_000 })
      await expect(stage.locator('.stage-status--error')).toHaveCount(0)
      await expect
        .poll(async () => stage.locator('main').getAttribute('aria-busy'), { timeout: 30_000 })
        .toBe('false')
      await expect(stage.locator('main')).not.toContainText('她暂时没能出现')
      const firstAnimationFrame = await stage.screenshot()
      await stage.waitForTimeout(750)
      const secondAnimationFrame = await stage.screenshot()
      expect(secondAnimationFrame.equals(firstAnimationFrame)).toBe(false)

      const stageGlobals = await stage.evaluate(() => ({
        hasStageApi: typeof window.live2dStage !== 'undefined',
        hasCompanion: 'companion' in window,
        hasCanvas: document.querySelector('canvas') !== null,
        dragRegion: getComputedStyle(document.querySelector('main')!).getPropertyValue(
          '-webkit-app-region'
        )
      }))
      expect(stageGlobals).toEqual({
        hasStageApi: true,
        hasCompanion: false,
        hasCanvas: true,
        dragRegion: 'drag'
      })

      const centeredPlacement = await app.evaluate(({ BrowserWindow, screen }) => {
        const stageWindow = BrowserWindow.getAllWindows().find((window) =>
          window.webContents.getURL().includes('/live2d.html')
        )
        if (!stageWindow) throw new Error('Live2D BrowserWindow did not open')
        const currentDisplay = screen.getDisplayMatching(stageWindow.getBounds())
        stageWindow.setPosition(currentDisplay.workArea.x + 10, currentDisplay.workArea.y + 10)
        const bounds = stageWindow.getBounds()
        return {
          x: Math.round(
            currentDisplay.workArea.x + (currentDisplay.workArea.width - bounds.width) / 2
          ),
          y: Math.round(
            currentDisplay.workArea.y + (currentDisplay.workArea.height - bounds.height) / 2
          )
        }
      })
      const placementReset = await chat.evaluate(() =>
        window.companion.live2d.resetWindowPlacement()
      )
      expect(placementReset.ok).toBe(true)
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) => {
            const stageWindow = BrowserWindow.getAllWindows().find((window) =>
              window.webContents.getURL().includes('/live2d.html')
            )
            if (!stageWindow) return null
            const bounds = stageWindow.getBounds()
            return { x: bounds.x, y: bounds.y }
          })
        )
        .toEqual(centeredPlacement)

      await stage.evaluate(() => {
        const host = window as typeof window & {
          __nacimeZoomCommands?: number[]
          __nacimeOffsetCommands?: Array<{ x: number; y: number }>
          __nacimeEmotionCommands?: string[]
        }
        host.__nacimeZoomCommands = []
        host.__nacimeOffsetCommands = []
        host.__nacimeEmotionCommands = []
        window.live2dStage.onCommand((command) => {
          if (command.type === 'set-zoom') host.__nacimeZoomCommands?.push(command.zoom)
          if (command.type === 'set-offset') {
            host.__nacimeOffsetCommands?.push({ x: command.offsetX, y: command.offsetY })
          }
          if (command.type === 'set-emotion') host.__nacimeEmotionCommands?.push(command.emotion)
        })
      })
      const updateFraming = async (framing: {
        zoom?: number
        offsetX?: number
        offsetY?: number
      }): Promise<{ ok: boolean }> =>
        chat.evaluate(async (value): Promise<{ ok: boolean }> => {
          const current = await window.companion.config.get()
          if (!current.ok) return current
          return window.companion.config.update({
            expectedSchemaVersion: current.data.schemaVersion,
            domains: { ui: { live2d: { ...current.data.ui.live2d, ...value } } }
          })
        }, framing)
      const updateZoom = async (zoom: number): Promise<{ ok: boolean }> => updateFraming({ zoom })
      const lastOffsetCommand = (): Promise<{ x: number; y: number } | null> =>
        stage.evaluate(() => {
          const host = window as typeof window & {
            __nacimeOffsetCommands?: Array<{ x: number; y: number }>
          }
          return host.__nacimeOffsetCommands?.at(-1) ?? null
        })
      const captureRenderedBounds = async (): Promise<RenderedBounds | null> =>
        app.evaluate(async ({ BrowserWindow }): Promise<RenderedBounds | null> => {
          const stageWindow = BrowserWindow.getAllWindows().find((window) =>
            window.webContents.getURL().includes('/live2d.html')
          )
          if (!stageWindow) throw new Error('Live2D BrowserWindow did not open')
          const image = await stageWindow.webContents.capturePage()
          const { width, height } = image.getSize()
          const bitmap = image.toBitmap()
          let left = width
          let top = height
          let right = -1
          let bottom = -1
          let pixels = 0
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              const offset = (y * width + x) * 4
              if (bitmap[offset]! <= 4 && bitmap[offset + 1]! <= 4 && bitmap[offset + 2]! <= 4)
                continue
              left = Math.min(left, x)
              top = Math.min(top, y)
              right = Math.max(right, x)
              bottom = Math.max(bottom, y)
              pixels++
            }
          }
          if (right < left || bottom < top) return null
          return {
            width: right - left + 1,
            height: bottom - top + 1,
            top,
            bottom,
            pixels,
            canvasHeight: height
          }
        })

      expect((await updateZoom(0.5)).ok).toBe(true)
      await expect
        .poll(() =>
          stage.evaluate(() => {
            const host = window as typeof window & { __nacimeZoomCommands?: number[] }
            return host.__nacimeZoomCommands?.at(-1) ?? 0
          })
        )
        .toBe(0.5)
      await stage.waitForTimeout(200)
      const smallModelBounds = await captureRenderedBounds()

      expect((await updateZoom(1.5)).ok).toBe(true)
      await expect
        .poll(() =>
          stage.evaluate(() => {
            const host = window as typeof window & { __nacimeZoomCommands?: number[] }
            return host.__nacimeZoomCommands?.at(-1) ?? 0
          })
        )
        .toBe(1.5)
      await stage.waitForTimeout(200)
      const largeModelBounds = await captureRenderedBounds()
      expect(smallModelBounds).not.toBeNull()
      expect(largeModelBounds).not.toBeNull()
      // 两个官方模型的透明画布边距不同：放大后 Mao 会裁掉宽袖，Hiyori 则扩大外接框，
      // 因此不假定外接框变化方向，只要求真实像素覆盖发生足够大的可见变化。
      expect(Math.abs(largeModelBounds!.width - smallModelBounds!.width)).toBeGreaterThan(40)
      expect(
        Math.max(largeModelBounds!.pixels, smallModelBounds!.pixels) /
          Math.min(largeModelBounds!.pixels, smallModelBounds!.pixels)
      ).toBeGreaterThan(1.2)
      await expect
        .poll(async () => {
          const state = await chat.evaluate(() => window.companion.live2d.getState())
          return state.ok ? state.data.window.zoom : 0
        })
        .toBe(1.5)

      // 取景偏移：缩到约一屏高后模型只占下半屏，抬到中线（offsetY=50，即「全身」预设）
      // 必须把人物顶部推到画面上部——这是「看上半身 vs 看全身」的可测量差别。
      expect((await updateFraming({ zoom: 0.5, offsetX: 0, offsetY: 0 })).ok).toBe(true)
      await expect.poll(lastOffsetCommand).toEqual({ x: 0, y: 0 })
      await stage.waitForTimeout(200)
      const bottomAnchored = await captureRenderedBounds()

      expect((await updateFraming({ zoom: 0.5, offsetX: 0, offsetY: 50 })).ok).toBe(true)
      await expect.poll(lastOffsetCommand).toEqual({ x: 0, y: 50 })
      await stage.waitForTimeout(200)
      const raisedFraming = await captureRenderedBounds()

      expect(bottomAnchored).not.toBeNull()
      expect(raisedFraming).not.toBeNull()
      expect(bottomAnchored!.top).toBeGreaterThan(bottomAnchored!.canvasHeight * 0.25)
      expect(raisedFraming!.top).toBeLessThan(
        bottomAnchored!.top - bottomAnchored!.canvasHeight * 0.2
      )
      // 越界值由 main 钳制，stage 永远只收到合同内偏移。
      expect((await updateFraming({ offsetX: 0, offsetY: 100 })).ok).toBe(true)
      await expect.poll(lastOffsetCommand).toEqual({ x: 0, y: 100 })
      expect((await updateFraming({ offsetX: 0, offsetY: 101 })).ok).toBe(false)
      await expect
        .poll(async () => {
          const state = await chat.evaluate(() => window.companion.live2d.getState())
          return state.ok ? state.data.window.offsetY : -1
        })
        .toBe(100)

      // 实时预览：拖动时 stage 立刻跟着变，但 config 与公开投影仍是已保存值；
      // 结束预览后 stage 归位，不会把没保存的构图留在桌面上。
      const savedFraming = await chat.evaluate(async () => {
        const current = await window.companion.config.get()
        if (!current.ok) throw new Error('config unavailable')
        return { zoom: current.data.ui.live2d.zoom, offsetY: current.data.ui.live2d.offsetY }
      })
      const previewed = await chat.evaluate(() =>
        window.companion.live2d.previewFraming({
          framing: { zoom: 2.25, offsetX: 30, offsetY: -40 }
        })
      )
      expect(previewed.ok).toBe(true)
      await expect.poll(lastOffsetCommand).toEqual({ x: 30, y: -40 })
      const duringPreview = await chat.evaluate(async () => {
        const current = await window.companion.config.get()
        const state = await window.companion.live2d.getState()
        if (!current.ok || !state.ok) throw new Error('preview readback failed')
        return {
          configZoom: current.data.ui.live2d.zoom,
          configOffsetY: current.data.ui.live2d.offsetY,
          projectedZoom: state.data.window.zoom
        }
      })
      expect(duringPreview).toEqual({
        configZoom: savedFraming.zoom,
        configOffsetY: savedFraming.offsetY,
        projectedZoom: savedFraming.zoom
      })

      const previewEnded = await chat.evaluate(() =>
        window.companion.live2d.previewFraming({ framing: null })
      )
      expect(previewEnded.ok).toBe(true)
      await expect.poll(lastOffsetCommand).toEqual({ x: 0, y: savedFraming.offsetY })

      // 完成定义第 3 条的端到端证据：聊天说完一轮 → main 分类 → stage 收到 set-emotion。
      // 这一环此前完全缺失（stage 侧全实现，但 main 从未发过这条命令），单测覆盖不了跨进程。
      // Electron E2E 窗口对用户可见；若测试期间设置被打开，先收起这个域外模态，且把
      // 输入/发送选择器限定在 Composer，避免宽泛 textarea 误命中语音试听框。
      const settingsBackdrop = chat.locator('.settings-backdrop')
      if (await settingsBackdrop.isVisible()) {
        await chat.getByRole('button', { name: '关闭设置' }).click()
        const discard = chat.getByRole('button', { name: '放弃修改' })
        if (await discard.isVisible()) await discard.click()
        await expect(settingsBackdrop).toHaveCount(0)
      }
      const composer = chat.locator('.composer')
      await composer.getByRole('textbox', { name: '输入给 Nacime 的消息' }).fill('今天顺利吗')
      await composer.getByRole('button', { name: '发送', exact: true }).click()
      await expect
        .poll(
          () =>
            stage.evaluate(() => {
              const host = window as typeof window & { __nacimeEmotionCommands?: string[] }
              return host.__nacimeEmotionCommands?.at(-1) ?? null
            }),
          { timeout: 30_000 }
        )
        // faux 回复固定为「你好！我是 Nacime，很高兴认识你。」——「高兴」是 happy 信号。
        .toBe('happy')

      await expect
        .poll(async () => {
          const result = await chat.evaluate(() => window.companion.debug.getSnapshot())
          return result.ok ? (result.data.metrics['live2d.renderMemoryMb'] ?? 0) : 0
        })
        .toBeGreaterThan(0)
      // 通过 main 的既有 metadata-only stage report 取证；不向 chat renderer 或 stage preload
      // 新增调试接口，也不会暴露模型路径/对话内容。
      await expect
        .poll(
          () => {
            const fps = [...mainOutput.matchAll(/status=ready[^\r\n]*\bfps=(\d+)/g)]
              .map((match) => Number(match[1]))
              .filter(Number.isFinite)
            return fps.at(-1) ?? 0
          },
          { timeout: 15_000 }
        )
        .toBeGreaterThanOrEqual(MIN_FPS)
      const performanceSnapshot = await chat.evaluate(() => window.companion.debug.getSnapshot())
      if (!performanceSnapshot.ok) throw new Error('Live2D performance metrics were unavailable')
      const metrics = performanceSnapshot.data.metrics
      expect(metrics['live2d.fps'] ?? 0).toBeGreaterThanOrEqual(MIN_FPS)
      expect(metrics['live2d.fps'] ?? Infinity).toBeLessThanOrEqual(75)
      // 内存与首帧对显卡不敏感（CI 上实测也在预算内），保持产品口径不放宽。
      expect(metrics['live2d.renderMemoryMb'] ?? Infinity).toBeLessThanOrEqual(150)
      expect(metrics['live2d.idleCpuPercent'] ?? Infinity).toBeLessThanOrEqual(MAX_IDLE_CPU)
      expect(metrics['live2d.firstFrameMs.p95'] ?? Infinity).toBeLessThanOrEqual(3_000)
      expect(stageRuntimeErrors).toEqual([])
    } finally {
      await shutdownApp(app)
      cleanupTmpDir(tmpDir)
    }
  })
}
