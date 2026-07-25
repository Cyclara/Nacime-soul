// src/main/ipc/handlers/debug.ts
// Debug IPC handlers：get-snapshot/open-log-folder
// 依据：S-003 §3.2、F5-011 §3（DebugSnapshot）、Q-003（实现归属）
// 注意：这两个通道在 Phase 1 仅提供基础实现，完整调试面板在 Phase 2+ 扩展

import { app, shell } from 'electron'
import type { Logger } from '@shared/observability/types'
import type { DebugSnapshot } from '@shared/observability/types'
import type { ErrorBuffer } from '../../observability/error-buffer'
import { registerValidatedHandler } from '../register'

/** Debug handler 依赖 */
export interface DebugHandlerDeps {
  logger: Logger
  errorBuffer: ErrorBuffer
  /** 应用启动时间（epoch ms） */
  startTime: number
  /** 日志文件路径 */
  logFilePath: string
}

/**
 * 注册所有 debug IPC handler。
 * 在 main/index.ts 中调用，需在 configureIpcGuard 之后。
 * 依据 Q-003：两个 debug 通道的 handler 归属。
 */
export function registerDebugHandlers(deps: DebugHandlerDeps): void {
  const { logger, errorBuffer, startTime, logFilePath } = deps

  // === companion:debug:get-snapshot ===
  registerValidatedHandler('companion:debug:get-snapshot', async (): Promise<DebugSnapshot> => {
    const uptimeSec = Math.floor((Date.now() - startTime) / 1000)
    const recentErrors = errorBuffer.snapshot()

    return {
      appVersion: app.getVersion(),
      uptimeSec,
      metrics: {}, // Phase 2+ 接入 MetricsRegistry
      recentTraces: [], // Phase 2+ 接入 TurnTracer
      recentErrors,
      logFilePath,
      circuit: null, // Phase 4 断路器状态
      offline: null // Phase 2+ 离线状态机
    }
  })

  // === companion:debug:open-log-folder ===
  registerValidatedHandler('companion:debug:open-log-folder', async () => {
    // 日志文件路径在 userData/logs/ 下
    const logDir = app.getPath('logs')
    const openError = await shell.openPath(logDir)
    if (openError) {
      logger.error('failed to open log folder', {
        scope: 'debug',
        detail: openError
      })
    }
  })

  logger.debug('debug handlers registered', { scope: 'ipc' })
}
