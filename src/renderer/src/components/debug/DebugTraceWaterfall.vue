<script setup lang="ts">
// P2-28: 最近一轮追踪的 span 瀑布
// 依据：F5-011 §3 wireframe 右上
import { computed } from 'vue'
import type { TurnTrace } from '@shared/observability/types'

const props = defineProps<{
  traces: TurnTrace[]
}>()

const latest = computed<TurnTrace | null>(() => {
  if (props.traces.length === 0) return null
  return props.traces[props.traces.length - 1]
})

const maxSpanMs = computed(() => {
  if (!latest.value) return 1
  const max = Math.max(...latest.value.spans.map((s) => s.durationMs), 1)
  return max
})

function barWidth(ms: number): string {
  return `${Math.max(2, Math.round((ms / maxSpanMs.value) * 100))}%`
}

function fmtMs(ms: number): string {
  if (ms < 1) return '<1ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function fmtTurnId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id
}
</script>

<template>
  <div class="trace-waterfall">
    <div class="trace-header">
      最近一轮追踪
      <span v-if="latest" class="trace-meta">
        ({{ fmtTurnId(latest.turnId) }}) 总耗时 {{ fmtMs(latest.totalMs ?? 0) }}
      </span>
      <span v-else class="trace-empty">暂无</span>
    </div>
    <div v-if="latest" class="trace-spans">
      <div
        v-for="(span, i) in latest.spans"
        :key="i"
        class="trace-span"
        :class="{ 'span-fail': !span.ok }"
      >
        <span class="span-name" :title="span.name">{{ span.name }}</span>
        <div class="span-bar-track">
          <div class="span-bar" :style="{ width: barWidth(span.durationMs) }" />
        </div>
        <span class="span-dur">{{ fmtMs(span.durationMs) }}</span>
        <span v-if="span.code" class="span-code">{{ span.code }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.trace-waterfall {
  background: var(--dbg-bg, #1e1e2e);
  padding: 8px;
  flex: 1;
  overflow-y: auto;
  min-height: 120px;
}
.trace-header {
  font-weight: 600;
  color: var(--dbg-accent, #89b4fa);
  border-bottom: 1px solid var(--dbg-border, #45475a);
  padding-bottom: 4px;
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.trace-meta {
  font-weight: 400;
  opacity: 0.7;
}
.trace-empty {
  font-weight: 400;
  opacity: 0.5;
}
.trace-spans {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.trace-span {
  display: grid;
  grid-template-columns: 120px 1fr 60px 80px;
  gap: 6px;
  align-items: center;
}
.span-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.span-bar-track {
  background: var(--dbg-border, #45475a);
  height: 10px;
  border-radius: 2px;
  overflow: hidden;
}
.span-bar {
  height: 100%;
  background: var(--dbg-accent, #89b4fa);
  border-radius: 2px;
}
.span-dur {
  text-align: right;
  opacity: 0.8;
}
.span-code {
  opacity: 0.6;
  font-size: 11px;
}
.span-fail .span-bar {
  background: var(--dbg-error, #f38ba8);
}
.span-fail .span-code {
  color: var(--dbg-error, #f38ba8);
  opacity: 1;
}
</style>
