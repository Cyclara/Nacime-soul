// src/main/compliance/feedback.test.ts
// P3C1-07：合规用户反馈--方向语义（dislike vs out-of-character）/ 幂等 / 关联校验 /
// 裁定 1.7 写入纪律（turns 行不存在静默忽略）/ 指标与补审回调的一次性 / 日志红线。
// 依据：F5-001 §3.7 + 开工裁定 1.7（#1 dislikeOnHitTurns 排除 OOC；#3 独立表 +
// UNIQUE(message_id, kind) 幂等 + INSERT 前查 turns 行存在性）。

import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import type { Logger, LogFields, MetricsRegistry } from '@shared/observability/types'
import { createMetrics } from '../observability/metrics'
import { createMemorySessionStore, type SessionStore } from '../chat/session-store'
import type { ChatMessage } from '@shared/chat/types'
import type { ChatFeedbackRequest } from '@shared/compliance/types'
import { migration as m009 } from '../migrations/scripts/009_compliance_history'
import { createComplianceFeedbackService, type ComplianceFeedbackOutcome } from './feedback'

// === 测试辅助 ===

function noopLogger(): Logger {
  const l: Logger = {
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
    child: () => l
  }
  return l
}

interface LogCall {
  readonly level: 'fatal' | 'error' | 'warn' | 'info' | 'debug'
  readonly msg: string
  readonly fields: LogFields
}

function spyLogger(): { logger: Logger; calls: LogCall[] } {
  const calls: LogCall[] = []
  const rec =
    (level: LogCall['level']) =>
    (msg: string, fields: LogFields): void => {
      calls.push({ level, msg, fields })
    }
  const l: Logger = {
    fatal: rec('fatal'),
    error: rec('error'),
    warn: rec('warn'),
    info: rec('info'),
    debug: rec('debug'),
    child: () => l
  }
  return { logger: l, calls }
}

interface FeedbackRow {
  turn_id: string
  message_id: string
  kind: string
  created_at: number
}

interface FixtureOptions {
  /** false = 不建 compliance_turns 行（模拟门控未启用的轮） */
  withTurnRow?: boolean
  logger?: Logger
  metrics?: MetricsRegistry
  onDislike?: (turnId: string, sessionId: string, messageId: string) => void
}

interface Fixture {
  db: Database.Database
  store: SessionStore
  sessionId: string
  /** turn-1 的 assistant 消息 id */
  messageId: string
  /** 按默认参数（turn-1 / msg-a1 / dislike）记录，可覆写任一字段 */
  record: (overrides?: Partial<ChatFeedbackRequest>) => ComplianceFeedbackOutcome
  /** 全部已插入的 feedback 行（按插入序） */
  rows: () => FeedbackRow[]
  rowCount: () => number
}

const dbs: Database.Database[] = []
afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      db.close()
    } catch {
      /* best-effort */
    }
  }
})

function insertTurnRow(db: Database.Database, turnId: string): void {
  db.prepare(
    `INSERT INTO compliance_turns (turn_id, occurred_at, gate_scope) VALUES (?, 1000, 'observe')`
  ).run(turnId)
}

/** 建库（迁移 009 三表）+ 会话内一轮完整对话（user msg-u1 + assistant msg-a1，turn-1）。 */
function makeFixture(opts: FixtureOptions = {}): Fixture {
  const db = new Database(':memory:')
  dbs.push(db)
  m009.up({ db, dataDir: '.', log: noopLogger(), dryRun: false })
  if (opts.withTurnRow !== false) {
    insertTurnRow(db, 'turn-1')
  }
  const store = createMemorySessionStore()
  const sessionId = store.createSession()
  store.appendMessage(sessionId, {
    id: 'msg-u1',
    sessionId,
    role: 'user',
    content: 'user text',
    createdAt: 1,
    status: 'complete',
    turnId: 'turn-1'
  } satisfies ChatMessage)
  store.appendMessage(sessionId, {
    id: 'msg-a1',
    sessionId,
    role: 'assistant',
    content: 'assistant reply',
    createdAt: 2,
    status: 'complete',
    turnId: 'turn-1'
  } satisfies ChatMessage)
  const service = createComplianceFeedbackService({
    db,
    sessionStore: store,
    logger: opts.logger,
    metrics: opts.metrics,
    onDislike: opts.onDislike,
    now: () => 5_000
  })
  return {
    db,
    store,
    sessionId,
    messageId: 'msg-a1',
    record: (overrides) =>
      service.recordFeedback({
        sessionId,
        turnId: 'turn-1',
        messageId: 'msg-a1',
        kind: 'dislike',
        ...overrides
      }),
    rows: () =>
      db
        .prepare(
          `SELECT turn_id, message_id, kind, created_at FROM compliance_feedback ORDER BY id`
        )
        .all() as FeedbackRow[],
    rowCount: () =>
      (db.prepare(`SELECT COUNT(*) AS n FROM compliance_feedback`).get() as { n: number }).n
  }
}

// === 方向语义：dislike（§3.7 强制补审 + compliance.userDislike） ===

