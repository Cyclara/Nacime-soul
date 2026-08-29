<script setup lang="ts">
// P2-32: DmaeMemoryTable -- 有资格进入的记忆列表（F5-002 §3.7 activeSet）。
// 验收①：显示"有资格进入"集合。
// ⚠ 文案必须写"有资格进入"，不写"上一轮用了"（F5-002 §5 红线）。

import { computed } from 'vue'
import type { DmaeActiveSetEntry } from '@shared/memory/dmae-types'
import type { DensityMode } from '../../stores/dmae'

const props = defineProps<{
  entries: readonly DmaeActiveSetEntry[]
  density: DensityMode
  maxActive: number
  hasMore?: boolean
}>()

const emit = defineEmits<{
  select: [memoryId: string]
  loadMore: []
}>()

const hasEntries = computed(() => props.entries.length > 0)

function trendIcon(trend: 'rising' | 'falling' | 'stable'): string {
  if (trend === 'rising') return '↑'
  if (trend === 'falling') return '↓'
  return '→'
}

function trendLabel(trend: 'rising' | 'falling' | 'stable'): string {
  if (trend === 'rising') return '上升中'
  if (trend === 'falling') return '下降中'
  return '稳定'
}
</script>

<template>
  <section class="memory-table-section">
    <h2 class="section-title">
      有资格进入的{{ entries.length }}件事
      <span class="title-hint">（共 {{ maxActive }} 个位置）</span>
    </h2>
    <p class="section-explain">达到记忆门槛的候选；不等同于本轮最终注入。</p>
    <div v-if="!hasEntries" class="table-empty">
      <p class="empty-text">目前没有记忆达到进入思考的门槛。</p>
      <p class="empty-hint">多聊几轮，她记住的事会在这里出现。</p>
    </div>
    <ul v-else class="memory-list" role="list">
      <li
        v-for="entry in entries"
        :key="entry.memoryId"
        class="memory-row"
        :class="{ selected: entry.selectedLastTurn }"
        role="button"
        tabindex="0"
        :aria-label="`查看记忆详情：${entry.contentPreview || '（无内容预览）'}`"
        @click="emit('select', entry.memoryId)"
        @keydown.enter="emit('select', entry.memoryId)"
        @keydown.space.prevent="emit('select', entry.memoryId)"
      >
        <div class="row-main">
          <p class="row-content">{{ entry.contentPreview || '（无内容预览）' }}</p>
          <div class="row-meta">
            <span v-if="entry.decayExempt" class="exempt-badge" title="重要度满级，不会自然淡忘"
              >🔒 不会淡忘</span
            >
            <span v-if="entry.selectedLastTurn" class="selected-badge">上一轮选中</span>
            <span v-if="entry.injectedLastTurn" class="injected-badge">最终注入</span>
            <span class="trend-badge" :class="'trend-' + entry.trend">
              {{ trendIcon(entry.trend) }} {{ trendLabel(entry.trend) }}
            </span>
          </div>
        </div>
        <div class="row-aside">
          <div class="activation-value">{{ Math.round(entry.activation) }}</div>
          <!-- 迷你 sparkline -->
          <svg
            v-if="entry.spark.length >= 2"
            class="sparkline"
            :viewBox="`0 0 40 16`"
            preserveAspectRatio="none"
          >
            <polyline
              :points="
                entry.spark
                  .map((v, i) => {
                    const x = (i / (entry.spark.length - 1)) * 40
                    const max = Math.max(...entry.spark)
                    const min = Math.min(...entry.spark)
                    const range = max - min || 1
                    const y = 14 - ((v - min) / range) * 12
                    return `${x},${y}`
                  })
                  .join(' ')
              "
              fill="none"
              stroke="var(--color-accent)"
              stroke-width="1.5"
            />
          </svg>
          <span v-if="density === 'engineering'" class="eng-id">{{
            entry.memoryId.slice(0, 12)
          }}</span>
        </div>
      </li>
    </ul>
    <button v-if="hasMore" type="button" class="load-more" @click="emit('loadMore')">加载更多有资格的记忆</button>
  </section>
</template>

