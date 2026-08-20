// src/main/chat/service.budget-turns.test.ts
// M-03 修复验证：buildBudgetHistoryTurns 合并跨轮的连续 user 消息。
// 关键断言：失败/取消轮留下的孤立 user 轮会被并入下一轮首条 user，不再出现连续 user；
//           正常 [user,assistant] 轮保持原样；全部文本保留。

import { describe, it, expect } from 'vitest'
import { buildBudgetHistoryTurns } from './service'
import type { ChatMessage } from '@shared/chat/types'

function msg(
  id: string,
  turnId: string,
  role: 'user' | 'assistant',
  content: string,
  status: ChatMessage['status'] = 'complete'
): ChatMessage {
  return {
    id,
    sessionId: 's1',
    role,
    content,
    createdAt: 0,
    status,
    turnId
  }
}

const CUR_TURN = 'turn-current'

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
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！' },
      { role: 'user', content: '今天天气如何？' }
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
    expect(flat).toEqual([
      { role: 'user', content: '上一句（没回复）\n重试这句' },
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
      { role: 'user', content: '第一句\n第二句\n第三句' },
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
      { role: 'user', content: '问题' },
      { role: 'assistant', content: '回答' },
      { role: 'user', content: '下一句' }
    ])
  })
})
