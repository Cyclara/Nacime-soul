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
import AppErrorBanner from '../components/common/AppErrorBanner.vue'
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
    <AppErrorBanner />
    <div v-if="isLoading" class="loading">
      <div class="spinner"></div>
      <p>正在加载...</p>
    </div>
    <div v-else-if="appState.fatalError" class="fatal-error">
      <p>{{ appState.fatalError.message }}</p>
      <button class="retry-btn" @click="appStore.reset()">重试</button>
    </div>
    <FirstRunGuide v-else-if="needsOnboarding" @start-chat="onFirstRunComplete" />
    <ChatShell v-else />
  </div>
</template>

<style scoped>
.chat-view {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.loading,
.fatal-error {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-md);
  color: var(--color-text-secondary);
}
.spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--color-border);
  border-top-color: var(--color-accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.retry-btn {
  padding: var(--spacing-sm) var(--spacing-lg);
  border-radius: var(--radius);
  background: var(--color-accent);
  color: var(--color-bg);
  font-weight: 600;
}
.retry-btn:hover {
  background: var(--color-accent-hover);
}
</style>
