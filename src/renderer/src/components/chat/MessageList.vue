<script setup lang="ts">
// P1-24: MessageList - 消息列表
// 依据：S-001 P1-24、S-002 §3.2 orderedMessages（main 已排序，禁止组件再排序）
// 无业务逻辑：只展示 store.orderedMessages，自动滚动到底部

import { ref, watch, nextTick, computed, onMounted, onBeforeUnmount } from 'vue'
import { storeToRefs } from 'pinia'
import { useChatStore } from '../../stores/chat'
import MessageBubble from './MessageBubble.vue'
import { shouldShowDivider, formatDividerLabel } from '../../utils/time-divider'
import type { ChatMessageView } from '@shared/chat/types'

const chatStore = useChatStore()
const { orderedMessages } = storeToRefs(chatStore)

const scrollContainer = ref<HTMLElement | null>(null)

// 验收反馈④b：QQ/微信式时间分隔条。now 每 30s 走一格，
// 标签随时间推移自动老化（今天 HH:mm → 昨天 HH:mm → …）。
const now = ref(Date.now())
let nowTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  nowTimer = setInterval(() => {
    now.value = Date.now()
  }, 30_000)
})
onBeforeUnmount(() => {
  if (nowTimer !== null) clearInterval(nowTimer)
})

type ListItem =
  | { type: 'divider'; key: string; label: string }
  | { type: 'message'; key: string; message: ChatMessageView }

const items = computed<ListItem[]>(() => {
  const out: ListItem[] = []
  let prev: number | null = null
  for (const m of orderedMessages.value) {
    if (shouldShowDivider(prev, m.createdAt)) {
      out.push({ type: 'divider', key: `t-${m.id}`, label: formatDividerLabel(m.createdAt, now.value) })
    }
    out.push({ type: 'message', key: m.id, message: m })
    prev = m.createdAt
  }
  return out
})

// 用户是否上滑离开了底部（距底部 > 80px 视为"正在读历史"，不再强制滚底）。
// S-02 修复：流式输出时上滑阅读不被拽回；滑回底部后自动跟随恢复。
let userScrolledUp = false

function scrollToBottom(): void {
  nextTick(() => {
    if (scrollContainer.value && !userScrolledUp) {
      scrollContainer.value.scrollTop = scrollContainer.value.scrollHeight
    }
  })
}

function onScroll(): void {
  const el = scrollContainer.value
  if (!el) return
  userScrolledUp = el.scrollHeight - el.scrollTop - el.clientHeight > 80
}

watch(
  () => orderedMessages.value.length,
  () => scrollToBottom()
)

// 流式时也滚动（内容增长）
watch(
  () => {
    const msgs = orderedMessages.value
    return msgs.length > 0 ? msgs[msgs.length - 1].content : ''
  },
  () => scrollToBottom()
)
</script>

<template>
  <div ref="scrollContainer" class="message-list" @scroll="onScroll">
    <div v-if="orderedMessages.length === 0" class="empty-hint">
      <span class="empty-orbit" aria-hidden="true"><i></i></span>
      <p>开始和 Nacime 对话吧</p>
      <span class="empty-subtitle">不必想好开场，想到什么就慢慢说。</span>
    </div>
    <div v-if="orderedMessages.length > 0" class="message-column">
      <template v-for="item in items" :key="item.key">
        <div v-if="item.type === 'divider'" class="time-divider">
          <span>{{ item.label }}</span>
        </div>
        <MessageBubble v-else :message="item.message" />
      </template>
    </div>
  </div>
</template>

<style scoped>
.message-list {
  position: relative;
  z-index: 1;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 0 24px;
  scroll-padding-block: 18px;
}

.message-column {
  width: min(100%, 1040px);
  margin-inline: auto;
}

/* QQ/微信式时间分隔条：居中、浅字，安静不抢戏 */
.time-divider {
  display: flex;
  justify-content: center;
  margin: 16px 0 12px;
  user-select: none;
}

.time-divider span {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  letter-spacing: 0.04em;
}

.empty-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  min-height: 260px;
  padding: var(--spacing-xl);
  color: var(--color-text-secondary);
  text-align: center;
}

.empty-hint p {
  margin-top: 22px;
  color: var(--color-text-secondary);
  font-family: var(--font-family-display);
  font-size: clamp(19px, 2vw, 24px);
  letter-spacing: 0.015em;
}

.empty-subtitle {
  margin-top: 8px;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  line-height: 1.65;
}

.empty-orbit {
  position: relative;
  display: grid;
  width: 72px;
  height: 72px;
  place-items: center;
  border: 1px solid var(--color-border-subtle);
  border-radius: 50%;
  background:
    radial-gradient(circle at 36% 32%, var(--color-companion-soft), transparent 38%),
    var(--color-surface-translucent);
  box-shadow: var(--shadow-glow);
}

.empty-orbit::before,
.empty-orbit::after {
  position: absolute;
  content: '';
  border-radius: 50%;
}

.empty-orbit::before {
  inset: 15px;
  border: 1px solid color-mix(in srgb, var(--color-accent) 42%, transparent);
  border-right-color: transparent;
  transform: rotate(-30deg);
}

.empty-orbit::after {
  top: 17px;
  right: 18px;
  width: 7px;
  height: 7px;
  background: var(--color-companion);
  box-shadow: 0 0 14px color-mix(in srgb, var(--color-companion) 58%, transparent);
}

.empty-orbit i {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: var(--color-accent);
  box-shadow: 0 0 0 6px var(--color-accent-soft);
}

@media (max-height: 560px) {
  .empty-orbit {
    width: 58px;
    height: 58px;
  }

  .empty-hint p {
    margin-top: 14px;
  }
}
</style>
