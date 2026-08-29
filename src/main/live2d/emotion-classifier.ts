// src/main/live2d/emotion-classifier.ts
// 完成定义第 3 条缺失的第一环：把最终可见回复映射成一个语义情绪标签。
//
// 为什么是 main 侧本地启发式，而不是让模型在回复里内嵌标签（用户 2026-08-29 选定方案 ②）：
//   内嵌标签要在流式输出里剥离，直接撞 F5-001 C1 的红线「observe 下 releaseText 逐字节
//   等于 delta」，还要改 prompt 预算。本分类器只读**已经完成、已经持久化**的那一条 assistant
//   文本，不进流循环、不改一个字节、不发网络请求。
//
// 保守原则：没有可辨信号就回 neutral，绝不为了「有反应」乱猜。分类结果只是一个枚举标签，
// 正文永不出本模块（调用方只拿到 Live2dSemanticEmotion）。
//
// 正则安全：全部用字面量 includes，不用带量词的正则，天然无 ReDoS。

import type { Live2dSemanticEmotion } from '@shared/live2d/types'

/** 只扫描前 4000 字：情绪信号密度足够，且超长回复不会拖住 turn.end。 */
const MAX_SCAN_CHARS = 4_000

interface EmotionSignal {
  readonly emotion: Live2dSemanticEmotion
  readonly weight: number
  readonly markers: readonly string[]
}

/**
 * 分值相同时的优先级：情绪越强烈/越少见越优先，泛化的正面词最后。
 * 「她说了对不起又说了哈哈」应当读作难过而不是开心。
 */
const PRECEDENCE: readonly Live2dSemanticEmotion[] = [
  'sad',
  'angry',
  'shy',
  'surprised',
  'happy',
  'smile',
  'confused',
  'neutral'
]

const SIGNALS: readonly EmotionSignal[] = [
  {
    emotion: 'sad',
    weight: 2,
    markers: ['对不起', '抱歉', '难过', '伤心', '遗憾', '可惜', '心疼', '失落', '哭', '呜', '唉']
  },
  {
    emotion: 'angry',
    weight: 2,
    markers: ['讨厌', '生气', '过分', '气死', '哼！', '哼。', '别闹']
  },
  {
    emotion: 'shy',
    weight: 2,
    markers: ['害羞', '脸红', '不好意思', '难为情', '别看我', '羞']
  },
  {
    emotion: 'surprised',
    weight: 2,
    markers: ['真的吗', '居然', '竟然', '没想到', '哇', '咦', '诶', '欸', '？！', '！？', '?!', '!?']
  },
  {
    emotion: 'happy',
    weight: 2,
    markers: ['太好了', '好开心', '超开心', '哈哈', '嘿嘿', '嘻嘻', '好耶', '棒极了', '高兴']
  },
  {
    emotion: 'smile',
    weight: 1,
    markers: ['开心', '喜欢', '谢谢', '好棒', '不错', '当然', '嗯嗯', '~', '～', '♪']
  },
  {
    emotion: 'confused',
    weight: 1,
    markers: ['不太明白', '不明白', '搞不懂', '奇怪', '怎么办', '疑惑']
  }
]

function scan(text: string): Map<Live2dSemanticEmotion, number> {
  const scores = new Map<Live2dSemanticEmotion, number>()
  for (const signal of SIGNALS) {
    let score = 0
    for (const marker of signal.markers) {
      if (text.includes(marker)) score += signal.weight
    }
    if (score > 0) scores.set(signal.emotion, score)
  }
  return scores
}

/**
 * 把一条最终 assistant 回复分类为语义情绪。纯函数、确定性、可单测；
 * 无信号或空文本恒为 `neutral`。
 */
export function classifyReplyEmotion(reply: string): Live2dSemanticEmotion {
  const text = reply.slice(0, MAX_SCAN_CHARS).toLocaleLowerCase()
  if (text.trim().length === 0) return 'neutral'

  const scores = scan(text)
  if (scores.size === 0) {
    // 纯疑问句没有情绪词时读作困惑；这是「她在问你」而不是「她没表情」。
    const trimmed = text.trimEnd()
    return trimmed.endsWith('？') || trimmed.endsWith('?') ? 'confused' : 'neutral'
  }

  let best: Live2dSemanticEmotion = 'neutral'
  let bestScore = 0
  for (const emotion of PRECEDENCE) {
    const score = scores.get(emotion) ?? 0
    if (score > bestScore) {
      best = emotion
      bestScore = score
    }
  }
  return best
}
