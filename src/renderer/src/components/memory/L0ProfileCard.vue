<script setup lang="ts">
// P2-31: L0ProfileCard -- 画像字段网格（"未知/待发现"灰态 + 已知值 + pin 图标）。
// 依据：S-006 §1.2、S-011 §1.3（L0 按白名单固定顺序）、S-006 §1.4（空态人格化）。
// 功能版（视觉待前端模型美化）。

import { storeToRefs } from 'pinia'
import { useMemoryStore } from '../../stores/memory'

const memoryStore = useMemoryStore()
const { state } = storeToRefs(memoryStore)
</script>

<template>
  <section class="l0-card" aria-label="用户画像">
    <div class="card-header">
      <h2 class="card-title">她了解的你</h2>
      <span v-if="state.l0" class="field-count"
        >{{ state.l0.filledCount }}/{{ state.l0.totalCount }}</span
      >
    </div>

    <div v-if="!state.l0 || state.l0.filledCount === 0" class="l0-empty">
      <span class="empty-icon" aria-hidden="true">🌙</span>
      <p>她还不了解你</p>
      <p class="empty-hint">多聊聊自己，她会一点点记住的。</p>
    </div>

    <div v-else class="l0-grid">
      <div
        v-for="field in state.l0.fields"
        :key="field.key"
        class="l0-field"
        :class="{ unknown: field.value === null, pinned: field.isPinned }"
      >
        <div class="field-header">
          <span class="field-label">{{ field.label }}</span>
          <span v-if="field.isPinned" class="pin-badge" title="已固定（不会被覆盖）">📌</span>
        </div>
        <div class="field-value">
          <span v-if="field.value !== null">{{ field.value }}</span>
          <span v-else class="value-placeholder">待发现</span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.l0-card {
  flex-shrink: 0;
  padding: var(--spacing-md) var(--spacing-lg);
  background: var(--color-bg-secondary);
  border-bottom: 1px solid var(--color-border);
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--spacing-md);
}

.card-title {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.field-count {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

.l0-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-xs);
  padding: var(--spacing-xl) var(--spacing-md);
  text-align: center;
  color: var(--color-text-secondary);
  background: var(--color-bg-tertiary);
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-lg);
}

.empty-icon {
  font-size: var(--font-size-2xl);
  opacity: 0.7;
}

.empty-hint {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}

.l0-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: var(--spacing-sm);
}

.l0-field {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
  padding: var(--spacing-sm);
  border-radius: var(--radius);
  background: var(--color-surface);
  border: 1px solid transparent;
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease,
    transform 0.1s ease;
}

.l0-field:hover {
  background: var(--color-surface-elevated);
  border-color: var(--color-border);
}

.l0-field.unknown {
  background: transparent;
  border: 1px dashed var(--color-border);
}

.l0-field.unknown:hover {
  background: var(--color-bg-tertiary);
}

.l0-field.pinned {
  background: var(--color-accent-soft);
  border-color: var(--color-accent-soft-hover);
}

.l0-field.pinned:hover {
  background: var(--color-accent-soft-hover);
}

.field-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-xs);
}

.field-label {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.pin-badge {
  font-size: var(--font-size-xs);
  cursor: help;
}

.field-value {
  font-size: var(--font-size-base);
  color: var(--color-text);
  line-height: 1.4;
  word-break: break-word;
}

.value-placeholder {
  color: var(--color-text-muted);
  font-style: italic;
}

@media (max-width: 480px) {
  .l0-grid {
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  }
}
</style>
