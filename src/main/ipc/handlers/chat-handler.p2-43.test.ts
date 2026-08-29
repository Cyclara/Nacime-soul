// src/main/ipc/handlers/chat-handler.p2-43.test.ts
// P2-43：companion:chat:get-last-session IPC 接线测试。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { ipcMain } from 'electron'
import type { Logger } from '@shared/observability/types'
import type { ChatService } from '../../chat/service'
import { configureIpcGuard } from '../register'
import { registerChatHandlers } from './chat'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }
}))

function noopLogger(): Logger {
  const logger: Logger = {
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
    child() {
      return logger
    }
  }
  return logger
}

interface RegisteredHandler {
  (event: unknown, raw: unknown): Promise<unknown>
}

function getHandler(channel: string): RegisteredHandler {
  const found = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel)
  if (!found) throw new Error(`handler not registered: ${channel}`)
  return found[1] as RegisteredHandler
}

function trustedEvent(): Partial<IpcMainInvokeEvent> {
  return {
    sender: { id: 1 } as IpcMainInvokeEvent['sender'],
    senderFrame: { url: 'http://localhost:5173/' } as IpcMainInvokeEvent['senderFrame']
  }
}

describe('P2-43 chat:get-last-session handler', () => {
  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockClear()
    vi.mocked(ipcMain.removeHandler).mockClear()
    configureIpcGuard(
      { trustedOrigins: new Set(['http://localhost:5173']), trustedWebContentsIds: new Set([1]) },
      noopLogger()
    )
  })

  it('返回 ChatService 最近会话；空库 null 原样透传', async () => {
    const getLastSessionId = vi
      .fn<() => string | null>()
      .mockReturnValueOnce('s-last')
      .mockReturnValueOnce(null)
    const chatService = { getLastSessionId } as unknown as ChatService
    registerChatHandlers({
      chatService,
      logger: noopLogger(),
      searchMessages: () => [],
      // P3C1-07：feedback handler 在专属测试文件覆盖；此处仅需满足依赖形状
      recordFeedback: () => ({ status: 'ignored', reason: 'turn-row-missing' })
    })

    const handler = getHandler('companion:chat:get-last-session')
    await expect(handler(trustedEvent(), undefined)).resolves.toEqual({
      ok: true,
      data: { sessionId: 's-last' }
    })
    await expect(handler(trustedEvent(), undefined)).resolves.toEqual({
      ok: true,
      data: { sessionId: null }
    })
    expect(getLastSessionId).toHaveBeenCalledTimes(2)
  })
})
