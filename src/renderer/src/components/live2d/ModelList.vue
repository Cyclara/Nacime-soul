<script setup lang="ts">
import { useLive2dStore } from '../../stores/live2d'

const live2d = useLive2dStore()

async function select(id: string): Promise<void> {
  if (id !== live2d.state.selectedModelId) await live2d.selectModel(id)
}
</script>

<template>
  <section class="model-list" aria-labelledby="model-list-title">
    <div class="model-list__heading">
      <div>
        <div class="model-list__eyebrow">形象库</div>
        <h3 id="model-list-title">选择一个她</h3>
      </div>
      <span class="model-list__count">{{ live2d.state.models.length }} 个模型</span>
    </div>
    <div v-if="live2d.state.models.length" class="model-list__items" role="list">
      <button
        v-for="model in live2d.state.models"
        :key="model.id"
        class="model-item"
        :class="{ 'model-item--selected': model.id === live2d.state.selectedModelId }"
        type="button"
        role="listitem"
        :aria-pressed="model.id === live2d.state.selectedModelId"
        @click="select(model.id)"
      >
        <span class="model-item__mark" aria-hidden="true">{{
          model.id === live2d.state.selectedModelId ? '✓' : '○'
        }}</span>
        <span class="model-item__body">
          <strong>{{ model.displayName }}</strong>
          <small
            >{{ model.source === 'builtin' ? '内置模型' : '已导入模型' }} ·
            {{ model.expressionCount }} 个表情 · {{ model.motionCount }} 个动作</small
          >
        </span>
        <span v-if="model.warnings.length" class="model-item__badge" title="存在兼容性提示"
          >提示</span
        >
      </button>
    </div>
    <p v-else class="model-list__empty">还没有可用模型。可以导入一个 `.zip` 模型包。</p>
  </section>
</template>

<style scoped>
.model-list {
  margin-top: 1rem;
}
.model-list__heading {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 0.7rem;
}
.model-list__eyebrow {
  color: var(--color-text-muted, rgb(255 255 255 / 48%));
  font-size: 0.7rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.model-list h3 {
  margin: 0.2rem 0 0;
  color: var(--color-text-primary, white);
  font-size: 0.98rem;
}
.model-list__count {
  color: var(--color-text-muted, rgb(255 255 255 / 45%));
  font-size: 0.72rem;
}
.model-list__items {
  display: grid;
  gap: 0.5rem;
}
.model-item {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  width: 100%;
  padding: 0.7rem;
  border: 1px solid var(--color-border);
  border-radius: 0.75rem;
  background: color-mix(in srgb, var(--color-surface-elevated) 58%, transparent);
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: 160ms ease;
}
.model-item:hover {
  border-color: color-mix(in srgb, var(--color-accent) 58%, var(--color-border));
  background: var(--color-surface-elevated);
}
.model-item--selected {
  border-color: var(--color-accent);
  background: linear-gradient(100deg, var(--color-accent-soft), var(--color-surface-elevated));
}
.model-item:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
.model-item__mark {
  width: 1.35rem;
  color: var(--color-accent);
  font-size: 1.05rem;
  text-align: center;
}
.model-item__body {
  display: grid;
  min-width: 0;
  flex: 1;
  gap: 0.2rem;
}
.model-item__body strong {
  overflow: hidden;
  color: var(--color-text-primary, white);
  font-size: 0.82rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-item__body small {
  overflow: hidden;
  color: var(--color-text-muted, rgb(255 255 255 / 50%));
  font-size: 0.7rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-item__badge {
  color: var(--color-warning);
  font-size: 0.68rem;
  font-weight: 650;
}
.model-list__empty {
  margin: 0;
  padding: 0.8rem;
  border: 1px dashed var(--color-border, rgb(255 255 255 / 18%));
  border-radius: 0.75rem;
  color: var(--color-text-muted, rgb(255 255 255 / 56%));
  font-size: 0.78rem;
  line-height: 1.5;
}
</style>
