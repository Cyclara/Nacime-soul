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
          {{ current.source === 'builtin' ? '随应用提供' : '已导入' }} · Cubism {{ current.cubismVersion }} ·
          {{ current.expressionCount }} 个表情
        </p>
        <p v-else class="model-card__meta">可以从下方导入一个 Live2D 模型。</p>
      </div>
      <span v-if="live2d.isReady" class="model-card__status">已就绪</span>
    </div>
    <p v-if="current?.warnings.length" class="model-card__warning" role="status">
      {{ current.warnings.join('、') === 'MOUTH_OPEN_PARAMETER_MISSING' ? '这个模型没有口型参数，语音阶段将不驱动嘴部。' : current.warnings.join('、') }}
    </p>
  </section>
</template>

<style scoped>
.model-card { padding: 1rem; border: 1px solid var(--color-border, rgb(255 255 255 / 12%)); border-radius: 1rem; background: linear-gradient(135deg, rgb(255 255 255 / 8%), rgb(255 255 255 / 3%)); }
.model-card__eyebrow { margin-bottom: 0.7rem; color: var(--color-text-muted, rgb(255 255 255 / 52%)); font-size: 0.72rem; letter-spacing: 0.08em; text-transform: uppercase; }
.model-card__row { display: flex; align-items: center; gap: 0.75rem; }
.model-card__avatar { display: grid; width: 2.75rem; height: 2.75rem; place-items: center; border-radius: 0.8rem; background: linear-gradient(145deg, rgb(193 177 255 / 55%), rgb(137 117 212 / 40%)); color: white; font-size: 1.25rem; box-shadow: inset 0 1px rgb(255 255 255 / 24%); }
.model-card__body { min-width: 0; flex: 1; }
.model-card h3 { margin: 0 0 0.25rem; color: var(--color-text-primary, white); font-size: 1rem; }
.model-card__meta { margin: 0; color: var(--color-text-secondary, rgb(255 255 255 / 64%)); font-size: 0.78rem; line-height: 1.45; }
.model-card__status { flex: 0 0 auto; padding: 0.25rem 0.5rem; border-radius: 999px; background: rgb(133 226 174 / 14%); color: rgb(133 226 174); font-size: 0.7rem; }
.model-card__warning { margin: 0.75rem 0 0; padding: 0.6rem 0.7rem; border-radius: 0.65rem; background: rgb(255 208 126 / 10%); color: rgb(255 208 126 / 88%); font-size: 0.75rem; line-height: 1.45; }
</style>
