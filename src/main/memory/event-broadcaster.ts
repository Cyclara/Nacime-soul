// src/main/memory/event-broadcaster.ts
// P2-29: memory-updated 事件广播器。250ms 节流合并 hint，广播到 renderer。
// 依据：S-003-补充 §3.2（event 通道）、S-022 §1.4（revision 真源 + 跨 hint 合并为 bulk）。
//
// 设计要点：
//   1. notify(hint) 非阻塞：写入路径调用后立即返回，不 await 网络/IPC。
//   2. 250ms 节流窗口：同窗口内的多个 hint 合并。同 hint 合并取最高 revision；
//      不同 hint 合为 'bulk'（S-022 §1.4 红线：只取最后 hint 会漏掉切片）。
//   3. revision 在 flush 时读 revisionClock.current()（窗口内多次 next 取最终值）。
//   4. webContents 可能被重建（CrashGuard）或销毁：通过 getWebContents 回调取最新引用。
//   5. 败而不崩：广播失败（webContents 销毁）只 debug 日志，不抛错。

import type { WebContents } from 'electron'
import type { Logger } from '@shared/observability/types'
import type { MemoryRevisionClock } from './revision-clock'
import type { MemoryUpdatedEvent } from '@shared/memory/types'

export type MemoryUpdateHint = 'l0' | 'l1' | 'l2' | 'dmae' | 'growth' | 'bulk'

export interface MemoryEventBroadcaster {
  /** 写入路径调用：登记 hint，触发 250ms 节流 flush。非阻塞。 */
  notify(hint: MemoryUpdateHint): void
  /** 立即 flush 待发事件（app 退出/测试用） */
  flush(): void
  /** 清理定时器 */
  dispose(): void
}

export interface EventBroadcasterDeps {
  revisionClock: MemoryRevisionClock
  /** 获取主窗口 webContents（可能被 CrashGuard 重建；null = 无窗口可发） */
  getWebContents: () => WebContents | null
  logger: Logger
  now?: () => number
  /** 节流窗口（默认 250ms，S-022 §1.4） */
  throttleMs?: number
}

export function createMemoryEventBroadcaster(deps: EventBroadcasterDeps): MemoryEventBroadcaster {
  const { revisionClock, getWebContents, logger } = deps
  const now = deps.now ?? ((): number => Date.now())
  const throttleMs = deps.throttleMs ?? 250

  let pendingHints = new Set<MemoryUpdateHint>()
  let timer: ReturnType<typeof setTimeout> | null = null

  function broadcast(hint: MemoryUpdateHint, revision: number): void {
    const payload: MemoryUpdatedEvent = { revision, hint, ts: now() }
    const wc = getWebContents()
    if (!wc || wc.isDestroyed()) {
      logger.debug('memory-updated skipped: no webContents', {
        scope: 'memory',
        tags: { hint }
      })
      return
    }
    // 审计 B-6：isDestroyed() 检查与 send 之间存在竞态窗口
    //（CrashGuard 重建窗口、用户关窗都可能发生在这两行之间），
    // 且 send 本身可能抛（renderer 已 gone）。本模块承诺"败而不崩"（见文件头注释 5），
    // 裸 send 会让异常穿透到调用它的记忆写入路径——记忆已落库却报错，是更糟的结果。
    try {
      wc.send('companion:event:memory-updated', payload)
    } catch (e) {
      logger.debug('memory-updated send failed', {
        scope: 'memory',
        tags: { hint },
        detail: e instanceof Error ? e.message : String(e)
      })
    }
  }

  function flush(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (pendingHints.size === 0) return
    const hints = pendingHints
    pendingHints = new Set()
    // S-022 §1.4：同 hint 合并；不同 hint 合为 bulk
    const hint: MemoryUpdateHint = hints.size === 1 ? ([...hints][0] as MemoryUpdateHint) : 'bulk'
    const revision = revisionClock.current()
    broadcast(hint, revision)
  }

  function notify(hint: MemoryUpdateHint): void {
    pendingHints.add(hint)
    if (timer === null) {
      timer = setTimeout(flush, throttleMs)
    }
  }

  function dispose(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    pendingHints.clear()
  }

  return { notify, flush, dispose }
}
