// src/main/ipc/handlers/live2d.test.ts
// P3A-23：Live2D chat IPC 固定通道、无路径参数、选择模型只传 ID。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { ipcMain } from 'electron'
import type { Logger } from '@shared/observability/types'
import { configureIpcGuard } from '../register'
import { registerLive2dHandlers } from './live2d'
import type { Live2dModelService } from '../../live2d/model-service'
import type { Live2dModelImporter } from '../../live2d/model-import'
import type { Live2dWindowManager } from '../../windows/live2d-window-manager'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => undefined), getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialogSync: vi.fn(() => undefined) }
}))

function logger(): Logger {
  const value: Logger = {
    fatal() { /* noop */ },
    error() { /* noop */ },
    warn() { /* noop */ },
    info() { /* noop */ },
    debug() { /* noop */ },
    child: () => value
  }
  return value
}
function event(): Partial<IpcMainInvokeEvent> {
  return { sender: { id: 1 } as IpcMainInvokeEvent['sender'], senderFrame: { url: 'http://localhost:5173/' } as IpcMainInvokeEvent['senderFrame'] }
}
function handler(channel: string): (event: unknown, payload: unknown) => Promise<unknown> {
  const found = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel)
  if (!found) throw new Error(`missing ${channel}`)
  return found[1] as (event: unknown, payload: unknown) => Promise<unknown>
}

describe('P3A-23 Live2D handlers', () => {
  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockClear()
    configureIpcGuard({ trustedOrigins: new Set(['http://localhost:5173']), trustedWebContentsIds: new Set([1]), senderCapabilities: new Map([[1, 'chat']]) }, logger())
  })

  it('get-state 只返回注入 snapshot，select-model 只向 manager 传受控 URL', async () => {
    const sendStageCommand = vi.fn()
    const service = {
      getRegistered: () => ({ id: 'mao' }), select: () => true, getStageModelUrl: () => 'nacime-live2d://model/mao/Mao.model3.json',
      getLoadPlan: () => ({ attempts: [], exhaustedError: { code: 'FILE_NOT_FOUND', retryable: false, suggestedAction: 'choose-model' } }), list: () => [], getLoadAttemptUrl: () => null, resolveAssetPath: () => null
    } as unknown as Live2dModelService
    const importer = { importZip: vi.fn() } as unknown as Live2dModelImporter
    const manager = {
      sendStageCommand,
      requestModelLoad: vi.fn((modelId: string) => {
        sendStageCommand({ type: 'load-model', modelUrl: `nacime-live2d://model/${modelId}/Mao.model3.json` })
        return true
      })
    } as unknown as Live2dWindowManager
    const snapshot = { models: [], selectedModelId: null, loadedModelId: null, window: { visible: false, alwaysOnTop: true, zoom: 1, offsetX: 0, offsetY: 0, stageStatus: 'closed' as const }, loading: false, lastError: null, revision: 0, lastEventSequence: 0 }
    registerLive2dHandlers({ logger: logger(), getMainWindow: () => null, service, importer, manager, getSnapshot: () => snapshot })

    await expect(handler('companion:live2d:get-state')(event(), undefined)).resolves.toEqual({ ok: true, data: snapshot })
    await expect(handler('companion:live2d:select-model')(event(), { modelId: 'mao' })).resolves.toMatchObject({ ok: true })
    expect(sendStageCommand).toHaveBeenCalledWith({ type: 'load-model', modelUrl: 'nacime-live2d://model/mao/Mao.model3.json' })
  })

  it('reset-window-placement 只调用 main manager，失败返回可恢复错误', async () => {
    const resetWindowPlacement = vi.fn<() => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
    const manager = {
      getSnapshot: () => ({ webContentsId: 10 }),
      resetWindowPlacement
    } as unknown as Live2dWindowManager
    registerLive2dHandlers({
      logger: logger(),
      getMainWindow: () => null,
      service: {} as Live2dModelService,
      importer: {} as Live2dModelImporter,
      manager,
      getSnapshot: () => { throw new Error('unused') }
    })
    const invoke = handler('companion:live2d:reset-window-placement')

    await expect(invoke(event(), undefined)).resolves.toMatchObject({ ok: true })
    await expect(invoke(event(), undefined)).resolves.toMatchObject({
      ok: false,
      error: { code: 'L2D_MODEL_LOAD', retryable: true }
    })
    expect(resetWindowPlacement).toHaveBeenCalledTimes(2)
  })

  it('select-model 拒绝未知 modelId，带绝对路径/多余字段的载荷在 validator 层拒绝', async () => {
    const service = { getRegistered: () => null } as unknown as Live2dModelService
    registerLive2dHandlers({ logger: logger(), getMainWindow: () => null, service, importer: {} as Live2dModelImporter, manager: {} as Live2dWindowManager, getSnapshot: () => { throw new Error('should not call') } })
    const invoke = handler('companion:live2d:select-model')
    expect(await invoke(event(), { modelId: 'C:\\secret.model3.json' })).toMatchObject({ ok: false, error: { code: 'IPC_VALIDATION' } })
    expect(await invoke(event(), { modelId: 'mao', path: 'C:\\secret' })).toMatchObject({ ok: false, error: { code: 'IPC_VALIDATION' } })
    expect(await invoke(event(), { modelId: 'missing' })).toMatchObject({ ok: false, error: { code: 'L2D_MODEL_LOAD' } })
  })
})
