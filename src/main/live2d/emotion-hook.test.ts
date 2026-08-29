// src/main/live2d/emotion-hook.test.ts
// 完成定义第 3 条第二环：turn.end 把情绪下发到 stage，且不让正文离开 main。

import { describe, expect, it, vi } from 'vitest'
import type { Logger } from '@shared/observability/types'
import type { SessionStore } from '../chat/session-store'
import type { TurnEndData } from '../chat/service'
import { createLive2dEmotionHook } from './emotion-hook'

interface LoggedCall {
  readonly msg: string
  readonly fields: unknown
}

function silentLogger(onDebug?: (msg: string, fields: unknown) => void): Logger {
  const logger = {
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
    debug: (msg: string, fields: unknown) => {
      onDebug?.(msg, fields)
    },
    child() {
      return logger
    }
  }
  return logger as unknown as Logger
}

function harness(options: { reply?: string | null; stageLive?: boolean } = {}): {
  hook: ReturnType<typeof createLive2dEmotionHook>
  emitted: string[]
  logged: LoggedCall[]
  reads: number
} {
  const emitted: string[] = []
  const logged: LoggedCall[] = []
  let reads = 0
  const logger = silentLogger((msg, fields) => {
    logged.push({ msg, fields })
  })
  const sessionStore = {
    getTurnMessages: () => {
      reads++
      const reply = options.reply
      if (reply === null || reply === undefined) return null
      return { user: { content: 'ignored' }, assistant: { content: reply } }
    }
  } as unknown as SessionStore

  const hook = createLive2dEmotionHook({
    logger,
    sessionStore,
    setEmotion: (emotion) => emitted.push(emotion),
    isStageLive: () => options.stageLive ?? true
  })
  return {
    hook,
    emitted,
    logged,
    get reads() {
      return reads
    }
  }
}

function turn(overrides: Partial<TurnEndData> = {}): TurnEndData {
  return {
    turnId: 't1',
    sessionId: 's1' as TurnEndData['sessionId'],
    requestId: 'r1' as TurnEndData['requestId'],
    status: 'completed',
    inputLen: 4,
    outputLen: 12,
    memoryEligible: true,
    referencedMemoryIds: [],
    ...overrides
  } as TurnEndData
}

describe('Live2D 情绪 hook', () => {
  it('挂在 turn.end 且 failOpen，优先级排在合规审计(350)之后', () => {
    const { hook } = harness()
    expect(hook.event).toBe('turn.end')
    expect(hook.failOpen).toBe(true)
    expect(hook.priority).toBeGreaterThan(350)
  })

  it('completed 轮把分类结果下发给 stage', async () => {
    const h = harness({ reply: '太好了，我们成功了！' })
    await h.hook.fn({ event: 'turn.end' }, turn())
    expect(h.emitted).toEqual(['happy'])
  })

  it('failed/cancelled 不改表情——话没说完时保持她当前的样子', async () => {
    for (const status of ['failed', 'cancelled'] as const) {
      const h = harness({ reply: '对不起' })
      await h.hook.fn({ event: 'turn.end' }, turn({ status }))
      expect(h.emitted).toEqual([])
    }
  })

  it('stage 未开时直接返回，连 SessionStore 都不读', async () => {
    const h = harness({ reply: '太好了', stageLive: false })
    await h.hook.fn({ event: 'turn.end' }, turn())
    expect(h.emitted).toEqual([])
    expect(h.reads).toBe(0)
  })

  it('取不到该轮消息或回复为空时不下发', async () => {
    const missing = harness({ reply: null })
    await missing.hook.fn({ event: 'turn.end' }, turn())
    expect(missing.emitted).toEqual([])

    const empty = harness({ reply: '' })
    await empty.hook.fn({ event: 'turn.end' }, turn())
    expect(empty.emitted).toEqual([])
  })

  it('日志只留标签与长度，正文绝不进日志（§3.11 红线）', async () => {
    const secret = '对不起，你的银行卡尾号是 4417。'
    const h = harness({ reply: secret })
    await h.hook.fn({ event: 'turn.end' }, turn())
    expect(h.emitted).toEqual(['sad'])
    const serialized = JSON.stringify(h.logged)
    expect(serialized).not.toContain('4417')
    expect(serialized).not.toContain('银行卡')
    expect(serialized).toContain('sad')
  })

  it('hook 恒返回原 data，不改写 turn.end 载荷', async () => {
    const h = harness({ reply: '我喜欢这样~' })
    const data = turn()
    const result = await h.hook.fn({ event: 'turn.end' }, data)
    expect(result).toEqual({ data })
    expect(result.shouldStop).toBeUndefined()
  })

  it('setEmotion 抛错交给 runner 按 failOpen 处理，而不是自己吞掉后返回错误 data', () => {
    const hook = createLive2dEmotionHook({
      logger: silentLogger(),
      sessionStore: {
        getTurnMessages: () => ({ user: { content: 'x' }, assistant: { content: '太好了' } })
      } as unknown as SessionStore,
      setEmotion: () => {
        throw new Error('stage gone')
      },
      isStageLive: () => true
    })
    expect(hook.failOpen).toBe(true)
    expect(() => hook.fn({ event: 'turn.end' }, turn())).toThrow('stage gone')
  })

  it('每轮各下发一次，最后一次反映最新一轮的情绪', async () => {
    const setEmotion = vi.fn()
    const hook = createLive2dEmotionHook({
      logger: silentLogger(),
      sessionStore: {
        getTurnMessages: () => ({ user: { content: 'x' }, assistant: { content: '真的吗？' } })
      } as unknown as SessionStore,
      setEmotion,
      isStageLive: () => true
    })
    await hook.fn({ event: 'turn.end' }, turn())
    await hook.fn({ event: 'turn.end' }, turn({ turnId: 't2' }))
    expect(setEmotion).toHaveBeenCalledTimes(2)
    expect(setEmotion).toHaveBeenLastCalledWith('surprised')
  })
})
