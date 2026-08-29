// src/main/live2d/public-state.test.ts
// P3A-23：公开快照投影只含 DTO，revision/sequence 单调。

import { describe, expect, it } from 'vitest'
import { createLive2dPublicState } from './public-state'

describe('P3A-23 public Live2D state', () => {
  it('snapshot 隔离 main 内部 window/model 对象，bump 产生单调 event', () => {
    let visible = false
    const source = {
      listModels: () => [{ id: 'mao', displayName: 'Mao', source: 'builtin' as const, cubismVersion: 3, expressionCount: 8, motionCount: 8, hasMouthOpen: false, warnings: [] }],
      selectedModelId: () => 'mao', loadedModelId: () => null,
      window: () => ({ stageInstanceId: null, status: 'starting' as const, visible, alwaysOnTop: true, webContentsId: 2, loadedModelId: null }),
      loading: () => false, lastError: () => null, zoom: () => 1, offset: () => ({ x: 0, y: 0 })
    }
    const state = createLive2dPublicState(source)
    const first = state.bump()
    visible = true
    const second = state.bump()
    expect(first.sequence).toBe(1)
    expect(second.sequence).toBe(2)
    expect(first.window.visible).toBe(false)
    expect(second.window.visible).toBe(true)
    expect(JSON.stringify(second)).not.toContain('webContentsId')
    expect(JSON.stringify(second)).not.toContain('stageInstanceId')
  })
})
