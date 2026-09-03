<script setup lang="ts">
import { ref } from 'vue'
import { useLive2dStore } from '../../stores/live2d'

const live2d = useLive2dStore()
const dragging = ref(false)
const message = ref('')

async function importModel(): Promise<void> {
  message.value = ''
  const result = await live2d.chooseImportSource()
  if (result.ok) {
    message.value = `${result.displayName ?? '模型'} 已加入形象库，可在上方选择。`
  } else if (result.error !== null) {
    message.value = `导入没有完成（${result.error.code}）。可以换一个模型包再试。`
  }
}

function onDragOver(event: DragEvent): void {
  event.preventDefault()
  dragging.value = true
}
function onDragLeave(): void {
  dragging.value = false
}
function onDrop(event: DragEvent): void {
  event.preventDefault()
  dragging.value = false
  // 文件路径不能从 renderer 传给 main；drop 只作为 UI affordance，统一走 main dialog。
  void importModel()
}
</script>

<template>
  <section class="dropzone-section" aria-labelledby="import-model-title">
    <div
      class="dropzone"
      :class="{ 'dropzone--dragging': dragging, 'dropzone--loading': live2d.state.loading }"
      role="button"
      tabindex="0"
      aria-describedby="import-model-hint"
      @click="importModel"
      @keydown.enter="importModel"
      @keydown.space.prevent="importModel"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <span class="dropzone__icon" aria-hidden="true">＋</span>
      <span>
        <strong id="import-model-title">导入模型</strong>
        <small id="import-model-hint">拖入 `.zip`，或点击从电脑选择</small>
      </span>
      <span v-if="live2d.state.loading" class="dropzone__loading" aria-label="正在导入">…</span>
    </div>
    <p v-if="message" class="dropzone__message" role="status" aria-live="polite">{{ message }}</p>
  </section>
</template>

<style scoped>
.dropzone-section {
  margin-top: 1rem;
}
.dropzone {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  min-height: 4.6rem;
  padding: 0.85rem 1rem;
  border: 1px dashed color-mix(in srgb, var(--color-accent) 52%, var(--color-border));
  border-radius: 0.9rem;
  background: linear-gradient(105deg, var(--color-accent-soft), var(--color-surface));
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: 160ms ease;
}
.dropzone:hover,
.dropzone:focus-visible,
.dropzone--dragging {
  border-color: var(--color-accent);
  background: var(--color-accent-soft-hover);
  outline: none;
}
.dropzone--loading {
  cursor: progress;
  opacity: 0.7;
}
.dropzone__icon {
  display: grid;
  width: 2rem;
  height: 2rem;
  place-items: center;
  border-radius: 0.65rem;
  background: var(--color-accent-soft-hover);
  color: var(--color-accent);
  font-size: 1.4rem;
}
.dropzone > span:nth-child(2) {
  display: grid;
  gap: 0.18rem;
}
.dropzone strong {
  color: var(--color-text-primary, white);
  font-size: 0.82rem;
}
.dropzone small {
  color: var(--color-text-muted, rgb(255 255 255 / 55%));
  font-size: 0.72rem;
}
.dropzone__loading {
  margin-left: auto;
  font-size: 1.25rem;
}
.dropzone__message {
  margin: 0.55rem 0 0;
  color: var(--color-text-muted, rgb(255 255 255 / 58%));
  font-size: 0.72rem;
  line-height: 1.4;
}
</style>
