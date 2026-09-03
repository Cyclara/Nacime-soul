// src/main/ipc/handlers/chat-handler.ack.test.ts
// P3B-15A：companion:chat:ack-rendered IPC 接线测试。
// 验收（S-Phase3 P3B-15A + 台账 §3）：stage 无权调用；未登记（旧）requestId 拒绝；
// 逆序/重复 sequence 拒绝；合法 ack 喂进 ChatRenderAckGate（播放队列消费点）。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { ipcMain } from 'electron'
import type { Logger } from '@shared/observability/types'
import {
  createChatRenderAckTracker,
  type ChatRenderAckTracker
} from '../../voice/playback/ack-gate'
import type { ChatService } from '../../chat/service'
import { configureIpcGuard } from '../register'
import { registerChatHandlers } from './chat'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }
}))

type RegisteredHandler = (event: unknown, raw: unknown) => Promise<unknown>

function getHandler(channel: string): RegisteredHandler {
  const found = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel)
  if (!found) throw new Error(`handler not registered: ${channel}`)
  return found[1] as RegisteredHandler
}

function trustedEvent(senderId = 1): Partial<IpcMainInvokeEvent> {
  return {
    sender: { id: senderId } as IpcMainInvokeEvent['sender'],
    senderFrame: { url: 'http://localhost:5173/' } as IpcMainInvokeEvent['senderFrame']
  }
}

function noopLogger(): Logger {
  const l: Logger = {
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
    child: () => l
  }
  return l
}

function makeDeps(ackTracker: ChatRenderAckTracker): {
  deps: Parameters<typeof registerChatHandlers>[0]
} {
  const deps = {
    chatService: {} as unknown as ChatService,
    logger: noopLogger(),
    searchMessages: () => [],
    recordFeedback: () => ({ status: 'ignored', reason: 'turn-row-missing' }) as const,
    ackTracker
  }
  return { deps }
}

describe('P3B-15A chat:ack-rendered handler', () => {
  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockClear()
    vi.mocked(ipcMain.removeHandler).mockClear()
    configureIpcGuard({
      trustedOrigins: new Set(['http://localhost:5173']),
      trustedWebContentsIds: new Set([1, 2]),
      // 1 = chat（默认），2 = stage 负例
      senderCapabilities: new Map([
        [1, 'chat'],
        [2, 'live2d-stage']
      ])
    })
  })

  it('合法 ack 回报 ok；gate.waitForPainted 的等待者被满足', async () => {
    const tracker = createChatRenderAckTracker()
    registerChatHandlers(makeDeps(tracker).deps)
    tracker.noteRequestIssued('r1')

    const waiting = tracker.gate.waitForPainted('r1', 3, new AbortController().signal)
    const result = await getHandler('companion:chat:ack-rendered')(trustedEvent(), {
      requestId: 'r1',
      sequence: 3
    })
    expect(result).toEqual({ ok: true, data: undefined })
    await expect(waiting).resolves.toMatchObject({ requestId: 'r1', sequence: 3 })
  })

  it('未登记（旧/未知）requestId 被拒绝：handler return ok 但 gate 不认账', async () => {
    const tracker = createChatRenderAckTracker()
    registerChatHandlers(makeDeps(tracker).deps)

    const result = await getHandler('companion:chat:ack-rendered')(trustedEvent(), {
      requestId: 'ghost',
      sequence: 1
    })
    expect(result).toEqual({ ok: true, data: undefined })
    expect(tracker.issuedRequestCount).toBe(0)
  })

  it('逆序/重复 sequence 被拒绝（gate 语义透传）', async () => {
    const tracker = createChatRenderAckTracker()
    registerChatHandlers(makeDeps(tracker).deps)
    tracker.noteRequestIssued('r1')

    const handler = getHandler('companion:chat:ack-rendered')
    await handler(trustedEvent(), { requestId: 'r1', sequence: 5 })
    await handler(trustedEvent(), { requestId: 'r1', sequence: 5 }) // 重复
    await handler(trustedEvent(), { requestId: 'r1', sequence: 4 }) // 逆序

    // 只看最终认账：到 5 为止
    const waiting = tracker.gate.waitForPainted('r1', 5, new AbortController().signal)
    await expect(waiting).resolves.toMatchObject({ requestId: 'r1', sequence: 5 })
  })

  it('stage capability 越权调用被 guard 拒（IPC_UNAUTHORIZED）', async () => {
    const tracker = createChatRenderAckTracker()
    const acceptSpy = vi.spyOn(tracker, 'acceptAck')
    registerChatHandlers(makeDeps(tracker).deps)
    tracker.noteRequestIssued('r1')

    const result = await getHandler('companion:chat:ack-rendered')(trustedEvent(2), {
      requestId: 'r1',
      sequence: 1
    })
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: 'IPC_UNAUTHORIZED',
          retryable: false,
          requestId: expect.any(String)
        })
      })
    )
    // guard 在 handler 之前拦截：tracker 从未被喂——stage 无权让声音开播
    expect(acceptSpy).not.toHaveBeenCalled()
  })

  it('非法载荷被 central validator 拒（IPC_VALIDATION）', async () => {
    const tracker = createChatRenderAckTracker()
    registerChatHandlers(makeDeps(tracker).deps)

    const result = await getHandler('companion:chat:ack-rendered')(trustedEvent(), {
      requestId: 'r1',
      sequence: -1
    })
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: 'IPC_VALIDATION',
          retryable: false,
          requestId: expect.any(String)
        })
      })
    )
  })
})
