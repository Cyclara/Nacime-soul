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

    <div class="header-actions">
      <button
        class="dmae-btn"
        aria-label="查看记忆引擎"
        title="记忆引擎"
        @click="router.push('/dmae')"
      >
        <span>引擎</span>
      </button>
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
    </div>
  </header>
</template>

<style scoped>
.memory-header {
  position: relative;
  z-index: 5;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: var(--spacing-md);
  min-height: 72px;
  padding: 11px clamp(14px, 2.4vw, 28px);
  border-bottom: 1px solid var(--color-border-subtle);
  background: var(--color-surface-translucent);
  backdrop-filter: blur(18px) saturate(112%);
  flex-shrink: 0;
}

.back-btn,
.growth-btn,
.dmae-btn {
  display: inline-flex;
  min-height: 38px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 7px 11px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--color-surface) 74%, transparent);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.back-btn {
  justify-self: start;
}

.back-btn:hover,
.growth-btn:hover,
.dmae-btn:hover {
  border-color: color-mix(in srgb, var(--color-accent) 32%, var(--color-border));
  background: var(--color-accent-soft);
  color: var(--color-text);
  transform: translateY(-1px);
}

.header-actions {
  display: flex;
  justify-self: end;
  gap: 6px;
}

.dmae-btn {
  background: var(--color-companion-soft);
}

.btn-icon {
  width: 16px;
  height: 16px;
}

.header-center {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: center;
  gap: 12px;
}

.header-title {
  color: var(--color-text);
  font-family: var(--font-family-display);
  font-size: clamp(20px, 2.2vw, 25px);
  font-weight: 600;
  letter-spacing: 0.015em;
  white-space: nowrap;
}

.fill-badge {
  position: relative;
  display: inline-flex;
  min-height: 32px;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--color-accent) 24%, var(--color-border));
  border-radius: var(--radius-full);
  background: var(--color-accent-soft);
  font-size: var(--font-size-xs);
}

.fill-badge::after {
  position: absolute;
  right: -12px;
  bottom: -16px;
  width: 48px;
  height: 34px;
  border-radius: 50%;
  background: var(--color-companion-soft);
  content: '';
  pointer-events: none;
}

.fill-icon,
.fill-label,
.fill-value {
  position: relative;
  z-index: 1;
}

.fill-icon {
  color: var(--color-companion);
  font-size: 10px;
}

.fill-label {
  color: var(--color-text-secondary);
}

.fill-value {
  color: var(--color-accent);
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}

@media (max-width: 720px) {
  .memory-header {
    min-height: 64px;
    padding-inline: 12px;
  }

  .header-center {
    flex-direction: column;
    gap: 2px;
  }

  .header-title {
    font-size: var(--font-size-lg);
  }

  .fill-badge {
    min-height: 24px;
    padding-block: 2px;
  }

  .back-btn,
  .growth-btn,
  .dmae-btn {
    width: 40px;
    height: 40px;
    padding: 0;
  }

  .back-btn span,
  .growth-btn span,
  .fill-label {
    display: none;
  }
}
</style>
