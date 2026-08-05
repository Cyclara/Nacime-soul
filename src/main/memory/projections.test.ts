// src/main/memory/projections.test.ts
// P2-29: 投影函数测试。L0/L2/DMAE 投影脱敏正确性。
// 依据：S-003-补充 §3.7（投影集中定义）、S-006 §1.4（色标/aria）。

import { describe, it, expect } from 'vitest'
import { projectL0, projectL2View, projectL2Detail, projectDmaeSnapshot } from './projections'
import type { L0Store } from './l0-store'
import type { L2Memory } from './l2-store'
import type { DmaeEngineService } from './dmae/service'
import type { MemoryConfig } from '@shared/config/types'

function makeL0Store(
  fields: Record<string, { value: string; isPinned: boolean; updatedAt: number }>
): L0Store {
  return {
    get: () => ({ schemaVersion: 1, fields }),
    getField: () => null,
    set: () => false,
    setPinned: () => {},
    clearField: () => {},
    filledFields: () => Object.keys(fields) as never[],
    on: () => () => {}
  }
}

function makeL2(over: Partial<L2Memory> = {}): L2Memory {
  return {
    id: 'l2_1700000000000_abc123',
    evidenceIds: ['msg_1'],
    sourceMessageIds: ['msg_1'],
    triggerText: '触发文本',
    content: '用户喜欢咖啡',
    confidence: 0.9,
    syncStatus: 'synced',
    lifecycleState: 'active',
    isPinned: false,
    accessCount: 3,
    weight: 1,
    type: 'stable',
    importance: 8,
    archivedAt: null,
    extractionKey: null,
    ...over
  }
}

const MEM_CFG: MemoryConfig = {
  enabled: true,
  embeddingProvider: '',
  embeddingModel: '',
  embeddingDimension: 1024,
  maxActive: 15,
  minRetrievalScore: 0.35,
  dmae: {
    enabled: true,
    maxScore: 100,
    promptThreshold: 30,
    userRewardBase: 20,
    wakeGamma: 0.5,
    modelRewardBase: 8,
    wakeLambda: 0.3,
    decayAlpha: 1.5,
    decayBeta: 0.3
  }
}

describe('P2-29 projections', () => {
  describe('projectL0', () => {
    it('已填字段显示值，未填显示 null', () => {
      const store = makeL0Store({
        preferredName: { value: '小明', isPinned: false, updatedAt: 100 }
      })
      const view = projectL0(store)
      expect(view.totalCount).toBe(9)
      expect(view.filledCount).toBe(1)
      const name = view.fields.find((f) => f.key === 'preferredName')!
      expect(name.value).toBe('小明')
      expect(name.isPinned).toBe(false)
      expect(name.updatedAt).toBe(100)
      const occ = view.fields.find((f) => f.key === 'occupation')!
      expect(occ.value).toBeNull()
    })

    it('字段按固定白名单顺序（不按对象插入顺序）', () => {
      const store = makeL0Store({
        permanentNote: { value: '备注', isPinned: false, updatedAt: 1 },
        preferredName: { value: '小明', isPinned: false, updatedAt: 2 }
      })
      const view = projectL0(store)
      expect(view.fields[0].key).toBe('preferredName')
      expect(view.fields[8].key).toBe('permanentNote')
    })
  })

  describe('projectL2View', () => {
    it('列表投影含 activation/importance，不含 evidence', () => {
      const view = projectL2View(makeL2(), 42.5)
      expect(view.id).toBe('l2_1700000000000_abc123')
      expect(view.content).toBe('用户喜欢咖啡')
      expect(view.activation).toBe(42.5)
      expect(view.importance).toBe(8)
      expect(view.isPinned).toBe(false)
      expect(view.createdAt).toBe(1700000000000)
      // 列表投影不含 evidenceIds
      expect((view as unknown as Record<string, unknown>).evidenceIds).toBeUndefined()
    })

    it('purged 状态降级为 archived（不暴露 purged）', () => {
      const view = projectL2View(makeL2({ lifecycleState: 'purged' }), 0)
      expect(view.lifecycleState).toBe('archived')
    })
  })

  describe('projectL2Detail', () => {
    it('详情含 evidenceIds + sourceMessageIds + triggerText', () => {
      const detail = projectL2Detail(makeL2(), 10)
      expect(detail.evidenceIds).toEqual(['msg_1'])
      expect(detail.sourceMessageIds).toEqual(['msg_1'])
      expect(detail.triggerText).toBe('触发文本')
      expect(detail.content).toBe('用户喜欢咖啡')
    })

    it('triggerText null -> 空字符串', () => {
      const detail = projectL2Detail(makeL2({ triggerText: null }), 0)
      expect(detail.triggerText).toBe('')
    })
  })

  describe('projectDmaeSnapshot', () => {
    it('dmaeService=null -> enabled=false 空快照', () => {
      const view = projectDmaeSnapshot(null, MEM_CFG)
      expect(view.enabled).toBe(false)
      expect(view.counts).toEqual({ active: 0, dormant: 0, archived: 0 })
      expect(view.activeSet).toEqual([])
      expect(view.maxActive).toBe(15)
      expect(view.promptThreshold).toBe(30)
    })

    it('dmaeService 存在 -> 激活集合按 activation 降序 + id 升序截 top maxActive', () => {
      const states = new Map([
        ['l2_1', { activation: 50, userSilence: 0, modelSilence: 0, everActivated: true }],
        ['l2_2', { activation: 80, userSilence: 0, modelSilence: 0, everActivated: true }],
        ['l2_3', { activation: 80, userSilence: 0, modelSilence: 0, everActivated: true }],
        ['l2_4', { activation: 10, userSilence: 0, modelSilence: 0, everActivated: true }] // < threshold, 不进集合
      ])
      const svc: DmaeEngineService = {
        initialize: () => {},
        selectL2: () => [],
        updateTurn: () => ({
          transitions: [],
          stats: {
            userHits: 0,
            modelHits: 0,
            floorRevivals: 0,
            totalDecay: 0,
            active: 0,
            dormant: 0,
            archived: 0
          }
        }),
        getActivation: (id: string) => states.get(id)?.activation ?? 0,
        getStats: () => ({ active: 2, dormant: 1, archived: 1 }),
        get pendingUserHitSessions() {
          return 0
        },
        get states() {
          return states
        }
      }
      const view = projectDmaeSnapshot(svc, MEM_CFG)
      expect(view.enabled).toBe(true)
      expect(view.counts).toEqual({ active: 2, dormant: 1, archived: 1 })
      // threshold=30: l2_4(10) 不进；l2_2(80) 和 l2_3(80) 同分 id 升序；l2_1(50)
      expect(view.activeSet.map((a) => a.memoryId)).toEqual(['l2_2', 'l2_3', 'l2_1'])
    })
  })
})
