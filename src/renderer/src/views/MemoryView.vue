<script setup lang="ts">
// P2-31: MemoryView -- 记忆面板主视图。
// 依据：S-006 §1.2（组件树）、S-012 §3.3（bootstrap 注册 memory 订阅）。
// 功能版（视觉待前端模型美化，CLAUDE.md UI 切换点：P2-31 功能完成后切换前端模型）。

import { onMounted, onUnmounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useMemoryStore } from '../stores/memory'
import MemoryHeader from '../components/memory/MemoryHeader.vue'
import MemoryEnableGuide from '../components/memory/MemoryEnableGuide.vue'
import L0ProfileCard from '../components/memory/L0ProfileCard.vue'
import L2MemoryList from '../components/memory/L2MemoryList.vue'
import MemoryDetailDrawer from '../components/memory/MemoryDetailDrawer.vue'

const router = useRouter()
const memoryStore = useMemoryStore()
const { state } = storeToRefs(memoryStore)

let unsub: (() => void) | null = null

// memory.enabled=false -> 引导态（S-006 §1.2 MemoryEnableGuide 替换整页）
const isDisabled = computed(() => !state.value.enabled)

// settingsUi store 尚未实现；引导按钮先回聊天页（设置抽屉后续 Phase 2 接入）
function openSettings(): void {
  void router.push('/')
}

onMounted(() => {
  // S-002-补充 §1：进入页面先 subscribe 再 hydrate
  unsub = memoryStore.subscribe()
  void memoryStore.hydrate()
})

onUnmounted(() => {
  unsub?.()
  memoryStore.reset()
})
</script>

<template>
  <div class="memory-view">
    <MemoryHeader />
    <MemoryEnableGuide v-if="isDisabled" @open-settings="openSettings" />
    <template v-else>
      <div class="memory-content">
        <L0ProfileCard />
        <L2MemoryList />
      </div>
    </template>
    <MemoryDetailDrawer />
    <transition name="slide-down">
      <div v-if="state.lastError" class="error-banner" role="alert">
        <span class="error-icon">⚠</span>
        <span class="error-message">{{ state.lastError.message }}</span>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.memory-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--color-bg);
}

.memory-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.error-banner {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-md);
  background: var(--color-error-bg);
  color: var(--color-error);
  font-size: var(--font-size-sm);
  border-top: 1px solid var(--color-error-border);
  backdrop-filter: blur(8px);
}

.error-icon {
  flex-shrink: 0;
  font-size: var(--font-size-base);
}

.error-message {
  line-height: 1.5;
}

.slide-down-enter-active,
.slide-down-leave-active {
  transition:
    transform 0.25s ease,
    opacity 0.25s ease;
}

.slide-down-enter-from,
.slide-down-leave-to {
  transform: translateY(-100%);
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .slide-down-enter-active,
  .slide-down-leave-active {
    transition: none;
  }
}
</style>
