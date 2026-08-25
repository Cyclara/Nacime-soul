<script setup lang="ts">
// P2-46: 外观设置。主题选项只从共享注册表派生；不硬编码 light/dark 列表。
// 选中即 patch config 草稿，App.vue watch 立即预览；随后走既有 save() 持久化。

import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { THEME_IDS, THEME_LABELS } from '@shared/config/themes'
import type { ThemeId, ThemeSetting } from '@shared/config/themes'
import { useConfigStore } from '../../stores/config'
import {
  stepZoom,
  zoomPercent,
  UI_ZOOM_MIN,
  UI_ZOOM_MAX,
  UI_ZOOM_DEFAULT
} from '../../utils/ui-zoom'

const configStore = useConfigStore()
const { state } = storeToRefs(configStore)

const savingTheme = ref<ThemeSetting | null>(null)
const feedback = ref('')

// ── M-51：界面缩放（fontScale 的消费端；webFrame zoomFactor 由 ZoomOverlay 的 watch 应用）──
const savingZoom = ref(false)
const currentZoom = computed(() => state.value.draft?.ui.fontScale ?? UI_ZOOM_DEFAULT)
const zoomPercentText = computed(() => `${zoomPercent(currentZoom.value)}%`)
const canZoomOut = computed(() => currentZoom.value > UI_ZOOM_MIN)
const canZoomIn = computed(() => currentZoom.value < UI_ZOOM_MAX)
const isDefaultZoom = computed(() => currentZoom.value === UI_ZOOM_DEFAULT)

async function applyZoom(scale: number): Promise<void> {
  if (!state.value.draft || savingZoom.value) return
  feedback.value = ''
  savingZoom.value = true
  configStore.patch('ui', { fontScale: scale })
  const saved = await configStore.save()
  if (!saved) {
    feedback.value = state.value.validationErrors.save ?? '缩放设置保存失败，请稍后重试。'
    configStore.discard()
  } else {
    feedback.value = `界面缩放已调整为 ${zoomPercent(scale)}%`
  }
  savingZoom.value = false
}

function zoomIn(): void {
  void applyZoom(stepZoom(currentZoom.value, 1))
}

function zoomOut(): void {
  void applyZoom(stepZoom(currentZoom.value, -1))
}

function resetZoom(): void {
  void applyZoom(UI_ZOOM_DEFAULT)
}

const selectedTheme = computed<ThemeSetting>(() => state.value.draft?.ui.theme ?? 'light')
const themes = computed(() =>
  THEME_IDS.map((id) => ({
    id,
    label: THEME_LABELS[id]
  }))
)

function themeDescription(id: ThemeId): string {
  const known: Partial<Record<ThemeId, string>> = {
    light: '柔和纸色与清晰墨色，适合白天长时间相处',
    dark: '深夜靛墨与低亮层次，减少暗处视觉刺激',
    light2: '雾白苔绿与赤陶点缀，像清晨植物园的凉意',
    dark2: '暖炭夜色与琥珀微光，壁炉旁的低蓝光夜晚'
  }
  return known[id] ?? `${THEME_LABELS[id]}主题，使用完整的共享语义色令牌`
}

async function selectTheme(theme: ThemeSetting): Promise<void> {
  if (!state.value.draft || savingTheme.value) return
  if (selectedTheme.value === theme && state.value.saved?.ui.theme === theme) return

  feedback.value = ''
  savingTheme.value = theme
  configStore.patch('ui', { theme })
  const saved = await configStore.save()
  if (!saved) {
    feedback.value = state.value.validationErrors.save ?? '主题保存失败，请稍后重试。'
    configStore.discard()
  } else {
    feedback.value = `${theme === 'system' ? '跟随系统' : THEME_LABELS[theme]}主题已保存`
  }
  savingTheme.value = null
}

function themeNumber(id: ThemeId): string {
  return String(THEME_IDS.indexOf(id) + 1).padStart(2, '0')
}
</script>

