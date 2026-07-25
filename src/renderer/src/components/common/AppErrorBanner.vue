<script setup lang="ts">
// P1-24: AppErrorBanner - 全局错误横幅
// 依据：S-001 P1-24、S-002 §3.1 transientErrors/fatalError
// 无业务逻辑：只展示 store 中的错误，调用 dismissError

import { storeToRefs } from 'pinia'
import { useAppStore } from '../../stores/app'

const appStore = useAppStore()
const { state } = storeToRefs(appStore)
</script>

<template>
  <div v-if="state.fatalError" class="banner fatal">
    <span class="icon">⚠</span>
    <span class="msg">{{ state.fatalError.message }}</span>
  </div>
  <div v-for="(err, idx) in state.transientErrors" :key="idx" class="banner transient">
    <span class="icon">⚠</span>
    <span class="msg">{{ err.message }}</span>
    <button class="close" @click="appStore.dismissError(err.code)">×</button>
  </div>
</template>

<style scoped>
.banner {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-md);
  font-size: var(--font-size-sm);
}
.banner.fatal {
  background: var(--color-error);
  color: var(--color-bg);
}
.banner.transient {
  background: var(--color-bg-tertiary);
  color: var(--color-warning);
  border-bottom: 1px solid var(--color-border);
}
.icon {
  flex-shrink: 0;
}
.msg {
  flex: 1;
}
.close {
  background: none;
  color: inherit;
  font-size: 18px;
  line-height: 1;
  padding: 0 var(--spacing-xs);
}
.close:hover {
  opacity: 0.7;
}
</style>
