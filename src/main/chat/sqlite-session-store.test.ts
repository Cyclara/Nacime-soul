// src/main/chat/sqlite-session-store.test.ts
// P2-43: SQLite SessionStore 单元测试。
// 依据：S-002-补充-P2-43 §5 测试矩阵 #1/#2/#3——与内存实现逐条语义等价 + 启动中断修复。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { ChatMessage } from '@shared/chat/types'
import { createMemorySessionStore } from './session-store'
import { createSQLiteSessionStore } from './sqlite-session-store'
import { makeMemoryDb, testNoopLogger, type TestDb } from '../../../tests/helpers/test-db'

let t: TestDb
beforeEach(async () => {
  t = await makeMemoryDb()
})
afterEach(() => t.cleanup())

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    sessionId: 's-1',
    role: 'user',
    content: '你好',
    createdAt: 1_000,
    status: 'complete',
    ...overrides
  }
}

describe('P2-43 SQLiteSessionStore：CRUD 与内存语义等价', () => {
  it('createSession -> exists；空库 getLastSessionId -> null', () => {
    const store = createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    expect(store.getLastSessionId()).toBeNull()
    expect(store.exists('nope')).toBe(false)

    const sid = store.createSession()
    expect(store.exists(sid)).toBe(true)
    expect(store.getLastSessionId()).toBe(sid)
  })

  it('appendMessage 自动建会话、seq 单调、getMessages 取最近 limit 条且升序', () => {
    const store = createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    const sid = 's-auto'
    expect(store.exists(sid)).toBe(false) // 宽松语义：append 自动创建

    for (let i = 0; i < 5; i++) {
      store.appendMessage(sid, makeMessage({ id: `m${i}`, createdAt: 1_000 + i, content: `c${i}` }))
    }
    expect(store.exists(sid)).toBe(true)

    const all = store.getMessages(sid, 100)
    expect(all.map((m) => m.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4'])

    // limit 取"最近 3 条"且保持升序（与内存 slice 语义一致）
    const last3 = store.getMessages(sid, 3)
    expect(last3.map((m) => m.id)).toEqual(['m2', 'm3', 'm4'])
  })

  it('appendMessage 刷新 updated_at：getLastSessionId 跟随最近活跃会话', () => {
    const store = createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    const a = store.createSession()
    const b = store.createSession()
    expect(store.getLastSessionId()).toBe(b)

    // 给 a 追加一条更晚的消息 -> a 变最热
    store.appendMessage(a, makeMessage({ id: 'ma', sessionId: a, createdAt: 9_999 }))
    expect(store.getLastSessionId()).toBe(a)
  })

  it('getTurnMessages：assistant 非 complete 返回 null', () => {
    const store = createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    const sid = 's-1'
    store.appendMessage(sid, makeMessage({ id: 'u1', turnId: 't1' }))
    store.appendMessage(
      sid,
      makeMessage({ id: 'a1', role: 'assistant', turnId: 't1', status: 'streaming' })
    )
    expect(store.getTurnMessages(sid, 't1')).toBeNull()

    store.updateMessage(sid, 'a1', { status: 'complete', content: '回复' })
    const pair = store.getTurnMessages(sid, 't1')
    expect(pair).not.toBeNull()
    expect(pair!.user.id).toBe('u1')
    expect(pair!.assistant.content).toBe('回复')
  })

  it('getMessage / updateMessage：白名单列回写，可选字段往返（reasoning/errorCode/turnId）', () => {
    const store = createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    const sid = 's-1'
    store.appendMessage(
      sid,
      makeMessage({
        id: 'm1',
        role: 'assistant',
        status: 'streaming',
        reasoning: '思考中',
        turnId: 't1'
      })
    )

    const before = store.getMessage(sid, 'm1')
    expect(before!.reasoning).toBe('思考中')
    expect(before!.turnId).toBe('t1')

    store.updateMessage(sid, 'm1', { status: 'failed', errorCode: 'NET_TIMEOUT' })
    const after = store.getMessage(sid, 'm1')
    expect(after!.status).toBe('failed')
    expect(after!.errorCode).toBe('NET_TIMEOUT')
    expect(after!.reasoning).toBe('思考中') // 未 patch 的字段不动

    expect(store.getMessage(sid, 'missing')).toBeNull()
  })

  it('toView 与内存实现同输入同输出（共享 chatMessageToView 防漂移）', () => {
    const sqlite = createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    const memory = createMemorySessionStore()
    const msg = makeMessage({
      role: 'assistant',
      status: 'failed',
      reasoning: 'r',
      errorCode: 'NET_DNS',
      turnId: 't1'
    })
    expect(sqlite.toView(msg)).toEqual(memory.toView(msg))
    // sessionId/turnId 不得泄漏到 view
    expect(sqlite.toView(msg)).not.toHaveProperty('sessionId')
    expect(sqlite.toView(msg)).not.toHaveProperty('turnId')
  })
})

describe('P2-43 SQLiteSessionStore：启动中断修复（§2.3）', () => {
  it('构造时 streaming -> failed；complete/failed/cancelled 不动；新实例才触发（崩溃语义）', () => {
    // 第一个实例：正常写入三种状态（模拟崩溃前的现场）
    const first = createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    const sid = 's-1'
    first.appendMessage(sid, makeMessage({ id: 'ok', status: 'complete' }))
    first.appendMessage(sid, makeMessage({ id: 'bad', status: 'failed' }))
    first.appendMessage(sid, makeMessage({ id: 'stop', status: 'cancelled' }))
    first.appendMessage(sid, makeMessage({ id: 'ghost', role: 'assistant', status: 'streaming' }))

    // 模拟重启：新实例构造即修复
    createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })

    const check = createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    expect(check.getMessage(sid, 'ghost')!.status).toBe('failed') // 尸体被修复
    expect(check.getMessage(sid, 'ok')!.status).toBe('complete')
    expect(check.getMessage(sid, 'bad')!.status).toBe('failed')
    expect(check.getMessage(sid, 'stop')!.status).toBe('cancelled')
  })
})

