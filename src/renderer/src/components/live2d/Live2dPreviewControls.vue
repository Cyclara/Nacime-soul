<script setup lang="ts">
// P3A-25：预览控制只发出 UI intent；zoom/alwaysOnTop 经 Live2dSettingsOrchestrator → config。
import { computed, ref, watch } from 'vue'
import { useLive2dStore } from '../../stores/live2d'
import {
  LIVE2D_FRAMING_PRESETS,
  type Live2dFramingPreset,
  type Live2dSettingsOrchestrator
} from '../../orchestrators/live2d-settings'

const props = defineProps<{ orchestrator?: Live2dSettingsOrchestrator }>()
const live2d = useLive2dStore()
const visible = computed(() => live2d.state.window.visible)
const zoom = ref(live2d.state.window.zoom)
const offsetX = ref(live2d.state.window.offsetX)
const offsetY = ref(live2d.state.window.offsetY)
const alwaysOnTop = ref(live2d.state.window.alwaysOnTop)
const saving = ref(false)
const saveError = ref<string | null>(null)
watch(() => live2d.state.window.zoom, (value) => { if (!saving.value) zoom.value = value })
watch(() => live2d.state.window.offsetX, (value) => { if (!saving.value) offsetX.value = value })
watch(() => live2d.state.window.offsetY, (value) => { if (!saving.value) offsetY.value = value })
watch(() => live2d.state.window.alwaysOnTop, (value) => { if (!saving.value) alwaysOnTop.value = value })

async function toggleVisible(): Promise<void> { await live2d.setVisible(!visible.value) }
async function resetPlacement(): Promise<void> { await live2d.resetWindowPlacement() }
async function saveSettings(): Promise<void> {
  if (!props.orchestrator) return
  saving.value = true
  saveError.value = null
  try {
    await props.orchestrator.saveAndApply()
  } catch {
    saveError.value = '设置没有保存，已保留原来的状态。'
  } finally {
    saving.value = false
  }
}
function onZoomInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  zoom.value = value
  props.orchestrator?.patchZoom(value)
}
function onOffsetXInput(event: Event): void {
  offsetX.value = Number((event.target as HTMLInputElement).value)
  props.orchestrator?.patchOffset(offsetX.value, offsetY.value)
}
function onOffsetYInput(event: Event): void {
  offsetY.value = Number((event.target as HTMLInputElement).value)
  props.orchestrator?.patchOffset(offsetX.value, offsetY.value)
}
function applyFraming(preset: Live2dFramingPreset): void {
  const next = LIVE2D_FRAMING_PRESETS[preset]
  zoom.value = next.zoom
  offsetX.value = next.offsetX
  offsetY.value = next.offsetY
  props.orchestrator?.applyFraming(preset)
}
function onAlwaysOnTopChange(event: Event): void {
  const value = (event.target as HTMLInputElement).checked
  alwaysOnTop.value = value
  props.orchestrator?.patchAlwaysOnTop(value)
}
</script>

<template>
  <section class="preview-panel" aria-labelledby="preview-controls-title">
    <div class="preview-panel__title" id="preview-controls-title">窗口控制</div>
    <div class="preview-controls" aria-label="角色窗口控制">
      <button type="button" class="control control--primary" @click="toggleVisible">
        <span aria-hidden="true">{{ visible ? '◌' : '✦' }}</span>
        {{ visible ? '隐藏角色' : '显示角色' }}
      </button>
      <span class="control-hint" :class="{ 'control-hint--ready': live2d.isReady }">
        {{ live2d.isReady ? '拖住她即可移动窗口' : '文字聊天不受影响' }}
      </span>
      <button type="button" class="control control--quiet" :disabled="!visible" @click="resetPlacement">
        重置位置
      </button>
    </div>
    <div v-if="props.orchestrator" class="settings-grid">
      <div class="framing" role="group" aria-label="取景预设">
        <span class="framing__label">取景</span>
        <button type="button" class="framing__preset" @click="applyFraming('upper-body')">半身</button>
        <button type="button" class="framing__preset" @click="applyFraming('full-body')">全身</button>
      </div>
      <label class="setting-row">
        <span><strong>角色大小</strong><small>{{ Math.round(zoom * 100) }}%</small></span>
        <input v-model="zoom" type="range" min="0.25" max="3" step="0.05" aria-label="角色窗口缩放" @input="onZoomInput" />
      </label>
      <label class="setting-row">
        <span><strong>左右位置</strong><small>{{ offsetX > 0 ? `右 ${offsetX}` : offsetX < 0 ? `左 ${-offsetX}` : '居中' }}</small></span>
        <input v-model="offsetX" type="range" min="-100" max="100" step="1" aria-label="角色左右位置" @input="onOffsetXInput" />
      </label>
      <label class="setting-row">
        <span><strong>上下位置</strong><small>{{ offsetY > 0 ? `上移 ${offsetY}` : offsetY < 0 ? `下移 ${-offsetY}` : '贴底' }}</small></span>
        <input v-model="offsetY" type="range" min="-100" max="100" step="1" aria-label="角色上下位置" @input="onOffsetYInput" />
      </label>
      <label class="setting-toggle">
        <input :checked="alwaysOnTop" type="checkbox" @change="onAlwaysOnTopChange" />
        <span class="toggle-box" aria-hidden="true" />
        <span><strong>保持置顶</strong><small>让她在其他窗口前待着</small></span>
      </label>
      <button class="save-settings" type="button" :disabled="saving" @click="saveSettings">
        {{ saving ? '保存中…' : '保存窗口设置' }}
      </button>
      <p v-if="saveError" class="save-error" role="alert">{{ saveError }}</p>
    </div>
  </section>
