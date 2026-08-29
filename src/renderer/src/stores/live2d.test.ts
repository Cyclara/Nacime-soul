// src/renderer/src/stores/live2d.test.ts
// P3A-23：store 只投影 DTO、丢弃旧 revision/sequence，不互调其他 store。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useLive2dStore } from './live2d'
import type { Live2dStateEvent } from '@shared/live2d/public-types'

const state: Live2dStateEvent = {
  models: [
    {
      id: 'mao',
      displayName: 'Mao',
      source: 'builtin',
      cubismVersion: 3,
      expressionCount: 8,
      motionCount: 8,
      hasMouthOpen: false,
      warnings: []
    }
  ],
  selectedModelId: 'mao',
  loadedModelId: 'mao',
  window: {
    visible: true,
    alwaysOnTop: true,
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
    stageStatus: 'ready'
  },
  loading: false,
  lastError: null,
  revision: 2,
  lastEventSequence: 3,
  sequence: 3
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.stubGlobal('window', {
    companion: {
      live2d: {
        getState: vi.fn(async () => ({ ok: true as const, data: state })),
        setVisible: vi.fn(async () => ({ ok: true as const, data: undefined })),
        chooseImportSource: vi.fn(async () => ({
          ok: true as const,
          data: { ok: true, modelId: 'x', displayName: 'X', warnings: [], error: null }
        })),
        selectModel: vi.fn(async () => ({ ok: true as const, data: undefined })),
        resetWindowPlacement: vi.fn(async () => ({ ok: true as const, data: undefined })),
        retryLoad: vi.fn(async () => ({ ok: true as const, data: undefined })),
        onState: vi.fn(() => () => {})
      }
    }
  })
})

describe('P3A-23 useLive2dStore', () => {
  it('hydrate/apply 投影公开 DTO，currentModel/isReady 正确', async () => {
    const store = useLive2dStore()
    await store.hydrate()
    expect(store.currentModel?.id).toBe('mao')
    expect(store.isReady).toBe(true)
    expect(JSON.stringify(store.state)).not.toContain('path')
  })

  it('旧 revision/同 revision 逆序 sequence 不覆盖当前状态', () => {
    const store = useLive2dStore()
    store.applyState(state)
    store.applyState({ ...state, revision: 1, sequence: 99, selectedModelId: null })
    store.applyState({ ...state, revision: 2, sequence: 2, selectedModelId: null })
    expect(store.state.selectedModelId).toBe('mao')
  })

  it('重复 subscribe 先退订旧 listener，reset 清理并恢复初始状态', () => {
    const store = useLive2dStore()
    const first = store.subscribe()
    store.subscribe()
    expect(first).toBeTypeOf('function')
    store.applyState(state)
    store.reset()
    expect(store.state.models).toEqual([])
    expect(store.state.window.stageStatus).toBe('closed')
  })
})
