// src/main/scheduling/idle-scheduler.ts
// P3G-01：通用 idle 调度器。对话开始立即让路；不会在启动热路径运行任务。

export interface IdleScheduler {
  markActivity(): void
  checkNow(): void
  dispose(): void
}

export function createIdleScheduler(options: {
  readonly idleMinutes: number
  readonly minIntervalHours: number
  readonly now?: () => number
  readonly schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  readonly cancel?: (timer: ReturnType<typeof setTimeout>) => void
  readonly run: () => void
}): IdleScheduler {
  const now = options.now ?? Date.now
  const schedule = options.schedule ?? setTimeout
  const cancel = options.cancel ?? clearTimeout
  const idleMs = options.idleMinutes * 60 * 1000
  const intervalMs = options.minIntervalHours * 60 * 60 * 1000
  let lastActivity = now()
  let lastRun: number | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const arm = (): void => {
    if (disposed) return
    if (timer !== null) cancel(timer)
    const remainingIdle = Math.max(0, idleMs - (now() - lastActivity))
    const remainingInterval = lastRun === null ? 0 : Math.max(0, intervalMs - (now() - lastRun))
    timer = schedule(() => {
      timer = null
      checkNow()
    }, Math.max(remainingIdle, remainingInterval))
  }

  const checkNow = (): void => {
    if (disposed || now() - lastActivity < idleMs || (lastRun !== null && now() - lastRun < intervalMs)) {
      arm()
      return
    }
    lastRun = now()
    options.run()
    arm()
  }

  arm()
  return {
    markActivity() {
      lastActivity = now()
      arm()
    },
    checkNow,
    dispose() {
      disposed = true
      if (timer !== null) cancel(timer)
      timer = null
    }
  }
}
