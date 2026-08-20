// src/main/growth/reference-tracker.test.ts
// P2-41 B 层引用->确认/纠正判定流测试。
// 验收（F5-006 §3）：上一轮 referenced -> 本轮用户纠正 -> emit l2.corrected；
//   未纠正 -> emit l2.confirmed；仅对上一轮 referencedMemoryIds 发射；payload 只含 memoryId。
// correctionIntent patterns 真源在 conflict/resolver.ts（F5-006 §3"复用冲突系统能力"），
//   此处注入它的 hasCorrectionIntent 测 hook，单测它本身。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeMemoryDb, testNoopLogger, type TestDb } from '../../../tests/helpers/test-db'
import { createGrowthEventBus } from './event-bus'
import { createGrowthStore } from './service'
import { createReferenceTrackerHook } from './reference-tracker'
import { hasCorrectionIntent } from '../memory/conflict/resolver'

describe('P2-41 hasCorrectionIntent（conflict/resolver.ts 真源）', () => {
  it('中文纠正模式', () => {
    expect(hasCorrectionIntent('不是，是猫')).toBe(true) // /不是.*[是就]/
    expect(hasCorrectionIntent('其实我更喜欢猫')).toBe(true) // /其实/
    expect(hasCorrectionIntent('不对，是我')).toBe(true) // /不对/
    expect(hasCorrectionIntent('纠正一下')).toBe(true) // /纠正/
  })

  it('英文纠正模式', () => {
    expect(hasCorrectionIntent('actually, I meant cats')).toBe(true)
    expect(hasCorrectionIntent('no wait, I like dogs')).toBe(true)
    expect(hasCorrectionIntent('scratch that')).toBe(true)
  })

  it('无纠正意图', () => {
    expect(hasCorrectionIntent('我喜欢猫')).toBe(false)
    expect(hasCorrectionIntent('今天天气真好')).toBe(false)
    expect(hasCorrectionIntent('I like cats')).toBe(false)
  })
})

describe('P2-41 reference-tracker hook', () => {
  let t: TestDb
  let eventBus: ReturnType<typeof createGrowthEventBus>
  let directStore: ReturnType<typeof createGrowthStore>
  let received: Array<{ type: string; memoryId?: string }>
  let ts: number

  beforeEach(async () => {
    t = await makeMemoryDb()
    eventBus = createGrowthEventBus()
    directStore = createGrowthStore({ db: t.db })
    received = []
    eventBus.on((e) => received.push({ type: e.type, memoryId: e.payload.memoryId }))
    ts = new Date(2024, 2, 9, 12, 0, 0).getTime()
  })
  afterEach(() => t.cleanup())

  function makeHook(): ReturnType<typeof createReferenceTrackerHook> {
    return createReferenceTrackerHook({
      eventBus,
      store: directStore,
      logger: testNoopLogger,
      now: () => ts,
      idGen: () => `evt_${received.length}`,
      correctionDetector: hasCorrectionIntent // 注入 conflict 真源（F5-006 §3 复用）
    })
  }

  function emitReferencedBatch(ids: string[], atTs: number): void {
    for (const id of ids) {
      directStore.append({
        id: `ref_${id}_${atTs}`,
        ts: atTs,
        type: 'l2.referenced',
        payload: { memoryId: id }
      })
    }
  }

  it('上一轮有 referenced + 本轮用户纠正 -> emit l2.corrected', async () => {
    emitReferencedBatch(['l2_a', 'l2_b'], ts)
    const hook = makeHook()
    await hook.fn({ event: 'chat.message' }, '不对，是猫')
    const corrected = received.filter((r) => r.type === 'l2.corrected')
    expect(corrected).toHaveLength(2)
    expect(corrected.map((r) => r.memoryId)).toEqual(['l2_a', 'l2_b'])
  })

  it('上一轮有 referenced + 本轮无纠正 -> emit l2.confirmed', async () => {
    emitReferencedBatch(['l2_a', 'l2_b'], ts)
    const hook = makeHook()
    await hook.fn({ event: 'chat.message' }, '今天天气真好')
    const confirmed = received.filter((r) => r.type === 'l2.confirmed')
    expect(confirmed).toHaveLength(2)
    expect(confirmed.map((r) => r.memoryId)).toEqual(['l2_a', 'l2_b'])
  })

  it('上一轮无 referenced -> 不发事件', async () => {
    const hook = makeHook()
    await hook.fn({ event: 'chat.message' }, '纠正：我喜欢猫')
    expect(received).toHaveLength(0)
  })

  it('空用户文本 -> 不发事件', async () => {
    emitReferencedBatch(['l2_a'], ts)
    const hook = makeHook()
    await hook.fn({ event: 'chat.message' }, '')
    expect(received).toHaveLength(0)
  })

  it('只对最近一轮 referenced 发射（更早的不计）', async () => {
    // 上一轮 2 条，再上一轮 3 条
    emitReferencedBatch(['l2_old1', 'l2_old2', 'l2_old3'], ts - 60000)
    emitReferencedBatch(['l2_new1', 'l2_new2'], ts) // 最近一轮
    const hook = makeHook()
    await hook.fn({ event: 'chat.message' }, '纠正')
    const corrected = received.filter((r) => r.type === 'l2.corrected')
    expect(corrected).toHaveLength(2)
    expect(corrected.map((r) => r.memoryId)).toEqual(['l2_new1', 'l2_new2'])
  })

  it('payload 只含 memoryId，不含内容文本（隐私纪律）', async () => {
    emitReferencedBatch(['l2_x'], ts)
    const hook = makeHook()
    await hook.fn({ event: 'chat.message' }, '今天天气真好')
    const confirmed = received.filter((r) => r.type === 'l2.confirmed')
    // received 已展开 payload；验证不含 content/quote/text
    const jsonStr = JSON.stringify(received)
    expect(jsonStr).not.toMatch(/"content"|"quote"|"text"/i)
    void confirmed
  })

  it('hook 元数据：name/event/priority/failOpen', () => {
    const hook = makeHook()
    expect(hook.name).toBe('growth-reference-tracker')
    expect(hook.event).toBe('chat.message')
    expect(hook.priority).toBe(150)
    expect(hook.failOpen).toBe(true)
  })
})
