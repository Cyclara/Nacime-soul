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
  <section class="l0-card" aria-label="她了解的你">
    <div class="card-header">
      <div>
        <h2 class="card-title">她了解的你</h2>
        <p v-if="state.l0?.filledCount === 0" class="card-subtitle">
          目前还是空白，所有字段都等待由你亲口告诉她。
        </p>
      </div>
      <span v-if="state.l0" class="field-count"
        >{{ state.l0.filledCount }}/{{ state.l0.totalCount }}</span
      >
    </div>

    <div v-if="!state.l0" class="l0-skeleton" aria-label="正在加载画像字段">
      <span v-for="index in 9" :key="index"></span>
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
  padding: 20px clamp(16px, 3vw, 30px) 22px;
  border-bottom: 1px solid var(--color-border-subtle);
  background:
    linear-gradient(180deg, var(--color-companion-soft), transparent 54%),
    color-mix(in srgb, var(--color-bg-secondary) 88%, transparent);
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}

.card-header > div {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.card-title {
  color: var(--color-text);
  font-family: var(--font-family-display);
  font-size: var(--font-size-lg);
  font-weight: 600;
  letter-spacing: 0.01em;
}

.card-subtitle {
  margin-top: 4px;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  line-height: 1.5;
}

.field-count {
  min-width: 40px;
  padding: 3px 8px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-full);
  background: var(--color-surface-translucent);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.l0-skeleton,
.l0-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(176px, 1fr));
  gap: 9px;
}

.l0-skeleton span {
  min-height: 74px;
  border: 1px dashed var(--color-border-subtle);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--color-border-subtle) 70%, transparent);
}

.l0-field {
  display: flex;
  min-height: 74px;
  flex-direction: column;
  gap: 7px;
  padding: 11px 12px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--color-surface) 76%, transparent);
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease;
}

.l0-field:hover {
  background: var(--color-surface);
  border-color: color-mix(in srgb, var(--color-border) 76%, var(--color-companion) 24%);
}

.l0-field.unknown {
  border-style: dashed;
  background: color-mix(in srgb, var(--color-bg-secondary) 44%, transparent);
}

.l0-field.unknown:hover {
  background: color-mix(in srgb, var(--color-bg-tertiary) 62%, transparent);
}

.l0-field.pinned {
  border-color: color-mix(in srgb, var(--color-accent) 28%, var(--color-border));
  background: var(--color-accent-soft);
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
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-weight: 600;
  letter-spacing: 0.015em;
}

.pin-badge {
  filter: grayscale(1);
  font-size: 10px;
  cursor: help;
  opacity: 0.72;
}

.field-value {
  color: var(--color-text);
  font-size: var(--font-size-base);
  line-height: 1.45;
  word-break: break-word;
  user-select: text;
}

.value-placeholder {
  color: var(--color-text-muted);
  font-style: italic;
}

@media (max-width: 480px) {
  .l0-card {
    padding-inline: 12px;
  }

  .l0-skeleton,
  .l0-grid {
    grid-template-columns: repeat(auto-fill, minmax(142px, 1fr));
  }
}
</style>
