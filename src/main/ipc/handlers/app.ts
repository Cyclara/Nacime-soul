// src/main/ipc/handlers/app.ts
// App IPC handlers：get-info/open-user-data + M-50 更新三通道
// 依据：S-003 §3.2、台账 §4.3（6 处同步）

import { app, shell } from 'electron'
import type { Logger } from '@shared/observability/types'
import type { AppInfo } from '@shared/ipc/contracts'
import type { UpdateStatus } from '@shared/update/types'
import { registerValidatedHandler } from '../register'

/** App handler 依赖 */
export interface AppHandlerDeps {
  logger: Logger
  /** M-50：Updater 的最小面（主进程 updater.ts 创建；测试可注入 fake） */
  updater: {
    checkNow(userInitiated: boolean): Promise<void>
    getStatus(): UpdateStatus
    install(): void
  }
}

/**
 * 注册所有 app IPC handler。
 * 在 main/index.ts 中调用，需在 configureIpcGuard 之后。
 */
export function registerAppHandlers(deps: AppHandlerDeps): void {
  const { logger, updater } = deps

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

  // === companion:app:check-for-updates（M-50：设置页手动触发）===
  registerValidatedHandler('companion:app:check-for-updates', async () => {
    await updater.checkNow(true)
  })

  // === companion:app:get-update-status（M-50：renderer 启动补水）===
  registerValidatedHandler('companion:app:get-update-status', async (): Promise<UpdateStatus> => {
    return updater.getStatus()
  })

  // === companion:app:quit-and-install（M-50：toast「立即更新」按钮）===
  registerValidatedHandler('companion:app:quit-and-install', async () => {
    updater.install()
  })

  logger.debug('app handlers registered', { scope: 'ipc' })
}
