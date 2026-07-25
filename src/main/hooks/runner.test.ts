// src/main/hooks/runner.test.ts
// Hook runner 测试：priority 排序、shouldStop 短路、fail-open/closed 策略、data 转换
// 依据：S-004 #33-#34

import { describe, it, expect, beforeEach } from 'vitest'
import { registerHook, unregisterHook, getHooks, clearHooks, hookCount } from './registry'
import { runHooks, setHookRunnerLogger } from './runner'
import { emitLifecycle, LifecycleEvent } from './lifecycle'
import { sanitizeMessageHook } from './builtin/sanitize-message'
import type { HookRegistration, HookFn } from './types'
import type { Logger } from '@shared/observability/types'

function noopLogger(): Logger {
  return {
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
      return noopLogger()
    }
  }
}

function makeHook(
  name: string,
  event: string,
  priority: number,
  fn: HookFn,
  failOpen?: boolean
): HookRegistration {
  return { name, event, priority, fn, failOpen }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function syncFn(transform: (data: any) => any): HookFn {
  return (_ctx, data) => ({ data: transform(data) })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asyncFn(transform: (data: any) => any, delayMs = 1): HookFn {
  return async (_ctx, data) => {
    await new Promise((r) => setTimeout(r, delayMs))
    return { data: transform(data) }
  }
}

describe('Hook registry', () => {
  beforeEach(() => {
    clearHooks()
  })

  it('getHooks returns empty for unknown event', () => {
    expect(getHooks('nonexistent')).toEqual([])
  })

  it('getHooks returns hooks sorted by priority ascending', () => {
    registerHook(
      makeHook(
        'c',
        'test',
        300,
        syncFn((d) => d)
      )
    )
    registerHook(
      makeHook(
        'a',
        'test',
        100,
        syncFn((d) => d)
      )
    )
    registerHook(
      makeHook(
        'b',
        'test',
        200,
        syncFn((d) => d)
      )
    )

    const result = getHooks('test')
    expect(result.map((h) => h.name)).toEqual(['a', 'b', 'c'])
  })

  it('same priority preserves registration order', () => {
    registerHook(
      makeHook(
        'first',
        'test',
        100,
        syncFn((d) => d)
      )
    )
    registerHook(
      makeHook(
        'second',
        'test',
        100,
        syncFn((d) => d)
      )
    )
    registerHook(
      makeHook(
        'third',
        'test',
        100,
        syncFn((d) => d)
      )
    )

    const result = getHooks('test')
    expect(result.map((h) => h.name)).toEqual(['first', 'second', 'third'])
  })

  it('getHooks only returns hooks for the specified event', () => {
    registerHook(
      makeHook(
        'a',
        'event1',
        100,
        syncFn((d) => d)
      )
    )
    registerHook(
      makeHook(
        'b',
        'event2',
        200,
        syncFn((d) => d)
      )
    )

    expect(getHooks('event1')).toHaveLength(1)
    expect(getHooks('event1')[0].name).toBe('a')
    expect(getHooks('event2')).toHaveLength(1)
  })

  it('re-registering same name+event replaces old hook', () => {
    const fn1 = syncFn((d: string) => d + '1')
    const fn2 = syncFn((d: string) => d + '2')

    registerHook(makeHook('test', 'ev', 100, fn1))
    registerHook(makeHook('test', 'ev', 200, fn2))

    expect(getHooks('ev')).toHaveLength(1)
    expect(getHooks('ev')[0].priority).toBe(200)
  })

  it('unregisterHook removes hook', () => {
    registerHook(
      makeHook(
        'test',
        'ev',
        100,
        syncFn((d) => d)
      )
    )
    expect(getHooks('ev')).toHaveLength(1)

    unregisterHook('test', 'ev')
    expect(getHooks('ev')).toHaveLength(0)
  })

  it('unregisterHook on non-existent hook is silent', () => {
    expect(() => unregisterHook('nope', 'ev')).not.toThrow()
  })

  it('hookCount returns correct count', () => {
    expect(hookCount()).toBe(0)
    registerHook(
      makeHook(
        'a',
        'e1',
        100,
        syncFn((d) => d)
      )
    )
    registerHook(
      makeHook(
        'b',
        'e2',
        200,
        syncFn((d) => d)
      )
    )
    expect(hookCount()).toBe(2)
  })

  it('clearHooks removes all hooks', () => {
    registerHook(
      makeHook(
        'a',
        'e1',
        100,
        syncFn((d) => d)
      )
    )
    registerHook(
      makeHook(
        'b',
        'e2',
        200,
        syncFn((d) => d)
      )
    )
    clearHooks()
    expect(hookCount()).toBe(0)
  })
})

describe('Hook runner', () => {
  beforeEach(() => {
    clearHooks()
    setHookRunnerLogger(noopLogger())
  })

  it('returns initialData when no hooks registered', async () => {
    const result = await runHooks('test', { event: 'test' }, { value: 42 })
    expect(result.data).toEqual({ value: 42 })
    expect(result.stopped).toBe(false)
    expect(result.errors).toEqual([])
  })

  it('executes hooks in priority order', async () => {
    const order: string[] = []
    registerHook(
      makeHook('c', 'test', 300, (_ctx, data) => {
        const arr = data as string[]
        order.push('c')
        return { data: [...arr, 'c'] }
      })
    )
    registerHook(
      makeHook('a', 'test', 100, (_ctx, data) => {
        const arr = data as string[]
        order.push('a')
        return { data: [...arr, 'a'] }
      })
    )
    registerHook(
      makeHook('b', 'test', 200, (_ctx, data) => {
        const arr = data as string[]
        order.push('b')
        return { data: [...arr, 'b'] }
      })
    )

    const result = await runHooks('test', { event: 'test' }, [] as string[])
    expect(order).toEqual(['a', 'b', 'c'])
    expect(result.data).toEqual(['a', 'b', 'c'])
  })

  it('shouldStop short-circuits remaining hooks', async () => {
    const order: string[] = []
    registerHook(
      makeHook('a', 'test', 100, () => {
        order.push('a')
        return { shouldStop: true }
      })
    )
    registerHook(
      makeHook('b', 'test', 200, () => {
        order.push('b')
        return {}
      })
    )

    const result = await runHooks('test', { event: 'test' }, null)
    expect(order).toEqual(['a'])
    expect(result.stopped).toBe(true)
  })

  it('data transforms through hooks', async () => {
    registerHook(
      makeHook(
        'append-a',
        'test',
        100,
        syncFn((d: string) => d + 'a')
      )
    )
    registerHook(
      makeHook(
        'append-b',
        'test',
        200,
        syncFn((d: string) => d + 'b')
      )
    )

    const result = await runHooks('test', { event: 'test' }, '')
    expect(result.data).toBe('ab')
  })

  it('data not modified when hook returns undefined data', async () => {
    registerHook(makeHook('noop', 'test', 100, () => ({})))

    const result = await runHooks('test', { event: 'test' }, { value: 42 })
    expect(result.data).toEqual({ value: 42 })
  })

  it('fail-closed (default) stops on error', async () => {
    const order: string[] = []
    registerHook(
      makeHook('throws', 'test', 100, () => {
        order.push('throws')
        throw new Error('boom')
      })
    )
    registerHook(
      makeHook('after', 'test', 200, () => {
        order.push('after')
        return {}
      })
    )

    const result = await runHooks('test', { event: 'test' }, null)
    expect(order).toEqual(['throws'])
    expect(result.stopped).toBe(true)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toBe('boom')
  })

  it('fail-open continues on error', async () => {
    const order: string[] = []
    registerHook(
      makeHook(
        'throws-open',
        'test',
        100,
        () => {
          order.push('throws-open')
          throw new Error('boom')
        },
        true
      )
    )
    registerHook(
      makeHook('after', 'test', 200, () => {
        order.push('after')
        return { data: 'after' }
      })
    )

    const result = await runHooks('test', { event: 'test' }, 'initial')
    expect(order).toEqual(['throws-open', 'after'])
    expect(result.data).toBe('after')
    expect(result.stopped).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toBe('boom')
  })

  it('async hooks execute in order', async () => {
    const order: string[] = []
    registerHook(
      makeHook(
        'a',
        'test',
        100,
        asyncFn((d: string[]) => {
          order.push('a')
          return [...d, 'a']
        }, 10)
      )
    )
    registerHook(
      makeHook(
        'b',
        'test',
        200,
        asyncFn((d: string[]) => {
          order.push('b')
          return [...d, 'b']
        }, 5)
      )
    )

    const result = await runHooks('test', { event: 'test' }, [] as string[])
    expect(order).toEqual(['a', 'b'])
    expect(result.data).toEqual(['a', 'b'])
  })

  it('multiple fail-open errors are all collected', async () => {
    registerHook(
      makeHook(
        'e1',
        'test',
        100,
        () => {
          throw new Error('err1')
        },
        true
      )
    )
    registerHook(
      makeHook(
        'e2',
        'test',
        200,
        () => {
          throw new Error('err2')
        },
        true
      )
    )
    registerHook(
      makeHook(
        'ok',
        'test',
        300,
        syncFn((d: string) => d + 'ok')
      )
    )

    const result = await runHooks('test', { event: 'test' }, '')
    expect(result.data).toBe('ok')
    expect(result.errors).toHaveLength(2)
    expect(result.errors[0].message).toBe('err1')
    expect(result.errors[1].message).toBe('err2')
    expect(result.stopped).toBe(false)
  })

  it('non-Error throws are wrapped', async () => {
    registerHook(
      makeHook('throws-string', 'test', 100, () => {
        throw 'string error'
      })
    )

    const result = await runHooks('test', { event: 'test' }, null)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toBe('string error')
  })
})

describe('Lifecycle', () => {
  beforeEach(() => {
    clearHooks()
    setHookRunnerLogger(noopLogger())
  })

  it('emitLifecycle runs hooks and returns data', async () => {
    registerHook(
      makeHook(
        'append',
        LifecycleEvent.CHAT_MESSAGE,
        100,
        syncFn((d: string) => d + '!')
      )
    )

    const result = await emitLifecycle(
      LifecycleEvent.CHAT_MESSAGE,
      { event: LifecycleEvent.CHAT_MESSAGE },
      'hello'
    )
    expect(result.data).toBe('hello!')
    expect(result.stopped).toBe(false)
  })

  it('emitLifecycle returns stopped=true when short-circuited', async () => {
    registerHook(makeHook('stop', LifecycleEvent.CHAT_MESSAGE, 100, () => ({ shouldStop: true })))

    const result = await emitLifecycle(
      LifecycleEvent.CHAT_MESSAGE,
      { event: LifecycleEvent.CHAT_MESSAGE },
      'hello'
    )
    expect(result.stopped).toBe(true)
  })

  it('LifecycleEvent constants are distinct', () => {
    expect(LifecycleEvent.CHAT_MESSAGE).toBe('chat.message')
    expect(LifecycleEvent.CHAT_PARAMS).toBe('chat.params')
    expect(LifecycleEvent.TURN_END).toBe('turn.end')
  })
})

describe('sanitize-message builtin hook', () => {
  beforeEach(() => {
    clearHooks()
    setHookRunnerLogger(noopLogger())
  })

  it('has priority 100', () => {
    expect(sanitizeMessageHook.priority).toBe(100)
  })

  it('is bound to chat.message event', () => {
    expect(sanitizeMessageHook.event).toBe(LifecycleEvent.CHAT_MESSAGE)
  })

  it('is failOpen', () => {
    expect(sanitizeMessageHook.failOpen).toBe(true)
  })

  it('sanitizes text via NFKC normalization', async () => {
    registerHook(sanitizeMessageHook)

    // 全角字母 → 半角 (NFKC)
    const result = await runHooks(
      LifecycleEvent.CHAT_MESSAGE,
      { event: LifecycleEvent.CHAT_MESSAGE },
      { text: 'Ｈｅｌｌｏ' }
    )
    expect(result.data.text).toBe('Hello')
  })

  it('removes zero-width spaces', async () => {
    registerHook(sanitizeMessageHook)

    const result = await runHooks(
      LifecycleEvent.CHAT_MESSAGE,
      { event: LifecycleEvent.CHAT_MESSAGE },
      { text: 'hel​lo' }
    )
    expect(result.data.text).toBe('hello')
  })

  it('preserves normal Chinese text', async () => {
    registerHook(sanitizeMessageHook)

    const result = await runHooks(
      LifecycleEvent.CHAT_MESSAGE,
      { event: LifecycleEvent.CHAT_MESSAGE },
      { text: '你好世界' }
    )
    expect(result.data.text).toBe('你好世界')
  })

  it('preserves other fields in data', async () => {
    registerHook(sanitizeMessageHook)

    const result = await runHooks(
      LifecycleEvent.CHAT_MESSAGE,
      { event: LifecycleEvent.CHAT_MESSAGE },
      { text: 'Hello', sessionId: 'abc', extra: 123 }
    )
    expect(result.data.text).toBe('Hello')
    expect(result.data.sessionId).toBe('abc')
    expect(result.data.extra).toBe(123)
  })
})
