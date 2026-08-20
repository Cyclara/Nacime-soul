<script setup lang="ts">
// P2-42/P2-46: 轻量 SVG 成长趋势图。
// 保持 ≤90 点自绘约定；只做投影与视觉坐标映射，不改变 growth store 查询行为。

import { computed } from 'vue'
import type { GrowthTrendPoint } from '@shared/memory/types'

const props = defineProps<{
  points: GrowthTrendPoint[]
  metric: string
  days: 7 | 30 | 90
}>()

const emit = defineEmits<{
  (e: 'select-metric', metric: 'understanding' | 'l0FillRate' | 'l2Total'): void
  (e: 'select-days', days: 7 | 30 | 90): void
}>()

const METRICS = [
  { key: 'understanding', label: '了解度', short: 'U' },
  { key: 'l0FillRate', label: '画像完整', short: 'P' },
  { key: 'l2Total', label: '共同记忆', short: 'M' }
] as const

const hasData = computed(() => props.points.length > 0)
const values = computed(() => props.points.map((point) => point.value))
const minValue = computed(() => (values.value.length ? Math.min(...values.value) : 0))
const maxValue = computed(() => (values.value.length ? Math.max(...values.value) : 0))
const latestPoint = computed(() => props.points.at(-1))
const firstPoint = computed(() => props.points[0])
const change = computed(() => (latestPoint.value?.value ?? 0) - (firstPoint.value?.value ?? 0))

function coordinates(): Array<{ x: number; y: number; value: number; date: string }> {
  const W = 100
  const H = 46
  const range = maxValue.value - minValue.value || 1
  return props.points.map((point, index) => ({
    x: props.points.length === 1 ? W / 2 : (index / (props.points.length - 1)) * W,
    y: H - ((point.value - minValue.value) / range) * 34 - 6,
    value: point.value,
    date: point.date
  }))
}

const vertexes = computed(coordinates)
const linePoints = computed(() =>
  vertexes.value.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')
)
const areaPoints = computed(() => (linePoints.value ? `0,46 ${linePoints.value} 100,46` : ''))
const chartDescription = computed(() => {
  if (!hasData.value) return '尚无成长趋势数据'
  return `${metricLabel(props.metric)}，${props.points.length} 个数据点，从 ${formatDate(firstPoint.value!.date)} 到 ${formatDate(latestPoint.value!.date)}`
})

function metricLabel(metric: string): string {
  return METRICS.find((item) => item.key === metric)?.label ?? metric
}

function formatDate(date: string): string {
  return date.slice(5).replace('-', '月') + '日'
}

function formatValue(value: number): string {
  if (props.metric === 'l0FillRate') return `${Math.round(value * 100)}%`
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}
</script>

<template>
  <section class="trend-chart" aria-labelledby="trend-title">
    <header class="trend-heading">
      <div>
        <p class="trend-kicker">30 DAYS IN MOTION · 变化的痕迹</p>
        <h2 id="trend-title">相处不是直线，但会留下方向</h2>
      </div>
      <div v-if="hasData" class="latest-reading">
        <span>当前</span>
        <strong>{{ formatValue(latestPoint!.value) }}</strong>
        <small :class="{ down: change < 0 }"
          >{{ change >= 0 ? '+' : '' }}{{ formatValue(change) }}</small
        >
      </div>
    </header>

    <div class="trend-toolbar">
      <div class="metric-tabs" role="radiogroup" aria-label="趋势指标">
        <button
          v-for="item in METRICS"
          :key="item.key"
          class="metric-tab"
          :class="{ active: metric === item.key }"
          role="radio"
          :aria-checked="metric === item.key"
          @click="emit('select-metric', item.key)"
        >
          <span aria-hidden="true">{{ item.short }}</span>
          {{ item.label }}
        </button>
      </div>
      <div class="day-tabs" role="radiogroup" aria-label="趋势时间范围">
        <button
          v-for="day in [7, 30, 90] as const"
          :key="day"
          class="day-tab"
          :class="{ active: days === day }"
          role="radio"
          :aria-checked="days === day"
          @click="emit('select-days', day)"
        >
          {{ day }}D
        </button>
      </div>
    </div>

    <div v-if="hasData" class="chart-layout">
      <div class="chart-scale" aria-hidden="true">
        <span>{{ formatValue(maxValue) }}</span>
        <span>{{ formatValue((maxValue + minValue) / 2) }}</span>
        <span>{{ formatValue(minValue) }}</span>
      </div>
      <div class="chart-canvas">
        <svg
          class="chart-svg"
          viewBox="0 0 100 46"
          preserveAspectRatio="none"
          role="img"
          :aria-label="chartDescription"
        >
          <defs>
            <linearGradient id="growth-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--color-accent)" stop-opacity="0.28" />
              <stop offset="100%" stop-color="var(--color-accent)" stop-opacity="0" />
            </linearGradient>
            <filter id="growth-glow" x="-20%" y="-50%" width="140%" height="200%">
              <feGaussianBlur stdDeviation="0.8" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <line
            v-for="y in [6, 17.33, 28.66, 40]"
            :key="y"
            x1="0"
            :y1="y"
            x2="100"
            :y2="y"
            class="grid-line"
          />
          <polygon class="chart-area" :points="areaPoints" />
          <polyline class="chart-line" :points="linePoints" />
          <g class="chart-points">
            <circle
              v-for="(point, index) in vertexes"
              :key="point.date"
              :cx="point.x"
              :cy="point.y"
              :r="index === vertexes.length - 1 ? 2 : 1.15"
              :class="['chart-vertex', { latest: index === vertexes.length - 1 }]"
            >
              <title>{{ formatDate(point.date) }}：{{ formatValue(point.value) }}</title>
            </circle>
          </g>
        </svg>
        <div class="chart-axis">
          <span>{{ formatDate(firstPoint!.date) }}</span>
          <span class="axis-caption">{{ metricLabel(metric) }} · {{ days }} 天</span>
          <span>{{ formatDate(latestPoint!.date) }}</span>
        </div>
      </div>
    </div>

    <div v-else class="chart-empty">
      <span class="empty-glyph" aria-hidden="true">∿</span>
      <div>
        <strong>曲线还在等待第一笔</strong>
        <p>开始对话后，每日快照会在这里连成你们的相处轨迹。</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.trend-chart {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: clamp(22px, 4vw, 36px);
  overflow: hidden;
  border: 1px solid var(--color-border-subtle);
  border-radius: 26px 26px 9px 26px;
  background:
    linear-gradient(125deg, transparent 0 66%, var(--color-accent-soft)),
    var(--color-surface-elevated);
  box-shadow: var(--shadow-md);
}

