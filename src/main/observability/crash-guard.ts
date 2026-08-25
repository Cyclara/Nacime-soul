// src/main/observability/crash-guard.ts
// CrashGuard：main/renderer 崩溃捕获 + 本地 crash context + renderer 自动重建熔断
// 依据：F5-011 §3（崩溃处理决策）、S-001 P1-14
//
// 设计要点：
//   1. main uncaughtException → logger.fatal → 写 CrashContext → 提示重启/退出
//   2. main unhandledRejection → 按 error 级别记录，不崩溃
//   3. renderer render-process-gone → 记录 → 自动重建窗口；10 分钟内 ≥2 次 → 停止重建
//   4. crashReporter 仅本地 minidump（uploadToServer: false）
//   5. 不自动上传任何数据

import { app, BrowserWindow, crashReporter } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Logger } from '@shared/observability/types'
import type { CrashContext } from '@shared/observability/types'
import type { ErrorBuffer } from './error-buffer'
import type { PublicAppError } from '@shared/errors'
import { scrub } from './scrub'

/** 熔断阈值：10 分钟内最多允许的 renderer 崩溃次数 */
const RENDERER_CRASH_WINDOW_MS = 10 * 60 * 1000
const RENDERER_CRASH_MAX_COUNT = 2

/** CrashGuard 配置 */
export interface CrashGuardConfig {
  logger: Logger
  errorBuffer: ErrorBuffer
  /** app.getPath('userData') 的路径 */
  userDataPath: string
  /** 应用版本号 */
  appVersion: string
  /** 应用启动时间（epoch ms） */
  startTime: number
  /** 创建新窗口的函数（renderer 崩溃恢复时调用） */
  createWindow: () => BrowserWindow
  /** 显示崩溃对话框的回调（main 崩溃时调用） */
  showCrashDialog?: (reason: string) => void
  /**
   * M-07：向 renderer 推送 app-error 事件的可选回调。
   * 接线后 main 的未处理 rejection 等可让 UI 显示错误横幅（此前 app-error 通道从未发射）。
   */
  onAppError?: (error: PublicAppError) => void
}

/** CrashGuard 实例 */
export interface CrashGuard {
  /** 安装所有崩溃处理器 */
  install(): void
  /** 卸载崩溃处理器（测试用） */
  uninstall(): void
}

class CrashGuardImpl implements CrashGuard {
  private readonly config: CrashGuardConfig
  private readonly rendererCrashes: number[] = []
  private installed = false
  /** M-37：main 崩溃处理进行中标记（再入保护；uninstall 时复位供测试） */
  private crashing = false

  constructor(config: CrashGuardConfig) {
    this.config = config
  }

  install(): void {
    if (this.installed) return
    this.installed = true

    // 启动 crashReporter（仅本地 minidump，不上传）
    crashReporter.start({
      uploadToServer: false,
      productName: 'AI-Companion'
    })

    // main 未捕获异常
    process.on('uncaughtException', this.onMainCrash)

    // main 未处理的 Promise 拒绝
    process.on('unhandledRejection', this.onUnhandledRejection)

    // renderer 崩溃
    app.on('render-process-gone', this.onRendererGone)
  }

  uninstall(): void {
    if (!this.installed) return
    this.installed = false
    this.crashing = false

    process.removeListener('uncaughtException', this.onMainCrash)
    process.removeListener('unhandledRejection', this.onUnhandledRejection)
    app.removeListener('render-process-gone', this.onRendererGone)
  }

  // === 私有方法 ===

