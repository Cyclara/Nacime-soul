<script setup lang="ts">
// P2-31: L2MemoryItem -- 内容摘要 + 状态色点 + activation 微条 + 类型标签。
// 依据：S-006 §1.2/§1.4（色点必须伴随文字标签，activation 提供 aria-label）。
// 功能版（视觉待前端模型美化）。

import type { L2MemoryView } from '@shared/memory/types'

const props = defineProps<{ item: L2MemoryView }>()
defineEmits<{ (e: 'open', id: string): void }>()

const STATE_LABELS: Record<string, { label: string; colorVar: string; bgVar: string }> = {
  active: { label: '活跃', colorVar: '--color-state-active', bgVar: '--color-state-active-bg' },
  dormant: { label: '休眠', colorVar: '--color-state-dormant', bgVar: '--color-state-dormant-bg' },
  archived: {
    label: '归档',
    colorVar: '--color-state-archived',
    bgVar: '--color-state-archived-bg'
  },
  soft_deleted: {
    label: '已删除',
    colorVar: '--color-state-deleted',
    bgVar: '--color-state-deleted-bg'
  }
}

const TYPE_LABELS: Record<string, string> = {
  one_off: '一次性',
  situational: '情境',
  stable: '稳定'
}

const stateMeta = STATE_LABELS[props.item.lifecycleState] ?? {
  label: props.item.lifecycleState,
  colorVar: '--color-text-muted',
  bgVar: '--color-bg-tertiary'
}
</script>

<template>
  <li
    class="l2-item"
    role="listitem"
    :class="{ deleted: item.lifecycleState === 'soft_deleted' }"
    @click="$emit('open', item.id)"
  >
    <div class="item-main">
      <p class="item-content">{{ item.content }}</p>
      <div class="item-meta">
        <span
          class="state-badge"
          :style="{
            color: `var(${stateMeta.colorVar})`,
            background: `var(${stateMeta.bgVar})`
          }"
        >
          <span class="state-dot" :style="{ background: `var(${stateMeta.colorVar})` }"></span>
          <span>{{ stateMeta.label }}</span>
        </span>
        <span class="type-tag">{{ TYPE_LABELS[item.type] ?? item.type }}</span>
        <span v-if="item.isPinned" class="pin-mark" title="已固定">📌</span>
      </div>
    </div>

    <div
      class="activation-bar"
      :title="`激活值 ${item.activation.toFixed(1)}`"
      :aria-label="`记忆激活值 ${item.activation.toFixed(1)}`"
    >
      <div class="bar-track">
        <div class="bar-fill" :style="{ width: Math.min(100, item.activation) + '%' }"></div>
      </div>
      <span class="bar-value" aria-hidden="true">{{ item.activation.toFixed(0) }}</span>
    </div>
  </li>
</template>

<style scoped>
.l2-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-sm) var(--spacing-lg);
  border-bottom: 1px solid var(--color-border-subtle);
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    transform 0.1s ease;
}

.l2-item:hover,
.l2-item:focus-visible {
  background: var(--color-bg-secondary);
}

.l2-item.deleted {
  opacity: 0.75;
}

.l2-item.deleted .item-content {
  text-decoration: line-through;
}

.item-main {
  flex: 1;
  min-width: 0;
}

.item-content {
  font-size: var(--font-size-base);
  line-height: 1.55;
  margin-bottom: var(--spacing-xs);
  color: var(--color-text);
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.item-meta {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  font-size: var(--font-size-xs);
}

.state-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: var(--radius-full);
  font-weight: 500;
}

.state-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.type-tag {
  color: var(--color-text-secondary);
  padding: 2px 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  background: var(--color-bg-tertiary);
}

.pin-mark {
  font-size: var(--font-size-sm);
}

.activation-bar {
  width: 64px;
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  flex-shrink: 0;
}

.bar-track {
  flex: 1;
  height: 4px;
  background: var(--color-border);
  border-radius: var(--radius-full);
  overflow: hidden;
}

.bar-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--color-accent), var(--color-accent-hover));
  border-radius: var(--radius-full);
  transition: width 0.25s ease;
}

.bar-value {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
  min-width: 14px;
  text-align: right;
}

@media (prefers-reduced-motion: reduce) {
  .bar-fill {
    transition: none;
  }
}

@media (max-width: 480px) {
  .l2-item {
    padding: var(--spacing-sm) var(--spacing-md);
  }

  .activation-bar {
    width: 48px;
  }

  .bar-value {
    display: none;
  }
}
</style>
