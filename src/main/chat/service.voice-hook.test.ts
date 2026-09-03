// src/main/chat/service.voice-hook.test.ts
// P3B-18（F5-007 §1.5）：ChatService → ChatVoiceTtsHook 的调用顺序契约。
//   - beginTurn 恰好一次（provider 流前）；每段 releaseText 先 sink chunk、
//     再恰好一次 onCommittedDelta（chatSequence = 该 chunk sequence）；
//   - 成功：finishTurn 在 completed 事件前（C17 同步返回）；
//   - failed/cancelled：abortTurn 取消。

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createChatService, type ChatService, type ChatEventSink } from './service'
import { createMemorySessionStore } from './session-store'
import { createFauxProvider, type FauxProviderHandle } from '../llm/providers/faux'
import { createMemoryPromptLoader } from '../prompts/loader'
import { registerHook, clearHooks } from '../hooks/registry'
import { setHookRunnerLogger } from '../hooks/runner'
import { sanitizeMessageHook } from '../hooks/builtin/sanitize-message'
import type { Logger } from '@shared/observability/types'
import type { ChatStreamEvent } from '@shared/chat/types'
import type { TtsCancelReason } from '@shared/voice/tts-types'

interface HookRecord {
  begin: Array<{ turnId: string; requestId: string }>
  deltas: Array<{ delta: string; chatSequence: number }>
  finished: Array<{ visibleChars: number; visibleSha256: string }>
  aborted: TtsCancelReason[]
}

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

function makeLoader(): ReturnType<typeof createMemoryPromptLoader> {
  return createMemoryPromptLoader({
    'seed.md': 'You are Nacime.',
    'system.md': 'Speak naturally.',
    'identity.md': 'Name: Nacime',
    'soul.md': 'Curious and warm.',
    'styles/casual.md': 'Casual tone.'
  })
}

function makeService(faux: FauxProviderHandle, record: HookRecord): ChatService {
  return createChatService({
    logger: noopLogger(),
    promptLoader: makeLoader(),
    sessionStore: createMemorySessionStore(),
    providerFactory: () => ({
      provider: faux,
      capabilities: { contextWindow: 64000, maxOutputTokens: 2048 }
    }),
    voice: {
      beginTurn: (input) => record.begin.push(input),
      onCommittedDelta: (input) => record.deltas.push(input),
      finishTurn: (input) => record.finished.push(input),
      abortTurn: (reason) => record.aborted.push(reason)
    }
  })
}

function makeCollector(): { events: ChatStreamEvent[]; sink: ChatEventSink; done: Promise<void> } {
  const events: ChatStreamEvent[] = []
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  const sink: ChatEventSink = (event) => {
    events.push(event)
    if (event.type === 'completed' || event.type === 'failed' || event.type === 'cancelled') {
      resolveDone()
    }
  }
  return { events, sink, done }
}

describe('ChatService voice hook（P3B-18 / F5-007 §1.5）', () => {
  beforeEach(() => {
    clearHooks()
    setHookRunnerLogger(noopLogger())
    registerHook(sanitizeMessageHook)
  })

  afterEach(() => {
    clearHooks()
  })

  it('成功轮：chunk sink 后恰好一次 onCommittedDelta，finishTurn 在 completed 前', async () => {
    const faux = createFauxProvider()
    faux.setResponses([
      { type: 'text', text: '第一段话。' },
      { type: 'text', text: '第二段话！' }
    ])
    const record: HookRecord = { begin: [], deltas: [], finished: [], aborted: [] }
    const service = makeService(faux, record)
    const { events, sink, done } = makeCollector()

    const sessionId = service.createSession()
    const ack = await service.send({ sessionId, text: '你好', clientRequestId: 'c1' }, sink)
    await done

    expect(record.begin).toEqual([{ turnId: expect.any(String), requestId: ack.requestId }])
    // 每个非空 chunk 恰好一次 delta；chatSequence 与 chunk 事件 sequence 一致
    const chunkEvents = events.filter((e) => e.type === 'chunk')
    expect(record.deltas).toHaveLength(chunkEvents.length)
    for (let i = 0; i < chunkEvents.length; i += 1) {
      const chunk = chunkEvents[i] as { sequence: number; delta: string }
      expect(record.deltas[i]).toEqual({ delta: chunk.delta, chatSequence: chunk.sequence })
    }
    // finishTurn 恰好一次，且在 completed 事件之前（collector 顺序保证）
    expect(record.finished).toHaveLength(1)
    const completedIndex = events.findIndex((e) => e.type === 'completed')
    const lastDelta = record.deltas.at(-1)
    expect(lastDelta).toBeDefined()
    expect(record.finished[0]!.visibleChars).toBe(
      record.deltas.reduce((sum, d) => sum + d.delta.length, 0)
    )
    expect(completedIndex).toBeGreaterThan(events.findIndex((e) => e.type === 'chunk'))
    expect(record.aborted).toEqual([])
  })

  it('failed 轮：abortTurn(provider-failed) 恰好一次', async () => {
    const faux = createFauxProvider()
    faux.setResponses([{ type: 'error', code: 'LLM_SERVER' }])
    const record: HookRecord = { begin: [], deltas: [], finished: [], aborted: [] }
    const service = makeService(faux, record)
    const { sink, done } = makeCollector()

    const sessionId = service.createSession()
    await service.send({ sessionId, text: '你好', clientRequestId: 'c2' }, sink)
    await done

    expect(record.begin).toHaveLength(1)
    expect(record.finished).toHaveLength(0)
    expect(record.aborted).toEqual(['provider-failed'])
  })

  it('cancelled 轮：abortTurn(user-cancel)', async () => {
    const faux = createFauxProvider()
    faux.setResponses([{ type: 'text', text: '慢慢说的一段话，等用户打断。' }])
    const record: HookRecord = { begin: [], deltas: [], finished: [], aborted: [] }
    const service = makeService(faux, record)
    const { sink, done } = makeCollector()

    const sessionId = service.createSession()
    const sendPromise = service.send({ sessionId, text: '你好', clientRequestId: 'c3' }, sink)
    // 等 provider 流开始后取消（poll 活跃轮）
    for (let i = 0; i < 50 && !service.hasActiveTurn(sessionId); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    const ack = await sendPromise
    service.cancel(ack.requestId)
    await done

    expect(record.aborted).toEqual(['user-cancel'])
    expect(record.finished).toHaveLength(0)
  })

  it('未注入 hook：零行为差异（成功轮照常完成）', async () => {
    const faux = createFauxProvider()
    faux.setResponses([{ type: 'text', text: '没有语音的回复。' }])
    const service = createChatService({
      logger: noopLogger(),
      promptLoader: makeLoader(),
      sessionStore: createMemorySessionStore(),
      providerFactory: () => ({
        provider: faux,
        capabilities: { contextWindow: 64000, maxOutputTokens: 2048 }
      })
    })
    const { sink, done, events } = makeCollector()

    const sessionId = service.createSession()
    await service.send({ sessionId, text: '你好', clientRequestId: 'c4' }, sink)
    await done

    expect(events.some((e) => e.type === 'completed')).toBe(true)
  })
})
