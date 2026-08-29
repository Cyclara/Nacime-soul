<script setup lang="ts">
// P2-32: DmaeStatusSummary -- 状态总览（叙事 + 三态条 + 有资格/实际注入）。
// 依据：F5-002 §3.1 wireframe、§2.1 事实 D（eligibleActive≠promptSelected）、F5-002-补充 §1.4 A。
// 验收②：总览必须同时显示 eligibleActive 与 selection.lastPromptSelectedCount，文案不混。

import { computed } from 'vue'
import type { DmaePanelSnapshot } from '@shared/memory/dmae-types'
import type { DensityMode } from '../../stores/dmae'

const props = defineProps<{
  snapshot: DmaePanelSnapshot
  density: DensityMode
}>()

const counts = computed(() => props.snapshot.counts)
const selection = computed(() => props.snapshot.selection)
const total = computed(
  () => counts.value.eligibleActive + counts.value.dormant + counts.value.archived
)

// 三态占比（用于堆叠条宽度）
const activePct = computed(() =>
  total.value > 0 ? (counts.value.eligibleActive / total.value) * 100 : 0
)
const dormantPct = computed(() =>
  total.value > 0 ? (counts.value.dormant / total.value) * 100 : 0
)
const archivedPct = computed(() =>
  total.value > 0 ? (counts.value.archived / total.value) * 100 : 0
)

// 叙事档一句话结论
const narrative = computed(() => {
  const a = counts.value.eligibleActive
  const d = counts.value.dormant
  const arch = counts.value.archived
  const selected = selection.value?.lastPromptSelectedCount ?? 0
  const included = selection.value?.lastPromptIncludedCount
  const retrieved = selection.value?.lastRetrievalHits ?? 0
  if (total.value === 0) return '她还没有留下任何记忆。'
  // M-46：archived 措辞"一时想不起来"——DMAE 语义下任何命中都能经 Floor 复活，
  // "已经想不起来了"暗示永久遗忘，与实际机制（再聊起相关话题会重新想起）不符。
  const injected =
    included === null || included === undefined ? '注入情况尚无记录' : `最终注入 ${included} 条`
  return `她现在清楚记得 ${a} 件事，${d} 件正在淡忘，${arch} 件一时想不起来。上一轮选中 ${selected} 条，${injected}（本轮共想起 ${retrieved} 条相关的）。`
})
</script>

<template>
  <section class="status-summary" aria-labelledby="dmae-status-title">
    <h2 id="dmae-status-title" class="summary-title">此刻的记忆</h2>
    <!-- 叙事档：一句话结论 -->
    <p v-if="density === 'narrative'" class="narrative-text">{{ narrative }}</p>

    <!-- 三态水平堆叠条（F5-002-补充 §1.4 A：不用环形图） -->
    <div
      v-if="total > 0"
      class="state-bar"
      role="img"
      :aria-label="`清楚记得 ${counts.eligibleActive}，正在淡忘 ${counts.dormant}，一时想不起 ${counts.archived}`"
    >
      <div
        class="state-seg state-active"
        :style="{ width: activePct + '%' }"
        :title="`清楚记得 ${counts.eligibleActive}`"
      >
        <span v-if="activePct > 8" class="seg-label">{{ counts.eligibleActive }}</span>
      </div>
      <div
        class="state-seg state-dormant"
        :style="{ width: dormantPct + '%' }"
        :title="`正在淡忘 ${counts.dormant}`"
      >
        <span v-if="dormantPct > 8" class="seg-label">{{ counts.dormant }}</span>
      </div>
      <div
        class="state-seg state-archived"
        :style="{ width: archivedPct + '%' }"
        :title="`一时想不起 ${counts.archived}`"
      >
        <span v-if="archivedPct > 8" class="seg-label">{{ counts.archived }}</span>
      </div>
    </div>

    <div v-if="total > 0" class="state-legend" aria-hidden="true">
      <span class="legend-item"
        ><i class="legend-dot active"></i>清楚记得 {{ counts.eligibleActive }}</span
      >
      <span class="legend-item"
        ><i class="legend-dot dormant"></i>正在淡忘 {{ counts.dormant }}</span
      >
      <span class="legend-item"
        ><i class="legend-dot archived"></i>一时想不起 {{ counts.archived }}</span
      >
    </div>

    <!-- 第二行：有资格 / selectL2 候选 / budget 后最终注入，三者不混称。 -->
    <div class="selection-row">
      <span class="sel-item">
        <span class="sel-label">有资格进入</span>
        <span class="sel-value">{{ selection.eligibleActiveCount }}</span>
      </span>
      <span class="sel-sep">·</span>
      <span class="sel-item">
        <span class="sel-label" title="selectL2 选中的候选，尚未经过 PromptBudgeter 裁剪"
          >上一轮选中</span
        >
        <span class="sel-value"
          >{{ selection.lastPromptSelectedCount }}/{{ selection.maxActive }}</span
        >
      </span>
      <span class="sel-sep">·</span>
      <span class="sel-item">
        <span class="sel-label" title="PromptBudgeter 预算裁剪后真正保留；旧历史没有此值"
          >最终注入</span
        >
        <span class="sel-value">{{ selection.lastPromptIncludedCount ?? '未知' }}</span>
      </span>
      <span class="sel-sep">·</span>
      <span class="sel-item">
        <span class="sel-label">本轮想起</span>
        <span class="sel-value">{{ selection.lastRetrievalHits }}</span>
      </span>
    </div>

    <!-- 工程档：原始数值 -->
    <dl v-if="density === 'engineering'" class="eng-stats">
      <div class="eng-row">
        <dt>eligibleActive</dt>
        <dd>{{ counts.eligibleActive }}</dd>
      </div>
      <div class="eng-row">
        <dt>dormant</dt>
        <dd>{{ counts.dormant }}</dd>
      </div>
      <div class="eng-row">
        <dt>archived</dt>
        <dd>{{ counts.archived }}</dd>
      </div>
      <div class="eng-row">
        <dt>l2Total</dt>
        <dd>{{ counts.l2Total }}</dd>
      </div>
      <div class="eng-row">
        <dt>turn</dt>
        <dd>#{{ snapshot.currentTurn }}</dd>
      </div>
    </dl>
  </section>