describe('P3C1-07 feedback：dislike 首次上报', () => {
  it('插入一行 + compliance.userDislike +1 + onDislike 回调恰好一次（带 turn/session/message 关联）', () => {
    const metrics = createMetrics()
    const cbArgs: Array<[string, string, string]> = []
    const f = makeFixture({
      metrics,
      onDislike: (turnId, sid, mid) => cbArgs.push([turnId, sid, mid])
    })

    const outcome = f.record({ kind: 'dislike' })

    expect(outcome).toEqual({ status: 'inserted', kind: 'dislike' })
    expect(metrics.counter('compliance.userDislike').value()).toBe(1)
    expect(cbArgs).toEqual([['turn-1', f.sessionId, 'msg-a1']])
    expect(f.rows()).toEqual([
      { turn_id: 'turn-1', message_id: 'msg-a1', kind: 'dislike', created_at: 5_000 }
    ])
  })

  it('created_at 用注入时钟', () => {
    const f = makeFixture()
    f.record({ kind: 'dislike' })
    expect(f.rows()[0]?.created_at).toBe(5_000)
  })
})

// === 幂等（§3.7 + UNIQUE(message_id, kind)） ===

describe('P3C1-07 feedback：幂等', () => {
  it('同消息同 kind 重复上报只计一次：一行 / 指标不涨 / 回调不重发', () => {
    const metrics = createMetrics()
    let callbackCount = 0
    const f = makeFixture({
      metrics,
      onDislike: () => {
        callbackCount++
      }
    })

    const first = f.record()
    const second = f.record()
    const third = f.record()

    expect(first).toEqual({ status: 'inserted', kind: 'dislike' })
    expect(second).toEqual({ status: 'duplicate' })
    expect(third).toEqual({ status: 'duplicate' })
    expect(metrics.counter('compliance.userDislike').value()).toBe(1)
    expect(callbackCount).toBe(1)
    expect(f.rowCount()).toBe(1)
  })

  it('同消息 dislike + out-of-character 各占一行（单槽废除的动机，裁定 1.7 #3）', () => {
    const f = makeFixture()
    f.record({ kind: 'dislike' })
    const ooc = f.record({ kind: 'out-of-character' })
    expect(ooc).toEqual({ status: 'inserted', kind: 'out-of-character' })
    expect(f.rows().map((r) => r.kind)).toEqual(['dislike', 'out-of-character'])
  })

  it('OOC 重复上报同样幂等', () => {
    const f = makeFixture()
    f.record({ kind: 'out-of-character' })
    expect(f.record({ kind: 'out-of-character' })).toEqual({ status: 'duplicate' })
    expect(f.rowCount()).toBe(1)
  })
})

// === 方向语义：out-of-character（漏报线索，非 dislike） ===

describe('P3C1-07 feedback：out-of-character 方向正确性', () => {
  it('OOC 落库但恒不计 dislike 指标、恒不触发补审回调（裁定 1.7 #1/#2）', () => {
    const metrics = createMetrics()
    let callbackCount = 0
    const f = makeFixture({
      metrics,
      onDislike: () => {
        callbackCount++
      }
    })

    const outcome = f.record({ kind: 'out-of-character' })

    expect(outcome).toEqual({ status: 'inserted', kind: 'out-of-character' })
    expect(metrics.counter('compliance.userDislike').value()).toBe(0)
    expect(callbackCount).toBe(0)
    expect(f.rowCount()).toBe(1)
  })

  it('先 dislike 后 OOC：OOC 不追加指标/回调（各 kind 独立计数）', () => {
    const metrics = createMetrics()
    let callbackCount = 0
    const f = makeFixture({
      metrics,
      onDislike: () => {
        callbackCount++
      }
    })
    f.record({ kind: 'dislike' })
    f.record({ kind: 'out-of-character' })

    expect(metrics.counter('compliance.userDislike').value()).toBe(1)
    expect(callbackCount).toBe(1)
  })
})

// === 写入纪律（裁定 1.7 #3：turns 行不存在静默忽略） ===

describe('P3C1-07 feedback：turns 行不存在静默忽略', () => {
  it('无 compliance_turns 行 -> 不插入、不计数、不回调', () => {
    const metrics = createMetrics()
    let callbackCount = 0
    const f = makeFixture({
      withTurnRow: false,
      metrics,
      onDislike: () => {
        callbackCount++
      }
    })

    const outcome = f.record({ kind: 'dislike' })

    expect(outcome).toEqual({ status: 'ignored', reason: 'turn-row-missing' })
    expect(f.rowCount()).toBe(0)
    expect(metrics.counter('compliance.userDislike').value()).toBe(0)
    expect(callbackCount).toBe(0)
  })

  it('另一轮有行但本轮没有 -> 只忽略本轮', () => {
    const f = makeFixture({ withTurnRow: false })
    insertTurnRow(f.db, 'turn-other')
    expect(f.record({ kind: 'dislike' })).toEqual({
      status: 'ignored',
      reason: 'turn-row-missing'
    })
    expect(f.rowCount()).toBe(0)
  })
})

// === 关联校验（防过期/伪造请求污染 dislikeOnHitTurns 统计） ===