describe('M-39 SQLiteSessionStore：孤儿轮次修复（启动中断修复第二类）', () => {
  it('用户消息有 turnId 但无 assistant 配对 -> 补 failed 占位（CHAT_INTERRUPTED）', () => {
    const first = createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    const sid = 's-1'
    // 模拟进程在"用户消息已落库、assistant 未落库"之间死亡
    first.appendMessage(sid, makeMessage({ id: 'u1', turnId: 't1' }))

    // 模拟重启：新实例构造即修复
    createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })

    const check = createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    const msgs = check.getMessages(sid, 100)
    expect(msgs).toHaveLength(2)
    const placeholder = msgs[1]
    expect(placeholder.role).toBe('assistant')
    expect(placeholder.status).toBe('failed')
    expect(placeholder.errorCode).toBe('CHAT_INTERRUPTED')
    expect(placeholder.turnId).toBe('t1')
    expect(placeholder.content).toBe('')
  })

  it('占位紧跟孤儿用户消息（尾部），且修复一次性（再次构造不重复补）', () => {
    const first = createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    const sid = 's-1'
    first.appendMessage(sid, makeMessage({ id: 'u0', turnId: 't0' }))
    first.appendMessage(
      sid,
      makeMessage({ id: 'a0', role: 'assistant', turnId: 't0', status: 'complete' })
    )
    first.appendMessage(sid, makeMessage({ id: 'u1', turnId: 't1' })) // 孤儿在尾部

    createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    createSQLiteSessionStore({ db: t.db, logger: testNoopLogger }) // 第三次构造不重复补

    const check = createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    const msgs = check.getMessages(sid, 100)
    expect(msgs).toHaveLength(4)
    expect(msgs[0].id).toBe('u0')
    expect(msgs[1].id).toBe('a0')
    expect(msgs[2].id).toBe('u1')
    expect(msgs[3].turnId).toBe('t1')
    expect(msgs[3].status).toBe('failed')
  })

  it('已有 assistant（任何状态）的轮次不是孤儿；无 turnId 的用户消息跳过', () => {
    const first = createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    const sid = 's-1'
    first.appendMessage(sid, makeMessage({ id: 'u1', turnId: 't1' }))
    first.appendMessage(
      sid,
      makeMessage({ id: 'a1', role: 'assistant', turnId: 't1', status: 'failed' })
    )
    first.appendMessage(sid, makeMessage({ id: 'u2' })) // 无 turnId（Phase 1 遗留消息）

    createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })

    const check = createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    expect(check.getMessages(sid, 100)).toHaveLength(3) // 没有补任何占位
  })

  it('修复不改变会话活跃排序（占位是修复产物，不 touch updated_at）', () => {
    const first = createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    const a = first.createSession()
    const b = first.createSession()
    // b 里制造孤儿；随后让 a 变成最热
    first.appendMessage(b, makeMessage({ id: 'u1', sessionId: b, turnId: 't1' }))
    first.appendMessage(a, makeMessage({ id: 'x', sessionId: a }))
    expect(first.getLastSessionId()).toBe(a)

    createSQLiteSessionStore({ db: t.db, logger: testNoopLogger }) // 修复 b 的孤儿

    const check = createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    expect(check.getLastSessionId()).toBe(a) // a 仍最热：修复没有 bump b
    // b 的孤儿确实被补了占位
    const bMsgs = check.getMessages(b, 100)
    expect(bMsgs).toHaveLength(2)
    expect(bMsgs[1].errorCode).toBe('CHAT_INTERRUPTED')
  })
})

