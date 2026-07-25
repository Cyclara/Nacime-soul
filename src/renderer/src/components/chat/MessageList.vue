<script setup lang="ts">
// P1-24: MessageList - 消息列表
// 依据：S-001 P1-24、S-002 §3.2 orderedMessages（main 已排序，禁止组件再排序）
// 无业务逻辑：只展示 store.orderedMessages，自动滚动到底部

import { ref, watch, nextTick } from 'vue'
import { storeToRefs } from 'pinia'
import { useChatStore } from '../../stores/chat'
import MessageBubble from './MessageBubble.vue'

const chatStore = useChatStore()
const { orderedMessages } = storeToRefs(chatStore)

const scrollContainer = ref<HTMLElement | null>(null)

function scrollToBottom(): void {
  nextTick(() => {
    if (scrollContainer.value) {
      scrollContainer.value.scrollTop = scrollContainer.value.scrollHeight
    }
  })
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
  <div ref="scrollContainer" class="message-list">
    <div v-if="orderedMessages.length === 0" class="empty-hint">
      <p>开始和 Nacime 对话吧</p>
    </div>
    <MessageBubble v-for="msg in orderedMessages" :key="msg.id" :message="msg" />
  </div>
</template>

<style scoped>
.message-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--spacing-md) 0;
}
.empty-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--color-text-muted);
  font-size: var(--font-size-lg);
}
</style>
