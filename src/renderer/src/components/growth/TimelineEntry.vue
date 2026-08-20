<script setup lang="ts">
// P2-42/P2-46: 时间线叙事条目。颜色永远伴随 kind 文本，不以颜色作为唯一信息通道。

import type { GrowthTimelineEntryView } from '@shared/memory/types'

const props = withDefaults(
  defineProps<{
    entry: GrowthTimelineEntryView
    index?: number
  }>(),
  { index: 0 }
)

function formatDate(ts: number): { day: string; year: string } {
  const date = new Date(ts)
  return {
    day: `${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`,
    year: String(date.getFullYear())
  }
}

const date = formatDate(props.entry.ts)
</script>

<template>
  <li class="timeline-entry" :class="entry.kind">
    <div class="entry-node" aria-hidden="true">
      <span>{{ entry.kind === 'milestone' ? '✦' : '◇' }}</span>
    </div>
    <article class="entry-card">
      <header class="entry-head">
        <div class="entry-labels">
          <span class="entry-kind">{{ entry.kind === 'milestone' ? '里程碑' : '月度小结' }}</span>
          <span class="entry-sequence">NO. {{ String(index + 1).padStart(2, '0') }}</span>
        </div>
        <time :datetime="new Date(entry.ts).toISOString()">
          <strong>{{ date.day }}</strong>
          <small>{{ date.year }}</small>
        </time>
      </header>
      <h3>{{ entry.title }}</h3>
      <p>{{ entry.text }}</p>
    </article>
  </li>
</template>

<style scoped>
.timeline-entry {
  position: relative;
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr);
  gap: 14px;
  padding: 10px 0 20px;
}

.timeline-entry:last-child {
  padding-bottom: 6px;
}

.entry-node {
  position: relative;
  z-index: 1;
  display: grid;
  width: 39px;
  height: 39px;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--color-accent) 38%, var(--color-border));
  border-radius: 50%;
  background: var(--color-surface-elevated);
  box-shadow: 0 0 0 6px color-mix(in srgb, var(--color-surface-elevated) 92%, transparent);
  color: var(--color-accent);
  font-size: 13px;
}

.timeline-entry.periodic .entry-node {
  border-color: color-mix(in srgb, var(--color-companion) 38%, var(--color-border));
  color: var(--color-companion);
}

.entry-card {
  position: relative;
  min-width: 0;
  padding: 16px 18px 17px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 4px 18px 18px 18px;
  background: color-mix(in srgb, var(--color-bg-secondary) 68%, var(--color-surface-elevated));
  transition:
    border-color 0.18s ease,
    box-shadow 0.18s ease,
    transform 0.18s ease;
}

.entry-card:hover {
  border-color: var(--color-border);
  box-shadow: var(--shadow-sm);
  transform: translateX(2px);
}

.entry-card::before {
  position: absolute;
  top: 17px;
  left: -7px;
  width: 12px;
  height: 12px;
  border-bottom: 1px solid var(--color-border-subtle);
  border-left: 1px solid var(--color-border-subtle);
  background: inherit;
  content: '';
  transform: rotate(45deg);
}

.entry-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
}

.entry-labels {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
}

.entry-kind {
  display: inline-flex;
  min-height: 22px;
  align-items: center;
  padding: 2px 9px;
  border-radius: var(--radius-full);
  background: var(--color-accent-soft);
  color: var(--color-accent);
  font-size: 9px;
  font-weight: 750;
  letter-spacing: 0.08em;
}

.periodic .entry-kind {
  background: var(--color-companion-soft);
  color: var(--color-companion);
}

.entry-sequence {
  color: var(--color-text-tertiary);
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 0.1em;
}

.entry-head time {
  display: flex;
  flex-shrink: 0;
  align-items: baseline;
  gap: 5px;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

.entry-head time strong {
  font-family: var(--font-family-display);
  font-size: 15px;
  font-weight: 560;
}

.entry-head time small {
  color: var(--color-text-tertiary);
  font-size: 8px;
}

.entry-card h3 {
  margin-top: 10px;
  color: var(--color-text);
  font-family: var(--font-family-display);
  font-size: clamp(17px, 2vw, 21px);
  font-weight: 560;
  letter-spacing: -0.015em;
}

.entry-card > p {
  margin-top: 6px;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.68;
  user-select: text;
}

@media (max-width: 500px) {
  .timeline-entry {
    grid-template-columns: 34px minmax(0, 1fr);
    gap: 10px;
  }

  .entry-node {
    width: 33px;
    height: 33px;
  }

  .entry-card {
    padding: 14px;
  }

  .entry-head {
    flex-direction: column;
    gap: 7px;
  }
}
</style>
