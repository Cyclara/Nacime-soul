<script setup lang="ts">
// P3A-23：聊天窗口的轻量角色在场按钮；复杂管理留在设置页。
import { computed } from 'vue'
import { useLive2dStore } from '../../stores/live2d'

const live2d = useLive2dStore()
const label = computed(() => live2d.state.window.visible ? '隐藏她' : '让她出现')
const status = computed(() => {
  switch (live2d.state.window.stageStatus) {
    case 'ready': return 'Live2D 已就绪'
    case 'loading-model': return '正在载入角色'
    case 'error': return live2d.state.lastError?.code ?? 'Live2D 暂不可用'
    default: return 'Live2D 未显示'
  }
})

async function toggle(): Promise<void> {
  await live2d.setVisible(!live2d.state.window.visible)
}
</script>

<template>
  <button class="presence-button" type="button" :aria-label="`${label}（${status}）`" @click="toggle">
    <span class="presence-dot" :class="`presence-dot--${live2d.state.window.stageStatus}`" aria-hidden="true" />
    <span>{{ label }}</span>
  </button>
</template>

<style scoped>
.presence-button {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  min-height: 2rem;
  padding: 0.35rem 0.7rem;
  border: 1px solid var(--color-border, rgb(255 255 255 / 14%));
  border-radius: 999px;
  background: var(--color-surface-raised, rgb(255 255 255 / 7%));
  color: var(--color-text-secondary, rgb(255 255 255 / 76%));
  cursor: pointer;
  font-size: 0.78rem;
  transition: border-color 160ms ease, background 160ms ease, transform 160ms ease;
}

.presence-button:hover { background: rgb(255 255 255 / 12%); border-color: rgb(193 177 255 / 48%); }
.presence-button:active { transform: translateY(1px); }
.presence-button:focus-visible { outline: 2px solid rgb(193 177 255); outline-offset: 2px; }
.presence-dot { width: 0.42rem; height: 0.42rem; border-radius: 50%; background: rgb(156 156 168); }
.presence-dot--ready { background: rgb(133 226 174); box-shadow: 0 0 0.45rem rgb(133 226 174 / 70%); }
.presence-dot--loading-model, .presence-dot--starting { background: rgb(255 208 126); }
.presence-dot--error, .presence-dot--degraded { background: rgb(255 139 139); }
</style>
