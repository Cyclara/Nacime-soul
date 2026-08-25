// src/main/updater.ts
// M-50: 自动更新检测（electron-updater 封装 + 状态机 + 周期调度）
// 依据：2026-08-24 用户需求「自动检测更新并弹出来」；参考 stablyai/orca 的
// updater 状态机与懒加载姿势（src/main/updater.ts + electron-updater-loader.ts），
// 按本项目体量裁剪为单文件。
//
// 设计要点：
//   1. electron-updater 仅在 enabled（打包且非 dev）时懒加载——
//      dev/E2E 直启时它会因 app.getVersion() 校验直接抛错（orca loader 同款注释）
//   2. 状态机：idle/checking/available/downloading/downloaded/not-available/error，
//      每次变化经 companion:event:update-status 推给 renderer（相同状态去重）
//   3. autoDownload=true + autoInstallOnAppQuit=true：后台静默下载；
//      用户不点「立即更新」也会在下一次正常退出时安装（不打扰原则）
//   4. 后台检查失败只记日志（userInitiated=false 的 error 状态 renderer 不弹窗）；
//      手动触发（设置页「检查更新」）的失败才以 userInitiated=true 反馈给 UI
//   5. 发布源由 electron-builder.yml 固定到 Cyclara/Nacime-soul；feed / 网络故障统一走
//      error 事件，后台检查静默、手动检查才反馈——不罚用户为发布基础设施买单

import type { WebContents } from 'electron'
import type { Logger } from '@shared/observability/types'
import type { UpdateStatus } from '@shared/update/types'
import { sendEvent } from './ipc/register'

/** electron-updater autoUpdater 的最小结构子集。测试注入 fake 用；真实对象由懒加载提供。 */
export interface AutoUpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  allowDowngrade: boolean
  on(event: 'checking-for-update', listener: () => void): void
  on(event: 'update-available', listener: (info: { version: string }) => void): void
  on(event: 'update-not-available', listener: (info: { version: string }) => void): void
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): void
  on(event: 'update-downloaded', listener: (info: { version: string }) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  checkForUpdates(): Promise<unknown>
  quitAndInstall(): void
}

export interface UpdaterDeps {
  logger: Logger
  /** 闭包读取最新窗口（CrashGuard 重建后仍能推送） */
  getWebContents: () => WebContents | null
  /** 是否启用真实检查：app.isPackaged && !is.dev。false 时手动检查得到明确提示 */
  enabled: boolean
  /** 直接注入 autoUpdater（测试用 fake）；缺省时 start() 内懒加载 electron-updater */
  autoUpdater?: AutoUpdaterLike
  /** 启动后首次检查延迟（默认 10s，避开启动高峰） */
  initialDelayMs?: number
  /** 周期间隔（默认 4h） */
  intervalMs?: number
}

export interface Updater {
  /** 启动周期调度。enabled=false 或已启动时安全重复调用（幂等） */
  start(): void
  /** 触发一次检查。userInitiated=true 时结果（含失败/已最新）会推给 UI */
  checkNow(userInitiated: boolean): Promise<void>
  getStatus(): UpdateStatus
  /** 仅在 downloaded 状态有效；其余状态 no-op 并记 warn */
  install(): void
  /** 清理定时器（before-quit / 测试） */
  dispose(): void
}

const DEFAULT_INITIAL_DELAY_MS = 10_000
const DEFAULT_INTERVAL_MS = 4 * 60 * 60 * 1000

