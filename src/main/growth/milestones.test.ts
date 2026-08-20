// src/main/growth/milestones.test.ts
// P2-41 里程碑引擎测试。
// 验收（S-Phase2 P2-41）：MILESTONES_V1 引擎只触发一次不回退、promptFragments 接入、
//   填 preferredName -> ms.name 达成、condition 检查、叙事模板渲染。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeMemoryDb, testNoopLogger, type TestDb } from '../../../tests/helpers/test-db'
import {
  createMilestoneStore,
  findNewlyReachedMilestones,
  isMilestoneReached,
  loadMilestones,
  collectPromptFragments,
  renderNarrative,
  makeMilestoneEvent
} from './milestones'
import { MILESTONES_V1 } from './types'
import type { GrowthSnapshot, MilestoneDef } from './types'

function emptySnapshot(date: string, overrides: Partial<GrowthSnapshot> = {}): GrowthSnapshot {
  return {
    date,
    l0FillRate: 0,
    l0FilledCount: 0,
    l1FreshnessScore: 0,
    l2Total: 0,
    l2ByState: { active: 0, dormant: 0, archived: 0 },
    refAccuracy7d: null,
    correctionsTotal: 0,
    manualEvalScore: null,
    dmaeAvgActivation: 0,
    dmaeOldestActiveDays: 0,
    understanding: 0,
    activeDays: 0,
    uniqueTopics: 0,
    ...overrides
  }
}

describe('P2-41 MilestoneStore', () => {
  let t: TestDb
  let store: ReturnType<typeof createMilestoneStore>

  beforeEach(async () => {
    t = await makeMemoryDb()
    store = createMilestoneStore({ db: t.db })
  })
  afterEach(() => t.cleanup())

  it('add + has: 记录达成状态', () => {
    expect(store.has('ms.name')).toBe(false)
    store.add('ms.name', 1710000000000)
    expect(store.has('ms.name')).toBe(true)
  })

  it('只增不删（F5-006 §5）：重复 add 同 id 幂等', () => {
    store.add('ms.name', 1710000000000)
    store.add('ms.name', 1710000001000) // 重复 add 不报错、不更新 ts（INSERT OR IGNORE）
    const list = store.list()
    expect(list).toHaveLength(1)
    expect(list[0].ts).toBe(1710000000000) // 第一条 ts 保留
  })

  it('list 按 ts 升序', () => {
    store.add('ms.u30', 3000)
    store.add('ms.u10', 1000)
    store.add('ms.u60', 5000)
    const list = store.list()
    expect(list.map((m) => m.id)).toEqual(['ms.u10', 'ms.u30', 'ms.u60'])
  })
})

describe('P2-41 isMilestoneReached', () => {
  const filled = new Set<string>(['preferredName'])

  it('l0.field:preferredName + field 已填 -> 达成', () => {
    const def = MILESTONES_V1.find((m) => m.id === 'ms.name')!
    expect(isMilestoneReached(def, emptySnapshot('2024-03-09'), filled)).toBe(true)
  })

  it('l0.field:preferredName + field 未填 -> 未达成', () => {
    const def = MILESTONES_V1.find((m) => m.id === 'ms.name')!
    expect(isMilestoneReached(def, emptySnapshot('2024-03-09'), new Set())).toBe(false)
  })

  it('understanding >= 10 -> ms.u10 达成', () => {
    const def = MILESTONES_V1.find((m) => m.id === 'ms.u10')!
    expect(
      isMilestoneReached(def, emptySnapshot('2024-03-09', { understanding: 10 }), filled)
    ).toBe(true)
    expect(isMilestoneReached(def, emptySnapshot('2024-03-09', { understanding: 9 }), filled)).toBe(
      false
    )
  })

  it('activeDays >= 30 -> ms.month 达成', () => {
    const def = MILESTONES_V1.find((m) => m.id === 'ms.month')!
    expect(isMilestoneReached(def, emptySnapshot('2024-03-09', { activeDays: 30 }), filled)).toBe(
      true
    )
  })

  it('l2Total >= 100 -> ms.l2_100 达成', () => {
    const def = MILESTONES_V1.find((m) => m.id === 'ms.l2_100')!
    expect(isMilestoneReached(def, emptySnapshot('2024-03-09', { l2Total: 100 }), filled)).toBe(
      true
    )
  })

  it('correctionsTotal >= 1 -> ms.firstFix 达成', () => {
    const def = MILESTONES_V1.find((m) => m.id === 'ms.firstFix')!
    expect(
      isMilestoneReached(def, emptySnapshot('2024-03-09', { correctionsTotal: 1 }), filled)
    ).toBe(true)
  })
})

