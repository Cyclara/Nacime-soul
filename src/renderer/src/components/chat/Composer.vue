<script setup lang="ts">
// P1-24: Composer - 输入框 + 发送/停止按钮 + 思考模式开关
// 依据：S-001 P1-24、S-002 §3.2 canSend/isStreaming
// 无业务逻辑：只调用 store.setDraft/send/stop + config.patch/save
//
// 思考模式开关（2026-07-15 加入）：
//   - 位置：输入框上方左侧
//   - 状态跟配置走（永久记忆）：thinkingEnabled ↔ config.model.reasoningEffort ('off' | 'high')
//   - 厂商不支持时（supportsThinking=false）禁用：如 Moonshot（thinkingFormat='none'）
//   - 依据：https://api-docs.deepseek.com/zh-cn/guides/thinking_mode

import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useChatStore } from '../../stores/chat'
import { useConfigStore } from '../../stores/config'

const chatStore = useChatStore()
const configStore = useConfigStore()
const { canSend, isStreaming } = storeToRefs(chatStore)
const { state: configState } = storeToRefs(configStore)

const toggleError = ref<string | null>(null)

// 思考模式开关：从 config.model.reasoningEffort 派生
// UI toggle 只用两个值：'off'（关）↔ 'high'（开）
// low/medium 也存在于 schema 中（S-005），但 UI 只暴露 off/high 两档以统一各厂商语义。
const thinkingEnabled = computed(() => {
  const effort = configState.value.draft?.model.reasoningEffort
  return effort !== undefined && effort !== 'off'
})

// 当前 provider/model 是否支持思考模式（compat 层判定）
// draft 或 saved 中任一认为支持即启用（HMR 后 draft 可能未重新加载）
const supportsThinking = computed(() => {
  const draftVal = configState.value.draft?.model.supportsThinking
  if (draftVal === true) return true
  const savedVal = configState.value.saved?.model.supportsThinking
  return savedVal === true
})

function onInput(e: Event): void {
  const target = e.target as HTMLTextAreaElement
  chatStore.setDraft(target.value)
}

function onEnter(e: KeyboardEvent): void {
  if (e.shiftKey) return
  e.preventDefault()
  if (canSend.value) {
    void chatStore.send()
  }
}

function onSend(): void {
  if (canSend.value) {
    void chatStore.send()
  }
}

function onStop(): void {
  void chatStore.stop()
}

async function onToggleThinking(): Promise<void> {
  if (!supportsThinking.value) return
  toggleError.value = null
  const next = thinkingEnabled.value ? 'off' : 'high'
  configStore.patch('model', { reasoningEffort: next })
  const ok = await configStore.save()
  if (!ok) {
    toggleError.value = '思考模式切换失败，请重试'
  }
}

// “显示思考过程”开关：控制 UI 是否渲染 reasoning_content（与思考模式开关独立）
const showReasoning = computed(() => {
  const draftVal = configState.value.draft?.ui.chat.showReasoning
  if (draftVal !== undefined) return draftVal
  return configState.value.saved?.ui.chat.showReasoning ?? true
})

async function onToggleShowReasoning(): Promise<void> {
  toggleError.value = null
  const currentChat = configState.value.draft?.ui.chat
  if (!currentChat) return
  const next = !showReasoning.value
  // patch 对嵌套对象只做顶层浅合并：ui.chat 必须整体替换，否则 sendOnEnter/showTimestamps 会丢
  configStore.patch('ui', { chat: { ...currentChat, showReasoning: next } })
  const ok = await configStore.save()
  if (!ok) {
    toggleError.value = '显示思考过程切换失败，请重试'
  }
}
</script>