function statusesEqual(a: UpdateStatus, b: UpdateStatus): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function createUpdater(deps: UpdaterDeps): Updater {
  const {
    logger,
    getWebContents,
    enabled,
    initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
    intervalMs = DEFAULT_INTERVAL_MS
  } = deps

  let status: UpdateStatus = { state: 'idle' }
  let autoUpdater: AutoUpdaterLike | null = deps.autoUpdater ?? null
  let loadPromise: Promise<AutoUpdaterLike> | null = null
  let started = false
  let initialTimer: NodeJS.Timeout | null = null
  let intervalTimer: NodeJS.Timeout | null = null
  /** 检查/下载互斥：新一轮检查不得打断进行中的下载 */
  let inFlight = false
  /** 最近一次检查的触发方式，决定 not-available/error 是否推 UI */
  let lastCheckUserInitiated = false
  function setStatus(next: UpdateStatus): void {
    if (statusesEqual(status, next)) return
    status = next
    const wc = getWebContents()
    if (wc) sendEvent(wc, 'companion:event:update-status', next)
  }

  /** error 状态的用户文案统一收敛，细节只进日志（不泄露 feed URL/堆栈给 UI） */
  function toErrorStatus(cause: unknown, userInitiated: boolean): UpdateStatus {
    logger.error('update check/download failed', {
      scope: 'updater',
      detail: cause instanceof Error ? cause.message : String(cause)
    })
    return {
      state: 'error',
      message: userInitiated ? '检查更新失败，请确认网络连接后重试' : '后台更新检查失败',
      userInitiated
    }
  }

  function attachListeners(updater: AutoUpdaterLike): void {
    updater.on('checking-for-update', () => {
      setStatus({ state: 'checking', userInitiated: lastCheckUserInitiated })
    })
    updater.on('update-available', (info) => {
      setStatus({ state: 'available', version: info.version })
    })
    updater.on('update-not-available', () => {
      inFlight = false
      setStatus({ state: 'not-available', userInitiated: lastCheckUserInitiated })
    })
    updater.on('download-progress', (progress) => {
      const version =
        status.state === 'available' || status.state === 'downloading' ? status.version : ''
      setStatus({
        state: 'downloading',
        version,
        percent: Math.max(0, Math.min(100, Math.round(progress.percent)))
      })
    })
    updater.on('update-downloaded', (info) => {
      inFlight = false
      setStatus({ state: 'downloaded', version: info.version })
      logger.info('update downloaded, ready to install on quit', {
        scope: 'updater',
        tags: { version: info.version }
      })
    })
    updater.on('error', (error) => {
      inFlight = false
      setStatus(toErrorStatus(error, lastCheckUserInitiated))
    })
  }

  function configureAutoUpdater(updater: AutoUpdaterLike): void {
    updater.autoDownload = true
    updater.autoInstallOnAppQuit = true
    updater.allowPrerelease = false
    updater.allowDowngrade = false
    attachListeners(updater)
  }

  async function ensureAutoUpdater(): Promise<AutoUpdaterLike> {
    if (autoUpdater) return autoUpdater
    if (!loadPromise) {
      loadPromise = import('electron-updater').then((mod) => {
        // electron-updater 的 autoUpdater 是 module.exports 上的惰性 getter
        // （Object.defineProperty），cjs-module-lexer 不会把它提升为 ESM 命名导出，
        // 直接取 mod.autoUpdater 会得到 undefined——必须经 default 取用（Node 26 实测）。
        const viaDefault = (mod.default as { autoUpdater?: unknown } | undefined)?.autoUpdater
        const viaNamed = (mod as unknown as { autoUpdater?: unknown }).autoUpdater
        const resolved = viaDefault ?? viaNamed
        if (!resolved) {
          throw new Error('electron-updater autoUpdater unavailable')
        }
        autoUpdater = resolved as AutoUpdaterLike
        configureAutoUpdater(autoUpdater)
        return autoUpdater
      })
      // 加载失败（如打包丢失依赖）只允许重试一次之外不缓存 reject：
      // 清掉 loadPromise 让下次检查重新尝试
      loadPromise.catch(() => {
        loadPromise = null
      })
    }
    return loadPromise
  }

  // 注入路径（测试/未来自定义源）：立即配置 + 挂监听，与懒加载路径行为一致——
  // 漏掉这一步会出现"checkForUpdates 被调但事件永远驱动不了状态机"的假死。
  if (autoUpdater) {
    configureAutoUpdater(autoUpdater)
  }

  async function runCheck(userInitiated: boolean): Promise<void> {
    if (!enabled) {
      if (userInitiated) {
        setStatus({
          state: 'error',
          message: '当前环境不支持自动更新（开发环境或未打包）',
          userInitiated: true
        })
      }
      return
    }
    if (inFlight) {
      logger.debug('update check skipped: another check/download in flight', { scope: 'updater' })
      return
    }
    inFlight = true
    lastCheckUserInitiated = userInitiated
    setStatus({ state: 'checking', userInitiated })
    try {
      const updater = await ensureAutoUpdater()
      await updater.checkForUpdates()
      // 后续状态由事件推进；checking 后没有任何事件属于异常沉默，由下一轮周期检查覆盖
      if (status.state === 'checking') {
        inFlight = false
        setStatus({ state: 'not-available', userInitiated })
      }
    } catch (cause) {
      inFlight = false
      setStatus(toErrorStatus(cause, userInitiated))
    }
  }

  return {
    start(): void {
      if (started) return
      started = true
      if (!enabled) {
        logger.info('auto updater disabled (dev/unpackaged); scheduling skipped', {
          scope: 'updater'
        })
        return
      }
      initialTimer = setTimeout(() => {
        void runCheck(false)
        intervalTimer = setInterval(() => {
          void runCheck(false)
        }, intervalMs)
        // 周期定时器不应阻止进程退出语义（quit 时 dispose 也会清，双保险）
        intervalTimer.unref?.()
      }, initialDelayMs)
      initialTimer.unref?.()
      logger.info('auto updater scheduled', {
        scope: 'updater',
        tags: { initialDelayMs: String(initialDelayMs), intervalMs: String(intervalMs) }
      })
    },

    checkNow: runCheck,

    getStatus(): UpdateStatus {
      return status
    },

    install(): void {
      if (status.state !== 'downloaded' || !autoUpdater) {
        logger.warn('quit-and-install ignored: no downloaded update', {
          scope: 'updater',
          tags: { state: status.state }
        })
        return
      }
      logger.info('quit and install requested by user', {
        scope: 'updater',
        tags: { version: status.version }
      })
      autoUpdater.quitAndInstall()
    },

    dispose(): void {
      if (initialTimer) clearTimeout(initialTimer)
      if (intervalTimer) clearInterval(intervalTimer)
      initialTimer = null
      intervalTimer = null
      started = false
    }
  }
}
