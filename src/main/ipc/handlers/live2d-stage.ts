// src/main/ipc/handlers/live2d-stage.ts
// P3A-05：stage-only IPC handlers。register.ts capability guard 先拒绝 chat sender；
// manager 再核对当前 webContents 和 stage instance，防止旧 stage/HMR report 串入。

import type { Logger } from '@shared/observability/types'
import type { Live2dWindowManager } from '../../windows/live2d-window-manager'
import { registerValidatedHandler } from '../register'

export interface Live2dStageHandlerDeps {
  readonly manager: Live2dWindowManager
  readonly logger: Logger
}

export function registerLive2dStageHandlers(deps: Live2dStageHandlerDeps): void {
  const logger = deps.logger.child('live2d-stage-ipc')

  registerValidatedHandler('companion:stage:ready', (ctx, input) => {
    const bootstrap = deps.manager.acceptStageReady(ctx.sender, input)
    logger.debug('Live2D stage became ready for bootstrap', {
      scope: 'live2d',
      tags: { stageInstanceId: bootstrap.stageInstanceId }
    })
    return bootstrap
  })

  registerValidatedHandler('companion:stage:report-state', (ctx, report) => {
    deps.manager.acceptStageReport(ctx.sender, report)
    logger.debug('Live2D stage state received', {
      scope: 'live2d',
      tags: { status: report.status, stageInstanceId: report.stageInstanceId },
      metrics: {
        ...(report.fps === undefined ? {} : { fps: report.fps }),
        ...(report.modelLoadMs === undefined ? {} : { modelLoadMs: report.modelLoadMs })
      }
    })
  })
}
