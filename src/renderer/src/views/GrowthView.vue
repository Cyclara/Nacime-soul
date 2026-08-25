<script setup lang="ts">
// P2-42/P2-46: 成长页 -- U 值 + 阶段徽章 + 趋势 + 里程碑时间线。
// 数据和 action 完全沿用 growth store；本文件只负责布局、路由与视觉叙事。

import { useRouter } from 'vue-router'
import { onMounted, onUnmounted } from 'vue'
import { useGrowthStore } from '../stores/growth'
import UnderstandingGauge from '../components/growth/UnderstandingGauge.vue'
import GrowthTrendChart from '../components/growth/GrowthTrendChart.vue'
import GrowthTimeline from '../components/growth/GrowthTimeline.vue'
import type { GrowthTrendMetric } from '../stores/growth'

const router = useRouter()
const growthStore = useGrowthStore()
let unsub: (() => void) | null = null

function selectMetric(metric: GrowthTrendMetric): void {
  void growthStore.loadTrend(metric, growthStore.state.trendDays)
}

function selectDays(days: 7 | 30 | 90): void {
  void growthStore.loadTrend(growthStore.state.trendMetric, days)
}

onMounted(() => {
  // 先订阅再 hydrate（S-002-补充 §4：进入页面先 subscribe 再 hydrate）
  unsub = growthStore.subscribe()
  void growthStore.hydrate()
  void growthStore.loadTrend('understanding', 30)
})

onUnmounted(() => {
  unsub?.()
})
</script>

<template>
  <div class="growth-view">
    <div class="growth-atmosphere" aria-hidden="true">
      <span class="orb orb-a"></span>
      <span class="orb orb-b"></span>
      <span class="grain"></span>
    </div>

    <header class="growth-header">
      <button class="back-btn" aria-label="返回聊天" @click="router.push('/')">
        <span aria-hidden="true">←</span>
        <span>返回聊天</span>
      </button>
      <div class="growth-heading">
        <span class="heading-seal" aria-hidden="true">✦</span>
        <div>
          <p>NACIME · GROWTH ARCHIVE</p>
          <h1>我们如何慢慢熟悉</h1>
        </div>
      </div>
      <button class="memory-btn" @click="router.push('/memory')">
        <span>记忆档案</span>
        <span aria-hidden="true">↗</span>
      </button>
    </header>

    <main class="growth-scroll">
      <div class="growth-content">
        <aside class="opening-note">
          <span class="note-number">OUR STORY · 相处札记</span>
          <p>
            成长不是等级，也不是奖励。它只是她记住了多少真实的你，又在多少次纠正后，更接近你本来的样子。
          </p>
        </aside>

        <Transition name="error-drop">
          <p v-if="growthStore.state.lastError" class="growth-error" role="alert">
            <span aria-hidden="true">!</span>
            {{ growthStore.state.lastError.message }}
          </p>
        </Transition>

        <div
          v-if="growthStore.state.loading && !growthStore.state.profile"
          class="growth-loading"
          role="status"
          aria-live="polite"
        >
          <span class="loading-orbit" aria-hidden="true"></span>
          <div>
            <strong>正在翻开你们的记忆</strong>
            <p>把散落的时刻慢慢排好……</p>
          </div>
        </div>

        <UnderstandingGauge
          v-if="growthStore.state.profile"
          :understanding="growthStore.state.profile.understanding"
          :stage-label="growthStore.stageLabel"
          :active-days="growthStore.state.profile.activeDays"
          :l2-total="growthStore.state.profile.l2Total"
        />

        <section class="growth-grid">
          <GrowthTrendChart
            class="trend-panel"
            :points="growthStore.state.trend"
            :metric="growthStore.state.trendMetric"
            :days="growthStore.state.trendDays"
            @select-metric="selectMetric"
            @select-days="selectDays"
          />

          <GrowthTimeline class="timeline-panel" :entries="growthStore.state.timeline" />
        </section>

        <footer class="growth-footer">
          <span>LOCAL MEMORY · PRIVATE BY DEFAULT</span>
          <p>这些成长记录只来自保存在你电脑上的本地记忆。</p>
        </footer>
      </div>
    </main>
  </div>
</template>

<style scoped>
.growth-view {
  position: relative;
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-bg);
}

.growth-atmosphere {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}

.orb {
  position: absolute;
  border-radius: 50%;
  filter: blur(3px);
}

.orb-a {
  top: -26vw;
  left: -12vw;
  width: min(65vw, 820px);
  height: min(65vw, 820px);
  background: radial-gradient(circle, var(--color-companion-soft), transparent 68%);
  opacity: 0.78;
}

.orb-b {
  top: 8%;
  right: -24vw;
  width: min(60vw, 760px);
  height: min(60vw, 760px);
  background: radial-gradient(circle, var(--color-accent-soft), transparent 67%);
  opacity: 0.84;
}

.grain {
  position: absolute;
  inset: 0;
  opacity: 0.24;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 160 160' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.055'/%3E%3C/svg%3E");
  mix-blend-mode: multiply;
}

.growth-header {
  position: relative;
  z-index: 5;
  display: grid;
  min-height: 76px;
  flex-shrink: 0;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 18px;
  padding: 11px clamp(15px, 2.5vw, 30px);
  border-bottom: 1px solid var(--color-border-subtle);
  background: var(--color-surface-translucent);
  backdrop-filter: blur(22px) saturate(112%);
}