<template>
  <section class="appearance-section" aria-labelledby="appearance-heading">
    <header class="section-heading">
      <p class="section-kicker">APPEARANCE · 外观</p>
      <h2 id="appearance-heading">让光线顺着你的时间呼吸</h2>
      <p>
        每个主题都使用同一套语义色令牌。以后在注册表加入新主题，它会自动来到这里，无需重写设置页。
      </p>
    </header>

    <div class="theme-grid" role="radiogroup" aria-label="应用主题">
      <button
        v-for="theme in themes"
        :key="theme.id"
        class="theme-card"
        :class="{ selected: selectedTheme === theme.id }"
        role="radio"
        :aria-checked="selectedTheme === theme.id"
        :aria-label="`${theme.label}主题：${themeDescription(theme.id)}`"
        :disabled="savingTheme !== null"
        @click="selectTheme(theme.id)"
      >
        <span class="theme-index">{{ themeNumber(theme.id) }}</span>
        <span class="theme-preview" :data-theme="theme.id" aria-hidden="true">
          <i class="preview-orbit"></i>
          <i class="preview-panel"></i>
          <i class="preview-line long"></i>
          <i class="preview-line short"></i>
          <i class="preview-accent"></i>
        </span>
        <span class="theme-copy">
          <strong>{{ theme.label }}</strong>
          <small>{{ themeDescription(theme.id) }}</small>
        </span>
        <span class="selection-mark" aria-hidden="true">{{
          selectedTheme === theme.id ? '✓' : '↗'
        }}</span>
      </button>
    </div>

    <button
      class="system-theme"
      :class="{ selected: selectedTheme === 'system' }"
      role="radio"
      :aria-checked="selectedTheme === 'system'"
      :disabled="savingTheme !== null"
      @click="selectTheme('system')"
    >
      <span class="system-icon" aria-hidden="true">
        <i class="sun-half"></i>
        <i class="moon-half"></i>
      </span>
      <span class="system-copy">
        <strong>跟随系统</strong>
        <small>日夜由 Windows 的浅色或深色偏好自动决定</small>
      </span>
      <span class="system-state">{{ selectedTheme === 'system' ? '已启用' : '自动' }}</span>
    </button>

    <p
      v-if="feedback"
      class="theme-feedback"
      :class="{ error: !!state.validationErrors.save }"
      role="status"
    >
      {{ feedback }}
    </p>

    <aside class="extension-note">
      <span class="note-mark" aria-hidden="true">+</span>
      <div>
        <strong>主题扩展已经留好接口</strong>
        <p>
          新主题只需登记 <code>THEME_IDS / THEME_LABELS</code>，再补一块
          <code>[data-theme='id']</code> CSS 变量；这里会自动生成新选项。
        </p>
      </div>
    </aside>

    <!-- M-51：界面缩放（字体与布局整体缩放） -->
    <div class="zoom-block">
      <div class="zoom-heading">
        <strong>界面缩放</strong>
        <small>字体与布局一起缩放，立即生效并自动保存</small>
      </div>
      <div class="zoom-control" role="group" aria-label="界面缩放">
        <button
          class="zoom-btn"
          :disabled="!canZoomOut || savingZoom"
          aria-label="缩小界面"
          @click="zoomOut"
        >
          −
        </button>
        <span class="zoom-value" aria-live="polite">{{ zoomPercentText }}</span>
        <button
          class="zoom-btn"
          :disabled="!canZoomIn || savingZoom"
          aria-label="放大界面"
          @click="zoomIn"
        >
          +
        </button>
        <button class="zoom-reset" :disabled="isDefaultZoom || savingZoom" @click="resetZoom">
          重置
        </button>
      </div>
      <p class="zoom-hint">
        也可以在主界面按住 <kbd>Ctrl</kbd> 滚动鼠标滚轮，或用 <kbd>Ctrl</kbd> +
        <kbd>+</kbd>/<kbd>−</kbd>/<kbd>0</kbd> 调整（设置窗口打开时快捷键暂不生效）。
      </p>
    </div>
  </section>
</template>

<style scoped>
.appearance-section {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.section-heading {
  max-width: 640px;
}

.section-kicker {
  margin-bottom: 9px;
  color: var(--color-accent);
  font-size: 10px;
  font-weight: 750;
  letter-spacing: 0.19em;
}

.section-heading h2 {
  color: var(--color-text);
  font-family: var(--font-family-display);
  font-size: clamp(25px, 3.2vw, 36px);
  font-weight: 560;
  letter-spacing: -0.025em;
  line-height: 1.12;
}

.section-heading > p:last-child {
  max-width: 57ch;
  margin-top: 10px;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.72;
}

.theme-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 13px;
}

.theme-card {
  position: relative;
  display: grid;
  min-height: 210px;
  grid-template-rows: 1fr auto;
  padding: 14px;
  overflow: hidden;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
  background: var(--color-surface-elevated);
  box-shadow: var(--shadow-sm);
  text-align: left;
}

