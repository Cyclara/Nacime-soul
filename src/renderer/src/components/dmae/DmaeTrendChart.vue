<script setup lang="ts">
// P2-32: DmaeTrendChart -- 状态趋势堆叠面积图（F5-002-补充 §1.4 B）。
// 验收③：趋势图渲染 ≥2 天数据。
// 不引入图表库（S-006 §3.1：Phase 2 用轻量 SVG 自绘，≤90 点/图）。

import { computed } from 'vue'
import type { DmaeDailyAggregate } from '@shared/memory/dmae-types'

const props = defineProps<{
  data: readonly DmaeDailyAggregate[]
  loading: boolean
  timeRange: 7 | 30 | 90
}>()

const W = 600
const H = 180
const PAD = { top: 10, right: 10, bottom: 24, left: 36 }
const plotW = W - PAD.left - PAD.right
const plotH = H - PAD.top - PAD.bottom

const hasData = computed(() => props.data.length >= 1)

const maxValue = computed(() => {
  if (props.data.length === 0) return 100
  const max = Math.max(...props.data.map((d) => d.eligibleActive + d.dormant + d.archived))
  return max > 0 ? max : 100
})

// X 轴：按日期数量等分
const xStep = computed(() => {
  return props.data.length > 1 ? plotW / (props.data.length - 1) : 0
})

function xPos(i: number): number {
  return PAD.left + i * xStep.value
}

// Y 轴：值映射到像素
function yPos(v: number): number {
  return PAD.top + plotH - (v / maxValue.value) * plotH
}

// 堆叠面积路径（从底到顶：archived -> dormant -> active）。
// M-13 修复：标准堆叠闭合 = 每层"上边正序 + 下边（下层顶部折线）反序"。
// 旧实现 dormant/active 层的底边只连首尾两点画直线，下层数据非单调变化时面积会重叠/露缝。
const layers = computed(() => {
  if (props.data.length === 0) return []
  const baseY = yPos(0)
  const top: Record<'archived' | 'dormant' | 'active', string[]> = {
    archived: [],
    dormant: [],
    active: []
  }
  const bottom: Record<'archived' | 'dormant' | 'active', string[]> = {
    archived: [],
    dormant: [],
    active: []
  }

  props.data.forEach((d, i) => {
    const x = xPos(i)
    const archY = yPos(d.archived)
    const dormY = yPos(d.archived + d.dormant)
    const actY = yPos(d.archived + d.dormant + d.eligibleActive)
    const cmd = i === 0 ? 'M' : 'L'

    // 上边：正序（archived 顶 / dormant 顶 / active 顶）
    top['archived'].push(`${cmd} ${x} ${archY}`)
    top['dormant'].push(`${cmd} ${x} ${dormY}`)
    top['active'].push(`${cmd} ${x} ${actY}`)
    // 下边：下层顶部折线，反序（unshift 在正向遍历时得到逆序）
    //   archived 底 = 轴线（常数 baseY）；dormant 底 = archived 顶折线；active 底 = dormant 顶折线
    bottom['archived'].unshift(`${cmd} ${x} ${baseY}`)
    bottom['dormant'].unshift(`${cmd} ${x} ${archY}`)
    bottom['active'].unshift(`${cmd} ${x} ${dormY}`)
  })

  const build = (
    name: 'archived' | 'dormant' | 'active',
    color: string
  ): { name: string; d: string; color: string } => ({
    name,
    d: `${top[name].join(' ')} ${bottom[name].join(' ')} Z`,
    color
  })

  return [
    build('archived', 'var(--color-state-archived)'),
    build('dormant', 'var(--color-state-dormant)'),
    build('active', 'var(--color-state-active)')
  ]
})

// Y 轴刻度
const yTicks = computed(() => {
  const ticks: Array<{ y: number; label: string }> = []
  const steps = 4
  for (let i = 0; i <= steps; i++) {
    const v = (maxValue.value / steps) * i
    ticks.push({ y: yPos(v), label: Math.round(v).toString() })
  }
  return ticks
})

