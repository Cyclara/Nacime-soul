// @vitest-environment jsdom
// P3X-03：DMAE eligible 集合的分页/游标复位只更新当前 store 投影。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useDmaeStore } from './dmae'
import type { DmaePanelSnapshot } from '@shared/memory/dmae-types'

function snapshot(overrides: Partial<DmaePanelSnapshot> = {}): DmaePanelSnapshot {
  return {
    enabled: true,
    params: {
      maxScore: 100,
      promptThreshold: 30,
      userRewardBase: 20,
      wakeGamma: 0.5,
      modelRewardBase: 8,
      wakeLambda: 0.3,
      decayAlpha: 1.5,
      decayBeta: 0.3
    },
    maxActive: 15,
    currentTurn: 1,
    counts: { eligibleActive: 250, dormant: 0, archived: 0, l2Total: 250 },
    selection: {
      eligibleActiveCount: 250,
      lastRetrievalHits: 2,
      lastPromptSelectedCount: 2,
      lastPromptIncludedCount: 1,
      lastPromptTrimmedCount: 1,
      lastPromptSelectedIds: ['m1'],
      maxActive: 15
    },
    activeSet: [
      {
        memoryId: 'm1',
        contentPreview: 'one',
        activation: 50,
        importance: 5,
        userSilence: 0,
        spark: [],
        trend: 'stable',
        decayExempt: false,
        selectedLastTurn: true,
        injectedLastTurn: true
      }
    ],
    nextEligibleCursor: { turn: 1, activation: 50, memoryId: 'm1' },
    activeSetPaginated: true,
    eligibleCursorReset: false,
    anomalies: [],
    lastBenchmark: null,
    lastQualitative: null,
    stateFile: {
      path: '',
      entries: 250,
      lastSaveOk: true,
      lastSaveAt: 1,
      lastLoadReset: 'none',
      saveFailures7d: 0
    },
    ...overrides
  }
}

describe('P3X-03 DMAE paging store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('next page appends non-stale entries and advances cursor', async () => {
    const first = snapshot()
    const second = snapshot({
      activeSet: [{ ...first.activeSet[0], memoryId: 'm2', activation: 49 }],
      nextEligibleCursor: null
    })
    vi.stubGlobal('window', {
      companion: {
        dmae: {
          getPanel: vi
            .fn()
            .mockResolvedValueOnce({ ok: true, data: first })
            .mockResolvedValueOnce({ ok: true, data: second }),
          getTrend: vi.fn(async () => ({ ok: true, data: [] }))
        }
      }
    })
    const store = useDmaeStore()
    await store.hydrate()
    await store.loadMoreEligible()
    expect(store.state.snapshot?.activeSet.map((entry) => entry.memoryId)).toEqual(['m1', 'm2'])
    expect(store.state.nextEligibleCursor).toBeNull()
  })

  it('stale cursor response replaces rather than appends the list', async () => {
    const first = snapshot()
    const reset = snapshot({
      activeSet: [{ ...first.activeSet[0], memoryId: 'fresh' }],
      eligibleCursorReset: true,
      nextEligibleCursor: null
    })
    vi.stubGlobal('window', {
      companion: {
        dmae: {
          getPanel: vi
            .fn()
            .mockResolvedValueOnce({ ok: true, data: first })
            .mockResolvedValueOnce({ ok: true, data: reset }),
          getTrend: vi.fn(async () => ({ ok: true, data: [] }))
        }
      }
    })
    const store = useDmaeStore()
    await store.hydrate()
    await store.loadMoreEligible()
    expect(store.state.snapshot?.activeSet.map((entry) => entry.memoryId)).toEqual(['fresh'])
  })
})
