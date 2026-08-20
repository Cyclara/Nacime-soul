<script setup lang="ts">
// P1-24/P1-24A/C-β: ChatView - 主视图
// 依据：S-001 P1-24/P1-24A、S-002-补充-bootstrap生命周期
// 职责：根据 App 级 boot stage 和 config 状态切换 FirstRunGuide/ChatShell
// 无业务逻辑进组件：应用 bootstrap 由路由外常驻的 App.vue 独占

import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useAppStore } from '../stores/app'
import { useConfigStore } from '../stores/config'
import { useChatStore } from '../stores/chat'
import ChatShell from '../components/chat/ChatShell.vue'
import FirstRunGuide from '../components/onboarding/FirstRunGuide.vue'

const appStore = useAppStore()
const configStore = useConfigStore()
const chatStore = useChatStore()
const { state: appState } = storeToRefs(appStore)
const { state: configState } = storeToRefs(configStore)

const isFirstRunCompleted = ref(false)

const needsOnboarding = computed(() => {
  if (isFirstRunCompleted.value) return false
  if (!configState.value.draft) return true
  return !configState.value.draft.model.hasApiKey
})

const isLoading = computed(
  () => appState.value.bootStage === 'idle' || appState.value.bootStage === 'loading-config'
)

function onFirstRunComplete(text: string): void {
  isFirstRunCompleted.value = true
  chatStore.setDraft(text)
  void chatStore.send()
}
</script>

<template>
  <div class="chat-view">
    <div v-if="isLoading" class="loading" role="status" aria-live="polite">
      <div class="spinner"></div>
      <p>正在加载...</p>
    </div>
    <div v-else-if="appState.fatalError" class="fatal-error" role="alert">
      <p>{{ appState.fatalError.message }}</p>
      <button class="retry-btn" @click="appStore.reset()">重试</button>
    </div>
    <FirstRunGuide v-else-if="needsOnboarding" @start-chat="onFirstRunComplete" />
    <ChatShell v-else />
  </div>
</template>

<style scoped>
.chat-view {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.loading,
.fatal-error {
  display: flex;
  width: min(calc(100% - 32px), 420px);
  min-height: 230px;
  flex: 0 0 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-md);
  margin: auto;
  padding: var(--spacing-xl);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-xl);
  background: var(--color-surface-translucent);
  box-shadow: var(--shadow-lg);
  color: var(--color-text-secondary);
  text-align: center;
  backdrop-filter: blur(18px);
}

.fatal-error {
  border-color: var(--color-error-border);
  background:
    radial-gradient(circle at 50% 0%, var(--color-error-bg), transparent 58%),
    var(--color-surface-translucent);
}

.fatal-error p {
  max-width: 34ch;
  color: var(--color-text-secondary);
  line-height: 1.65;
}

.spinner {
  width: 34px;
  height: 34px;
  border: 2px solid var(--color-border);
  border-top-color: var(--color-accent);
  border-right-color: var(--color-companion);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.retry-btn {
  min-height: 42px;
  padding: 9px 20px;
  border-radius: var(--radius-full);
  background: var(--color-accent);
  box-shadow: var(--shadow-sm);
  color: var(--color-text-on-accent);
  font-weight: 650;
}

.retry-btn:hover {
  background: var(--color-accent-hover);
  box-shadow: var(--shadow-md);
  transform: translateY(-1px);
}
</style>