.trend-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
}

.trend-kicker {
  color: var(--color-accent);
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.18em;
}

.trend-heading h2 {
  max-width: 18ch;
  margin-top: 8px;
  color: var(--color-text);
  font-family: var(--font-family-display);
  font-size: clamp(23px, 3vw, 32px);
  font-weight: 540;
  letter-spacing: -0.025em;
  line-height: 1.15;
}

.latest-reading {
  display: grid;
  flex-shrink: 0;
  grid-template-columns: auto auto;
  align-items: baseline;
  gap: 2px 8px;
  text-align: right;
}

.latest-reading span {
  grid-column: 1 / -1;
  color: var(--color-text-tertiary);
  font-size: 9px;
  letter-spacing: 0.08em;
}

.latest-reading strong {
  color: var(--color-text);
  font-family: var(--font-family-display);
  font-size: 34px;
  font-weight: 540;
  font-variant-numeric: tabular-nums;
}

.latest-reading small {
  padding: 2px 6px;
  border-radius: var(--radius-full);
  background: var(--color-success-bg);
  color: var(--color-success);
  font-size: 9px;
  font-weight: 700;
}

.latest-reading small.down {
  background: var(--color-warning-bg);
  color: var(--color-warning);
}

.trend-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--color-border-subtle);
}

.metric-tabs,
.day-tabs {
  display: flex;
  gap: 5px;
}

.metric-tab,
.day-tab {
  display: inline-flex;
  min-height: 32px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 5px 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-full);
  color: var(--color-text-muted);
  font-size: 10px;
  font-weight: 650;
}

.metric-tab > span {
  display: grid;
  width: 18px;
  height: 18px;
  place-items: center;
  border: 1px solid var(--color-border-subtle);
  border-radius: 50%;
  font-family: var(--font-family-display);
  font-size: 9px;
}

.metric-tab:hover,
.day-tab:hover {
  background: var(--color-accent-soft);
  color: var(--color-text);
}

.metric-tab.active,
.day-tab.active {
  border-color: color-mix(in srgb, var(--color-accent) 32%, var(--color-border));
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.metric-tab.active > span {
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: var(--color-text-on-accent);
}

.day-tabs {
  padding: 3px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-full);
  background: var(--color-surface);
}

.day-tab {
  min-width: 40px;
  min-height: 26px;
  padding: 3px 8px;
  font-size: 9px;
  letter-spacing: 0.06em;
}

.chart-layout {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  gap: 9px;
}

.chart-scale {
  display: flex;
  height: 188px;
  flex-direction: column;
  justify-content: space-between;
  padding: 3px 0 22px;
  color: var(--color-text-tertiary);
  font-size: 9px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.chart-canvas {
  min-width: 0;
}

.chart-svg {
  width: 100%;
  height: 166px;
  overflow: visible;
}

.grid-line {
  stroke: var(--color-border-subtle);
  stroke-width: 0.35;
  stroke-dasharray: 1.2 1.5;
}

.chart-area {
  fill: url(#growth-area);
}

.chart-line {
  fill: none;
  filter: url(#growth-glow);
  stroke: var(--color-accent);
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.45;
  vector-effect: non-scaling-stroke;
}

.chart-vertex {
  fill: var(--color-surface-elevated);
  stroke: var(--color-accent);
  stroke-width: 1.2;
  vector-effect: non-scaling-stroke;
}

.chart-vertex.latest {
  fill: var(--color-companion);
  stroke: var(--color-surface-elevated);
  stroke-width: 1.8;
}

.chart-axis {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  margin-top: 4px;
  color: var(--color-text-tertiary);
  font-size: 9px;
}

.chart-axis > span:last-child {
  text-align: right;
}

.axis-caption {
  color: var(--color-text-muted);
  font-weight: 650;
  letter-spacing: 0.05em;
}

.chart-empty {
  display: flex;
  min-height: 170px;
  align-items: center;
  justify-content: center;
  gap: 14px;
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--color-bg-tertiary) 55%, transparent);
}

.empty-glyph {
  color: var(--color-accent);
  font-family: var(--font-family-display);
  font-size: 42px;
}

.chart-empty strong {
  color: var(--color-text);
  font-family: var(--font-family-display);
  font-size: var(--font-size-lg);
  font-weight: 560;
}

.chart-empty p {
  max-width: 38ch;
  margin-top: 4px;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  line-height: 1.6;
}

@media (max-width: 560px) {
  .trend-heading {
    flex-direction: column;
  }

  .latest-reading {
    text-align: left;
  }

  .trend-toolbar {
    align-items: flex-start;
    flex-direction: column;
  }

  .metric-tabs {
    width: 100%;
  }

  .metric-tab {
    flex: 1;
    padding-inline: 5px;
  }

  .axis-caption {
    display: none;
  }

  .chart-axis {
    grid-template-columns: 1fr 1fr;
  }
}
</style>
