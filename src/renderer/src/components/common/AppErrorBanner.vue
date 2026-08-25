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
  <!-- M-32：全局 transient 错误横幅（挂根组件，所有路由可见）。fatal 错误由 ChatView 的
       fatal-error 面板处理（含重试），这里只展示可关闭的 transient 提示。 -->
  <div
    v-for="entry in state.transientErrors"
    :key="entry.id"
    class="banner transient"
    role="status"
  >
    <span class="icon" aria-hidden="true">!</span>
    <span class="msg">{{ entry.error.message }}</span>
    <button class="close" aria-label="关闭这条提示" @click="appStore.dismissError(entry.id)">
      ×
    </button>
  </div>
</template>

<style scoped>
.banner {
  position: relative;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 10px 16px 0;
  padding: 10px 12px;
  border: 1px solid;
  border-radius: var(--radius);
  box-shadow: var(--shadow-sm);
  font-size: var(--font-size-sm);
  line-height: 1.45;
}

.banner.fatal {
  border-color: var(--color-error-border);
  background: var(--color-error-bg);
  color: var(--color-error);
}

.banner.transient {
  border-color: var(--color-warning-border);
  background: var(--color-warning-bg);
  color: var(--color-warning);
}

.icon {
  display: grid;
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  place-items: center;
  border: 1px solid currentColor;
  border-radius: 50%;
  font-size: 11px;
  font-weight: 700;
}

.msg {
  flex: 1;
  color: inherit;
  user-select: text;
}

.close {
  display: grid;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  place-items: center;
  border-radius: 50%;
  color: inherit;
  font-size: 18px;
  line-height: 1;
}

.close:hover {
  background: color-mix(in srgb, currentColor 10%, transparent);
}

@media (max-width: 520px) {
  .banner {
    margin-inline: 10px;
  }
}
</style>
