// src/main/live2d/emotion-hook.ts
// 完成定义第 3 条的第二环：turn.end 把分类结果下发给 stage。
//
// 挂 hook 而不是塞进 ChatService：ChatService 不该知道桌面上有没有一个 Live2D 窗口
// （S-006-补充 §1.7.4 的链条是「ChatService 产生标签 → main 下发」，不是双向耦合）。
// priority 370 排在合规审计(350)之后——表情是最外层的表现层，任何情况下都不该抢在
// 记忆提取/DMAE/审计前面执行，也不该因为自己出错影响它们（failOpen: true）。
//
// 文本来源与合规审计 hook 同纪律：**不扩展 TurnEndData 携带全文**，用 turnId 回
// SessionStore 取该轮 assistant 正文。正文只在本模块内停留一次，出去的只有一个枚举标签；
// 日志只记标签与长度，绝不记正文（F5-001 §3.11 红线同样适用）。

import type { Logger } from '@shared/observability/types'
import type { Live2dSemanticEmotion } from '@shared/live2d/types'
import type { HookRegistration, HookResult } from '../hooks/types'
import type { TurnEndData } from '../chat/service'
import type { SessionStore } from '../chat/session-store'
import { classifyReplyEmotion } from './emotion-classifier'

export interface Live2dEmotionHookDeps {
  readonly logger: Logger
  readonly sessionStore: SessionStore
  /** 下发到 stage；无窗口时由 manager 自行 no-op。 */
  readonly setEmotion: (emotion: Live2dSemanticEmotion) => void
  /** stage 未开时直接返回，连 SessionStore 都不读。 */
  readonly isStageLive: () => boolean
}

export function createLive2dEmotionHook(deps: Live2dEmotionHookDeps): HookRegistration {
  return {
    name: 'live2d-emotion',
    event: 'turn.end',
    priority: 370,
    failOpen: true,
    fn(_context, data): HookResult {
      const turn = data as TurnEndData
      // 只有真正说完话的一轮才改表情：failed/cancelled 时她的上一个表情继续保持，
      // 比切回 neutral 更接近「话没说完」的真实状态。
      if (turn.status !== 'completed' || !deps.isStageLive()) return { data }

      const pair = deps.sessionStore.getTurnMessages(turn.sessionId, turn.turnId)
      const reply = pair?.assistant.content ?? ''
      if (reply.length === 0) return { data }

      const emotion = classifyReplyEmotion(reply)
      deps.setEmotion(emotion)
      deps.logger.debug('live2d emotion resolved', {
        scope: 'live2d',
        turnId: turn.turnId,
        tags: { emotion },
        metrics: { replyLen: reply.length }
      })
      return { data }
    }
  }
}
