// src/main/ipc/handlers/chat-handler.feedback.test.ts
// P3C1-07：companion:chat:feedback IPC 接线测试。
// 验收（S-Phase3 P3C1-07）：幂等语义对外恒 {ok:true}（插入/重复/忽略不向 renderer 泄漏差异）；
// 非法载荷被中央 validator 拒（IPC_VALIDATION）；日志只记元数据不记正文。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { ipcMain } from 'electron'
import type { Logger, LogFields } from '@shared/observability/types'
import type { ChatFeedbackRequest } from '@shared/compliance/types'
import type { ComplianceFeedbackOutcome } from '../../compliance/feedback'
import { createChatRenderAckTracker } from '../../voice/playback/ack-gate'
import type { ChatService } from '../../chat/service'
import { configureIpcGuard } from '../register'
import { registerChatHandlers } from './chat'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }
}))

interface LogCall {
  readonly level: 'fatal' | 'error' | 'warn' | 'info' | 'debug'
  readonly msg: string
  readonly fields: LogFields
}

function spyLogger(): { logger: Logger; calls: LogCall[] } {
  const calls: LogCall[] = []
  const rec =
    (level: LogCall['level']) =>
    (msg: string, fields: LogFields): void => {
      calls.push({ level, msg, fields })
    }
  const l: Logger = {
    fatal: rec('fatal'),
    error: rec('error'),
    warn: rec('warn'),
    info: rec('info'),
    debug: rec('debug'),
    child: () => l
  }
  return { logger: l, calls }
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

const VALID_REQUEST: ChatFeedbackRequest = {
  sessionId: 'sess_01JG',
  turnId: 'turn-1',
  messageId: 'msg-a1',
  kind: 'dislike'
}

function makeDeps(outcome: ComplianceFeedbackOutcome): {
  deps: Parameters<typeof registerChatHandlers>[0]
  recordFeedback: ReturnType<typeof vi.fn>
} {
  const recordFeedback = vi.fn().mockReturnValue(outcome)
  const deps = {
    chatService: {} as unknown as ChatService,
    logger: spyLogger().logger,
    searchMessages: () => [],
    recordFeedback: recordFeedback as unknown as Parameters<
      typeof registerChatHandlers
    >[0]['recordFeedback'],
    ackTracker: createChatRenderAckTracker()
  }
  return { deps, recordFeedback }
}

describe('P3C1-07 chat:feedback handler', () => {
  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockClear()
    vi.mocked(ipcMain.removeHandler).mockClear()
    configureIpcGuard(
      { trustedOrigins: new Set(['http://localhost:5173']), trustedWebContentsIds: new Set([1]) },
      spyLogger().logger
    )
  })

  it('受信请求 -> 调用 feedback service 一次（透传 payload）并返回 {ok:true}', async () => {
    const { deps, recordFeedback } = makeDeps({ status: 'inserted', kind: 'dislike' })
    registerChatHandlers(deps)

    const handler = getHandler('companion:chat:feedback')
    await expect(handler(trustedEvent(), VALID_REQUEST)).resolves.toEqual({
      ok: true,
      data: { ok: true }
    })
    expect(recordFeedback).toHaveBeenCalledTimes(1)
    expect(recordFeedback).toHaveBeenCalledWith(VALID_REQUEST)
  })

  it('重复上报（duplicate outcome）对外同样 {ok:true}--幂等不泄漏差异', async () => {
    const { deps } = makeDeps({ status: 'duplicate' })
    registerChatHandlers(deps)

    const handler = getHandler('companion:chat:feedback')
    await expect(handler(trustedEvent(), VALID_REQUEST)).resolves.toEqual({
      ok: true,
      data: { ok: true }
    })
  })

  it('语义性忽略（ignored outcome）对外同样 {ok:true}', async () => {
    const { deps } = makeDeps({ status: 'ignored', reason: 'turn-row-missing' })
    registerChatHandlers(deps)

    const handler = getHandler('companion:chat:feedback')
    await expect(handler(trustedEvent(), VALID_REQUEST)).resolves.toEqual({
      ok: true,
      data: { ok: true }
    })
  })

  it('out-of-character payload 合法直达 service', async () => {
    const { deps, recordFeedback } = makeDeps({ status: 'inserted', kind: 'out-of-character' })
    registerChatHandlers(deps)

    const handler = getHandler('companion:chat:feedback')
    const request: ChatFeedbackRequest = { ...VALID_REQUEST, kind: 'out-of-character' }
    await expect(handler(trustedEvent(), request)).resolves.toEqual({
      ok: true,
      data: { ok: true }
    })
    expect(recordFeedback).toHaveBeenCalledWith(request)
  })

  it('非法 kind / 多余字段 -> 中央 validator 拒（IPC_VALIDATION，service 不被调）', async () => {
    const { deps, recordFeedback } = makeDeps({ status: 'inserted', kind: 'dislike' })
    registerChatHandlers(deps)

    const handler = getHandler('companion:chat:feedback')
    const badKind = await handler(trustedEvent(), { ...VALID_REQUEST, kind: 'like' })
    expect(badKind).toMatchObject({ ok: false, error: { code: 'IPC_VALIDATION' } })
    const extraKey = await handler(trustedEvent(), { ...VALID_REQUEST, reason: 'x' })
    expect(extraKey).toMatchObject({ ok: false, error: { code: 'IPC_VALIDATION' } })
    expect(recordFeedback).not.toHaveBeenCalled()
  })

  it('service 抛错 -> IPC_INTERNAL（不向外泄漏 stack）', async () => {
    const recordFeedback = vi.fn().mockImplementation(() => {
      throw new Error('sqlite disk full')
    })
    registerChatHandlers({
      chatService: {} as unknown as ChatService,
      logger: spyLogger().logger,
      searchMessages: () => [],
      recordFeedback: recordFeedback as unknown as Parameters<
        typeof registerChatHandlers
      >[0]['recordFeedback'],
      // P3B-15A：ack 通道在专属测试文件覆盖；此处仅需满足依赖形状
      ackTracker: createChatRenderAckTracker()
    })

    const handler = getHandler('companion:chat:feedback')
    const result = (await handler(trustedEvent(), VALID_REQUEST)) as {
      ok: boolean
      error: { code: string }
    }
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('IPC_INTERNAL')
    expect(JSON.stringify(result)).not.toContain('sqlite disk full')
  })
})
