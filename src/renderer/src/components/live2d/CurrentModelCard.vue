<script setup lang="ts">
import { computed } from 'vue'
import { useLive2dStore } from '../../stores/live2d'

const live2d = useLive2dStore()
const current = computed(() => live2d.currentModel)
</script>

<template>
  <section class="model-card" aria-labelledby="current-model-title">
    <div class="model-card__eyebrow">当前形象</div>
    <div class="model-card__row">
      <div class="model-card__avatar" aria-hidden="true">✦</div>
      <div class="model-card__body">
        <h3 id="current-model-title">{{ current?.displayName ?? '尚未选择模型' }}</h3>
        <p v-if="current" class="model-card__meta">
          {{ current.source === 'builtin' ? '随应用提供' : '已导入' }} · Cubism
          {{ current.cubismVersion }} · {{ current.expressionCount }} 个表情
        </p>
        <p v-else class="model-card__meta">可以从下方导入一个 Live2D 模型。</p>
      </div>
      <span v-if="live2d.isReady" class="model-card__status">已就绪</span>
    </div>
    <p v-if="current?.warnings.length" class="model-card__warning" role="status">
      {{
        current.warnings.join('、') === 'MOUTH_OPEN_PARAMETER_MISSING'
          ? '这个模型没有口型参数，语音阶段将不驱动嘴部。'
          : current.warnings.join('、')
      }}
    </p>
  </section>
</template>

<style scoped>
.model-card {
  padding: 1rem;
  border: 1px solid var(--color-border);
  border-radius: 1rem;
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--color-surface-elevated) 82%, transparent),
    var(--color-surface)
  );
}
.model-card__eyebrow {
  margin-bottom: 0.7rem;
  color: var(--color-text-muted, rgb(255 255 255 / 52%));
  font-size: 0.72rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.model-card__row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.model-card__avatar {
  display: grid;
  width: 2.75rem;
  height: 2.75rem;
  place-items: center;
  border-radius: 0.8rem;
  background: linear-gradient(145deg, var(--color-accent), var(--color-companion));
  color: var(--color-text-on-accent);
  font-size: 1.25rem;
  box-shadow: inset 0 1px color-mix(in srgb, var(--color-surface-elevated) 38%, transparent);
}
.model-card__body {
  min-width: 0;
  flex: 1;
}
.model-card h3 {
  margin: 0 0 0.25rem;
  color: var(--color-text-primary, white);
  font-size: 1rem;
}
.model-card__meta {
  margin: 0;
  color: var(--color-text-secondary, rgb(255 255 255 / 64%));
  font-size: 0.78rem;
  line-height: 1.45;
}
.model-card__status {
  flex: 0 0 auto;
  padding: 0.25rem 0.5rem;
  border-radius: 999px;
  background: var(--color-success-bg);
  color: var(--color-success);
  font-size: 0.7rem;
  font-weight: 650;
}
.model-card__warning {
  margin: 0.75rem 0 0;
  padding: 0.6rem 0.7rem;
  border: 1px solid var(--color-warning-border);
  border-radius: 0.65rem;
  background: var(--color-warning-bg);
  color: var(--color-warning);
  font-size: 0.75rem;
  line-height: 1.45;
}
</style>
