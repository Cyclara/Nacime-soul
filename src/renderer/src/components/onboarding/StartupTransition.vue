<script setup lang="ts">
// P3A-30：品牌启动过渡只显示 main 真实离散阶段，不伪造百分比。
import { computed } from 'vue'

export type StartupStage = 'checking-data' | 'preparing-memory' | 'waking-nacime' | 'ready' | 'blocked'
const props = withDefaults(defineProps<{ stage: StartupStage; errorMessage?: string }>(), { errorMessage: '' })
const text = computed(() => ({
  'checking-data': '在整理她醒来前需要的东西…',
  'preparing-memory': '在把昨天和更早的事放回原位…',
  'waking-nacime': '就快见到她了。',
  ready: '',
  blocked: props.errorMessage || '暂时还没能醒来，可以稍后再试。'
}[props.stage]))
</script>

<template>
  <Transition name="startup-fade" appear>
    <section v-if="stage !== 'ready'" class="startup" :class="{ 'startup--blocked': stage === 'blocked' }" :role="stage === 'blocked' ? 'alert' : 'status'" aria-live="polite">
      <div class="startup__seal" aria-hidden="true">N</div>
      <div class="startup__line"><span class="startup__dot" aria-hidden="true" />{{ text }}</div>
    </section>
  </Transition>
</template>

<style scoped>
.startup { position: fixed; z-index: 100; inset: 0; display: grid; place-content: center; gap: 1.1rem; background: var(--color-bg); color: var(--color-text-secondary); }
.startup__seal { display: grid; width: 4.4rem; height: 4.4rem; place-self: center; place-items: center; border: 1px solid color-mix(in srgb, var(--color-companion) 40%, var(--color-border)); border-radius: 1.45rem 1.45rem 1.45rem 0.35rem; background: var(--color-companion-soft); color: var(--color-companion); font-family: var(--font-family-display); font-size: 2rem; box-shadow: var(--shadow-md); }
.startup__line { display: flex; align-items: center; gap: 0.6rem; font-size: 0.82rem; }
.startup__dot { width: 0.45rem; height: 0.45rem; border-radius: 999px; background: var(--color-companion); box-shadow: 0 0 0.6rem var(--color-companion); animation: pulse 1.5s ease-in-out infinite; }
.startup--blocked .startup__dot { background: var(--color-error); box-shadow: 0 0 0.6rem var(--color-error); animation: none; }
.startup-fade-enter-active, .startup-fade-leave-active { transition: opacity 200ms ease; }
.startup-fade-enter-from, .startup-fade-leave-to { opacity: 0; }
@keyframes pulse { 50% { opacity: 0.35; transform: scale(0.75); } }
@media (prefers-reduced-motion: reduce) { .startup__dot { animation: none; } }
</style>
