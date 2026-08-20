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
  position: relative;
  display: flex;
  align-items: center;
  gap: 16px;
  min-height: 76px;
  margin-bottom: 7px;
  padding: 12px 14px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--color-surface) 58%, transparent);
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease,
    box-shadow 0.15s ease,
    transform 0.12s ease;
}

.l2-item::before {
  position: absolute;
  top: 12px;
  bottom: 12px;
  left: 0;
  width: 2px;
  border-radius: var(--radius-full);
  background: var(--color-accent-soft-hover);
  content: '';
  opacity: 0;
  transition: opacity 0.15s ease;
}

.l2-item:hover,
.l2-item:focus-visible {
  border-color: color-mix(in srgb, var(--color-accent) 24%, var(--color-border));
  background: var(--color-surface);
  box-shadow: var(--shadow-sm);
  transform: translateY(-1px);
}

.l2-item:hover::before,
.l2-item:focus-visible::before {
  opacity: 1;
}

.l2-item.deleted {
  opacity: 0.72;
}

.l2-item.deleted .item-content {
  text-decoration: line-through;
}

.item-main {
  min-width: 0;
  flex: 1;
}

.item-content {
  display: -webkit-box;
  margin-bottom: 7px;
  overflow: hidden;
  color: var(--color-text);
  font-size: var(--font-size-base);
  line-height: 1.58;
  word-break: break-word;
  user-select: text;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.item-meta {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: var(--font-size-xs);
}

.state-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 22px;
  padding: 2px 8px;
  border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
  border-radius: var(--radius-full);
  font-weight: 550;
}

.state-dot {
  width: 6px;
  height: 6px;
  flex-shrink: 0;
  border-radius: 50%;
  box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 10%, transparent);
}

.type-tag {
  min-height: 22px;
  padding: 2px 8px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--color-bg-tertiary) 72%, transparent);
  color: var(--color-text-secondary);
}

.pin-mark {
  filter: grayscale(1);
  font-size: 10px;
  opacity: 0.72;
}

.activation-bar {
  display: flex;
  width: 76px;
  flex-shrink: 0;
  align-items: center;
  gap: 7px;
}

.bar-track {
  height: 5px;
  flex: 1;
  overflow: hidden;
  border-radius: var(--radius-full);
  background: var(--color-bg-tertiary);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.12);
}

.bar-fill {
  height: 100%;
  border-radius: var(--radius-full);
  background: linear-gradient(90deg, var(--color-companion), var(--color-accent));
  transition: width 0.25s ease;
}

.bar-value {
  min-width: 17px;
  color: var(--color-text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

@media (prefers-reduced-motion: reduce) {
  .bar-fill,
  .l2-item,
  .l2-item::before {
    transition: none;
  }
}

@media (max-width: 480px) {
  .l2-item {
    gap: 10px;
    padding: 11px 10px;
  }

  .activation-bar {
    width: 48px;
  }

  .bar-value {
    display: none;
  }
}
</style>
