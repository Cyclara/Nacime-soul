// src/main/ipc/handlers/app.ts
// App IPC handlers：get-info/open-user-data
// 依据：S-003 §3.2

import { app, shell } from 'electron'
import type { Logger } from '@shared/observability/types'
import type { AppInfo } from '@shared/ipc/contracts'
import { registerValidatedHandler } from '../register'

/** App handler 依赖 */
export interface AppHandlerDeps {
  logger: Logger
}

/**
 * 注册所有 app IPC handler。
 * 在 main/index.ts 中调用，需在 configureIpcGuard 之后。
 */
export function registerAppHandlers(deps: AppHandlerDeps): void {
  const { logger } = deps

  // === companion:app:get-info ===
  registerValidatedHandler('companion:app:get-info', async (): Promise<AppInfo> => {
    return {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch
    }
  })

  // === companion:app:open-user-data ===
  registerValidatedHandler('companion:app:open-user-data', async () => {
    // 在文件管理器中打开 userData 目录
    const userDataPath = app.getPath('userData')
    const openError = await shell.openPath(userDataPath)
    if (openError) {
      logger.error('failed to open user data folder', {
        scope: 'app',
        detail: openError
      })
    }
  })

  logger.debug('app handlers registered', { scope: 'ipc' })
}
