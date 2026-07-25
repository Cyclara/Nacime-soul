// src/main/hooks/lifecycle.ts
// Hook 生命周期事件常量 + 生命周期发射器
// 依据：S-001 P1-13、F5-011 §2.5 "Hook runner 里已有 emitHookStarted/emitHookResponse"

import type { HookContext } from './types'
import { runHooks } from './runner'

/** Phase 1 生命周期事件名 */
export const LifecycleEvent = {
  /** 用户发送消息时触发（sanitize hook 在此事件） */
  CHAT_MESSAGE: 'chat.message',
  /** 构建完 prompt、调用 LLM 前触发 */
  CHAT_PARAMS: 'chat.params',
  /** 一轮对话完成时触发（不区分成功/失败） */
  TURN_END: 'turn.end'
} as const

export type LifecycleEvent = (typeof LifecycleEvent)[keyof typeof LifecycleEvent]

/**
 * 触发指定生命周期事件，执行所有注册的 hook。
 * 返回最终 data 和是否被短路。
 *
 * 使用示例：
 *   const { data: cleaned } = await emitLifecycle(LifecycleEvent.CHAT_MESSAGE, { turnId }, { text: '...' })
 */
export async function emitLifecycle<T = unknown>(
  event: string,
  ctx: HookContext,
  initialData: T
): Promise<{ data: T; stopped: boolean }> {
  const result = await runHooks<T>(event, ctx, initialData)
  return { data: result.data, stopped: result.stopped }
}
