// src/main/ipc/handlers/live2d.ts
// P3A-23：chat renderer Live2D 管理面。
//
// handler 只接受 modelId/visible/无载荷；文件选择器由 main 弹出。所有响应都是安全 DTO，
// 不暴露绝对路径；实际模型 load/swap 由 stage manager 与 P3A-15 controller 继续承接。

import { BrowserWindow, dialog } from 'electron'
import type { Logger } from '@shared/observability/types'
import { AppError } from '@shared/errors'
import type { Live2dModelService } from '../../live2d/model-service'
import type { Live2dModelImporter } from '../../live2d/model-import'
import type { Live2dWindowManager } from '../../windows/live2d-window-manager'
import type { Live2dPublicSnapshot } from '@shared/live2d/public-types'
import { registerValidatedHandler } from '../register'

export interface Live2dHandlerDeps {
  readonly logger: Logger
  readonly getMainWindow: () => BrowserWindow | null
  readonly service: Live2dModelService
  readonly importer: Live2dModelImporter
  readonly manager: Live2dWindowManager
  readonly getSnapshot: () => Live2dPublicSnapshot
  readonly getAlwaysOnTop?: () => boolean
  readonly setEnabled?: (enabled: boolean) => Promise<boolean> | boolean
  readonly setSelectedModel?: (modelId: string) => Promise<boolean> | boolean
  readonly onStateChange?: () => void
  readonly setZoom?: (zoom: number) => Promise<boolean> | boolean
}

function chooseZip(window: BrowserWindow | null): string | null {
  const owner = window ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (owner === undefined) return null
  const result = dialog.showOpenDialogSync(owner, {
    title: '导入 Live2D 模型',
    properties: ['openFile'],
    filters: [{ name: 'Live2D 模型压缩包', extensions: ['zip'] }]
  })
  return result?.[0] ?? null
}

export function registerLive2dHandlers(deps: Live2dHandlerDeps): void {
  registerValidatedHandler('companion:live2d:get-state', async () => deps.getSnapshot())

  registerValidatedHandler('companion:live2d:choose-import-source', async () => {
    const zipPath = chooseZip(deps.getMainWindow())
    if (zipPath === null) {
      return { ok: false, modelId: null, displayName: null, warnings: [], error: null }
    }
    const result = await deps.importer.importZip(zipPath)
    return {
      ok: result.ok,
      modelId: result.modelId,
      displayName: result.manifest?.displayName ?? null,
      warnings: result.validation.warnings,
      error: result.error
    }
  })

  registerValidatedHandler('companion:live2d:select-model', async (_ctx, input) => {
    if (deps.service.getRegistered(input.modelId) === null) {
      throw new AppError({
        code: 'L2D_MODEL_LOAD',
        userMessage: '找不到这个模型，请重新导入或选择其他模型',
        severity: 'error',
        retryable: true
      })
    }
    const selected =
      deps.setSelectedModel === undefined
        ? deps.service.select(input.modelId)
        : await deps.setSelectedModel(input.modelId)
    if (!selected) {
      throw new AppError({
        code: 'L2D_MODEL_LOAD',
        userMessage: '模型切换失败，当前模型保持不变',
        severity: 'error',
        retryable: true
      })
    }
    deps.onStateChange?.()
    if (!deps.manager.requestModelLoad(input.modelId)) {
      // 选中模型本身已落盘；没有 stage 时不报错，下一次显示窗口会按 selected model 加载。
      const snapshot = deps.manager.getSnapshot()
      if (snapshot.webContentsId !== null) {
        throw new AppError({
          code: 'L2D_MODEL_LOAD',
          userMessage: '模型窗口暂时无法加载，请重试',
          severity: 'error',
          retryable: true
        })
      }
    }
  })

  registerValidatedHandler('companion:live2d:set-visible', async (_ctx, input) => {
    if (deps.setEnabled !== undefined) {
      const saved = await deps.setEnabled(input.visible)
      if (!saved)
        throw new AppError({
          code: 'L2D_MODEL_LOAD',
          userMessage: '角色窗口设置没有保存',
          severity: 'error',
          retryable: true
        })
    }
    if (input.visible) deps.manager.show({ alwaysOnTop: deps.getAlwaysOnTop?.() ?? true })
    else deps.manager.destroy()
    deps.onStateChange?.()
  })

  registerValidatedHandler('companion:live2d:reset-window-placement', async () => {
    const snapshot = deps.manager.getSnapshot()
    if (snapshot.webContentsId === null) return
    if (!deps.manager.resetWindowPlacement()) {
      throw new AppError({
        code: 'L2D_MODEL_LOAD',
        userMessage: '角色窗口位置暂时无法重置，请稍后再试',
        severity: 'warn',
        retryable: true
      })
    }
    deps.logger.debug('Live2D placement reset completed', { scope: 'live2d' })
  })

  registerValidatedHandler('companion:live2d:preview-framing', async (_ctx, input) => {
    // 预览只驱动 stage 视觉：不写 config、不 bump 公开快照，因此不存在「预览也算保存」。
    deps.manager.previewFraming(input.framing)
  })

  registerValidatedHandler('companion:live2d:retry-load', async () => {
    const current = deps.service.getLoadPlan().attempts[0]
    if (current === undefined) return
    deps.manager.requestModelLoad(current.modelId)
  })
}