describe('P3C1-07 feedback：关联校验', () => {
  it('消息不存在（伪造 messageId）-> message-not-found', () => {
    const f = makeFixture()
    expect(f.record({ messageId: 'msg-forged' })).toEqual({
      status: 'ignored',
      reason: 'message-not-found'
    })
    expect(f.rowCount()).toBe(0)
  })

  it('sessionId 与消息所在会话不符 -> message-not-found（getMessage 按会话定位）', () => {
    const f = makeFixture()
    const otherSession = f.store.createSession()
    expect(f.record({ sessionId: otherSession })).toEqual({
      status: 'ignored',
      reason: 'message-not-found'
    })
    expect(f.rowCount()).toBe(0)
  })

  it('user 消息 id -> message-not-assistant（反馈只针对角色回复）', () => {
    const f = makeFixture()
    expect(f.record({ messageId: 'msg-u1' })).toEqual({
      status: 'ignored',
      reason: 'message-not-assistant'
    })
    expect(f.rowCount()).toBe(0)
  })

  it('turnId 与消息归属不符 -> turn-mismatch', () => {
    const f = makeFixture()
    // 补一轮 turn-2（有 turns 行），但用 turn-2 的 turnId 配 turn-1 的消息
    insertTurnRow(f.db, 'turn-2')
    expect(f.record({ turnId: 'turn-2' })).toEqual({
      status: 'ignored',
      reason: 'turn-mismatch'
    })
    expect(f.rowCount()).toBe(0)
  })
})

// === 容错：回调/指标/日志失败不撤销落库（反馈持久化优先） ===

describe('P3C1-07 feedback：依赖失败容错', () => {
  it('onDislike 抛错 -> 反馈已落库、指标已计、outcome 仍 inserted、不向外抛', () => {
    const { logger, calls } = spyLogger()
    const metrics = createMetrics()
    const f = makeFixture({
      logger,
      metrics,
      onDislike: () => {
        throw new Error('audit queue unavailable')
      }
    })

    const outcome = f.record({ kind: 'dislike' })

    expect(outcome).toEqual({ status: 'inserted', kind: 'dislike' })
    expect(metrics.counter('compliance.userDislike').value()).toBe(1)
    expect(f.rowCount()).toBe(1)
    expect(calls.some((c) => c.level === 'warn' && c.msg.includes('callback failed'))).toBe(true)
  })

  it('metrics 抛错不影响落库', () => {
    const broken: MetricsRegistry = {
      counter: () => {
        throw new Error('metrics broken')
      },
      gauge: () => {
        throw new Error('metrics broken')
      },
      histogram: () => {
        throw new Error('metrics broken')
      },
      snapshot: () => ({})
    }
    const f = makeFixture({ metrics: broken })
    const outcome = f.record({ kind: 'dislike' })
    expect(outcome).toEqual({ status: 'inserted', kind: 'dislike' })
    expect(f.rowCount()).toBe(1)
  })

  it('logger 抛错不影响落库', () => {
    const throwing: Logger = {
      fatal: () => {
        throw new Error('log sink broken')
      },
      error: () => {
        throw new Error('log sink broken')
      },
      warn: () => {
        throw new Error('log sink broken')
      },
      info: () => {
        throw new Error('log sink broken')
      },
      debug: () => {
        throw new Error('log sink broken')
      },
      child: () => throwing
    }
    const f = makeFixture({ logger: throwing })
    const outcome = f.record({ kind: 'dislike' })
    expect(outcome).toEqual({ status: 'inserted', kind: 'dislike' })
    expect(f.rowCount()).toBe(1)
  })
})

// === 日志红线（§3.11：只记元数据，不记正文） ===

describe('P3C1-07 feedback：日志红线', () => {
  it('所有日志不含消息正文/用户输入（含忽略路径）', () => {
    const { logger, calls } = spyLogger()
    const store = createMemorySessionStore()
    const sessionId = store.createSession()
    store.appendMessage(sessionId, {
      id: 'msg-a1',
      sessionId,
      role: 'assistant',
      content: 'SECRET-ASSISTANT-TEXT',
      createdAt: 2,
      status: 'complete',
      turnId: 'turn-1'
    } satisfies ChatMessage)
    const db = new Database(':memory:')
    dbs.push(db)
    m009.up({ db, dataDir: '.', log: noopLogger(), dryRun: false })
    insertTurnRow(db, 'turn-1')
    const service = createComplianceFeedbackService({
      db,
      sessionStore: store,
      logger,
      now: () => 5_000
    })
    service.recordFeedback({
      sessionId,
      turnId: 'turn-1',
      messageId: 'msg-a1',
      kind: 'dislike'
    })
    service.recordFeedback({
      sessionId,
      turnId: 'turn-1',
      messageId: 'msg-forged',
      kind: 'dislike'
    })

    const serialized = calls.map((c) => `${c.msg} ${JSON.stringify(c.fields)}`).join('\n')
    expect(serialized).not.toContain('SECRET-ASSISTANT-TEXT')
    expect(serialized).not.toContain('user text')
  })
})
