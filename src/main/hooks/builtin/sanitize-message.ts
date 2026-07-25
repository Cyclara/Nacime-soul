// src/main/hooks/builtin/sanitize-message.ts
// 内置 sanitize hook：priority=100，对用户消息执行 Unicode 安全清理
// 依据：S-001 P1-13、S-005 P1-09

import { sanitizeUnicode } from '../../security/unicode'
import { HookPriority, type HookRegistration } from '../types'
import { LifecycleEvent } from '../lifecycle'

/** 消息数据结构（chat.message 事件的 data） */
export interface ChatMessageData {
  text: string
  sessionId?: string
  [key: string]: unknown
}

/**
 * sanitize-message hook：对用户输入执行 Unicode NFKC 归一化 + 危险格式字符删除。
 * priority=100（最早执行），failOpen=true（sanitize 失败不阻断聊天）。
 */
export const sanitizeMessageHook: HookRegistration = {
  name: 'sanitize-message',
  event: LifecycleEvent.CHAT_MESSAGE,
  priority: HookPriority.SANITIZE,
  failOpen: true,
  fn(_ctx, data) {
    const msg = data as ChatMessageData
    const cleaned = sanitizeUnicode(msg.text)
    return { data: { ...msg, text: cleaned } }
  }
}
