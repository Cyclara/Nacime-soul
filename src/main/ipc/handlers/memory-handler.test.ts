// src/main/ipc/handlers/memory-handler.test.ts
// C-β R-4：memory:list-l2 必须把 search/offset/purged 排除与 count 条件下推 L2Store。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { ipcMain } from 'electron'
import type { Logger } from '@shared/observability/types'
import type { L2ListFilter, L2Memory, L2Store } from '../../memory/l2-store'
import { configureIpcGuard } from '../register'
import { registerMemoryHandlers } from './memory'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn()
  }
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

function makeMemory(overrides: Partial<L2Memory> = {}): L2Memory {
  return {
    id: 'l2_1710000000000_a1',
    evidenceIds: [],
    sourceMessageIds: [],
    triggerText: null,
    content: '进度 100%',
    confidence: 0.9,
    syncStatus: 'synced',
    lifecycleState: 'active',
    isPinned: false,
    accessCount: 0,
    weight: 1,
    type: 'stable',
    importance: 5,
    archivedAt: null,
    extractionKey: null,
    ...overrides
  }
}

describe('C-β memory:list-l2 handler', () => {
  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockClear()
    vi.mocked(ipcMain.removeHandler).mockClear()
    configureIpcGuard(
      { trustedOrigins: new Set(['http://localhost:5173']), trustedWebContentsIds: new Set([1]) },
      noopLogger()
    )
  })

  it('list/count 使用同一 search + 可见状态 WHERE，limit/offset 原样下推', async () => {
    const active = makeMemory()
    const purged = makeMemory({ id: 'l2_1710000000001_b2', lifecycleState: 'purged' })
    const rows = [active, purged]
    const excludesPurged = (filter?: L2ListFilter): boolean => {
      const states = filter?.lifecycleState
      return Array.isArray(states) && !states.includes('purged')
    }
    const list = vi.fn((filter?: L2ListFilter) => (excludesPurged(filter) ? [active] : rows))
    const count = vi.fn((filter?: Omit<L2ListFilter, 'limit' | 'offset'>) =>
      excludesPurged(filter) ? 1 : rows.length
    )
    const l2Store = { list, count } as unknown as L2Store

    registerMemoryHandlers({
      logger: noopLogger(),
      services: {
        l0Store: {} as never,
        l2Store,
        dmaeService: null,
        revisionClock: { current: () => 7, next: () => 8 },
        broadcaster: { notify: vi.fn(), flush: vi.fn(), dispose: vi.fn() }
      },
      getMemoryConfig: () => ({ enabled: true, dmae: { enabled: false } }) as never
    })

    const handler = getHandler('companion:memory:list-l2')
    const result = (await handler(trustedEvent(), {
      search: ' 100% ',
      limit: 25,
      offset: 50
    })) as { ok: boolean; data?: { items: unknown[]; total: number; revision: number } }

    const visibleStates = ['active', 'dormant', 'archived', 'soft_deleted']
    expect(result.ok).toBe(true)
    expect(result.data).toMatchObject({ total: 1, revision: 7 })
    expect(result.data?.items).toHaveLength(1)
    expect(list).toHaveBeenCalledWith({
      lifecycleState: visibleStates,
      search: '100%',
      limit: 25,
      offset: 50
    })
    expect(count).toHaveBeenCalledWith({
      lifecycleState: visibleStates,
      search: '100%'
    })
  })
})
