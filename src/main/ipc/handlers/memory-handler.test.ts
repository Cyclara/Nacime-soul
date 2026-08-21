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
    source: 'user_explicit',
    importanceBeforePin: null,
    editedAt: null,
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
        dmaeDiagnostics: null,
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

describe('memory handler disabled 语义（S-012 §3.3）', () => {
  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockClear()
    vi.mocked(ipcMain.removeHandler).mockClear()
    configureIpcGuard(
      { trustedOrigins: new Set(['http://localhost:5173']), trustedWebContentsIds: new Set([1]) },
      noopLogger()
    )
  })

  it('get-dmae-history: memory.enabled=false 返回空 points（query 空 data，不抛 MEM_DISABLED）', async () => {
    registerMemoryHandlers({
      logger: noopLogger(),
      services: null,
      getMemoryConfig: () => ({ enabled: false }) as never
    })

    const handler = getHandler('companion:memory:get-dmae-history')
    const result = (await handler(trustedEvent(), {
      memoryId: 'l2_1710000000000_a1',
      days: 30
    })) as { ok: boolean; data?: { memoryId: string; points: unknown[] } }

    expect(result.ok).toBe(true)
    expect(result.data).toEqual({ memoryId: 'l2_1710000000000_a1', points: [] })
  })
})

// === M-48/M-44（2026-08-21）：pin 接真豁免 + 记忆编辑 ===

interface WriteMocks {
  l2Store: { get: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
  l0Store: { setPinned: ReturnType<typeof vi.fn>; clearField: ReturnType<typeof vi.fn> }
  dmaeService: { seedActivation: ReturnType<typeof vi.fn> } | null
  revisionClock: { current: () => number; next: ReturnType<typeof vi.fn> }
  broadcaster: { notify: ReturnType<typeof vi.fn> }
}

function registerWriteHandlers(
  mem: L2Memory | null,
  over: { dmae?: 'null' | 'mock' } = {}
): WriteMocks {
  const mocks: WriteMocks = {
    l2Store: {
      get: vi.fn(() => mem),
      update: vi.fn()
    },
    l0Store: { setPinned: vi.fn(), clearField: vi.fn() },
    dmaeService: over.dmae === 'null' ? null : { seedActivation: vi.fn(() => true) },
    revisionClock: { current: () => 7, next: vi.fn(() => 8) },
    broadcaster: { notify: vi.fn() }
  }
  registerMemoryHandlers({
    logger: noopLogger(),
    services: {
      l0Store: mocks.l0Store as never,
      l2Store: mocks.l2Store as never,
      dmaeService: mocks.dmaeService as never,
      dmaeDiagnostics: null,
      revisionClock: mocks.revisionClock as never,
      broadcaster: mocks.broadcaster as never
    },
    getMemoryConfig: () =>
      ({ enabled: true, dmae: { enabled: true, promptThreshold: 30 } }) as never
  })
  return mocks
}

describe('M-48 set-pinned：pin 接真豁免', () => {
  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockClear()
    vi.mocked(ipcMain.removeHandler).mockClear()
    configureIpcGuard(
      { trustedOrigins: new Set(['http://localhost:5173']), trustedWebContentsIds: new Set([1]) },
      noopLogger()
    )
  })

  it('pin：存原 importance + 提到豁免档 10 + seedActivation 抬到 promptThreshold', async () => {
    const mem = makeMemory({ importance: 6 })
    const mocks = registerWriteHandlers(mem)
    const handler = getHandler('companion:memory:set-pinned')

    const result = (await handler(trustedEvent(), { memoryId: mem.id, pinned: true })) as {
      ok: boolean
    }

    expect(result.ok).toBe(true)
    expect(mocks.l2Store.update).toHaveBeenCalledWith(mem.id, {
      isPinned: true,
      importanceBeforePin: 6,
      importance: 10
    })
    expect(mocks.dmaeService && mocks.dmaeService.seedActivation).toHaveBeenCalledWith(mem.id, 30)
    expect(mocks.revisionClock.next).toHaveBeenCalled()
    expect(mocks.broadcaster.notify).toHaveBeenCalledWith('l2')
  })

  it('unpin：恢复 pin 前 importance 并清备份', async () => {
    const mem = makeMemory({ isPinned: true, importance: 10, importanceBeforePin: 6 })
    const mocks = registerWriteHandlers(mem)
    const handler = getHandler('companion:memory:set-pinned')

    await handler(trustedEvent(), { memoryId: mem.id, pinned: false })

    expect(mocks.l2Store.update).toHaveBeenCalledWith(mem.id, {
      isPinned: false,
      importance: 6,
      importanceBeforePin: null
    })
    // unpin 不抬激活值（已高的激活随恢复后的 importance 自然衰减）
    expect(mocks.dmaeService && mocks.dmaeService.seedActivation).not.toHaveBeenCalled()
  })

  it('unpin：007 前旧数据无备份（null）-> 保持现值', async () => {
    const mem = makeMemory({ isPinned: true, importance: 10, importanceBeforePin: null })
    const mocks = registerWriteHandlers(mem)
    const handler = getHandler('companion:memory:set-pinned')

    await handler(trustedEvent(), { memoryId: mem.id, pinned: false })

    expect(mocks.l2Store.update).toHaveBeenCalledWith(mem.id, {
      isPinned: false,
      importance: 10,
      importanceBeforePin: null
    })
  })

