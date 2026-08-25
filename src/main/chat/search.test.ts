// src/main/chat/search.test.ts
// P2-44: 全文搜索单元测试。
// 覆盖：CJK 分词、FTS5 查询编译、snippet 截取、FTS 端到端（含 CJK phrase/
// latin 前缀/大小写/单字/混合 AND/词序）、store 写路径同步（增/改/删）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { ChatMessage } from '@shared/chat/types'
import {
  segmentForFts,
  buildFtsQuery,
  extractNeedles,
  buildSnippet,
  searchMessages
} from './search'
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

describe('P2-44 segmentForFts：CJK 逐字分隔，latin 连续 run 保留', () => {
  it('纯中文逐字拆开', () => {
    expect(segmentForFts('今天天气真好')).toBe('今 天 天 气 真 好')
  })

  it('纯英文/数字保留整词（小写化，unicode61 匹配本就不分大小写）', () => {
    expect(segmentForFts('Hello World 2026')).toBe('hello world 2026')
  })

  it('中英混排：中文逐字、英文整词', () => {
    expect(segmentForFts('我用Claude写代码')).toBe('我 用 claude 写 代 码')
  })

  it('全角 ASCII 折半角后归 latin', () => {
    expect(segmentForFts('ＣＬＡＵＤＥ')).toBe('claude')
  })

  it('标点/空白/emoji 都是分隔符', () => {
    expect(segmentForFts('你好，世界！🌍')).toBe('你 好 世 界')
  })

  it('空串与纯标点都得到空分词', () => {
    expect(segmentForFts('')).toBe('')
    expect(segmentForFts('！！！…')).toBe('')
  })
})

describe('P2-44 buildFtsQuery：phrase + 前缀 + AND', () => {
  it('连续中文组 phrase（保证相邻、词序敏感）', () => {
    expect(buildFtsQuery('天气')).toBe('"天 气"')
  })

  it('单个中文字直接作为 token', () => {
    expect(buildFtsQuery('天')).toBe('天')
  })

  it('latin 词加前缀（边输边搜）', () => {
    expect(buildFtsQuery('claude')).toBe('claude*')
  })

  it('中英混合 = AND，前缀只加在最后一个 latin 词上', () => {
    expect(buildFtsQuery('今天 code')).toBe('"今 天" code*')
    expect(buildFtsQuery('claude code')).toBe('claude code*')
  })

  it('最后一个词是中文 phrase 时不加前缀', () => {
    expect(buildFtsQuery('code 天气')).toBe('code "天 气"')
  })

  it('引号等 FTS 特殊字符被剥离；大写操作符小写化为普通 token', () => {
    expect(buildFtsQuery('"天气"')).toBe('"天 气"')
    // OR/AND/NOT 小写化后不再是 FTS5 操作符，按普通词 AND 匹配
    expect(buildFtsQuery('code OR 天气')).toBe('code or "天 气"')
  })

  it('纯标点/空白查询返回 null（调用方给空结果）', () => {
    expect(buildFtsQuery('   ')).toBeNull()
    expect(buildFtsQuery('！！！')).toBeNull()
    expect(buildFtsQuery('')).toBeNull()
  })
})

describe('P2-44 extractNeedles / buildSnippet', () => {
  it('needles 剥离标点、折半角', () => {
    expect(extractNeedles('天气 code!')).toEqual(['天气', 'code'])
    expect(extractNeedles('ＣＬＡＵＤＥ')).toEqual(['CLAUDE'])
  })

  it('短消息整段返回，不加省略号', () => {
    expect(buildSnippet('今天天气真好', ['天气'])).toBe('今天天气真好')
  })

  it('长消息围绕命中词截窗，两端补 …', () => {
    const content = '前'.repeat(60) + '天气' + '后'.repeat(100)
    const snippet = buildSnippet(content, ['天气'])
    expect(snippet).toContain('天气')
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
    expect(Array.from(snippet).length).toBeLessThanOrEqual(100)
  })

  it('换行被压平成单行', () => {
    const content = '第一行\n第二行\n第三行'
    expect(buildSnippet(content, ['第二行'])).not.toContain('\n')
  })

  it('找不到命中词时退化为开头截取 + …', () => {
    const content = '字'.repeat(200)
    const snippet = buildSnippet(content, ['不存在'])
    expect(snippet.endsWith('…')).toBe(true)
  })
})