.back-btn,
.memory-btn {
  display: inline-flex;
  min-height: 38px;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-full);
  background: var(--color-surface-elevated);
  box-shadow: var(--shadow-sm);
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  font-weight: 650;
}

.back-btn {
  justify-self: start;
}

.memory-btn {
  justify-self: end;
}

.back-btn:hover,
.memory-btn:hover {
  border-color: color-mix(in srgb, var(--color-accent) 34%, var(--color-border));
  background: var(--color-accent-soft);
  color: var(--color-accent);
  transform: translateY(-1px);
}

.growth-heading {
  display: flex;
  grid-column: 2;
  align-items: center;
  gap: 10px;
  text-align: left;
}

.heading-seal {
  display: grid;
  width: 37px;
  height: 37px;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--color-companion) 36%, var(--color-border));
  border-radius: 50% 50% 50% 10px;
  background: var(--color-companion-soft);
  color: var(--color-companion);
  font-size: 12px;
}

.growth-heading p {
  color: var(--color-text-tertiary);
  font-size: 7px;
  font-weight: 800;
  letter-spacing: 0.15em;
}

.growth-heading h1 {
  margin-top: 2px;
  color: var(--color-text);
  font-family: var(--font-family-display);
  font-size: clamp(17px, 2vw, 22px);
  font-weight: 560;
  letter-spacing: -0.01em;
}

.growth-scroll {
  position: relative;
  z-index: 1;
  min-height: 0;
  flex: 1;
  overflow-y: auto;
}

.growth-content {
  display: flex;
  width: min(calc(100% - 32px), 1180px);
  flex-direction: column;
  gap: 18px;
  margin: 0 auto;
  padding: clamp(26px, 4vw, 52px) 0 50px;
}

.opening-note {
  display: grid;
  max-width: 720px;
  grid-template-columns: auto 1fr;
  align-items: start;
  gap: 15px;
  margin-bottom: 2px;
  color: var(--color-text-secondary);
}

.note-number {
  padding-top: 3px;
  color: var(--color-companion);
  font-family: var(--font-family-display);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.opening-note p {
  padding-left: 15px;
  border-left: 1px solid var(--color-border);
  font-family: var(--font-family-display);
  font-size: clamp(15px, 1.8vw, 19px);
  line-height: 1.65;
}

.growth-error {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 11px 14px;
  border: 1px solid var(--color-error-border);
  border-radius: var(--radius-lg);
  background: var(--color-error-bg);
  color: var(--color-error);
  font-size: var(--font-size-sm);
}

.growth-error span {
  display: grid;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  place-items: center;
  border: 1px solid currentColor;
  border-radius: 50%;
  font-family: var(--font-family-display);
  font-size: 11px;
}

.growth-loading {
  display: flex;
  min-height: 260px;
  align-items: center;
  justify-content: center;
  gap: 18px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 32px 32px 32px 10px;
  background: var(--color-surface-elevated);
  box-shadow: var(--shadow-md);
}

.loading-orbit {
  width: 50px;
  height: 50px;
  border: 1px dashed var(--color-accent);
  border-top-style: solid;
  border-radius: 50%;
  box-shadow: inset 0 0 0 8px var(--color-accent-soft);
  animation: loading-turn 1.4s linear infinite;
}

.growth-loading strong {
  color: var(--color-text);
  font-family: var(--font-family-display);
  font-size: var(--font-size-lg);
  font-weight: 560;
}

.growth-loading p {
  margin-top: 4px;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.growth-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr);
  align-items: start;
  gap: 18px;
}

.trend-panel,
.timeline-panel {
  min-width: 0;
}

.growth-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 18px 4px 0;
  color: var(--color-text-tertiary);
}

.growth-footer span {
  font-size: 8px;
  font-weight: 800;
  letter-spacing: 0.16em;
}

.growth-footer p {
  font-size: 10px;
}

.error-drop-enter-active,
.error-drop-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}

.error-drop-enter-from,
.error-drop-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

@keyframes loading-turn {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 900px) {
  .growth-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 620px) {
  .growth-header {
    grid-template-columns: auto 1fr auto;
    min-height: 66px;
    gap: 9px;
  }

  .growth-heading {
    justify-self: center;
  }

  .heading-seal,
  .growth-heading p,
  .back-btn > span:last-child,
  .memory-btn > span:first-child {
    display: none;
  }

  .back-btn,
  .memory-btn {
    width: 38px;
    padding-inline: 0;
    justify-content: center;
  }

  .growth-content {
    width: min(calc(100% - 22px), 1180px);
    padding-top: 24px;
  }

  .opening-note {
    grid-template-columns: 1fr;
    gap: 7px;
  }

  .opening-note p {
    padding-top: 10px;
    padding-left: 0;
    border-top: 1px solid var(--color-border);
    border-left: 0;
  }

  .growth-footer {
    align-items: flex-start;
    flex-direction: column;
  }
}

@media (prefers-reduced-motion: reduce) {
  .loading-orbit {
    animation: none;
  }

  .error-drop-enter-active,
  .error-drop-leave-active {
    transition: none;
  }
}
</style>
