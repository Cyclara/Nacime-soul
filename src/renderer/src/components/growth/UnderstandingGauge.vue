<script setup lang="ts">
// P2-42/P2-46: U 值主视觉 + 阶段徽章。
// 只展示 main 投影出的唯一汇总指标；不计算或泄露 A/B/C 原始指标。

import { computed } from 'vue'

const props = defineProps<{
  understanding: number
  stageLabel: string
  activeDays: number
  l2Total: number
}>()

const normalizedUnderstanding = computed(() => Math.min(100, Math.max(0, props.understanding)))
const progressStyle = computed(() => ({ '--understanding': String(normalizedUnderstanding.value) }))
</script>

<template>
  <section class="understanding-gauge" aria-labelledby="understanding-title">
    <div class="gauge-copy">
      <p class="gauge-kicker">OUR UNDERSTANDING · 相互了解</p>
      <h2 id="understanding-title">她正一点点读懂你</h2>
      <p class="gauge-story">不是一次答对，而是在每一次相处里，留下更准确的你。</p>

      <div class="gauge-meta" aria-label="相处概况">
        <span><i aria-hidden="true"></i>相处 {{ activeDays }} 天</span>
        <span><i aria-hidden="true"></i>{{ l2Total }} 段共同记忆</span>
      </div>
    </div>

    <div
      class="gauge-orbit"
      :style="progressStyle"
      role="img"
      :aria-label="`了解度 ${understanding}，当前关系阶段 ${stageLabel}`"
    >
      <div class="orbit-track" aria-hidden="true">
        <span class="orbit-mark mark-a"></span>
        <span class="orbit-mark mark-b"></span>
        <span class="orbit-mark mark-c"></span>
      </div>
      <div class="orbit-center">
        <span class="stage-badge">{{ stageLabel }}</span>
        <div class="u-value">{{ understanding }}</div>
        <span class="u-suffix">UNDERSTANDING / 100</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.understanding-gauge {
  position: relative;
  display: grid;
  min-height: 330px;
  grid-template-columns: minmax(0, 1fr) minmax(260px, 0.8fr);
  align-items: center;
  gap: clamp(22px, 5vw, 58px);
  padding: clamp(28px, 5vw, 54px);
  overflow: hidden;
  border: 1px solid var(--color-border-subtle);
  border-radius: 32px 32px 32px 10px;
  background:
    radial-gradient(circle at 90% 12%, var(--color-accent-soft), transparent 34%),
    radial-gradient(circle at 3% 100%, var(--color-companion-soft), transparent 34%),
    var(--color-surface-elevated);
  box-shadow: var(--shadow-lg);
}

.understanding-gauge::before {
  position: absolute;
  top: 22px;
  left: 22px;
  width: 38px;
  height: 1px;
  background: var(--color-companion);
  box-shadow: 46px 0 0 var(--color-border);
  content: '';
  opacity: 0.72;
}

.understanding-gauge::after {
  position: absolute;
  right: -92px;
  bottom: -110px;
  width: 280px;
  height: 280px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 50%;
  content: '';
  pointer-events: none;
}

.gauge-copy {
  position: relative;
  z-index: 1;
  padding-top: 16px;
}

.gauge-kicker {
  color: var(--color-companion);
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.19em;
}

.gauge-copy h2 {
  max-width: 11ch;
  margin-top: 12px;
  color: var(--color-text);
  font-family: var(--font-family-display);
  font-size: clamp(30px, 4.4vw, 47px);
  font-weight: 540;
  letter-spacing: -0.035em;
  line-height: 1.06;
}

.gauge-story {
  max-width: 38ch;
  margin-top: 16px;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.75;
}

.gauge-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 18px;
  margin-top: 26px;
  color: var(--color-text-muted);
  font-size: 11px;
}

.gauge-meta span {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.gauge-meta i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-accent);
  box-shadow: 0 0 0 4px var(--color-accent-soft);
}

.gauge-meta span:last-child i {
  background: var(--color-companion);
  box-shadow: 0 0 0 4px var(--color-companion-soft);
}

.gauge-orbit {
  --progress-angle: calc(var(--understanding) * 3.6deg);
  position: relative;
  z-index: 1;
  display: grid;
  width: min(100%, 276px);
  aspect-ratio: 1;
  place-items: center;
  justify-self: center;
  border-radius: 50%;
  background: conic-gradient(
    from -90deg,
    var(--color-accent) 0 var(--progress-angle),
    var(--color-border-subtle) var(--progress-angle) 360deg
  );
  box-shadow:
    0 0 0 13px color-mix(in srgb, var(--color-accent-soft) 55%, transparent),
    var(--shadow-glow);
}

.gauge-orbit::before {
  position: absolute;
  inset: 8px;
  border-radius: 50%;
  background: var(--color-surface-elevated);
  content: '';
}

.gauge-orbit::after {
  position: absolute;
  inset: 17px;
  border: 1px dashed color-mix(in srgb, var(--color-accent) 24%, var(--color-border));
  border-radius: 50%;
  content: '';
  animation: slow-turn 32s linear infinite;
}

.orbit-track {
  position: absolute;
  z-index: 2;
  inset: 4px;
  border-radius: 50%;
  pointer-events: none;
}

.orbit-mark {
  position: absolute;
  width: 7px;
  height: 7px;
  border: 2px solid var(--color-surface-elevated);
  border-radius: 50%;
  background: var(--color-companion);
  box-shadow: var(--shadow-sm);
}

.mark-a {
  top: 14%;
  right: 15%;
}

.mark-b {
  right: 2%;
  bottom: 38%;
  background: var(--color-accent);
}

.mark-c {
  bottom: 9%;
  left: 25%;
  background: var(--color-sage);
}

.orbit-center {
  position: relative;
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.stage-badge {
  display: inline-flex;
  min-height: 27px;
  align-items: center;
  padding: 4px 13px;
  border: 1px solid color-mix(in srgb, var(--color-companion) 38%, var(--color-border));
  border-radius: var(--radius-full);
  background: var(--color-companion-soft);
  color: var(--color-companion);
  font-size: 10px;
  font-weight: 720;
  letter-spacing: 0.1em;
}

.u-value {
  margin-top: 8px;
  color: var(--color-text);
  font-family: var(--font-family-display);
  font-size: clamp(66px, 9vw, 92px);
  font-weight: 540;
  letter-spacing: -0.055em;
  line-height: 0.92;
  font-variant-numeric: tabular-nums;
}

.u-suffix {
  margin-top: 9px;
  color: var(--color-text-tertiary);
  font-size: 8px;
  font-weight: 800;
  letter-spacing: 0.13em;
}

@keyframes slow-turn {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 720px) {
  .understanding-gauge {
    grid-template-columns: 1fr;
    text-align: center;
  }

  .gauge-copy h2,
  .gauge-story {
    margin-inline: auto;
  }

  .gauge-meta {
    justify-content: center;
  }

  .gauge-orbit {
    order: -1;
    width: min(68vw, 250px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .gauge-orbit::after {
    animation: none;
  }
}
</style>
