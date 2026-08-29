// src/main/observability/crash-guard.test.ts
// M-37：crash-guard 致命崩溃后的退出路径——再入保护、先排定退出再弹窗、硬兜底。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import type { Logger } from '@shared/observability/types'
import type { ErrorBuffer } from './error-buffer'

const appExit = vi.fn()

vi.mock('electron', () => ({
  app: {
    exit: (...args: unknown[]) => appExit(...args),
    on: vi.fn(),
    removeListener: vi.fn()
  },
  BrowserWindow: {
    getAllWindows: () => []
  },
  crashReporter: {
    start: vi.fn()
  }
}))

import { app } from 'electron'
import { createCrashGuard, type CrashGuardConfig } from './crash-guard'

function makeLogger(overrides: Partial<Logger> = {}): Logger & { fatals: string[] } {
  const fatals: string[] = []
  const logger: Logger & { fatals: string[] } = {
    fatals,
    fatal(msg: string) {
      fatals.push(msg)
    },
    error() {
      /* noop */
    },
    warn() {
      /* noop */
    },
    info() {
      /* noop */
    },
    debug() {
      /* noop */
    },
    child: () => logger,
    ...overrides
  } as Logger & { fatals: string[] }
  return logger
}

function makeErrorBuffer(): ErrorBuffer {
  return { snapshot: () => [] } as unknown as ErrorBuffer
}

let tmpDir: string

function makeConfig(overrides: Partial<CrashGuardConfig> = {}): CrashGuardConfig {
  return {
    logger: makeLogger(),
    errorBuffer: makeErrorBuffer(),
    userDataPath: tmpDir,
    appVersion: '1.0.0-test',
    startTime: Date.now() - 5000,
    createWindow: () => {
      throw new Error('not used in these tests')
    },
    showCrashDialog: vi.fn(),
    ...overrides
  }
}

function emitCrash(error: Error): void {
  process.emit('uncaughtException', error)
}

describe('M-37 crash-guard 致命崩溃退出路径', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-guard-'))
    appExit.mockClear()
    vi.mocked(app.on).mockClear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('fatal 后：写 CrashContext + 弹窗 + 1 秒后 app.exit(1)', () => {
    const showCrashDialog = vi.fn()
    const guard = createCrashGuard(makeConfig({ showCrashDialog }))
    guard.install()
    try {
      emitCrash(new Error('write EPIPE'))

      expect(showCrashDialog).toHaveBeenCalledTimes(1)
      // CrashContext 落盘
      const crashDir = path.join(tmpDir, 'crash')
      const files = fs.readdirSync(crashDir).filter((f) => f.startsWith('crash-main-'))
      expect(files).toHaveLength(1)

      expect(appExit).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1000)
      expect(appExit).toHaveBeenCalledWith(1)
    } finally {
      guard.uninstall()
    }
  })

  it('再入保护：崩溃处理中的二次 uncaughtException 不再弹窗/刷 FATAL/重新武装定时器', () => {
    const logger = makeLogger()
    const showCrashDialog = vi.fn()
    const guard = createCrashGuard(makeConfig({ logger, showCrashDialog }))
    guard.install()
    try {
      emitCrash(new Error('write EPIPE'))
      emitCrash(new Error('write EPIPE'))
      emitCrash(new Error('write EPIPE'))

      expect(showCrashDialog).toHaveBeenCalledTimes(1)
      expect(logger.fatals).toHaveLength(1)
      // CrashContext 只写一份
      const files = fs
        .readdirSync(path.join(tmpDir, 'crash'))
        .filter((f) => f.startsWith('crash-main-'))
      expect(files).toHaveLength(1)
    } finally {
      guard.uninstall()
    }
  })

  it('弹窗同步抛错：退出路径不受影响（定时器已先行 armed）', () => {
    const showCrashDialog = vi.fn(() => {
      throw new Error('dialog exploded')
    })
    const guard = createCrashGuard(makeConfig({ showCrashDialog }))
    guard.install()
    try {
      expect(() => emitCrash(new Error('boom'))).not.toThrow()
      vi.advanceTimersByTime(1000)
      expect(appExit).toHaveBeenCalledWith(1)
    } finally {
      guard.uninstall()
    }
  })

  it('fatal 日志写不动（logger.fatal 抛错）：退出路径不受影响', () => {
    const logger = makeLogger({
      fatal() {
        throw new Error('log sink broken')
      }
    })
    const guard = createCrashGuard(makeConfig({ logger }))
    guard.install()
    try {
      expect(() => emitCrash(new Error('boom'))).not.toThrow()
      vi.advanceTimersByTime(1000)
      expect(appExit).toHaveBeenCalledWith(1)
    } finally {
      guard.uninstall()
    }
  })

  it('app.exit 失败：2 秒后 process.exit(1) 硬兜底', () => {
    appExit.mockImplementation(() => {
      throw new Error('app.exit hung')
    })
    const processExit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const guard = createCrashGuard(makeConfig())
    guard.install()
    try {
      emitCrash(new Error('boom'))
      vi.advanceTimersByTime(1000)
      expect(appExit).toHaveBeenCalledWith(1)
      expect(processExit).not.toHaveBeenCalled()
      vi.advanceTimersByTime(2000)
      expect(processExit).toHaveBeenCalledWith(1)
    } finally {
      guard.uninstall()
      processExit.mockRestore()
    }
  })

  it('正常退出或非 chat renderer 关闭时不重建窗口', () => {
    const createWindow = vi.fn()
    const guard = createCrashGuard(
      makeConfig({
        createWindow,
        isQuitting: () => true,
        shouldHandleRendererCrash: () => false
      })
    )
    guard.install()
    try {
      const handler = (vi.mocked(app.on).mock.calls as Array<[string, unknown]>).find(
        ([event]) => event === 'render-process-gone'
      )?.[1] as (event: unknown, webContents: unknown, details: unknown) => void
      handler({}, { id: 2 }, { reason: 'crashed', exitCode: 1 })
      expect(createWindow).not.toHaveBeenCalled()
    } finally {
      guard.uninstall()
    }
  })

  it('uninstall 复位再入保护：重装后可再次处理崩溃', () => {
    const showCrashDialog = vi.fn()
    const guard = createCrashGuard(makeConfig({ showCrashDialog }))
    guard.install()
    emitCrash(new Error('first'))
    guard.uninstall()

    const guard2 = createCrashGuard(makeConfig({ showCrashDialog }))
    guard2.install()
    try {
      emitCrash(new Error('second'))
      expect(showCrashDialog).toHaveBeenCalledTimes(2)
    } finally {
      guard2.uninstall()
    }
  })
})
