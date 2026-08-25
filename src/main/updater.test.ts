// src/main/updater.test.ts
// M-50: Updater 状态机测试（fake autoUpdater + fake WebContents + fake timers）。
// 覆盖：调度门控、状态推进、事件推送去重、in-flight 互斥、install 门控、dispose。

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createUpdater, type AutoUpdaterLike } from './updater'
import type { UpdateStatus } from '@shared/update/types'
import type { Logger } from '@shared/observability/types'

type UpdaterEvent =
  | 'checking-for-update'
  | 'update-available'
  | 'update-not-available'
  | 'download-progress'
  | 'update-downloaded'
  | 'error'

function createFakeAutoUpdater(): AutoUpdaterLike & {
  emit(event: UpdaterEvent, payload?: unknown): void
  checkForUpdates: Mock
  quitAndInstall: Mock
} {
  const listeners = new Map<string, Array<(payload?: unknown) => void>>()
  return {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: true,
    allowDowngrade: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, listener: (payload?: any) => void) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event)!.push(listener)
    },
    emit(event: UpdaterEvent, payload?: unknown) {
      for (const l of listeners.get(event) ?? []) l(payload)
    },
    checkForUpdates: vi.fn(async () => ({})),
    quitAndInstall: vi.fn()
  }
}

function createNoopLogger(): Logger {
  const noop = (): void => {}
  const logger: Logger = {
    fatal: noop,
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    child: () => logger
  }
  return logger
}

function createFakeWebContents(): {
  isDestroyed(): boolean
  send(channel: string, payload: unknown): void
  sent: Array<{ channel: string; payload: UpdateStatus }>
} {
  const sent: Array<{ channel: string; payload: UpdateStatus }> = []
  return {
    sent,
    isDestroyed: () => false,
    send(channel: string, payload: unknown) {
      sent.push({ channel, payload: payload as UpdateStatus })
    }
  }
}

function states(wc: ReturnType<typeof createFakeWebContents>): string[] {
  return wc.sent
    .filter((m) => m.channel === 'companion:event:update-status')
    .map((m) => m.payload.state)
}

describe('M-50 Updater', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('enabled=false 时不调度周期检查，手动检查给出明确提示', async () => {
    const fake = createFakeAutoUpdater()
    const wc = createFakeWebContents()
    const updater = createUpdater({
      logger: createNoopLogger(),
      getWebContents: () => wc as never,
      enabled: false,
      autoUpdater: fake
    })
    updater.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fake.checkForUpdates).not.toHaveBeenCalled()

    await updater.checkNow(true)
    expect(updater.getStatus()).toEqual({
      state: 'error',
      message: '当前环境不支持自动更新（开发环境或未打包）',
      userInitiated: true
    })
    // 后台检查在 disabled 下完全静默
    await updater.checkNow(false)
    expect(updater.getStatus().state).toBe('error') // 保持上一条手动反馈
    expect(fake.checkForUpdates).not.toHaveBeenCalled()
    updater.dispose()
  })

  it('enabled=true 时 start 后按 initialDelay 触发首次检查，并推进 interval', async () => {
    const fake = createFakeAutoUpdater()
    const updater = createUpdater({
      logger: createNoopLogger(),
      getWebContents: () => null,
      enabled: true,
      autoUpdater: fake,
      initialDelayMs: 10_000,
      intervalMs: 60_000
    })
    updater.start()
    expect(fake.checkForUpdates).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(2)
    updater.dispose()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('完整链路：checking → available → downloading → downloaded，逐级推送且去重', async () => {
    const fake = createFakeAutoUpdater()
    const wc = createFakeWebContents()
    fake.checkForUpdates.mockImplementation(async () => {
      fake.emit('checking-for-update')
      fake.emit('update-available', { version: '1.1.0' })
      fake.emit('download-progress', { percent: 20.4 })
      fake.emit('download-progress', { percent: 20.49 }) // 取整后同为 20，应去重
      fake.emit('download-progress', { percent: 80 })
      fake.emit('update-downloaded', { version: '1.1.0' })
      return {}
    })
    const updater = createUpdater({
      logger: createNoopLogger(),
      getWebContents: () => wc as never,
      enabled: true,
      autoUpdater: fake
    })

    await updater.checkNow(false)

    expect(states(wc)).toEqual([
      'checking',
      'available',
      'downloading',
      'downloading',
      'downloaded'
    ])
    expect(updater.getStatus()).toEqual({ state: 'downloaded', version: '1.1.0' })
    const downloading = wc.sent
      .map((m) => m.payload)
      .filter(
        (p): p is Extract<UpdateStatus, { state: 'downloading' }> => p.state === 'downloading'
      )
    expect(downloading.map((p) => p.percent)).toEqual([20, 80])
  })

  it('not-available / error 带 userInitiated 标记；检查抛错收敛为 error 状态', async () => {
    const fake = createFakeAutoUpdater()
    fake.checkForUpdates.mockImplementation(async () => {
      fake.emit('checking-for-update')
      fake.emit('update-not-available', { version: '1.0.0' })
      return {}
    })
    const updater = createUpdater({
      logger: createNoopLogger(),
      getWebContents: () => null,
      enabled: true,
      autoUpdater: fake
    })
    await updater.checkNow(true)
    expect(updater.getStatus()).toEqual({ state: 'not-available', userInitiated: true })

    fake.checkForUpdates.mockRejectedValueOnce(new Error('net::ERR_INTERNET_DISCONNECTED'))
    await updater.checkNow(false)
    const s = updater.getStatus()
    expect(s.state).toBe('error')
    if (s.state === 'error') {
      expect(s.userInitiated).toBe(false)
      expect(s.message).toBe('后台更新检查失败')
    }
  })

  it('in-flight 期间重复检查被跳过（不重复触发 checkForUpdates）', async () => {
    const fake = createFakeAutoUpdater()
    let release!: () => void
    fake.checkForUpdates.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({})
        })
    )
    const updater = createUpdater({
      logger: createNoopLogger(),
      getWebContents: () => null,
      enabled: true,
      autoUpdater: fake
    })
    const first = updater.checkNow(false)
    await updater.checkNow(true)
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1)
    release()
    await first
  })

  it('install 仅在 downloaded 状态调用 quitAndInstall', async () => {
    const fake = createFakeAutoUpdater()
    fake.checkForUpdates.mockImplementation(async () => {
      fake.emit('update-available', { version: '1.1.0' })
      fake.emit('update-downloaded', { version: '1.1.0' })
      return {}
    })
    const updater = createUpdater({
      logger: createNoopLogger(),
      getWebContents: () => null,
      enabled: true,
      autoUpdater: fake
    })
    updater.install()
    expect(fake.quitAndInstall).not.toHaveBeenCalled()

    await updater.checkNow(false)
    updater.install()
    expect(fake.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('start 幂等：重复调用不重复调度', async () => {
    const fake = createFakeAutoUpdater()
    const updater = createUpdater({
      logger: createNoopLogger(),
      getWebContents: () => null,
      enabled: true,
      autoUpdater: fake,
      initialDelayMs: 1_000
    })
    updater.start()
    updater.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1)
    updater.dispose()
  })
})
