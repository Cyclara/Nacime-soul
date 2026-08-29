import { describe, expect, it, vi } from 'vitest'
import { createGcActivityHook } from './gc-activity-hook'

describe('P3G GC activity hook', () => {
  it('chat.message marks the idle scheduler active and leaves message data untouched', () => {
    const scheduler = { markActivity: vi.fn(), checkNow: vi.fn(), dispose: vi.fn() }
    const hook = createGcActivityHook(scheduler)
    const data = { text: 'hello' }
    expect(hook.fn({ event: 'chat.message' }, data)).toEqual({ data })
    expect(scheduler.markActivity).toHaveBeenCalledOnce()
  })
})
