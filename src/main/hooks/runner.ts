// src/main/hooks/runner.ts
// Hook 执行器：按 priority 排序 → 依序执行 → shouldStop 短路 → fail-open/closed 策略
// 依据：S-001 P1-13、S-004 #33-#34

import type { Logger } from '@shared/observability/types'
import type { HookContext, HookRunResult } from './types'
import { getHooks } from './registry'

/** noop logger，未注入真实 Logger 时的占位 */
const noopLogger: Logger = {
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
    return noopLogger
  }
}

let runnerLogger: Logger = noopLogger

/** 设置 runner 使用的 logger */
export function setHookRunnerLogger(logger: Logger): void {
  runnerLogger = logger
}

/**
 * 执行指定事件的所有 hook。
 *
 * 流程：
 *   1. getHooks(event) → 按 priority 升序 + 注册顺序
 *   2. 依次执行每个 hook
 *   3. hook 返回 shouldStop → 短路，立即返回
 *   4. hook 抛异常 + failOpen → 收集错误，继续执行
 *   5. hook 抛异常 + failClosed（默认）→ 收集错误，中止
 *   6. hook 返回 data → 替换当前 data，传给下一个 hook
 *
 * 依据 S-004 #33（priority 高者先执行）、#34（shouldStop 短路、fail-open/closed 策略正确）。
 */
export async function runHooks<T = unknown>(
  event: string,
  ctx: HookContext,
  initialData: T
): Promise<HookRunResult<T>> {
  const hooks = getHooks(event)
  let data: T = initialData
  const errors: Error[] = []

  const hookCtx: HookContext = { ...ctx, event }

  for (const hook of hooks) {
    try {
      const result = await hook.fn(hookCtx, data)

      // 更新 data
      if (result.data !== undefined) {
        data = result.data as T
      }

      // 短路
      if (result.shouldStop) {
        runnerLogger.debug('hook stopped pipeline', {
          scope: 'hooks',
          tags: { hook: hook.name, event }
        })
        return { data, stopped: true, errors }
      }
    } catch (cause) {
      const err = cause instanceof Error ? cause : new Error(String(cause))
      errors.push(err)

      runnerLogger.error('hook threw', {
        scope: 'hooks',
        code: 'UNKNOWN',
        tags: { hook: hook.name, event, failOpen: String(!!hook.failOpen) },
        detail: err.message
      })

      if (!hook.failOpen) {
        // fail-closed（默认）：中止
        return { data, stopped: true, errors }
      }
      // fail-open：继续执行下一个 hook
    }
  }

  return { data, stopped: false, errors }
}
