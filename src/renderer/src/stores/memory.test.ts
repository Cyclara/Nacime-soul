// @vitest-environment jsdom
// src/renderer/src/stores/memory.test.ts
// P2-30: memory Pinia store 测试。
// 依据：S-012 §3.4 测试矩阵（hint 矩阵、revision 比对、写操作不乐观、订阅清理、disabled）。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useMemoryStore } from './memory'
import type { MemoryOverview, MemoryUpdatedEvent } from '@shared/memory/types'

// === window.companion mock ===

function makeResult<T>(
  ok: boolean,
  data?: T,
  error?: unknown
): { ok: true; data: T } | { ok: false; error: unknown } {
  return ok ? { ok: true, data: data as T } : { ok: false, error }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

interface MockState {
  overview: MemoryOverview
  listResponse: { items: unknown[]; total: number; revision: number }
  l0View: unknown
  dmaeSnapshot: unknown
  detail: unknown | null
  setPinnedError: boolean
  updateContentError: boolean
  setL0FieldError: boolean
}

function setupCompanionApi(over: Partial<MockState> = {}): {
  memory: Record<string, ReturnType<typeof vi.fn>>
  state: MockState
} {
  const state: MockState = {
    overview: { revision: 1, enabled: true, l0: null, dmae: null },
    listResponse: { items: [], total: 0, revision: 1 },
    l0View: { fields: [], filledCount: 0, totalCount: 9 },
    dmaeSnapshot: {
      enabled: true,
      counts: { active: 0, dormant: 0, archived: 0 },
      maxActive: 15,
      promptThreshold: 30,
      activeSet: []
    },
    detail: null,
    setPinnedError: false,
    updateContentError: false,
    setL0FieldError: false,
    ...over
  }

  const memory = {
    getOverview: vi.fn(async () => makeResult(true, state.overview)),
    getL0: vi.fn(async () => makeResult(true, state.l0View)),
    listL2: vi.fn(async () => makeResult(true, state.listResponse)),
    getDetail: vi.fn(async () => makeResult(state.detail !== null, state.detail ?? undefined)),
    setPinned: vi.fn(async () => {
      if (state.setPinnedError)
        return makeResult(false, undefined, {
          code: 'MEM_NOT_FOUND',
          message: '不存在',
          retryable: false
        })
      return makeResult(true, undefined)
    }),
    softDelete: vi.fn(async () => makeResult(true, undefined)),
    restore: vi.fn(async () => makeResult(true, undefined)),
    updateContent: vi.fn(async () => {
      if (state.updateContentError)
        return makeResult(false, undefined, {
          code: 'IPC_VALIDATION',
          message: '记忆内容不能为空（想删掉请用删除）',
          retryable: false
        })
      return makeResult(true, undefined)
    }),
    setL0Field: vi.fn(async () => {
      if (state.setL0FieldError)
        return makeResult(false, undefined, {
          code: 'MEM_DISABLED',
          message: '记忆功能未开启',
          retryable: false
        })
      return makeResult(true, undefined)
    }),
    getDmaeSnapshot: vi.fn(async () => makeResult(true, state.dmaeSnapshot)),
    getDmaeHistory: vi.fn(async () => makeResult(true, { memoryId: 'x', points: [] })),
    onUpdated: vi.fn((cb: (e: MemoryUpdatedEvent) => void) => () => {
      void cb
    })
  }

  const growth = {
    getProfile: vi.fn(async () =>
      makeResult(true, {
        understanding: 0,
        stage: 'stranger',
        activeDays: 0,
        l2Total: 0,
        startedAt: 0,
        milestonesReached: []
      })
    ),
    getTimeline: vi.fn(async () => makeResult(true, [])),
    getTrend: vi.fn(async () => makeResult(true, []))
  }

  ;(window as unknown as { companion: unknown }).companion = { memory, growth }
  return { memory, state }
}

const ITEM = {
  id: 'l2_1',
  content: 'x',
  type: 'stable',
  lifecycleState: 'active',
  activation: 50,
  importance: 5,
  confidence: 0.9,
  isPinned: false,
  accessCount: 0,
  createdAt: 0
}

describe('P2-30 memory store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  describe('hydrate', () => {
    it('拉取 overview + list，合并到 state', async () => {
      setupCompanionApi({
        overview: {
          revision: 5,
          enabled: true,
          l0: { fields: [], filledCount: 2, totalCount: 9 },
          dmae: null
        },
        listResponse: { items: [ITEM], total: 1, revision: 5 }
      })
      const store = useMemoryStore()
      await store.hydrate()
      expect(store.state.revision).toBe(5)
      expect(store.state.enabled).toBe(true)
      expect(store.state.l0?.filledCount).toBe(2)
      expect(store.state.l2Items.length).toBe(1)
      expect(store.state.l2Total).toBe(1)
    })

    it('overview 返回 enabled=false -> state.enabled=false', async () => {
      setupCompanionApi({
        overview: { revision: 0, enabled: false, l0: null, dmae: null }
      })
      const store = useMemoryStore()
      await store.hydrate()
      expect(store.state.enabled).toBe(false)
    })
  })

  describe('applyUpdate hint 矩阵', () => {
    it('l0 hint -> 调 getL0，推进 revision', async () => {
      const { memory, state } = setupCompanionApi({
        overview: { revision: 1, enabled: true, l0: null, dmae: null }
      })
      const store = useMemoryStore()
      await store.hydrate()
      state.l0View = {
        fields: [
          { key: 'preferredName', label: '名字', value: '小明', isPinned: false, updatedAt: 100 }
        ],
        filledCount: 1,
        totalCount: 9
      }
      store.applyUpdate({ revision: 2, hint: 'l0', ts: 0 })
      await vi.waitFor(() => {
        expect(store.state.revision).toBe(2)
      })
      expect(memory.getL0).toHaveBeenCalled()
      expect(store.state.l0?.filledCount).toBe(1)
    })

    it('l1 hint -> 不发 invoke，但推进 revision', async () => {
      const { memory } = setupCompanionApi({
        overview: { revision: 1, enabled: true, l0: null, dmae: null }
      })
      const store = useMemoryStore()
      await store.hydrate()
      const beforeCallCount = memory.getL0.mock.calls.length
      store.applyUpdate({ revision: 3, hint: 'l1', ts: 0 })
      await vi.waitFor(() => {
        expect(store.state.revision).toBe(3)
      })
      expect(memory.getL0.mock.calls.length).toBe(beforeCallCount)
    })

    it('l2 hint -> 调 listL2 + getDmaeSnapshot', async () => {
      const { memory } = setupCompanionApi({
        overview: { revision: 1, enabled: true, l0: null, dmae: null }
      })
      const store = useMemoryStore()
      await store.hydrate()
      const beforeList = memory.listL2.mock.calls.length
      const beforeDmae = memory.getDmaeSnapshot.mock.calls.length
      store.applyUpdate({ revision: 2, hint: 'l2', ts: 0 })
      await vi.waitFor(() => {
        expect(memory.listL2.mock.calls.length).toBe(beforeList + 1)
      })
      expect(memory.getDmaeSnapshot.mock.calls.length).toBe(beforeDmae + 1)
    })

    it('dmae hint -> 只调 getDmaeSnapshot', async () => {
      const { memory } = setupCompanionApi({
        overview: { revision: 1, enabled: true, l0: null, dmae: null }
      })
      const store = useMemoryStore()
      await store.hydrate()
      const beforeList = memory.listL2.mock.calls.length
      // hydrate 不直接调 getDmaeSnapshot（dmae 在 overview 里），所以 hint 前调用数为 0
      store.applyUpdate({ revision: 2, hint: 'dmae', ts: 0 })
      await vi.waitFor(() => {
        expect(memory.getDmaeSnapshot.mock.calls.length).toBe(1)
      })
      expect(memory.listL2.mock.calls.length).toBe(beforeList)
    })

    it('growth hint -> memory store 不拉取，不推进 revision', async () => {
      const { memory } = setupCompanionApi({
        overview: { revision: 1, enabled: true, l0: null, dmae: null }
      })
      const store = useMemoryStore()
      await store.hydrate()
      const before = memory.getOverview.mock.calls.length
      const beforeRev = store.state.revision
      store.applyUpdate({ revision: 5, hint: 'growth', ts: 0 })
      await new Promise((r) => setTimeout(r, 50))
      expect(store.state.revision).toBe(beforeRev)
      expect(memory.getOverview.mock.calls.length).toBe(before)
    })

    it('bulk hint -> 调 getOverview + listL2', async () => {
      const { memory } = setupCompanionApi({
        overview: { revision: 1, enabled: true, l0: null, dmae: null }
      })
      const store = useMemoryStore()
      await store.hydrate()
      const beforeOverview = memory.getOverview.mock.calls.length
      const beforeList = memory.listL2.mock.calls.length
      store.applyUpdate({ revision: 3, hint: 'bulk', ts: 0 })
      await vi.waitFor(() => {
        expect(memory.getOverview.mock.calls.length).toBe(beforeOverview + 1)
      })
      expect(memory.listL2.mock.calls.length).toBe(beforeList + 1)
    })
  })

  describe('revision 比对', () => {
    it('event.revision <= state.revision -> 丢弃', async () => {
      const { memory } = setupCompanionApi({
        overview: { revision: 5, enabled: true, l0: null, dmae: null }
      })
      const store = useMemoryStore()
      await store.hydrate()
      const before = memory.getL0.mock.calls.length
      store.applyUpdate({ revision: 3, hint: 'l0', ts: 0 })
      store.applyUpdate({ revision: 5, hint: 'l0', ts: 0 })
      await new Promise((r) => setTimeout(r, 50))
      expect(memory.getL0.mock.calls.length).toBe(before)
    })
  })

  describe('写操作不乐观更新', () => {
    it('setPinned 成功后不立即改本地数据（等 event 回流）', async () => {
      setupCompanionApi({
        overview: { revision: 1, enabled: true, l0: null, dmae: null },
        listResponse: { items: [ITEM], total: 1, revision: 1 }
      })
      const store = useMemoryStore()
      await store.hydrate()
      expect(store.state.l2Items[0].isPinned).toBe(false)
      const ok = await store.setPinned('l2_1', true)
      expect(ok).toBe(true)
      expect(store.state.l2Items[0].isPinned).toBe(false)
    })

    it('setPinned 失败 -> lastError 设置', async () => {
      setupCompanionApi({
        overview: { revision: 1, enabled: true, l0: null, dmae: null },
        setPinnedError: true
      })
      const store = useMemoryStore()
      await store.hydrate()
      const ok = await store.setPinned('l2_x', true)
      expect(ok).toBe(false)
      expect(store.state.lastError?.code).toBe('MEM_NOT_FOUND')
    })
  })

  describe('M-44 编辑操作', () => {
    it('updateContent 成功 -> 参数原样透传（trim 由 main 做），不乐观更新', async () => {
      const { memory } = setupCompanionApi({
        overview: { revision: 1, enabled: true, l0: null, dmae: null },
        listResponse: { items: [ITEM], total: 1, revision: 1 }
      })
      const store = useMemoryStore()
      await store.hydrate()
      const ok = await store.updateContent('l2_1', '  新内容  ')
      expect(ok).toBe(true)
      expect(memory.updateContent).toHaveBeenCalledWith({ memoryId: 'l2_1', content: '  新内容  ' })
      // 不乐观更新：本地列表内容不变，等 event 回流
      expect(store.state.l2Items[0].content).toBe('x')
    })

    it('updateContent 失败 -> lastError 设置', async () => {
      setupCompanionApi({
        overview: { revision: 1, enabled: true, l0: null, dmae: null },
        updateContentError: true
      })
      const store = useMemoryStore()
      await store.hydrate()
      const ok = await store.updateContent('l2_1', '   ')
      expect(ok).toBe(false)
      expect(store.state.lastError?.code).toBe('IPC_VALIDATION')
    })

    it('setL0Field 成功 -> 参数透传（空串 = 清空字段）', async () => {
      const { memory } = setupCompanionApi({
        overview: { revision: 1, enabled: true, l0: null, dmae: null }
      })
      const store = useMemoryStore()
      await store.hydrate()
      expect(await store.setL0Field('occupation', '工程师')).toBe(true)
      expect(memory.setL0Field).toHaveBeenCalledWith({ field: 'occupation', value: '工程师' })
      expect(await store.setL0Field('likes', '')).toBe(true)
      expect(memory.setL0Field).toHaveBeenCalledWith({ field: 'likes', value: '' })
    })

    it('setL0Field 失败 -> lastError 设置', async () => {
      setupCompanionApi({
        overview: { revision: 1, enabled: true, l0: null, dmae: null },
        setL0FieldError: true
      })
      const store = useMemoryStore()
      await store.hydrate()
      const ok = await store.setL0Field('likes', 'x')
      expect(ok).toBe(false)
      expect(store.state.lastError?.code).toBe('MEM_DISABLED')
    })
  })

  describe('分页合并', () => {
    it('offset=0 替换；offset>0 追加并按 id 去重，以新响应覆盖重复项', async () => {
      const item2 = { ...ITEM, id: 'l2_2', content: 'second' }
      const item2Updated = { ...item2, content: 'second-updated' }
      const item3 = { ...ITEM, id: 'l2_3', content: 'third' }
      const { state } = setupCompanionApi({
        overview: { revision: 1, enabled: true, l0: null, dmae: null },
        listResponse: { items: [ITEM, item2], total: 3, revision: 1 }
      })
      const store = useMemoryStore()

      await store.loadL2({ offset: 0, limit: 2 })
      expect(store.state.l2Items.map((m) => m.id)).toEqual(['l2_1', 'l2_2'])

      state.listResponse = { items: [item2Updated, item3], total: 3, revision: 2 }
      await store.loadL2({ offset: 2, limit: 2 })

      expect(store.state.l2Items.map((m) => m.id)).toEqual(['l2_1', 'l2_2', 'l2_3'])
      expect(store.state.l2Items.find((m) => m.id === 'l2_2')?.content).toBe('second-updated')
      expect(store.state.l2Total).toBe(3)
    })
  })

  describe('requestEpoch', () => {
    it('reset 后 epoch 仍单调：旧响应不得覆盖 reset 后的新请求', async () => {
      const { memory } = setupCompanionApi()
      const oldResponse = deferred<ReturnType<typeof makeResult>>()
      const newResponse = deferred<ReturnType<typeof makeResult>>()
      memory.listL2
        .mockReturnValueOnce(oldResponse.promise)
        .mockReturnValueOnce(newResponse.promise)
      const store = useMemoryStore()

      const oldRequest = store.loadL2({ offset: 0, limit: 50 })
      store.reset()
      const newRequest = store.loadL2({ offset: 0, limit: 50 })

      newResponse.resolve(
        makeResult(true, {
          items: [{ ...ITEM, id: 'l2_new', content: 'new' }],
          total: 1,
          revision: 2
        })
      )
      await newRequest
      oldResponse.resolve(
        makeResult(true, {
          items: [{ ...ITEM, id: 'l2_old', content: 'old' }],
          total: 1,
          revision: 1
        })
      )
      await oldRequest

      expect(store.state.l2Items.map((m) => m.id)).toEqual(['l2_new'])
      expect(store.state.revision).toBe(2)
    })
  })

  describe('subscribe', () => {
    it('subscribe 返回 unsubscribe，调用后无异常', () => {
      setupCompanionApi({ overview: { revision: 1, enabled: true, l0: null, dmae: null } })
      const store = useMemoryStore()
      const unsub = store.subscribe()
      expect(typeof unsub).toBe('function')
      expect(() => unsub()).not.toThrow()
    })
  })

  describe('reset', () => {
    it('reset 清空所有 state', async () => {
      setupCompanionApi({
        overview: {
          revision: 5,
          enabled: true,
          l0: { fields: [], filledCount: 1, totalCount: 9 },
          dmae: null
        },
        listResponse: { items: [ITEM], total: 1, revision: 5 }
      })
      const store = useMemoryStore()
      await store.hydrate()
      store.reset()
      expect(store.state.revision).toBe(0)
      expect(store.state.l0).toBeNull()
      expect(store.state.l2Items).toEqual([])
      expect(store.state.l2Total).toBe(0)
    })
  })
})