  it('幂等：重复 pin 不改写（importanceBeforePin 原件不被 10 覆盖）', async () => {
    const mem = makeMemory({ isPinned: true, importance: 10, importanceBeforePin: 6 })
    const mocks = registerWriteHandlers(mem)
    const handler = getHandler('companion:memory:set-pinned')

    const result = (await handler(trustedEvent(), { memoryId: mem.id, pinned: true })) as {
      ok: boolean
    }

    expect(result.ok).toBe(true)
    expect(mocks.l2Store.update).not.toHaveBeenCalled()
    expect(mocks.revisionClock.next).not.toHaveBeenCalled()
  })

  it('dmae 关闭（service=null）：仍写 importance 豁免，不触碰 seedActivation', async () => {
    const mem = makeMemory({ importance: 6 })
    const mocks = registerWriteHandlers(mem, { dmae: 'null' })
    const handler = getHandler('companion:memory:set-pinned')

    const result = (await handler(trustedEvent(), { memoryId: mem.id, pinned: true })) as {
      ok: boolean
    }

    expect(result.ok).toBe(true)
    expect(mocks.l2Store.update).toHaveBeenCalledWith(mem.id, {
      isPinned: true,
      importanceBeforePin: 6,
      importance: 10
    })
  })
})

describe('M-44 update-content：编辑 L2 内容', () => {
  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockClear()
    vi.mocked(ipcMain.removeHandler).mockClear()
    configureIpcGuard(
      { trustedOrigins: new Set(['http://localhost:5173']), trustedWebContentsIds: new Set([1]) },
      noopLogger()
    )
  })

  it('trim 后落库 + syncStatus 打回 pending + editedAt 编辑标记 + 广播', async () => {
    const mem = makeMemory({ content: '旧内容', syncStatus: 'synced' })
    const mocks = registerWriteHandlers(mem)
    const handler = getHandler('companion:memory:update-content')

    const result = (await handler(trustedEvent(), {
      memoryId: mem.id,
      content: '  新内容  '
    })) as { ok: boolean }

    expect(result.ok).toBe(true)
    const [id, patch] = mocks.l2Store.update.mock.calls[0] as [string, Record<string, unknown>]
    expect(id).toBe(mem.id)
    expect(patch.content).toBe('新内容')
    expect(patch.syncStatus).toBe('pending')
    expect(typeof patch.editedAt).toBe('number')
    expect(mocks.revisionClock.next).toHaveBeenCalled()
    expect(mocks.broadcaster.notify).toHaveBeenCalledWith('l2')
  })

  it('trim 后为空 -> IPC_VALIDATION 错误（不写库）', async () => {
    const mem = makeMemory()
    const mocks = registerWriteHandlers(mem)
    const handler = getHandler('companion:memory:update-content')

    const result = (await handler(trustedEvent(), { memoryId: mem.id, content: '   ' })) as {
      ok: boolean
      error?: { code: string }
    }

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('IPC_VALIDATION')
    expect(mocks.l2Store.update).not.toHaveBeenCalled()
  })

  it('内容无变化 -> 不写库不 bump revision（不盖 editedAt）', async () => {
    const mem = makeMemory({ content: '一样' })
    const mocks = registerWriteHandlers(mem)
    const handler = getHandler('companion:memory:update-content')

    const result = (await handler(trustedEvent(), { memoryId: mem.id, content: ' 一样 ' })) as {
      ok: boolean
    }

    expect(result.ok).toBe(true)
    expect(mocks.l2Store.update).not.toHaveBeenCalled()
    expect(mocks.revisionClock.next).not.toHaveBeenCalled()
  })

  it('记忆不存在 -> MEM_NOT_FOUND', async () => {
    registerWriteHandlers(null)
    const handler = getHandler('companion:memory:update-content')

    const result = (await handler(trustedEvent(), {
      memoryId: 'l2_1710000000000_a1',
      content: 'x'
    })) as { ok: boolean; error?: { code: string } }

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('MEM_NOT_FOUND')
  })
})

describe('M-44 set-l0-field：设定/清空 L0 字段', () => {
  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockClear()
    vi.mocked(ipcMain.removeHandler).mockClear()
    configureIpcGuard(
      { trustedOrigins: new Set(['http://localhost:5173']), trustedWebContentsIds: new Set([1]) },
      noopLogger()
    )
  })

  it('非空值 -> setPinned（user_pinned 防覆盖；l0Store 内部自 notify）', async () => {
    const mocks = registerWriteHandlers(null)
    const handler = getHandler('companion:memory:set-l0-field')

    const result = (await handler(trustedEvent(), {
      field: 'occupation',
      value: '  工程师  '
    })) as { ok: boolean }

    expect(result.ok).toBe(true)
    expect(mocks.l0Store.setPinned).toHaveBeenCalledWith('occupation', '工程师')
    expect(mocks.l0Store.clearField).not.toHaveBeenCalled()
  })

  it('空串 -> clearField（允许 fillRate 下降）', async () => {
    const mocks = registerWriteHandlers(null)
    const handler = getHandler('companion:memory:set-l0-field')

    const result = (await handler(trustedEvent(), { field: 'likes', value: '  ' })) as {
      ok: boolean
    }

    expect(result.ok).toBe(true)
    expect(mocks.l0Store.clearField).toHaveBeenCalledWith('likes')
    expect(mocks.l0Store.setPinned).not.toHaveBeenCalled()
  })
})
