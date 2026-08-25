<script setup lang="ts">
// P2-42/P2-46: "你们的记忆时间线"，保持倒序投影与 TimelineEntry 子组件边界。

import TimelineEntry from './TimelineEntry.vue'
import type { GrowthTimelineEntryView } from '@shared/memory/types'

defineProps<{
  entries: GrowthTimelineEntryView[]
}>()
</script>

<template>
  <section class="growth-timeline" aria-labelledby="timeline-title">
    <header class="timeline-heading">
      <div>
        <p class="timeline-kicker">MOMENTS KEPT · 被留下的时刻</p>
        <h2 id="timeline-title">你们的记忆时间线</h2>
      </div>
      <span class="entry-count">{{ String(entries.length).padStart(2, '0') }}</span>
    </header>

    <ol v-if="entries.length > 0" class="timeline-list">
      <TimelineEntry
        v-for="(entry, index) in entries"
        :key="entry.ts + entry.title"
        :entry="entry"
        :index="index"
      />
    </ol>
    <div v-else class="timeline-empty">
      <span class="empty-mark" aria-hidden="true">✦</span>
      <div>
        <strong>第一枚里程碑还没落下</strong>
        <p>当她记住你的名字、陪你聊过一周，或真正理解一次纠正，这里会留下那一天。</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.growth-timeline {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: clamp(22px, 4vw, 36px);
  border: 1px solid var(--color-border-subtle);
  border-radius: 9px 26px 26px 26px;
  background:
    radial-gradient(circle at 0 100%, var(--color-companion-soft), transparent 30%),
    var(--color-surface-elevated);
  box-shadow: var(--shadow-md);
}

.timeline-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 18px;
  padding-bottom: 15px;
  border-bottom: 1px solid var(--color-border-subtle);
}

.timeline-kicker {
  color: var(--color-companion);
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.18em;
}

.timeline-heading h2 {
  margin-top: 7px;
  color: var(--color-text);
  font-family: var(--font-family-display);
  font-size: clamp(24px, 3vw, 32px);
  font-weight: 540;
  letter-spacing: -0.025em;
}

.entry-count {
  color: var(--color-text-tertiary);
  font-family: var(--font-family-display);
  font-size: 28px;
  font-variant-numeric: tabular-nums;
}

.timeline-list {
  position: relative;
  margin: 0;
  padding: 1px 0;
  list-style: none;
}

.timeline-list::before {
  position: absolute;
  top: 16px;
  bottom: 16px;
  left: 19px;
  width: 1px;
  background: linear-gradient(var(--color-accent), var(--color-border-subtle) 72%, transparent);
  content: '';
}

.timeline-empty {
  display: flex;
  min-height: 150px;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 24px;
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--color-bg-tertiary) 52%, transparent);
}

.empty-mark {
  display: grid;
  width: 46px;
  height: 46px;
  flex-shrink: 0;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--color-companion) 34%, var(--color-border));
  border-radius: 50% 50% 50% 13px;
  background: var(--color-companion-soft);
  color: var(--color-companion);
  font-size: 18px;
}

.timeline-empty strong {
  color: var(--color-text);
  font-family: var(--font-family-display);
  font-size: var(--font-size-lg);
  font-weight: 560;
}

.timeline-empty p {
  max-width: 46ch;
  margin-top: 5px;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  line-height: 1.65;
}

@media (max-width: 520px) {
  .timeline-empty {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
