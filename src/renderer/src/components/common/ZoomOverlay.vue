<script setup lang="ts">
// M-51: UI 缩放覆盖层 + Ctrl+滚轮 / Ctrl+±0 快捷键。
// 参考 stablyai/orca ZoomOverlay（居中 pill、1.5s 自动隐去）与 UIZoomControl（步进/夹取/持久化）。
//
// 接线：
//   - 状态源是 config.ui.fontScale（0.8..1.5，schema/IPC validator 早已就位，此前无消费端）
//   - 应用层是 webFrame.zoomFactor（preload ui.setZoomFactor 直连，本窗口本地行为）
//   - 启动/外部变更：watch saved.fontScale 立即应用（webFrame zoom 不跨重启，必须每次补水）
//   - 快捷键路径：patch 草稿 + 立即应用 + 400ms 防抖 save（高频滚轮不打爆 IPC）
//
// 守卫：设置抽屉打开时快捷键不改配置（抽屉里由外观分区的步进器接管，
//   避免自动 save 把用户未完成的其他草稿一起落盘）；但仍须 preventDefault，
//   否则 Electron 原生 Ctrl+±0 / Ctrl+滚轮会绕过 Pinia 直接改 webFrame，造成 UI 与落盘值漂移。

import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useConfigStore } from '../../stores/config'
import { useSettingsUiStore } from '../../stores/settings-ui'
import { clampZoom, stepZoom, zoomPercent } from '../../utils/ui-zoom'

const configStore = useConfigStore()
const settingsUi = useSettingsUiStore()
const { isOpen: settingsOpen } = storeToRefs(settingsUi)

const visible = ref(false)
const percent = ref(100)
let hideTimer: ReturnType<typeof setTimeout> | undefined
let saveTimer: ReturnType<typeof setTimeout> | undefined

const DISPLAY_MS = 1400
const SAVE_DEBOUNCE_MS = 400

function currentScale(): number {
  return configStore.state.draft?.ui.fontScale ?? configStore.state.saved?.ui.fontScale ?? 1
}

function applyZoom(scale: number): void {
  window.companion?.ui?.setZoomFactor(scale)
}

function showPill(scale: number): void {
  percent.value = zoomPercent(scale)
  visible.value = true
  clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    visible.value = false
  }, DISPLAY_MS)
}

function scheduleSave(): void {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    void configStore.save().then((saved) => {
      if (!saved) {
        // 保存失败不打扰（视觉缩放已生效），错误进 validationErrors.save，
        // 下次打开设置时用户能看到；草稿保留，抽屉的「放弃修改」守卫会兜底。
        console.warn('[ui-zoom] fontScale 保存失败', configStore.state.validationErrors.save)
      }
    })
  }, SAVE_DEBOUNCE_MS)
}

function changeZoom(direction: 1 | -1 | 0): void {
  const current = currentScale()
  const next = direction === 0 ? 1 : stepZoom(current, direction)
  if (next === current && direction !== 0) return
  configStore.patch('ui', { fontScale: next })
  applyZoom(next)
  showPill(next)
  scheduleSave()
}

function onWheel(event: WheelEvent): void {
  // Ctrl+滚轮（含触控板捏合——Chromium 把它报成 ctrlKey=true 的 wheel）
  if (!event.ctrlKey && !event.metaKey) return
  if (event.defaultPrevented) return
  // 先拦截 Electron/Chromium 原生缩放；设置打开时只阻断、不改草稿。
  event.preventDefault()
  if (settingsOpen.value) return
  changeZoom(event.deltaY < 0 ? 1 : -1)
}

function onKeydown(event: KeyboardEvent): void {
  if (!event.ctrlKey && !event.metaKey) return

  let direction: 1 | -1 | 0 | null = null
  if (event.key === '=' || event.key === '+') direction = 1
  else if (event.key === '-') direction = -1
  else if (event.key === '0') direction = 0
  if (direction === null) return

  // 与 wheel 同理：设置打开时必须阻断原生 accelerator，不能只 return。
  event.preventDefault()
  if (settingsOpen.value) return
  changeZoom(direction)
}

// 启动补水 + 设置页步进器保存后的回流：saved.fontScale 是唯一持久化真源。
// draft 变化不直接驱动（快捷键路径已自行 apply），避免与防抖 save 来回打架。
watch(
  () => configStore.state.saved?.ui.fontScale,
  (scale) => {
    if (scale !== undefined) {
      applyZoom(clampZoom(scale))
      percent.value = zoomPercent(clampZoom(scale))
    }
  },
  { immediate: true }
)

onMounted(() => {
  // capture + passive:false：抢在原生 Ctrl+滚轮缩放和滚动容器之前，preventDefault 阻断浏览器默认缩放
  window.addEventListener('wheel', onWheel, { passive: false, capture: true })
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('wheel', onWheel, { capture: true })
  window.removeEventListener('keydown', onKeydown)
  clearTimeout(hideTimer)
  clearTimeout(saveTimer)
})
</script>

<template>
  <!-- 完全卸载条件由 v-if 承担，避免 fixed 层残留遮挡（orca 同款理由） -->
  <div v-if="visible" class="zoom-overlay" role="status" aria-live="polite">
    <div class="zoom-pill">
      <span class="zoom-icon" aria-hidden="true">⌕</span>
      <span class="zoom-label">界面缩放</span>
      <span class="zoom-percent">{{ percent }}%</span>
    </div>
  </div>
</template>

<style scoped>
.zoom-overlay {
  position: fixed;
  z-index: 1300;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  animation: zoom-fade-in 0.16s ease-out;
}

.zoom-pill {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 20px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--color-surface-elevated) 94%, transparent);
  box-shadow: var(--shadow-lg);
  backdrop-filter: blur(8px);
}

.zoom-icon {
  color: var(--color-text-muted);
  font-size: var(--font-size-base);
}

.zoom-label {
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
}

.zoom-percent {
  min-width: 4ch;
  color: var(--color-text);
  font-size: var(--font-size-base);
  font-weight: 750;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

@keyframes zoom-fade-in {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.96);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
</style>