</template>

<style scoped>
.preview-panel { display: grid; gap: 0.65rem; margin-top: 0.1rem; padding: 0.85rem; border: 1px solid var(--color-border, rgb(255 255 255 / 10%)); border-radius: 0.9rem; background: rgb(255 255 255 / 3%); }
.preview-panel__title { color: var(--color-text-muted, rgb(255 255 255 / 48%)); font-size: 0.7rem; letter-spacing: 0.08em; text-transform: uppercase; }
.preview-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 0.6rem; }
.control { min-height: 2.25rem; padding: 0.45rem 0.8rem; border: 1px solid transparent; border-radius: 0.7rem; cursor: pointer; font: inherit; font-size: 0.78rem; transition: 160ms ease; }
.control--primary { background: rgb(193 177 255 / 84%); color: rgb(31 24 56); box-shadow: 0 0.3rem 1rem rgb(120 99 204 / 22%); }
.control--primary:hover { background: rgb(207 194 255); transform: translateY(-1px); }
.control--quiet { border-color: var(--color-border, rgb(255 255 255 / 14%)); background: transparent; color: var(--color-text-secondary, rgb(255 255 255 / 70%)); }
.control--quiet:hover:not(:disabled) { background: rgb(255 255 255 / 7%); }
.control:disabled { cursor: not-allowed; opacity: 0.38; }
.control:focus-visible, .save-settings:focus-visible, input:focus-visible { outline: 2px solid rgb(193 177 255); outline-offset: 2px; }
.control-hint { flex: 1; min-width: 10rem; color: var(--color-text-muted, rgb(255 255 255 / 48%)); font-size: 0.75rem; }
.control-hint--ready { color: rgb(133 226 174 / 82%); }
.settings-grid { display: grid; gap: 0.7rem; padding-top: 0.45rem; border-top: 1px solid var(--color-border-subtle, rgb(255 255 255 / 8%)); }
.framing { display: flex; align-items: center; gap: 0.45rem; }
.framing__label { flex: 1; color: var(--color-text-secondary, rgb(255 255 255 / 72%)); font-size: 0.75rem; font-weight: 600; }
.framing__preset { min-height: 1.9rem; padding: 0.3rem 0.75rem; border: 1px solid rgb(193 177 255 / 30%); border-radius: 999px; background: transparent; color: var(--color-text-secondary, rgb(255 255 255 / 75%)); cursor: pointer; font: inherit; font-size: 0.72rem; transition: 160ms ease; }
.framing__preset:hover { border-color: rgb(193 177 255 / 66%); background: rgb(193 177 255 / 14%); color: rgb(255 255 255 / 92%); }
.framing__preset:focus-visible { outline: 2px solid rgb(193 177 255); outline-offset: 2px; }
.setting-row { display: grid; gap: 0.45rem; }
.setting-row > span, .setting-toggle { display: flex; align-items: center; justify-content: space-between; gap: 0.7rem; color: var(--color-text-secondary, rgb(255 255 255 / 72%)); font-size: 0.75rem; }
.setting-row small, .setting-toggle small { display: block; color: var(--color-text-muted, rgb(255 255 255 / 46%)); font-size: 0.68rem; }
.setting-row input[type='range'] { width: 100%; accent-color: var(--color-companion, rgb(193 177 255)); }
.setting-toggle { justify-content: flex-start; cursor: pointer; }
.setting-toggle input { position: absolute; opacity: 0; pointer-events: none; }
.toggle-box { width: 1.65rem; height: 1rem; flex: 0 0 auto; border: 1px solid var(--color-border, rgb(255 255 255 / 22%)); border-radius: 999px; background: rgb(255 255 255 / 8%); transition: 160ms ease; }
.setting-toggle input:checked + .toggle-box { border-color: rgb(193 177 255 / 70%); background: rgb(193 177 255 / 68%); box-shadow: inset 0 0 0 3px rgb(30 25 51 / 38%); }
.save-settings { justify-self: start; min-height: 2rem; padding: 0.35rem 0.7rem; border: 1px solid rgb(193 177 255 / 30%); border-radius: 0.65rem; background: transparent; color: var(--color-text-secondary, rgb(255 255 255 / 75%)); cursor: pointer; font: inherit; font-size: 0.72rem; }
.save-settings:disabled { cursor: progress; opacity: 0.52; }
.save-error { margin: 0; color: var(--color-error, rgb(255 139 139)); font-size: 0.72rem; }
</style>
