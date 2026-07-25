<script setup lang="ts">
// P1-24: MessageBubble - 单条消息气泡
// 依据：S-001 P1-24、S-002 §3.2 ChatMessageView
// 无业务逻辑：只展示 store 投影的消息

import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import type { ChatMessageView } from '@shared/chat/types'
import { useConfigStore } from '../../stores/config'
import ReasoningBlock from './ReasoningBlock.vue'

const props = defineProps<{
  message: ChatMessageView
}>()

const configStore = useConfigStore()
const { state: configState } = storeToRefs(configStore)

const isUser = computed(() => props.message.role === 'user')
const isError = computed(() => props.message.status === 'failed')
const isStreaming = computed(() => props.message.status === 'streaming')
const isCancelled = computed(() => props.message.status === 'cancelled')

// 是否显示思考过程：配置 showReasoning 为 true 且消息含 reasoning
// draft 优先（编辑中的配置），fallback 到 saved（已保存的配置）
const showReasoning = computed(() => {
  const draftVal = configState.value.draft?.ui.chat.showReasoning
  if (draftVal !== undefined) return draftVal
  return configState.value.saved?.ui.chat.showReasoning ?? true
})
const hasReasoning = computed(
  () => (props.message.reasoning ?? '').trim().length > 0 || isStreaming.value
)
const visibleReasoning = computed(() => showReasoning.value && hasReasoning.value && !isUser.value)
</script>

<template>
  <div class="message-row" :class="{ user: isUser, assistant: !isUser }">
    <div class="bubble" :class="{ user: isUser, assistant: !isUser }">
      <div v-if="isError" class="status-tag error">发送失败</div>
      <div v-else-if="isCancelled" class="status-tag cancelled">已取消</div>
      <div v-else-if="isStreaming && !message.content" class="typing-indicator">
        <span></span><span></span><span></span>
      </div>
      <span class="content">{{ message.content }}</span>
      <span v-if="isStreaming && message.content" class="cursor">▋</span>
      <ReasoningBlock
        v-if="visibleReasoning"
        :content="message.reasoning ?? ''"
        :is-streaming="isStreaming"
      />
    </div>
  </div>
</template>

<style scoped>
.message-row {
  display: flex;
  margin: var(--spacing-sm) var(--spacing-md);
}
.message-row.user {
  justify-content: flex-end;
}
.message-row.assistant {
  justify-content: flex-start;
}
.bubble {
  max-width: 75%;
  padding: var(--spacing-sm) var(--spacing-md);
  border-radius: var(--radius);
  font-size: var(--font-size-base);
  line-height: 1.6;
  word-break: break-word;
  white-space: pre-wrap;
}
.bubble.user {
  background: var(--color-user-bubble);
  color: var(--color-text);
}
.bubble.assistant {
  background: var(--color-assistant-bubble);
  color: var(--color-text);
}
.status-tag {
  font-size: var(--font-size-sm);
  margin-bottom: var(--spacing-xs);
  color: var(--color-error);
}
.status-tag.cancelled {
  color: var(--color-text-muted);
}
.typing-indicator span {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin: 0 2px;
  border-radius: 50%;
  background: var(--color-text-muted);
  animation: bounce 1.2s infinite ease-in-out;
}
.typing-indicator span:nth-child(2) {
  animation-delay: 0.15s;
}
.typing-indicator span:nth-child(3) {
  animation-delay: 0.3s;
}
@keyframes bounce {
  0%,
  60%,
  100% {
    transform: translateY(0);
  }
  30% {
    transform: translateY(-6px);
  }
}
.cursor {
  animation: blink 1s step-end infinite;
  color: var(--color-accent);
}
@keyframes blink {
  50% {
    opacity: 0;
  }
}
</style>