<style scoped>
.memory-table-section {
  padding: 18px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
  background: var(--color-surface-translucent);
  box-shadow:
    var(--shadow-sm),
    inset 0 1px rgba(255, 255, 255, 0.025);
  backdrop-filter: blur(12px);
}

.section-title {
  margin-bottom: 4px;
  color: var(--color-text);
  font-family: var(--font-family-display);
  font-size: var(--font-size-lg);
  font-weight: 600;
  line-height: 1.35;
}

.title-hint {
  color: var(--color-text-muted);
  font-family: var(--font-family-body);
  font-size: var(--font-size-xs);
  font-weight: 400;
}

.section-explain {
  margin-bottom: 12px;
  color: var(--color-text-muted);
  font-size: 10px;
  line-height: 1.5;
}

.table-empty {
  padding: 32px 8px;
  border: 1px dashed var(--color-border-subtle);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--color-bg-tertiary) 36%, transparent);
  text-align: center;
}

.empty-text {
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.55;
}

.empty-hint {
  margin-top: 5px;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.memory-list {
  display: flex;
  flex-direction: column;
  gap: 7px;
  list-style: none;
}

.memory-row {
  display: flex;
  min-height: 72px;
  align-items: center;
  gap: 10px;
  padding: 10px 11px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--color-bg-tertiary) 42%, transparent);
  cursor: pointer;
  transition:
    background 0.15s ease,
    border-color 0.15s ease,
    box-shadow 0.15s ease,
    transform 0.12s ease;
}

.memory-row:hover {
  border-color: color-mix(in srgb, var(--color-accent) 24%, var(--color-border));
  background: var(--color-surface);
  box-shadow: var(--shadow-sm);
  transform: translateY(-1px);
}

.memory-row:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.memory-row.selected {
  border-color: color-mix(in srgb, var(--color-accent) 44%, var(--color-border));
  background:
    linear-gradient(145deg, var(--color-accent-soft), transparent 74%), var(--color-surface);
}

.row-main {
  min-width: 0;
  flex: 1;
}

.row-content {
  display: -webkit-box;
  overflow: hidden;
  color: var(--color-text);
  font-size: var(--font-size-sm);
  line-height: 1.5;
  text-overflow: ellipsis;
  user-select: text;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.row-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 7px;
}

.exempt-badge,
.selected-badge,
.injected-badge,
.trend-badge {
  min-height: 20px;
  padding: 2px 7px;
  border: 1px solid transparent;
  border-radius: var(--radius-full);
  font-size: 10px;
}

.exempt-badge {
  border-color: color-mix(in srgb, var(--color-state-active) 18%, transparent);
  background: var(--color-state-active-bg);
  color: var(--color-state-active);
  filter: saturate(0.8);
}

.selected-badge {
  border-color: color-mix(in srgb, var(--color-accent) 18%, transparent);
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.injected-badge {
  border-color: color-mix(in srgb, var(--color-state-active) 18%, transparent);
  background: var(--color-state-active-bg);
  color: var(--color-state-active);
}

.load-more {
  width: 100%;
  min-height: 34px;
  margin-top: 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
  cursor: pointer;
  font: inherit;
  font-size: var(--font-size-xs);
}

.load-more:hover { background: var(--color-surface); }

.trend-badge {
  color: var(--color-text-muted);
}

.trend-rising {
  color: var(--color-state-active);
}

.trend-falling {
  color: var(--color-state-dormant);
}

.row-aside {
  display: flex;
  flex-shrink: 0;
  flex-direction: column;
  align-items: flex-end;
  gap: 3px;
}

.activation-value {
  display: grid;
  min-width: 30px;
  height: 26px;
  place-items: center;
  border-radius: var(--radius-full);
  background: var(--color-accent-soft);
  color: var(--color-text-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: var(--font-size-xs);
  font-weight: 650;
}

.sparkline {
  width: 44px;
  height: 17px;
  opacity: 0.82;
}

.eng-id {
  color: var(--color-text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 9px;
}

@media (max-width: 1180px) {
  .memory-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  }
}

@media (max-width: 520px) {
  .memory-list {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .memory-row {
    transition: none;
  }
}
</style>
