// P3G-01：用户开始一轮对话时通知 idle scheduler，让 GC 在热路径让路。

import type { HookRegistration } from '../hooks/types'
import type { IdleScheduler } from '../scheduling/idle-scheduler'

export function createGcActivityHook(scheduler: IdleScheduler): HookRegistration {
  return {
    name: 'memory-gc-activity',
    event: 'chat.message',
    priority: 199,
    failOpen: true,
    fn(_context, data) {
      scheduler.markActivity()
      return { data }
    }
  }
}
