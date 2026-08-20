<script setup lang="ts">
// P2-31: MemoryView -- 记忆面板主视图。
// 依据：S-006 §1.2（组件树）、S-012 §3.3（bootstrap 注册 memory 订阅）。
// 功能版（视觉待前端模型美化，CLAUDE.md UI 切换点：P2-31 功能完成后切换前端模型）。

import { onMounted, onUnmounted, computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useMemoryStore } from '../stores/memory'
import { useSettingsUiStore } from '../stores/settings-ui'
import MemoryHeader from '../components/memory/MemoryHeader.vue'
import MemoryEnableGuide from '../components/memory/MemoryEnableGuide.vue'
import L0ProfileCard from '../components/memory/L0ProfileCard.vue'
import L2MemoryList from '../components/memory/L2MemoryList.vue'
import MemoryDetailDrawer from '../components/memory/MemoryDetailDrawer.vue'

const memoryStore = useMemoryStore()
const settingsUi = useSettingsUiStore()
const { state } = storeToRefs(memoryStore)

let unsub: (() => void) | null = null

// memory.enabled=false -> 引导态（S-006 §1.2 MemoryEnableGuide 替换整页）
const isDisabled = computed(() => !state.value.enabled)

function openSettings(): void {
  settingsUi.open('memory')
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
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background:
    radial-gradient(circle at 8% 4%, var(--color-companion-soft), transparent 28%),
    radial-gradient(circle at 92% 12%, var(--color-accent-soft), transparent 26%), var(--color-bg);
}

.memory-content {
  display: flex;
  width: min(100%, 1320px);
  min-height: 0;
  flex: 1;
  flex-direction: column;
  align-self: center;
  overflow: hidden;
  border-inline: 1px solid var(--color-border-subtle);
  background: color-mix(in srgb, var(--color-bg) 86%, transparent);
  box-shadow: 0 20px 60px rgba(8, 7, 10, 0.08);
}

.error-banner {
  position: absolute;
  z-index: 80;
  right: 18px;
  bottom: 18px;
  display: flex;
  max-width: min(460px, calc(100% - 36px));
  align-items: center;
  gap: 10px;
  padding: 10px 13px;
  border: 1px solid var(--color-error-border);
  border-radius: var(--radius);
  background: var(--color-surface-translucent);
  box-shadow: var(--shadow-md);
  color: var(--color-error);
  font-size: var(--font-size-sm);
  backdrop-filter: blur(14px);
}

.error-icon {
  display: grid;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  place-items: center;
  border: 1px solid currentColor;
  border-radius: 50%;
  font-size: 10px;
}

.error-message {
  line-height: 1.5;
  user-select: text;
}

.slide-down-enter-active,
.slide-down-leave-active {
  transition:
    transform 0.25s ease,
    opacity 0.25s ease;
}

.slide-down-enter-from,
.slide-down-leave-to {
  opacity: 0;
  transform: translateY(12px);
}

@media (max-width: 1320px) {
  .memory-content {
    border-inline: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .slide-down-enter-active,
  .slide-down-leave-active {
    transition: none;
  }
}
</style>
