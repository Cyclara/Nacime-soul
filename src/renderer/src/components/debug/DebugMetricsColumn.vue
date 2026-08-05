<script setup lang="ts">
// P2-28: 调试面板指标列（LLM/TTS/DMAE/Live2D 计数）
// 依据：F5-011 §3 wireframe 左栏
import { computed } from 'vue'

const props = defineProps<{
  metrics: Record<string, number>
}>()

function m(key: string): number {
  return props.metrics[key] ?? 0
}

const llmP95 = computed(() => Math.round(m('llm.latencyMs.p95')))
const llmCalls = computed(() => m('llm.calls'))
const llmErrors = computed(() => m('llm.errors'))
const tokensIn = computed(() => m('llm.tokens.in'))
const tokensOut = computed(() => m('llm.tokens.out'))
const dmaeActive = computed(() => m('dmae.active'))
const dmaeDormant = computed(() => m('dmae.dormant'))
const dmaeArchived = computed(() => m('dmae.archived'))
const l2Count = computed(() => m('memory.l2.count'))
const conflicts = computed(() => m('memory.conflicts'))
</script>

<template>
  <div class="metrics-col">
    <div class="metric-group">
      <div class="metric-title">LLM</div>
      <div class="metric-row">
        <span>调用</span><b>{{ llmCalls }}</b>
      </div>
      <div class="metric-row">
        <span>错误</span><b :class="{ 'metric-warn': llmErrors > 0 }">{{ llmErrors }}</b>
      </div>
      <div class="metric-row">
        <span>p95</span><b>{{ llmP95 }}ms</b>
      </div>
      <div class="metric-row">
        <span>tok 入/出</span><b>{{ tokensIn }}/{{ tokensOut }}</b>
      </div>
    </div>
    <div class="metric-group">
      <div class="metric-title">记忆</div>
      <div class="metric-row">
        <span>L2 总数</span><b>{{ l2Count }}</b>
      </div>
      <div class="metric-row">
        <span>冲突</span><b>{{ conflicts }}</b>
      </div>
    </div>
    <div class="metric-group">
      <div class="metric-title">DMAE</div>
      <div class="metric-row">
        <span>三态</span>
        <b>
          <span class="state-active">A{{ dmaeActive }}</span>
          <span class="state-dormant">D{{ dmaeDormant }}</span>
          <span class="state-archived">R{{ dmaeArchived }}</span>
        </b>
      </div>
    </div>
    <div class="metric-group">
      <div class="metric-title">TTS / Live2D</div>
      <div class="metric-row">
        <span>缓存命中</span><b>{{ m('tts.cache.hit') }}</b>
      </div>
      <div class="metric-row">
        <span>FPS</span><b>{{ m('live2d.fps') }}</b>
      </div>
    </div>
  </div>
</template>

<style scoped>
.metrics-col {
  width: 200px;
  background: var(--dbg-bg, #1e1e2e);
  padding: 8px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.metric-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.metric-title {
  font-weight: 600;
  color: var(--dbg-accent, #89b4fa);
  border-bottom: 1px solid var(--dbg-border, #45475a);
  padding-bottom: 2px;
  margin-bottom: 2px;
}
.metric-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.metric-row span {
  opacity: 0.7;
}
.metric-row b {
  font-weight: 600;
}
.metric-warn {
  color: var(--dbg-warn, #f9e2af);
}
.state-active {
  color: var(--dbg-ok, #a6e3a1);
}
.state-dormant {
  color: var(--dbg-warn, #f9e2af);
}
.state-archived {
  opacity: 0.5;
}
</style>