.theme-card::after {
  position: absolute;
  inset: 0;
  border: 1px solid transparent;
  border-radius: inherit;
  content: '';
  pointer-events: none;
  transition: border-color 0.18s ease;
}

.theme-card:hover {
  border-color: var(--color-border);
  box-shadow: var(--shadow-md);
  transform: translateY(-2px);
}

.theme-card.selected {
  border-color: color-mix(in srgb, var(--color-accent) 54%, var(--color-border));
  box-shadow: var(--shadow-glow);
}

.theme-card.selected::after {
  border-color: color-mix(in srgb, var(--color-accent) 32%, transparent);
}

.theme-index,
.selection-mark {
  position: absolute;
  z-index: 2;
  top: 11px;
  font-size: 10px;
  font-weight: 750;
  letter-spacing: 0.08em;
}

.theme-index {
  left: 12px;
  color: var(--color-text-tertiary);
}

.selection-mark {
  right: 12px;
  display: grid;
  width: 26px;
  height: 26px;
  place-items: center;
  border: 1px solid var(--color-border-subtle);
  border-radius: 50%;
  background: color-mix(in srgb, var(--color-surface-elevated) 74%, transparent);
  color: var(--color-text-muted);
}

.theme-card.selected .selection-mark {
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: var(--color-text-on-accent);
}

.theme-preview {
  position: relative;
  display: block;
  height: 125px;
  overflow: hidden;
  border-radius: 12px 12px 12px 5px;
  background: var(--preview-bg, var(--color-bg-tertiary));
  box-shadow: inset 0 0 0 1px var(--preview-border, var(--color-border-subtle));
}

.theme-card .theme-preview:not([data-theme='light']):not([data-theme='dark']) {
  --preview-bg: color-mix(in srgb, var(--color-accent-soft) 68%, var(--color-bg-tertiary));
  --preview-panel: var(--color-surface-elevated);
  --preview-line: var(--color-text-muted);
  --preview-accent: var(--color-accent);
  --preview-orbit: var(--color-companion-soft);
  --preview-border: var(--color-border-subtle);
}

.theme-card .theme-preview[data-theme='light'] {
  --preview-bg: #eee8dd;
  --preview-panel: #fffdf8;
  --preview-line: #7b746d;
  --preview-accent: #315f72;
  --preview-orbit: rgba(174, 108, 112, 0.28);
  --preview-border: rgba(77, 62, 53, 0.12);
}

.theme-card .theme-preview[data-theme='dark'] {
  --preview-bg: #161b25;
  --preview-panel: #222938;
  --preview-line: #a7afbd;
  --preview-accent: #8fbec6;
  --preview-orbit: rgba(205, 147, 151, 0.27);
  --preview-border: rgba(233, 231, 226, 0.11);
}

.theme-card .theme-preview[data-theme='light2'] {
  --preview-bg: #e5ebdb;
  --preview-panel: #fcfcf3;
  --preview-line: #7a8577;
  --preview-accent: #3f6c4f;
  --preview-orbit: rgba(177, 98, 67, 0.24);
  --preview-border: rgba(52, 66, 55, 0.12);
}

.theme-card .theme-preview[data-theme='dark2'] {
  --preview-bg: #1b1613;
  --preview-panel: #2f261c;
  --preview-line: #b3a691;
  --preview-accent: #e5ad61;
  --preview-orbit: rgba(210, 139, 125, 0.25);
  --preview-border: rgba(241, 231, 213, 0.1);
}

.preview-orbit {
  position: absolute;
  top: -34px;
  right: -16px;
  width: 118px;
  height: 118px;
  border-radius: 50%;
  background: radial-gradient(circle, var(--preview-orbit), transparent 67%);
}

.preview-panel {
  position: absolute;
  top: 25px;
  left: 18px;
  width: 64%;
  height: 76px;
  border-radius: 10px 10px 10px 3px;
  background: var(--preview-panel);
  box-shadow: 0 12px 26px rgba(8, 12, 20, 0.13);
}

.preview-line {
  position: absolute;
  left: 33px;
  height: 5px;
  border-radius: 99px;
  background: var(--preview-line);
  opacity: 0.55;
}

.preview-line.long {
  top: 46px;
  width: 44%;
}

.preview-line.short {
  top: 61px;
  width: 29%;
  opacity: 0.32;
}

.preview-accent {
  position: absolute;
  right: 23px;
  bottom: 20px;
  width: 34px;
  height: 34px;
  border-radius: 50% 50% 50% 12px;
  background: var(--preview-accent);
  box-shadow: 0 7px 18px color-mix(in srgb, var(--preview-accent) 32%, transparent);
}

