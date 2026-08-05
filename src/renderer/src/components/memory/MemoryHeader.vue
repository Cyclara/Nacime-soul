<script setup lang="ts">
// P2-31: MemoryHeader -- 返回聊天 + L0 填充比 + 成长页入口
// 依据：S-006 §1.2。功能版（视觉待前端模型美化）。

import { useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useMemoryStore } from '../../stores/memory'

const router = useRouter()
const memoryStore = useMemoryStore()
const { fillRateLabel } = storeToRefs(memoryStore)
</script>

<template>
  <header class="memory-header">
    <button class="back-btn" aria-label="返回聊天" @click="router.push('/')">
      <svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M15 19l-7-7 7-7"
          stroke="currentColor"
          stroke-width="2"
          fill="none"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <span>返回</span>
    </button>

    <div class="header-center">
      <h1 class="header-title">她的记忆</h1>
      <div class="fill-badge" :title="`画像填充 ${fillRateLabel}`">
        <span class="fill-icon">✦</span>
        <span class="fill-label">了解程度</span>
        <span class="fill-value">{{ fillRateLabel }}</span>
      </div>
    </div>

    <button class="growth-btn" aria-label="进入成长页" @click="router.push('/growth')">
      <span>成长</span>
      <svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M9 5l7 7-7 7"
          stroke="currentColor"
          stroke-width="2"
          fill="none"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
  </header>
</template>

<style scoped>
.memory-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-md);
  padding: var(--spacing-md) var(--spacing-lg);
  background: var(--color-bg-secondary);
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.back-btn,
.growth-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-xs);
  padding: var(--spacing-xs) var(--spacing-sm);
  border-radius: var(--radius);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  border: 1px solid var(--color-border);
}

.back-btn:hover,
.growth-btn:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
  border-color: var(--color-text-muted);
}

.btn-icon {
  width: 16px;
  height: 16px;
}

.header-center {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-md);
  min-width: 0;
}

.header-title {
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--color-text);
}

.fill-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-xs);
  padding: var(--spacing-xs) var(--spacing-sm);
  background: var(--color-accent-soft);
  border: 1px solid var(--color-accent-soft-hover);
  border-radius: var(--radius-full);
  font-size: var(--font-size-sm);
}

.fill-icon {
  color: var(--color-accent);
  font-size: var(--font-size-xs);
}

.fill-label {
  color: var(--color-text-secondary);
}

.fill-value {
  font-weight: 600;
  color: var(--color-accent);
}

@media (max-width: 640px) {
  .memory-header {
    padding: var(--spacing-sm) var(--spacing-md);
  }

  .header-center {
    flex-direction: column;
    gap: var(--spacing-xs);
    align-items: flex-start;
  }

  .back-btn span,
  .growth-btn span {
    display: none;
  }

  .fill-label {
    display: none;
  }
}
</style>