</template>

<style scoped>
.status-summary {
  position: relative;
  padding: clamp(18px, 2.5vw, 26px);
  overflow: hidden;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
  background:
    radial-gradient(circle at 8% 0%, var(--color-companion-soft), transparent 40%),
    linear-gradient(145deg, var(--color-accent-soft), transparent 62%),
    var(--color-surface-translucent);
  box-shadow:
    var(--shadow-md),
    inset 0 1px rgba(255, 255, 255, 0.035);
  backdrop-filter: blur(14px);
}

.status-summary::after {
  position: absolute;
  top: -76px;
  right: -48px;
  width: 190px;
  height: 190px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 50%;
  background: radial-gradient(circle, var(--color-accent-soft), transparent 66%);
  content: '';
  pointer-events: none;
}

.summary-title,
.narrative-text,
.state-bar,
.state-legend,
.selection-row,
.eng-stats {
  position: relative;
  z-index: 1;
}

.summary-title {
  margin-bottom: 9px;
  color: var(--color-text);
  font-family: var(--font-family-display);
  font-size: clamp(20px, 2.2vw, 25px);
  font-weight: 600;
  letter-spacing: 0.01em;
}

.narrative-text {
  max-width: 72ch;
  margin-bottom: 20px;
  color: var(--color-text-secondary);
  font-size: 15px;
  line-height: 1.78;
}

.state-bar {
  display: flex;
  height: 14px;
  overflow: hidden;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-full);
  background: var(--color-bg-tertiary);
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.15);
}

.state-seg {
  display: flex;
  min-width: 2px;
  align-items: center;
  justify-content: center;
  transition: width 0.3s ease;
}

.state-active {
  background: var(--color-state-active);
}

.state-dormant {
  background: var(--color-state-dormant);
}

.state-archived {
  background: var(--color-state-archived);
}

.seg-label {
  display: none;
}

.state-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin-top: 9px;
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.legend-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.legend-dot.active {
  background: var(--color-state-active);
}

.legend-dot.dormant {
  background: var(--color-state-dormant);
}

.legend-dot.archived {
  background: var(--color-state-archived);
}

.selection-row {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin-top: 20px;
}

.sel-item {
  display: flex;
  min-width: 0;
  min-height: 58px;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  padding: 9px 11px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--color-bg-tertiary) 58%, transparent);
}

.sel-label {
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sel-value {
  color: var(--color-text);
  font-family: var(--font-family-display);
  font-size: var(--font-size-xl);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.sel-sep {
  display: none;
}

.eng-stats {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(126px, 1fr));
  gap: 6px;
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--color-border-subtle);
}

.eng-row {
  display: flex;
  justify-content: space-between;
  padding: 5px 7px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--color-bg-tertiary) 46%, transparent);
  font-size: var(--font-size-xs);
}

.eng-row dt {
  color: var(--color-text-muted);
}

.eng-row dd {
  color: var(--color-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

@media (max-width: 620px) {
  .selection-row {
    grid-template-columns: 1fr;
  }

  .sel-item {
    min-height: 50px;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
  }

  .sel-value {
    font-size: var(--font-size-lg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .state-seg {
    transition: none;
  }
}
</style>