.theme-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 13px 2px 0;
}

.theme-copy strong {
  color: var(--color-text);
  font-size: var(--font-size-base);
  font-weight: 680;
}

.theme-copy small {
  max-width: 29ch;
  color: var(--color-text-muted);
  font-size: 11px;
  line-height: 1.55;
}

.system-theme {
  display: grid;
  min-height: 72px;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 13px;
  padding: 12px 14px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
  background: var(--color-surface-elevated);
  box-shadow: var(--shadow-sm);
  text-align: left;
}

.system-theme:hover,
.system-theme.selected {
  border-color: color-mix(in srgb, var(--color-accent) 45%, var(--color-border));
  background: color-mix(in srgb, var(--color-accent-soft) 64%, var(--color-surface-elevated));
}

.system-icon {
  position: relative;
  display: grid;
  width: 42px;
  height: 42px;
  grid-template-columns: 1fr 1fr;
  overflow: hidden;
  border: 1px solid var(--color-border-subtle);
  border-radius: 50%;
}

.sun-half {
  background: #eee7d8;
}

.moon-half {
  background: #1b2230;
}

.system-icon::after {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 9px;
  height: 9px;
  border: 1px solid rgba(255, 255, 255, 0.65);
  border-radius: 50%;
  background: var(--color-accent);
  content: '';
  transform: translate(-50%, -50%);
}

.system-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}

.system-copy strong {
  color: var(--color-text);
  font-weight: 680;
}

.system-copy small {
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.system-state {
  color: var(--color-accent);
  font-size: var(--font-size-xs);
  font-weight: 700;
}

.theme-feedback {
  margin-top: -12px;
  color: var(--color-success);
  font-size: var(--font-size-xs);
}

.theme-feedback.error {
  color: var(--color-error);
}

.extension-note {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 15px;
  border: 1px dashed color-mix(in srgb, var(--color-accent) 30%, var(--color-border));
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--color-accent-soft) 58%, transparent);
}

.note-mark {
  display: grid;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--color-accent) 38%, var(--color-border));
  border-radius: 50%;
  color: var(--color-accent);
  font-family: var(--font-family-display);
  font-size: 20px;
}

.extension-note strong {
  color: var(--color-text);
  font-size: var(--font-size-sm);
}

.extension-note p {
  margin-top: 4px;
  color: var(--color-text-muted);
  font-size: 11px;
  line-height: 1.6;
}

.extension-note code {
  color: var(--color-accent);
  font-family: 'Cascadia Mono', 'SFMono-Regular', monospace;
  font-size: 10px;
}

/* ── M-51：界面缩放步进器 ── */
.zoom-block {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 15px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
  background: var(--color-surface-elevated);
  box-shadow: var(--shadow-sm);
}

.zoom-heading {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.zoom-heading strong {
  color: var(--color-text);
  font-size: var(--font-size-sm);
  font-weight: 680;
}

.zoom-heading small {
  color: var(--color-text-muted);
  font-size: 11px;
}

.zoom-control {
  display: flex;
  align-items: center;
  gap: 10px;
}

.zoom-btn {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border: 1px solid var(--color-border);
  border-radius: 50%;
  background: var(--color-surface-elevated);
  color: var(--color-text);
  font-size: 16px;
  font-weight: 700;
  transition:
    border-color 0.15s ease,
    background 0.15s ease;
}

.zoom-btn:hover:not(:disabled) {
  border-color: var(--color-accent);
  background: var(--color-accent-soft);
}

.zoom-btn:disabled,
.zoom-reset:disabled {
  opacity: 0.45;
}

.zoom-value {
  min-width: 56px;
  color: var(--color-text);
  font-size: var(--font-size-base);
  font-weight: 750;
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.zoom-reset {
  margin-left: 6px;
  padding: 7px 16px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-full);
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  font-weight: 650;
}

.zoom-reset:hover:not(:disabled) {
  border-color: var(--color-accent);
  color: var(--color-accent);
}

.zoom-hint {
  color: var(--color-text-muted);
  font-size: 11px;
  line-height: 1.6;
}

.zoom-hint kbd {
  padding: 1px 6px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 6px;
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
  font-family: inherit;
  font-size: 10px;
}

@media (max-width: 640px) {
  .theme-grid {
    grid-template-columns: 1fr;
  }

  .system-copy small {
    white-space: normal;
  }
}
</style>
