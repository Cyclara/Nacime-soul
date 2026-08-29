// src/main/ipc/register-capability.test.ts
// P3A-05：chat 与 stage 都通过 origin + id 信任后，仍必须受 capability allowlist 隔离。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { ipcMain } from 'electron'
import type { Logger } from '@shared/observability/types'
import {
  configureIpcGuard,
  getIpcSenderCapabilities,
  registerValidatedHandler,
  removeIpcSenderCapability,
  sendEvent
} from './register'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }
}))

function logger(): Logger {
  const result: Logger = {
    fatal() {
      /* noop */
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
    child: () => result
  }
  return result
}

function event(id: number): Partial<IpcMainInvokeEvent> {
  return {
    sender: { id } as IpcMainInvokeEvent['sender'],
    senderFrame: { url: 'http://localhost:5173/' } as IpcMainInvokeEvent['senderFrame']
  }
}

function registered(channel: string): (event: unknown, payload: unknown) => Promise<unknown> {
  const found = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel)
  if (found === undefined) throw new Error(`missing ${channel}`)
  return found[1] as (event: unknown, payload: unknown) => Promise<unknown>
}

describe('P3A-05 IPC sender capability guard', () => {
  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockClear()
    vi.mocked(ipcMain.removeHandler).mockClear()
    configureIpcGuard(
      {
        trustedOrigins: new Set(['http://localhost:5173']),
        trustedWebContentsIds: new Set([1, 2]),
        senderCapabilities: new Map([
          [1, 'chat'],
          [2, 'live2d-stage']
        ])
      },
      logger()
    )
  })

  it('stage 可调用 stage:ready，但 chat 即使受信也被拒绝', async () => {
    const handler = vi.fn(() => ({
      stageInstanceId: 'stage-1',
      status: 'loading-model' as const,
      initialModelUrl: null,
      cubismCoreUrl: null,
      zoom: 1,
      offsetX: 0,
      offsetY: 0
    }))
    registerValidatedHandler('companion:stage:ready', handler)
    const invoke = registered('companion:stage:ready')

    await expect(invoke(event(2), { stageInstanceId: 'stage-1' })).resolves.toMatchObject({
      ok: true
    })
    const denied = await invoke(event(1), { stageInstanceId: 'stage-1' })
    expect(denied).toMatchObject({ ok: false, error: { code: 'IPC_UNAUTHORIZED' } })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('chat 可调用 chat 通道，但 stage 即使受信也被拒绝', async () => {
    const handler = vi.fn(() => ({ version: '1', platform: 'win32', arch: 'x64' }))
    registerValidatedHandler('companion:app:get-info', handler)
    const invoke = registered('companion:app:get-info')

    await expect(invoke(event(1), undefined)).resolves.toMatchObject({ ok: true })
    const denied = await invoke(event(2), undefined)
    expect(denied).toMatchObject({ ok: false, error: { code: 'IPC_UNAUTHORIZED' } })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('窗口销毁移除 ID 和 capability，后续调用不可继承旧 stage 权限', async () => {
    removeIpcSenderCapability(2)
    expect(getIpcSenderCapabilities().has(2)).toBe(false)

    const handler = vi.fn(() => ({
      stageInstanceId: 'stage-1',
      status: 'loading-model' as const,
      initialModelUrl: null,
      cubismCoreUrl: null,
      zoom: 1,
      offsetX: 0,
      offsetY: 0
    }))
    registerValidatedHandler('companion:stage:ready', handler)
    const result = await registered('companion:stage:ready')(event(2), {
      stageInstanceId: 'stage-1'
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'IPC_UNAUTHORIZED' } })
    expect(handler).not.toHaveBeenCalled()
  })

  it('event send 在窗口销毁竞态下不向 main 抛出异常', () => {
    const webContents = {
      id: 1,
      isDestroyed: () => false,
      send: vi.fn(() => {
        throw new Error('Object has been destroyed')
      })
    }
    expect(() =>
      sendEvent(webContents as never, 'companion:event:window-state', { maximized: true })
    ).not.toThrow()
  })
})