// X 轴日期标签（最多 6 个，避免重叠）
const xLabels = computed(() => {
  if (props.data.length === 0) return []
  const step = Math.max(1, Math.floor(props.data.length / 6))
  const labels: Array<{ x: number; label: string }> = []
  for (let i = 0; i < props.data.length; i += step) {
    labels.push({ x: xPos(i), label: props.data[i].date.slice(5) }) // MM-DD
  }
  return labels
})
</script>

<template>
  <div class="trend-chart">
    <div v-if="loading" class="trend-loading">加载中…</div>
    <svg
      v-else-if="hasData"
      :viewBox="`0 0 ${W} ${H}`"
      class="trend-svg"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="记忆状态趋势图"
    >
      <title>记忆状态趋势</title>
      <desc>清楚记得、正在淡忘与一时想不起的记忆数量随日期变化。</desc>
      <!-- Y 轴刻度线 + 标签 -->
      <g class="axis-y">
        <line
          v-for="(tick, i) in yTicks"
          :key="'yt' + i"
          :x1="PAD.left"
          :x2="W - PAD.right"
          :y1="tick.y"
          :y2="tick.y"
          class="grid-line"
        />
        <text
          v-for="(tick, i) in yTicks"
          :key="'yl' + i"
          :x="PAD.left - 4"
          :y="tick.y + 3"
          class="axis-label"
          text-anchor="end"
        >
          {{ tick.label }}
        </text>
      </g>

      <!-- 堆叠面积 -->
      <g class="layers">
        <path
          v-for="layer in layers"
          :key="layer.name"
          :d="layer.d"
          :fill="layer.color"
          :fill-opacity="0.5"
          :stroke="layer.color"
          stroke-width="1"
        />
      </g>

      <!-- X 轴日期标签 -->
      <g class="axis-x">
        <text
          v-for="(lbl, i) in xLabels"
          :key="'xl' + i"
          :x="lbl.x"
          :y="H - 6"
          class="axis-label"
          text-anchor="middle"
        >
          {{ lbl.label }}
        </text>
      </g>
    </svg>
    <div v-else class="trend-empty">
      <p class="empty-text">暂无趋势数据</p>
      <p class="empty-hint">聊几轮后这里会显示她记忆状态的变化。</p>
    </div>

    <!-- 图例 -->
    <div v-if="hasData" class="trend-legend">
      <span class="legend-item"><span class="legend-dot legend-active"></span>清楚记得</span>
      <span class="legend-item"><span class="legend-dot legend-dormant"></span>正在淡忘</span>
      <span class="legend-item"><span class="legend-dot legend-archived"></span>一时想不起</span>
    </div>
  </div>
</template>

<style scoped>
.trend-chart {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.trend-svg {
  display: block;
  width: 100%;
  min-height: 190px;
  max-height: 240px;
  padding: 8px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius);
  background:
    linear-gradient(180deg, var(--color-accent-soft), transparent 60%),
    color-mix(in srgb, var(--color-bg-tertiary) 48%, transparent);
}

.grid-line {
  stroke: var(--color-border-subtle);
  stroke-width: 1;
}

.axis-label {
  fill: var(--color-text-muted);
  font-family: var(--font-family-body);
  font-size: 10px;
}

.layers path {
  pointer-events: none;
}

.trend-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
}

.legend-item {
  display: inline-flex;
  min-height: 25px;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--color-bg-tertiary) 48%, transparent);
}

.legend-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.legend-active {
  background: var(--color-state-active);
}

.legend-dormant {
  background: var(--color-state-dormant);
}

.legend-archived {
  background: var(--color-state-archived);
}

.trend-loading,
.trend-empty {
  display: flex;
  height: 210px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: 1px dashed var(--color-border-subtle);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--color-bg-tertiary) 36%, transparent);
}

.trend-loading {
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}

.empty-text {
  color: var(--color-text-secondary);
  font-family: var(--font-family-display);
  font-size: var(--font-size-lg);
}

.empty-hint {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

@media (max-width: 600px) {
  .trend-svg {
    min-height: 170px;
    padding: 3px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .layers path {
    transition: none;
  }
}
</style>
