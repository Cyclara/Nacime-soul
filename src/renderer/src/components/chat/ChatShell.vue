<script setup lang="ts">
// P1-24/P2-31: ChatShell - 聊天容器（消息列表 + 输入框 + 记忆面板入口）
// 依据：S-001 P1-24、S-006 §1.2（ChatHeader 菜单入口；当前用浮动按钮简化，前端模型可美化）
// 无业务逻辑：组合 MessageList + Composer + 记忆入口

import { useRouter } from 'vue-router'
import MessageList from './MessageList.vue'
import Composer from './Composer.vue'

const router = useRouter()
</script>

<template>
  <div class="chat-shell">
    <button
      class="memory-entry"
      aria-label="查看她的记忆"
      title="她的记忆"
      @click="router.push('/memory')"
    >
      🧠
    </button>
    <MessageList />
    <Composer />
  </div>
</template>

<style scoped>
.chat-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  flex: 1;
  position: relative;
}
.memory-entry {
  position: absolute;
  top: var(--spacing-sm);
  right: var(--spacing-sm);
  z-index: 10;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  color: var(--color-text);
  font-size: 1.1rem;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.memory-entry:hover {
  background: var(--color-accent);
  color: var(--color-bg);
}
</style>
