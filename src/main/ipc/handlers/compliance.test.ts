// src/main/ipc/handlers/compliance.test.ts
// P3C1-08：companion:compliance:get-snapshot IPC 接线测试。
// 覆盖：可信 sender / 无载荷 validator / 固定共享类型返回 / service throw -> IPC_INTERNAL
//      以及「审查不可见」约束（仅 get-snapshot invoke，无 event 通道）。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { ipcMain } from 'electron'
import type { Logger } from '@shared/observability/types'
import type { ComplianceSnapshot } from '@shared/compliance/types'
import { configureIpcGuard } from '../register'
import { registerComplianceHandlers } from './compliance'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }
}))

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

const SNAPSHOT: ComplianceSnapshot = {
  gateEnabled: true,
  gateScope: 'observe',
  ruleHits: { 'R-MR-01': 2 },
  rejectedRules: [],
  recentViolations: [
    {
      turnId: 't1',
      type: 'meta-reference',
      severity: 'critical',
      detectionMethod: 'regex',
      ruleId: 'R-MR-01'
    }
  ],
  approxFalsePositiveRate: null,
  approxEscapeRate: 0.25
}

describe('P3C1-08 compliance:get-snapshot handler', () => {
  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockClear()
    vi.mocked(ipcMain.removeHandler).mockClear()
    configureIpcGuard(
      { trustedOrigins: new Set(['http://localhost:5173']), trustedWebContentsIds: new Set([1]) },
      noopLogger()
    )
  })

  it('受信、undefined 载荷 -> 返回完整聚合快照', async () => {
    const getSnapshot = vi.fn(() => SNAPSHOT)
    registerComplianceHandlers({ logger: noopLogger(), getSnapshot })
    const handler = getHandler('companion:compliance:get-snapshot')

    await expect(handler(trustedEvent(), undefined)).resolves.toEqual({ ok: true, data: SNAPSHOT })
    expect(getSnapshot).toHaveBeenCalledTimes(1)
  })

  it('运行时上游偷塞 rationale/content -> IPC 白名单投影剥离（模型正文不可跨进程）', async () => {
    const secret = 'SECRET-ASSISTANT-OR-USER-TEXT'
    const poisoned = {
      ...SNAPSHOT,
      rationale: secret,
      recentViolations: [{ ...SNAPSHOT.recentViolations[0]!, rationale: secret, content: secret }]
    } as unknown as ComplianceSnapshot
    registerComplianceHandlers({ logger: noopLogger(), getSnapshot: () => poisoned })
    const handler = getHandler('companion:compliance:get-snapshot')

    const result = await handler(trustedEvent(), undefined)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('rationale')
    expect(serialized).not.toContain('content')
  })

  it('任何非 undefined 载荷 -> IPC_VALIDATION，数据源不得调用', async () => {
    const getSnapshot = vi.fn(() => SNAPSHOT)
    registerComplianceHandlers({ logger: noopLogger(), getSnapshot })
    const handler = getHandler('companion:compliance:get-snapshot')

    const result = await handler(trustedEvent(), { extra: true })
    expect(result).toMatchObject({ ok: false, error: { code: 'IPC_VALIDATION' } })
    expect(getSnapshot).not.toHaveBeenCalled()
  })

  it('非受信 sender -> IPC_UNAUTHORIZED，数据源不得调用', async () => {
    const getSnapshot = vi.fn(() => SNAPSHOT)
    registerComplianceHandlers({ logger: noopLogger(), getSnapshot })
    const handler = getHandler('companion:compliance:get-snapshot')
    const untrusted = {
      sender: { id: 99 } as IpcMainInvokeEvent['sender'],
      senderFrame: { url: 'https://evil.example/' } as IpcMainInvokeEvent['senderFrame']
    }

    const result = await handler(untrusted, undefined)
    expect(result).toMatchObject({ ok: false, error: { code: 'IPC_UNAUTHORIZED' } })
    expect(getSnapshot).not.toHaveBeenCalled()
  })

  it('getSnapshot 抛错 -> IPC_INTERNAL，错误正文不泄漏', async () => {
    registerComplianceHandlers({
      logger: noopLogger(),
      getSnapshot: () => {
        throw new Error('SECRET-RATIONALE-TEXT')
      }
    })
    const handler = getHandler('companion:compliance:get-snapshot')
    const result = await handler(trustedEvent(), undefined)

    expect(result).toMatchObject({ ok: false, error: { code: 'IPC_INTERNAL' } })
    expect(JSON.stringify(result)).not.toContain('SECRET-RATIONALE-TEXT')
  })
})
