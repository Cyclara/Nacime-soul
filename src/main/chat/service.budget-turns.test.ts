// src/main/chat/service.budget-turns.test.ts
// M-03 修复验证：buildBudgetHistoryTurns 合并跨轮的连续 user 消息。
// 关键断言：失败/取消轮留下的孤立 user 轮会被并入下一轮首条 user，不再出现连续 user；
//           正常 [user,assistant] 轮保持原样；全部文本保留。
// 2026-08-21：user 消息在装配时带 `[YYYY-MM-DD HH:MM] ` 时间前缀（datetime-prefix），
//             断言相应更新；assistant 消息不加前缀。

import { describe, it, expect } from 'vitest'
import { buildBudgetHistoryTurns } from './service'
import { formatTimePrefix } from './datetime-prefix'
import type { ChatMessage } from '@shared/chat/types'

function msg(
  id: string,
  turnId: string,
  role: 'user' | 'assistant',
  content: string,
  status: ChatMessage['status'] = 'complete',
  createdAt = 0
): ChatMessage {
  return {
    id,
    sessionId: 's1',
    role,
    content,
    createdAt,
    status,
    turnId
  }
}

const CUR_TURN = 'turn-current'
// 本测试多数用例不关心具体时间：统一用 createdAt=0 的固定前缀
const P = formatTimePrefix(0)

function build(messages: ChatMessage[]): Array<{ role: string; content: string }> {
  return buildBudgetHistoryTurns(messages, CUR_TURN, 'assistant-placeholder').flatMap((t) =>
    t.messages.map((m) => ({ role: m.role, content: m.content }))
  )
}

describe('M-03: buildBudgetHistoryTurns 合并连续 user', () => {
  it('正常 [user,assistant] 轮保持原样', () => {
    const msgs = [
      msg('u1', 't1', 'user', '你好'),
      msg('a1', 't1', 'assistant', '你好！'),
      msg('u2', CUR_TURN, 'user', '今天天气如何？')
    ]
    const flat = build(msgs)
    expect(flat).toEqual([
      { role: 'user', content: `${P}你好` },
      { role: 'assistant', content: '你好！' },
      { role: 'user', content: `${P}今天天气如何？` }
    ])
  })

  it('失败轮 [user] 紧邻重试 [user,assistant] -> 合并为单条 user，不出现连续 user', () => {
    const msgs = [
      msg('u1', 't-failed', 'user', '上一句（没回复）'),
      // t-failed 的 assistant 是 failed 状态，被排除 -> 孤立 user 轮
      msg('a1', 't-failed', 'assistant', '', 'failed'),
      msg('u2', CUR_TURN, 'user', '重试这句'),
      msg('a2', CUR_TURN, 'assistant', '回复')
    ]
    const flat = build(msgs)
    // 两条 user 各自带时间前缀（合并后两个前缀都在——恰好保留了"两次发送时间"的信息）
    expect(flat).toEqual([
      { role: 'user', content: `${P}上一句（没回复）\n${P}重试这句` },
      { role: 'assistant', content: '回复' }
    ])
  })

  it('多个孤立 user 轮连续出现 -> 全部并入同一条 user', () => {
    const msgs = [
      msg('u1', 't-f1', 'user', '第一句'),
      msg('u2', 't-f2', 'user', '第二句'),
      msg('u3', CUR_TURN, 'user', '第三句'),
      msg('a1', CUR_TURN, 'assistant', '最终回复')
    ]
    const flat = build(msgs)
    expect(flat).toEqual([
      { role: 'user', content: `${P}第一句\n${P}第二句\n${P}第三句` },
      { role: 'assistant', content: '最终回复' }
    ])
  })

  it('孤立 user 不并入前一个正常轮的 assistant（只在连续 user 时合并）', () => {
    const msgs = [
      msg('u1', 't1', 'user', '问题'),
      msg('a1', 't1', 'assistant', '回答'),
      msg('u2', 't2', 'user', '下一句')
    ]
    const flat = build(msgs)
    // t2 是 [user] 孤儿轮，但前一轮以 assistant 结尾 -> 不合并
    expect(flat).toEqual([
      { role: 'user', content: `${P}问题` },
      { role: 'assistant', content: '回答' },
      { role: 'user', content: `${P}下一句` }
    ])
  })
})

describe('时间前缀（datetime-prefix）', () => {
  it('user 消息按各自 createdAt 加前缀，assistant 不加', () => {
    const t1 = new Date(2026, 7, 20, 23, 32).getTime()
    const t2 = new Date(2026, 7, 21, 17, 58).getTime()
    const msgs = [
      msg('u1', 't1', 'user', '昨晚说的', 'complete', t1),
      msg('a1', 't1', 'assistant', '昨晚回的', 'complete', t1 + 3000),
      msg('u2', CUR_TURN, 'user', '今天说的', 'complete', t2)
    ]
    const flat = build(msgs)
    expect(flat).toEqual([
      { role: 'user', content: `[2026-08-20 23:32] 昨晚说的` },
      { role: 'assistant', content: '昨晚回的' },
      { role: 'user', content: `[2026-08-21 17:58] 今天说的` }
    ])
  })
})