  private onMainCrash = (error: Error): void => {
    const { logger, errorBuffer, userDataPath, appVersion, startTime, showCrashDialog } =
      this.config

    // M-37：崩溃处理再入保护——fatal 路径上的二次异常（如日志写失败触发的连锁
    // uncaughtException）不再重复弹窗/刷 FATAL。M-35 事故中同一 EPIPE 在 100 秒内
    // 刷了 5 次 FATAL + 重复弹窗，每次循环还重新武装退出定时器，进程始终不死。
    if (this.crashing) return
    this.crashing = true

    const reason = scrub(error.message)
    const uptimeSec = Math.floor((Date.now() - startTime) / 1000)

    // 取最近日志行（从 errorBuffer 中提取）
    const recentErrors = errorBuffer.snapshot()
    const lastLogLines = recentErrors.slice(-50).map((e) => e.msg)

    const crashContext: CrashContext = {
      processType: 'main',
      reason,
      ts: Date.now(),
      appVersion,
      uptimeSec,
      lastLogLines
    }

    // 写 CrashContext 到 data/crash/
    try {
      const crashDir = path.join(userDataPath, 'crash')
      fs.mkdirSync(crashDir, { recursive: true })
      const crashFile = path.join(crashDir, `crash-main-${Date.now()}.json`)
      fs.writeFileSync(crashFile, JSON.stringify(crashContext, null, 2), 'utf8')
    } catch {
      // 写盘失败：已经在崩溃流程中，静默
    }

    // M-37：fatal 日志写不动（如 stdout 断管连锁）不能带走退出路径
    try {
      logger.fatal(`uncaughtException: ${reason}`, {
        scope: 'crash',
        code: 'UNKNOWN',
        metrics: { uptimeSec }
      })
    } catch {
      /* 日志哑火，退出路径继续 */
    }

    // M-37：先排定退出再弹窗——dialog.showErrorBox 是同步模态对话框，阻塞事件循环
    // 期间定时器不触发；旧代码把定时器放在弹窗之后，弹窗一旦被异常打断退出路径就
    // 永远排不上（M-35 事故中用户点完"确定"进程仍活着，靠 taskkill 才清掉）。
    // 现在定时器必定 armed：弹窗返回（或被 try/catch 吞掉）后定时器立即到期执行。
    // app.exit 之后再加 process.exit 硬兜底——will-quit 链路挂起时 2 秒后仍能退。
    setTimeout(() => {
      try {
        app.exit(1)
      } catch {
        /* app.exit 失败也继续走硬兜底 */
      }
      setTimeout(() => process.exit(1), 2000).unref()
    }, 1000)

    // 尝试显示对话框（M-37：弹窗异常不能带走退出路径——定时器已在上面 armed）
    if (showCrashDialog) {
      try {
        showCrashDialog(reason)
      } catch {
        /* 弹窗失败静默，退出定时器照常 */
      }
    }
  }

  private onUnhandledRejection = (reason: unknown): void => {
    const { logger, onAppError } = this.config
    const msg = reason instanceof Error ? reason.message : String(reason)

    logger.error(`unhandledRejection: ${scrub(msg)}`, {
      scope: 'crash',
      code: 'UNKNOWN'
    })
    // M-07：把 main 的内部异常推到 UI（通用文案，不含可能敏感的原始 message）。
    // 不崩溃，仅记录 + 通知。
    onAppError?.({
      code: 'UNKNOWN',
      message: '应用内部发生错误，已尝试继续运行。若反复出现，请反馈。',
      severity: 'error',
      retryable: false
    })
  }

  private onRendererGone = (
    _event: Electron.Event,
    _webContents: Electron.WebContents,
    details: Electron.RenderProcessGoneDetails
  ): void => {
    const { logger, createWindow } = this.config

    const reason = details.reason
    const exitCode = details.exitCode

    logger.error('renderer process gone', {
      scope: 'crash',
      code: 'UNKNOWN',
      tags: { reason, exitCode: String(exitCode) }
    })

    // 熔断检查
    const now = Date.now()
    this.rendererCrashes.push(now)

    // 清理超过窗口期的旧记录
    const windowStart = now - RENDERER_CRASH_WINDOW_MS
    while (this.rendererCrashes.length > 0 && this.rendererCrashes[0] < windowStart) {
      this.rendererCrashes.shift()
    }

    if (this.rendererCrashes.length >= RENDERER_CRASH_MAX_COUNT) {
      logger.error('renderer crash circuit breaker triggered', {
        scope: 'crash',
        code: 'UNKNOWN',
        metrics: {
          crashCount: this.rendererCrashes.length,
          windowMinutes: RENDERER_CRASH_WINDOW_MS / 60000
        }
      })
      // 不重建窗口——熔断
      return
    }

    // 自动重建窗口
    try {
      createWindow()
      logger.info('renderer window recreated', {
        scope: 'crash',
        metrics: { crashCount: this.rendererCrashes.length }
      })
    } catch (e) {
      logger.error('failed to recreate renderer window', {
        scope: 'crash',
        code: 'UNKNOWN',
        detail: e instanceof Error ? e.message : String(e)
      })
    }
  }
}

/**
 * 创建 CrashGuard 实例。
 * 调用 install() 安装所有崩溃处理器。
 *
 * 使用示例：
 *   const guard = createCrashGuard({ logger, errorBuffer, userDataPath, appVersion, startTime, createWindow })
 *   guard.install()
 */
export function createCrashGuard(config: CrashGuardConfig): CrashGuard {
  return new CrashGuardImpl(config)
}
