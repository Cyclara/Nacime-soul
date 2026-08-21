<script setup lang="ts">
// P1-24: MessageBubble - 单条消息气泡
// 依据：S-001 P1-24、S-002 §3.2 ChatMessageView
// 无业务逻辑：只展示 store 投影的消息

import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import type { ChatMessageView } from '@shared/chat/types'
import { useConfigStore } from '../../stores/config'
import { useChatStore } from '../../stores/chat'
import ReasoningBlock from './ReasoningBlock.vue'

// M-18：把错误码映射为用户可读的安全文案（不再只显示"发送失败"四个字）
const ERROR_TEXT: Record<string, string> = {
  LLM_AUTH: 'API Key 无效或未配置，请到设置里检查',
  LLM_RATE_LIMIT: '请求过于频繁，请稍后再试',
  LLM_SERVER: '模型服务暂时不可用，请重试',
  LLM_MALFORMED: '模型返回了异常内容',
  NET_TIMEOUT: '连接超时，请检查网络后重试',
  NET_OFFLINE: '网络连接失败，请检查网络',
  CHAT_CONTEXT_TOO_LARGE: '内容过长，已超出模型上下文窗口',
  CHAT_INTERRUPTED: '回复被中断（应用可能意外关闭）',
  CFG_INVALID: '配置无效，请检查设置',
  UNKNOWN: '发生未知错误，请重试'
}

const props = defineProps<{
  message: ChatMessageView
}>()

const configStore = useConfigStore()
const chatStore = useChatStore()
const { state: configState } = storeToRefs(configStore)

const isUser = computed(() => props.message.role === 'user')
const isError = computed(() => props.message.status === 'failed')
const isStreaming = computed(() => props.message.status === 'streaming')
const isCancelled = computed(() => props.message.status === 'cancelled')

// 失败时的用户可读原因（errorCode -> 文案；无码时用通用文案）
const errorText = computed(() => {
  const code = props.message.errorCode
  if (code && ERROR_TEXT[code]) return ERROR_TEXT[code]
  return '发送失败'
})

// 重试：把当前消息 id 交给 store.retry —— main 侧从该 id 向前找最近 user 消息重新发送。
// 失败/取消的是 assistant 气泡（user 消息恒 complete），retry 会重新生成 assistant 回复。
function onRetry(): void {
  if (props.message.status === 'failed' || props.message.status === 'cancelled') {
    void chatStore.retry(props.message.id)
  }
}

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
  <!-- data-message-id：右键菜单（AppContextMenu）靠 closest('[data-message-id]') 定位气泡所在轮 -->
  <div class="message-row" :class="{ user: isUser, assistant: !isUser }" :data-message-id="message.id">
    <div class="bubble" :class="{ user: isUser, assistant: !isUser }">
      <span class="sender-label">{{ isUser ? '你' : 'Nacime' }}</span>
      <div v-if="isError" class="status-tag error">
        <span class="error-text">{{ errorText }}</span>
        <button class="retry-btn" @click="onRetry">重试</button>
      </div>
      <div v-else-if="isCancelled" class="status-tag cancelled">
        <span>已取消</span>
        <button class="retry-btn" @click="onRetry">重试</button>
      </div>
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
  margin: 12px clamp(16px, 4vw, 52px);
}

.message-row.user {
  justify-content: flex-end;
}

.message-row.assistant {
  justify-content: flex-start;
}

.bubble {
  position: relative;
  max-width: min(78%, 760px);
  padding: 13px 16px 14px;
  border: 1px solid transparent;
  color: var(--color-text);
  font-size: 15px;
  line-height: 1.68;
  word-break: break-word;
  white-space: pre-wrap;
  user-select: text;
}

.sender-label {
  display: block;
  margin-bottom: 5px;
  color: var(--color-text-muted);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  line-height: 1.3;
  text-transform: uppercase;
}

/* 2026-08-21 布局⑤：用户气泡便签化——她=信纸（边框/渐变/衬线署名），
   你=便签（纯底色块、紧凑内边距、更小的不对称圆角），一去一留形成材质对比 */
.bubble.user {
  max-width: min(70%, 680px);
  padding: 10px 14px 11px;
  border-color: transparent;
  border-radius: 14px 14px 4px 14px;
  background: var(--color-user-bubble);
  box-shadow: none;
}

.bubble.user .sender-label {
  color: var(--color-accent);
}

.bubble.assistant {
  border-color: var(--color-border-subtle);
  border-radius: 18px 18px 18px 6px;
  background:
    linear-gradient(145deg, var(--color-companion-soft), transparent 52%),
    var(--color-assistant-bubble);
  box-shadow: inset 0 1px rgba(255, 255, 255, 0.025);
}

.bubble.assistant .sender-label {
  color: var(--color-companion);
  font-family: var(--font-family-display);
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: none;
}

.status-tag {
  display: inline-flex;
  width: fit-content;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  padding: 2px 7px;
  border-radius: var(--radius-full);
  background: var(--color-error-bg);
  color: var(--color-error);
  font-size: var(--font-size-xs);
}

.status-tag.cancelled {
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
}

.retry-btn {
  min-height: 22px;
  padding: 1px 9px;
  border: 1px solid color-mix(in srgb, var(--color-error) 35%, transparent);
  border-radius: var(--radius-full);
  background: var(--color-surface-elevated);
  color: var(--color-error);
  font-size: var(--font-size-xs);
  font-weight: 600;
}

.retry-btn:hover {
  background: var(--color-error);
  color: var(--color-text-on-accent);
}

.typing-indicator {
  display: flex;
  align-items: center;
  min-height: 20px;
  gap: 3px;
}

.typing-indicator span {
  display: inline-block;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--color-companion);
  animation: bounce 1.4s infinite ease-in-out;
}

.typing-indicator span:nth-child(2) {
  animation-delay: 0.16s;
}

.typing-indicator span:nth-child(3) {
  animation-delay: 0.32s;
}

@keyframes bounce {
  0%,
  62%,
  100% {
    opacity: 0.42;
    transform: translateY(0);
  }
  30% {
    opacity: 1;
    transform: translateY(-4px);
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

@media (max-width: 700px) {
  .message-row {
    margin-inline: 12px;
  }

  .bubble,
  .bubble.user {
    max-width: 90%;
  }
}
</style>