describe('P2-44 searchMessages：FTS5 端到端 + store 写路径同步', () => {
  it('CJK phrase 命中且词序错误不命中', () => {
    const store = createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    store.appendMessage('s-1', makeMessage({ id: 'm1', content: '今天天气真好', createdAt: 1000 }))

    const hits = searchMessages(t.db, '天气')
    expect(hits).toHaveLength(1)
    expect(hits[0].messageId).toBe('m1')
    expect(hits[0].sessionId).toBe('s-1')
    expect(hits[0].snippet).toContain('天气')

    expect(searchMessages(t.db, '气天')).toHaveLength(0)
  })

  it('latin 前缀 + 大小写不敏感', () => {
    const store = createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    store.appendMessage(
      's-1',
      makeMessage({ id: 'm1', content: 'I love ClaudeCode', createdAt: 1000 })
    )

    expect(searchMessages(t.db, 'clau')).toHaveLength(1)
    expect(searchMessages(t.db, 'CLAUDE')).toHaveLength(1)
    expect(searchMessages(t.db, 'lov')).toHaveLength(1)
  })

  it('单字中文可搜；中英混合是 AND', () => {
    const store = createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    store.appendMessage('s-1', makeMessage({ id: 'm1', content: '今天写了 code', createdAt: 1000 }))
    store.appendMessage('s-1', makeMessage({ id: 'm2', content: '今天没写东西', createdAt: 2000 }))

    expect(searchMessages(t.db, '天')).toHaveLength(2)
    const both = searchMessages(t.db, '今天 code')
    expect(both).toHaveLength(1)
    expect(both[0].messageId).toBe('m1')
  })

  it('空查询/纯标点返回空数组，不报错', () => {
    expect(searchMessages(t.db, '')).toEqual([])
    expect(searchMessages(t.db, '   ')).toEqual([])
    expect(searchMessages(t.db, '！！')).toEqual([])
  })

  it('结果按 created_at 倒序，limit 生效', () => {
    const store = createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    for (let i = 0; i < 5; i++) {
      store.appendMessage(
        's-1',
        makeMessage({ id: `m${i}`, content: '共同的天气词', createdAt: 1000 + i })
      )
    }
    const hits = searchMessages(t.db, '天气')
    expect(hits.map((h) => h.messageId)).toEqual(['m4', 'm3', 'm2', 'm1', 'm0'])

    const limited = searchMessages(t.db, '天气', 2)
    expect(limited.map((h) => h.messageId)).toEqual(['m4', 'm3'])
  })

  it('跨会话命中带各自 sessionId', () => {
    const store = createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    store.appendMessage(
      's-a',
      makeMessage({ id: 'ma', sessionId: 's-a', content: '天气A', createdAt: 1000 })
    )
    store.appendMessage(
      's-b',
      makeMessage({ id: 'mb', sessionId: 's-b', content: '天气B', createdAt: 2000 })
    )

    const hits = searchMessages(t.db, '天气')
    expect(hits).toHaveLength(2)
    expect(hits[0].sessionId).toBe('s-b') // 新的在前
    expect(hits[1].sessionId).toBe('s-a')
  })

  it('reasoning 不入索引，只搜正文', () => {
    const store = createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    store.appendMessage(
      's-1',
      makeMessage({ id: 'm1', content: '正文没有目标', reasoning: '思考里有天气', createdAt: 1000 })
    )
    expect(searchMessages(t.db, '天气')).toHaveLength(0)
  })

  it('updateMessage 回写正文后按新内容命中、旧内容不再命中', () => {
    const store = createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    store.appendMessage('s-1', makeMessage({ id: 'm1', content: '旧词阿尔法', createdAt: 1000 }))
    expect(searchMessages(t.db, '阿尔法')).toHaveLength(1)

    store.updateMessage('s-1', 'm1', { content: '新词贝塔' })
    expect(searchMessages(t.db, '阿尔法')).toHaveLength(0)
    expect(searchMessages(t.db, '贝塔')).toHaveLength(1)
  })

  it('updateMessage 不动正文时索引保持', () => {
    const store = createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    store.appendMessage('s-1', makeMessage({ id: 'm1', content: '天气', createdAt: 1000 }))
    store.updateMessage('s-1', 'm1', { status: 'failed' })
    expect(searchMessages(t.db, '天气')).toHaveLength(1)
  })

  it('deleteMessage / deleteTurnMessages / clearMessages 后不再命中', () => {
    const store = createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    store.appendMessage(
      's-1',
      makeMessage({ id: 'm1', content: '天气一', turnId: 't1', createdAt: 1000 })
    )
    store.appendMessage(
      's-1',
      makeMessage({ id: 'm2', role: 'assistant', content: '天气二', turnId: 't1', createdAt: 1001 })
    )
    store.appendMessage(
      's-2',
      makeMessage({ id: 'm3', sessionId: 's-2', content: '天气三', createdAt: 1002 })
    )

    store.deleteMessage('s-2', 'm3')
    expect(searchMessages(t.db, '天气')).toHaveLength(2)

    store.deleteTurnMessages('s-1', 't1')
    expect(searchMessages(t.db, '天气')).toHaveLength(0)

    store.appendMessage('s-1', makeMessage({ id: 'm4', content: '天气四', createdAt: 2000 }))
    store.clearMessages('s-1')
    expect(searchMessages(t.db, '天气')).toHaveLength(0)
  })

  it('deleteSupersededAssistantMessages 同步摘除索引', () => {
    const store = createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    store.appendMessage(
      's-1',
      makeMessage({ id: 'u1', content: '问', turnId: 't1', createdAt: 1000 })
    )
    store.appendMessage(
      's-1',
      makeMessage({
        id: 'a-old',
        role: 'assistant',
        content: '旧答天气',
        turnId: 't1',
        status: 'failed',
        createdAt: 1001
      })
    )
    store.appendMessage(
      's-1',
      makeMessage({
        id: 'a-new',
        role: 'assistant',
        content: '新答天气',
        turnId: 't1',
        status: 'complete',
        createdAt: 1002
      })
    )

    const removed = store.deleteSupersededAssistantMessages('s-1', 't1', 'a-new')
    expect(removed).toBe(1)
    const hits = searchMessages(t.db, '天气')
    expect(hits).toHaveLength(1)
    expect(hits[0].messageId).toBe('a-new')
  })

  it('孤儿轮次修复的占位行入索引但无 token（行数 1:1 不变量）', () => {
    // 构造孤儿：只有 user 行、无 assistant 行
    const store1 = createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    store1.appendMessage(
      's-1',
      makeMessage({ id: 'u1', content: '孤独的问题', turnId: 't-orphan', createdAt: 1000 })
    )

    // 重建 store 触发孤儿修复
    createSQLiteSessionStore({ db: t.db, logger: testNoopLogger })
    const messages = t.db.prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number }
    const fts = t.db.prepare(`SELECT COUNT(*) AS n FROM messages_fts`).get() as { n: number }
    expect(fts.n).toBe(messages.n)
    // 占位行内容为空，搜不到任何东西；user 行照常可搜
    expect(searchMessages(t.db, '孤独')).toHaveLength(1)
  })
})