describe('P2-41 findNewlyReachedMilestones', () => {
  let t: TestDb
  let store: ReturnType<typeof createMilestoneStore>

  beforeEach(async () => {
    t = await makeMemoryDb()
    store = createMilestoneStore({ db: t.db })
  })
  afterEach(() => t.cleanup())

  it('只返回未记录的新达成里程碑（已达成的不重复触发）', () => {
    store.add('ms.name', 1000) // ms.name 已达成
    const filled = new Set<string>(['preferredName'])
    const snap = emptySnapshot('2024-03-09', { understanding: 12, activeDays: 7 })
    // ms.name 已达成；ms.u10(understanding>=10)、ms.week(activeDays>=7) 应新达成
    const newly = findNewlyReachedMilestones(MILESTONES_V1, snap, filled, store)
    const ids = newly.map((m) => m.id)
    expect(ids).not.toContain('ms.name')
    expect(ids).toContain('ms.u10')
    expect(ids).toContain('ms.week')
  })

  it('无新达成时返回空数组', () => {
    const snap = emptySnapshot('2024-03-09') // 全 0
    const newly = findNewlyReachedMilestones(MILESTONES_V1, snap, new Set(), store)
    expect(newly).toHaveLength(0)
  })
})

describe('P2-41 collectPromptFragments', () => {
  it('已达成里程碑的非空 promptFragment，按达成顺序', () => {
    const reached = [
      { id: 'ms.name', ts: 1000 },
      { id: 'ms.u10', ts: 2000 },
      { id: 'ms.l2_100', ts: 3000 } // promptFragment 为空
    ]
    const fragments = collectPromptFragments(MILESTONES_V1, reached)
    expect(fragments).toHaveLength(2) // ms.l2_100 的 fragment 为空被过滤
    expect(fragments[0]).toContain('名字')
    expect(fragments[1]).toContain('刚认识')
  })

  it('未知 milestoneId 被跳过', () => {
    const reached = [{ id: 'ms.unknown', ts: 1000 }]
    expect(collectPromptFragments(MILESTONES_V1, reached)).toEqual([])
  })
})

describe('P2-41 renderNarrative', () => {
  it('{{l2Total}} 占位替换', () => {
    const snap = emptySnapshot('2024-03-09', { l2Total: 123 })
    const out = renderNarrative('你们之间已经有 {{l2Total}} 段共同记忆。', snap)
    expect(out).toBe('你们之间已经有 123 段共同记忆。')
  })

  it('未知占位替换为空字符串', () => {
    const out = renderNarrative('未知 {{nonExistent}} 字段', emptySnapshot('2024-03-09'))
    expect(out).toBe('未知  字段')
  })
})

describe('P2-41 loadMilestones', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nacime-ms-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('文件不存在 -> 回退 MILESTONES_V1', () => {
    const loaded = loadMilestones(join(dir, 'nope.json'), testNoopLogger)
    expect(loaded).toBe(MILESTONES_V1)
  })

  it('文件存在且合法 -> 加载内容', () => {
    const custom: MilestoneDef[] = [
      {
        id: 'ms.custom',
        title: '自定义',
        condition: { metric: 'understanding', op: '>=', value: 20 },
        promptFragment: '自定义片段',
        narrativeTemplate: '自定义叙事',
        once: true
      }
    ]
    writeFileSync(join(dir, 'milestones.json'), JSON.stringify(custom), 'utf-8')
    const loaded = loadMilestones(join(dir, 'milestones.json'), testNoopLogger)
    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe('ms.custom')
  })

  it('文件非法 JSON -> 回退 MILESTONES_V1', () => {
    writeFileSync(join(dir, 'milestones.json'), 'not json', 'utf-8')
    const loaded = loadMilestones(join(dir, 'milestones.json'), testNoopLogger)
    expect(loaded).toBe(MILESTONES_V1)
  })

  it('文件非数组 -> 回退 MILESTONES_V1', () => {
    writeFileSync(join(dir, 'milestones.json'), '{}', 'utf-8')
    const loaded = loadMilestones(join(dir, 'milestones.json'), testNoopLogger)
    expect(loaded).toBe(MILESTONES_V1)
  })
})

describe('P2-41 makeMilestoneEvent', () => {
  it('构造 milestone.reached 事件，payload 只含 milestoneId', () => {
    const def = MILESTONES_V1[0]
    let i = 0
    const evt = makeMilestoneEvent(def, 12345, () => `id_${i++}`)
    expect(evt.type).toBe('milestone.reached')
    expect(evt.ts).toBe(12345)
    expect(evt.payload.milestoneId).toBe(def.id)
    const payloadStr = JSON.stringify(evt.payload)
    expect(payloadStr).not.toMatch(/content|quote|text/i) // 隐私纪律
  })
})