<template>
  <div class="composer-wrapper">
    <div class="thinking-toggle-row">
      <button
        class="thinking-toggle"
        :class="{ 'is-on': thinkingEnabled, 'is-disabled': !supportsThinking }"
        :disabled="!supportsThinking"
        :title="supportsThinking ? '' : '当前模型不支持思考模式'"
        @click="onToggleThinking"
      >
        <span class="toggle-label">思考模式</span>
        <span class="toggle-track">
          <span class="toggle-thumb"></span>
        </span>
        <span class="toggle-state">{{ thinkingEnabled ? '开' : '关' }}</span>
      </button>
      <button
        class="reasoning-visibility-toggle"
        :class="{ 'is-on': showReasoning }"
        title="是否显示思考过程"
        @click="onToggleShowReasoning"
      >
        显示思考
      </button>
      <span v-if="toggleError" class="toggle-error">{{ toggleError }}</span>
    </div>
    <div class="composer">
      <textarea
        class="input"
        placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
        :value="chatStore.state.draft"
        rows="2"
        @input="onInput"
        @keydown.enter="onEnter"
      />
      <button v-if="!isStreaming" class="send-btn" :disabled="!canSend" @click="onSend">
        发送
      </button>
      <button v-else class="stop-btn" @click="onStop">停止</button>
    </div>
  </div>
</template>

<style scoped>
.composer-wrapper {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
}
.thinking-toggle-row {
  display: flex;
  padding: var(--spacing-sm) var(--spacing-md) 0;
}
.thinking-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-xs) var(--spacing-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  border-radius: var(--radius);
}
.thinking-toggle:hover:not(.is-disabled) {
  background: var(--color-bg-tertiary);
}
.thinking-toggle.is-disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.toggle-label {
  font-weight: 500;
}
/* 滑动开关：track 是圆角胶囊，thumb 左右滑动 */
.toggle-track {
  position: relative;
  width: 34px;
  height: 18px;
  background: var(--color-bg-tertiary);
  border-radius: 9px;
  transition: background 0.2s ease;
}
.toggle-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  background: var(--color-text-secondary);
  border-radius: 50%;
  transition:
    left 0.2s ease,
    background 0.2s ease;
}
.thinking-toggle.is-on .toggle-track {
  background: var(--color-accent);
}
.thinking-toggle.is-on .toggle-thumb {
  left: 18px;
  background: var(--color-bg);
}
.toggle-state {
  min-width: 16px;
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
.thinking-toggle.is-on .toggle-state {
  color: var(--color-accent);
  font-weight: 600;
}
.toggle-error {
  margin-left: var(--spacing-sm);
  font-size: var(--font-size-sm);
  color: var(--color-error);
}
.reasoning-visibility-toggle {
  margin-left: var(--spacing-sm);
  padding: var(--spacing-xs) var(--spacing-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  border-radius: var(--radius);
  border: 1px solid var(--color-border);
}
.reasoning-visibility-toggle:hover {
  background: var(--color-bg-tertiary);
}
.reasoning-visibility-toggle.is-on {
  color: var(--color-accent);
  border-color: var(--color-accent);
  background: rgba(122, 162, 247, 0.1);
}
.composer {
  display: flex;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-md) var(--spacing-md);
}
.input {
  flex: 1;
  padding: var(--spacing-sm) var(--spacing-md);
  border-radius: var(--radius);
  border: 1px solid var(--color-border);
  background: var(--color-bg-tertiary);
  color: var(--color-text);
  font-size: var(--font-size-base);
  line-height: 1.5;
}
.input:focus {
  border-color: var(--color-accent);
}
.send-btn {
  padding: var(--spacing-sm) var(--spacing-lg);
  border-radius: var(--radius);
  background: var(--color-accent);
  color: var(--color-bg);
  font-size: var(--font-size-base);
  font-weight: 600;
}
.send-btn:hover:not(:disabled) {
  background: var(--color-accent-hover);
}
.stop-btn {
  padding: var(--spacing-sm) var(--spacing-lg);
  border-radius: var(--radius);
  background: var(--color-error);
  color: var(--color-bg);
  font-size: var(--font-size-base);
  font-weight: 600;
}
.stop-btn:hover {
  opacity: 0.85;
}
</style>
