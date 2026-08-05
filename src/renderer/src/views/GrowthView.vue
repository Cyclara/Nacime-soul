<script setup lang="ts">
// P2-31: GrowthView 占位（成长面板 P2-42 实现）。
// 依据：S-006 §1.1（/growth 路由）、S-012 §3.1（growth store P2-30b 后交付）。
// 当前只提供返回聊天气泡 + 占位说明，不伪造成长数据。

import { useRouter } from 'vue-router'
import { useMemoryStore } from '../stores/memory'
import { onMounted, onUnmounted } from 'vue'

const router = useRouter()
const memoryStore = useMemoryStore()
let unsub: (() => void) | null = null

onMounted(() => {
  // growth store 未实现（P2-30b）；复用 memory store 的 enabled 判断引导态
  unsub = memoryStore.subscribe()
  void memoryStore.hydrate()
})
onUnmounted(() => {
  unsub?.()
})
</script>

<template>
  <div class="growth-view">
    <header class="growth-header">
      <button class="back-btn" @click="router.push('/')">← 返回</button>
      <h1>你们的记忆</h1>
    </header>
    <div class="growth-placeholder">
      <p>成长面板将在后续阶段完整呈现（U 值、阶段徽章、里程碑时间线）。</p>
      <p class="hint">当前她还在认识你的路上。</p>
    </div>
  </div>
</template>

<style scoped>
.growth-view {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.growth-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-md);
  border-bottom: 1px solid var(--color-border);
}
.back-btn {
  padding: var(--spacing-xs) var(--spacing-sm);
  border-radius: var(--radius);
  background: var(--color-surface);
  color: var(--color-text);
}
.growth-placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-sm);
  color: var(--color-text-secondary);
}
.hint {
  font-size: 0.9em;
  opacity: 0.7;
}
</style>
