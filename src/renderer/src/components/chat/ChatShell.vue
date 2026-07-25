<script setup lang="ts">
// P1-24: ChatShell - 聊天容器（消息列表 + 输入框）
// 依据：S-001 P1-24
// 无业务逻辑：组合 MessageList + Composer

import MessageList from './MessageList.vue'
import Composer from './Composer.vue'
</script>

<template>
  <div class="chat-shell">
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
}
</style>