describe('验收反馈④c：deleteSupersededAssistantMessages（重试终局清理）', () => {
  it('删除同轮 failed/cancelled assistant 行，保留 keep 行与 complete 行；user 行不动', () => {
    const store = createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    const sid = 's-1'
    store.appendMessage(sid, makeMessage({ id: 'u1', turnId: 't1' }))
    store.appendMessage(
      sid,
      makeMessage({ id: 'a-old', role: 'assistant', turnId: 't1', status: 'failed', errorCode: 'NET_TIMEOUT' })
    )
    store.appendMessage(
      sid,
      makeMessage({ id: 'a-cancel', role: 'assistant', turnId: 't1', status: 'cancelled' })
    )
    store.appendMessage(
      sid,
      makeMessage({ id: 'a-new', role: 'assistant', turnId: 't1', status: 'complete', content: '新回答' })
    )
    // 另一轮的 failed 行不受影响
    store.appendMessage(
      sid,
      makeMessage({ id: 'a-other', role: 'assistant', turnId: 't2', status: 'failed', errorCode: 'NET_TIMEOUT' })
    )

    const removed = store.deleteSupersededAssistantMessages(sid, 't1', 'a-new')
    expect(removed).toBe(2)

    const msgs = store.getMessages(sid, 100)
    expect(msgs.map((m) => m.id)).toEqual(['u1', 'a-new', 'a-other'])
  })

  it('complete 行绝不删（防御：同一轮出现两条 complete 也不动旧的）', () => {
    const store = createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    const sid = 's-1'
    store.appendMessage(sid, makeMessage({ id: 'u1', turnId: 't1' }))
    store.appendMessage(
      sid,
      makeMessage({ id: 'a-good', role: 'assistant', turnId: 't1', status: 'complete', content: '旧好回答' })
    )
    store.appendMessage(
      sid,
      makeMessage({ id: 'a-new', role: 'assistant', turnId: 't1', status: 'complete', content: '新回答' })
    )

    const removed = store.deleteSupersededAssistantMessages(sid, 't1', 'a-new')
    expect(removed).toBe(0)
    expect(store.getMessages(sid, 100)).toHaveLength(3)
  })

  it('无可删行返回 0；与内存实现语义一致', () => {
    const sqlite = createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    const memory = createMemorySessionStore()
    const sid = 's-1'
    const seed = (store: typeof sqlite): void => {
      store.appendMessage(sid, makeMessage({ id: 'u1', turnId: 't1' }))
      store.appendMessage(
        sid,
        makeMessage({ id: 'a1', role: 'assistant', turnId: 't1', status: 'failed', errorCode: 'CHAT_INTERRUPTED' })
      )
      store.appendMessage(
        sid,
        makeMessage({ id: 'a2', role: 'assistant', turnId: 't1', status: 'complete', content: '答' })
      )
    }
    seed(sqlite)
    seed(memory)

    expect(sqlite.deleteSupersededAssistantMessages(sid, 't1', 'a2')).toBe(1)
    expect(memory.deleteSupersededAssistantMessages(sid, 't1', 'a2')).toBe(1)
    expect(sqlite.getMessages(sid, 100).map((m) => m.id)).toEqual(
      memory.getMessages(sid, 100).map((m) => m.id)
    )
    // 再删一次：幂等 0
    expect(sqlite.deleteSupersededAssistantMessages(sid, 't1', 'a2')).toBe(0)
  })
})
