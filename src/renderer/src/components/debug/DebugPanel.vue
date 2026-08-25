<script setup lang="ts">
// P2-28: 调试面板（开发者，Ctrl+Shift+D 切换）
// 依据：F5-011 §3 wireframe、S-006（直连 debug IPC，不建 store）
// 功能优先，视觉朴素：前端模型后续可美化 template/style，不改 script 逻辑
import { ref, onMounted, onUnmounted, computed } from 'vue'
import type { DebugSnapshot } from '@shared/observability/types'
import DebugMetricsColumn from './DebugMetricsColumn.vue'
import DebugTraceWaterfall from './DebugTraceWaterfall.vue'
import DebugErrorList from './DebugErrorList.vue'

const visible = ref(false)
const snapshot = ref<DebugSnapshot | null>(null)
const loading = ref(false)
let timer: number | null = null

// M-05：打包后的正式应用禁用调试面板——权威门在 main 侧（app.isPackaged 时
// debug:get-snapshot/open-log-folder 拒绝服务，调试信息不会流出）。
// M-45（2026-08-20 回归）：渲染层不再按 import.meta.env.PROD 禁用——out/ 未打包
// 直跑也是 PROD 构建，旧实现把验收环境一并误杀（onMounted 早退连 keydown 都不注册）。
// 渲染层职责只剩"main 拒绝时保持隐藏"：打开前先探一次快照，拿不到就不显示。

async function refresh(): Promise<void> {
  loading.value = true
  try {
    const res = await window.companion.debug.getSnapshot()
    if (res.ok) snapshot.value = res.data
  } catch {
    /* 败而不崩：面板拉取失败静默，下次重试 */
  } finally {
    loading.value = false
  }
}

/** 打开前探测：main 拒绝（打包）或拉取失败时保持隐藏、静默 */
async function open(): Promise<void> {
  if (loading.value) return
  loading.value = true
  try {
    const res = await window.companion.debug.getSnapshot()
    if (res.ok) {
      snapshot.value = res.data
      visible.value = true
    }
  } catch {
    /* 保持隐藏 */
  } finally {
    loading.value = false
  }
}

function toggle(): void {
  if (visible.value) {
    visible.value = false
    return
  }
  void open()
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
    e.preventDefault()
    toggle()
  }
}

async function openLogFolder(): Promise<void> {
  await window.companion.debug.openLogFolder()
}

const uptimeStr = computed(() => {
  if (!snapshot.value) return ''
  const s = snapshot.value.uptimeSec
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${h}h${m}m`
})

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
  // 面板可见时每 2 秒拉取一次快照（F5-011 wireframe "实时"）
  timer = window.setInterval(() => {
    if (visible.value) void refresh()
  }, 2000)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown)
  if (timer !== null) clearInterval(timer)
})
</script>

<template>
  <div v-if="visible" class="debug-panel">
    <div class="debug-header">
      <span class="debug-meta"> v{{ snapshot?.appVersion ?? '...' }} · 运行 {{ uptimeStr }} </span>
      <span class="debug-logpath" :title="snapshot?.logFilePath">
        日志: {{ snapshot?.logFilePath ?? '' }}
      </span>
      <div class="debug-actions">
        <button class="debug-btn" :disabled="loading" @click="refresh">
          {{ loading ? '刷新中...' : '刷新' }}
        </button>
        <button class="debug-btn" @click="openLogFolder">打开日志目录</button>
        <button class="debug-btn debug-close" @click="visible = false">×</button>
      </div>
    </div>
    <div class="debug-body">
      <DebugMetricsColumn :metrics="snapshot?.metrics ?? {}" />
      <div class="debug-right">
        <DebugTraceWaterfall :traces="snapshot?.recentTraces ?? []" />
        <DebugErrorList :errors="snapshot?.recentErrors ?? []" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.debug-panel {
  position: fixed;
  top: 60px;
  right: 16px;
  width: 720px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 120px);
  background: var(--dbg-bg, #1e1e2e);
  color: var(--dbg-fg, #cdd6f4);
  border: 1px solid var(--dbg-border, #45475a);
  border-radius: 8px;
  font-family: ui-monospace, 'Cascadia Code', monospace;
  font-size: 12px;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}
.debug-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--dbg-border, #45475a);
  flex-wrap: wrap;
}
.debug-meta {
  font-weight: 600;
}
.debug-logpath {
  opacity: 0.6;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 300px;
}
.debug-actions {
  margin-left: auto;
  display: flex;
  gap: 6px;
}
.debug-btn {
  background: var(--dbg-btn-bg, #313244);
  color: var(--dbg-fg, #cdd6f4);
  border: 1px solid var(--dbg-border, #45475a);
  border-radius: 4px;
  padding: 2px 10px;
  cursor: pointer;
  font-size: 12px;
}
.debug-btn:hover {
  background: var(--dbg-btn-hover, #45475a);
}
.debug-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.debug-close {
  font-size: 16px;
  line-height: 1;
  padding: 2px 8px;
}
.debug-body {
  display: flex;
  gap: 1px;
  background: var(--dbg-border, #45475a);
  overflow: hidden;
  flex: 1;
  min-height: 0;
}
.debug-right {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 1px;
  background: var(--dbg-border, #45475a);
  overflow: hidden;
}
</style>
