<script setup lang="ts">
// P2-28: 最近 50 条脱敏错误
// 依据：F5-011 §3 wireframe 右下
import { computed } from 'vue'
import type { LogLevel } from '@shared/observability/types'
import type { ErrorCode } from '@shared/errors'

interface ErrorEntry {
  ts: number
  level: LogLevel
  code?: ErrorCode
  msg: string
}

const props = defineProps<{
  errors: ErrorEntry[]
}>()

// 倒序显示（最新在上）
const sorted = computed(() => [...props.errors].reverse())

function fmtTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}
</script>

<template>
  <div class="error-list">
    <div class="error-header">最近错误 ({{ sorted.length }})</div>
    <div class="error-items">
      <div v-if="sorted.length === 0" class="error-empty">暂无错误</div>
      <div v-for="(e, i) in sorted" :key="i" class="error-row" :class="`level-${e.level}`">
        <span class="err-time">{{ fmtTime(e.ts) }}</span>
        <span class="err-level">{{ e.level }}</span>
        <span v-if="e.code" class="err-code">{{ e.code }}</span>
        <span class="err-msg" :title="e.msg">{{ e.msg }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.error-list {
  background: var(--dbg-bg, #1e1e2e);
  padding: 8px;
  flex: 1;
  overflow-y: auto;
  min-height: 80px;
  max-height: 200px;
}
.error-header {
  font-weight: 600;
  color: var(--dbg-accent, #89b4fa);
  border-bottom: 1px solid var(--dbg-border, #45475a);
  padding-bottom: 4px;
  margin-bottom: 6px;
}
.error-items {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.error-empty {
  opacity: 0.5;
}
.error-row {
  display: grid;
  grid-template-columns: 60px 50px 120px 1fr;
  gap: 6px;
  font-size: 11px;
  align-items: baseline;
}
.err-time {
  opacity: 0.6;
}
.err-level {
  font-weight: 600;
}
.err-code {
  opacity: 0.7;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.err-msg {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.level-fatal .err-level,
.level-error .err-level {
  color: var(--dbg-error, #f38ba8);
}
.level-warn .err-level {
  color: var(--dbg-warn, #f9e2af);
}
.level-fatal {
  background: rgba(243, 139, 168, 0.1);
}
</style>
