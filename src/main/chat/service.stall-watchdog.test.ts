// src/main/chat/service.stall-watchdog.test.ts
// 轮次看门狗（停滞自愈）：
//   - 登记后 360s 没有任何流事件 -> 判停滞 -> abort -> failed(NET_TIMEOUT) 终局释放轮次
//     （应用不再只能靠重启解锁"永远在想"的卡死轮）
//   - 每个流事件重置计时（慢但有响应的轮不误杀）
//   - 正常完成的轮看门狗不迟到触发
//   - 用户取消仍是 cancelled（停滞 abort 不误标）
// 预算依据：provider idle timeout 上限 = max(timeoutMs 300s, 思考地板 120s) -> 看门狗 360s 永不抢跑。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createChatService, type ChatService, type ChatEventSink } from './service'
import { createMemorySessionStore, type SessionStore } from './session-store'
import { createFauxProvider, type FauxProviderHandle } from '../llm/providers/faux'
import { createMemoryPromptLoader } from '../prompts/loader'
import { registerHook, clearHooks } from '../hooks/registry'
import { setHookRunnerLogger } from '../hooks/runner'
import { sanitizeMessageHook } from '../hooks/builtin/sanitize-message'
import type { Logger } from '@shared/observability/types'
import type { ChatStreamEvent } from '@shared/chat/types'

const STALL_MS = 360_000 // 与 service.ts TURN_STALL_TIMEOUT_MS 对齐

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
    child() {
      return l
    }
  }
  return l
}

function makeCollector(): {
  events: ChatStreamEvent[]
  sink: ChatEventSink
} {
  const events: ChatStreamEvent[] = []
  return { events, sink: (e) => events.push(e) }
}

describe('ChatService 轮次看门狗（停滞自愈）', () => {
  let store: SessionStore
  let sessionId: string
  let faux: FauxProviderHandle
  let service: ChatService

  beforeEach(() => {
    vi.useFakeTimers()
    clearHooks()
    setHookRunnerLogger(noopLogger())
    registerHook(sanitizeMessageHook)
    store = createMemorySessionStore()
    sessionId = store.createSession()
    faux = createFauxProvider()
    service = createChatService({
      logger: noopLogger(),
      promptLoader: createMemoryPromptLoader({
        'seed.md': 'You are Nacime.',
        'system.md': 'Speak naturally.',
        'identity.md': 'Name: Nacime',
        'soul.md': 'Curious and warm.',
        'styles/casual.md': 'Casual tone.'
      }),
      sessionStore: store,
      providerFactory: () => ({
        provider: faux,
        capabilities: { contextWindow: 64000, maxOutputTokens: 2048 }
      })
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    clearHooks()
  })

  it('360s 无流事件 -> 停滞判死：failed(NET_TIMEOUT) 终局 + 轮次释放可再发', async () => {
    faux.setResponses([{ type: 'text', text: '永远不到的回复', delayMs: 999_999 }])
    const collector = makeCollector()

    const sendP = service.send(
      { sessionId, text: '会卡住的一句', clientRequestId: 'c1' },
      collector.sink
    )
    await vi.advanceTimersByTimeAsync(0) // ACK + started
    await sendP
    expect(collector.events.map((e) => e.type)).toEqual(['started'])
    expect(service.hasActiveTurn(sessionId)).toBe(true)

    await vi.advanceTimersByTimeAsync(STALL_MS) // 看门狗触发

    const failed = collector.events.find((e) => e.type === 'failed')
    expect(failed).toBeDefined()
    expect(failed && failed.type === 'failed' ? failed.error.code : null).toBe('NET_TIMEOUT')
    expect(service.hasActiveTurn(sessionId)).toBe(false)

    // assistant 行落库为 failed/NET_TIMEOUT（部分文本保留——此例为空）
    const msgs = store.getMessages(sessionId, 100)
    const assistant = msgs.find((m) => m.role === 'assistant')
    expect(assistant?.status).toBe('failed')
    expect(assistant?.errorCode).toBe('NET_TIMEOUT')

    // 解锁实证：紧接着能正常发新一轮
    faux.setResponses([{ type: 'text', text: '恢复正常' }])
    const c2 = makeCollector()
    await service.send({ sessionId, text: '再来一句', clientRequestId: 'c2' }, c2.sink)
    await vi.advanceTimersByTimeAsync(0)
    expect(c2.events.map((e) => e.type)).toContain('completed')
  })

  it('慢但有响应不误杀：chunk 间隔 200s（总时长 400s > 预算）正常完成', async () => {
    faux.setResponses([{ type: 'text', text: '甲乙', chunkSize: 1, delayMs: 200_000 }])
    const collector = makeCollector()

    const sendP = service.send(
      { sessionId, text: '慢工出细活', clientRequestId: 'c1' },
      collector.sink
    )
    await vi.advanceTimersByTimeAsync(0)
    await sendP

    await vi.advanceTimersByTimeAsync(200_000) // t=200s：chunk 甲（重置看门狗）
    await vi.advanceTimersByTimeAsync(200_000) // t=400s：chunk 乙 + usage + completed

    const types = collector.events.map((e) => e.type)
    expect(types).toEqual(['started', 'chunk', 'chunk', 'completed'])
    expect(service.hasActiveTurn(sessionId)).toBe(false)

    // 终局后再推进两个预算周期：看门狗不得迟到触发
    await vi.advanceTimersByTimeAsync(STALL_MS * 2)
    expect(collector.events.filter((e) => e.type === 'failed')).toHaveLength(0)
  })

  it('正常秒回的轮：看门狗不触发，也不留尾巴计时器', async () => {
    faux.setResponses([{ type: 'text', text: '快' }])
    const collector = makeCollector()

    const sendP = service.send({ sessionId, text: '你好', clientRequestId: 'c1' }, collector.sink)
    await vi.advanceTimersByTimeAsync(0)
    await sendP

    expect(collector.events.map((e) => e.type)).toEqual(['started', 'chunk', 'completed'])

    await vi.advanceTimersByTimeAsync(STALL_MS * 2)
    expect(collector.events).toHaveLength(3) // 无任何迟到事件
  })

  it('用户主动取消仍是 cancelled（不被看门狗语义污染）', async () => {
    faux.setResponses([{ type: 'text', text: '慢慢来', delayMs: 100_000 }])
    const collector = makeCollector()

    const sendP = service.send(
      { sessionId, text: '等不及了', clientRequestId: 'c1' },
      collector.sink
    )
    await vi.advanceTimersByTimeAsync(0)
    const ack = await sendP

    expect(service.cancel(ack.requestId)).toBe(true)
    await vi.advanceTimersByTimeAsync(0) // abort 生效 -> 流安静结束 -> cancelled 终局

    const types = collector.events.map((e) => e.type)
    expect(types).toEqual(['started', 'cancelled'])
    expect(service.hasActiveTurn(sessionId)).toBe(false)

    // 取消后再推进：看门狗已在终局清除，不得再触发
    await vi.advanceTimersByTimeAsync(STALL_MS * 2)
    expect(collector.events).toHaveLength(2)
  })
})
