<script setup lang="ts">
// P2-46: 设置模态抽屉。遵循 S-006：设置不占路由，renderer settingsUi 控制开关与 section。
// 四个正式分区均复用既有 config store/IPC；高级分区仅开发构建显示（F5-001 C0-5）。

import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useConfigStore } from '../../stores/config'
import { useSettingsUiStore } from '../../stores/settings-ui'
import type { SettingsSection } from '../../stores/settings-ui'
import AppearanceSection from './AppearanceSection.vue'
import ModelSettingsSection from './ModelSettingsSection.vue'
import MemorySettingsSection from './MemorySettingsSection.vue'
import SecuritySettingsSection from './SecuritySettingsSection.vue'
import AboutSection from './AboutSection.vue'
import AdvancedSection from './AdvancedSection.vue'
import Live2dSettingsSection from './Live2dSettingsSection.vue'

const settingsUi = useSettingsUiStore()
const configStore = useConfigStore()
const { isOpen, activeSection } = storeToRefs(settingsUi)

const dialog = ref<HTMLElement | null>(null)
const closeButton = ref<HTMLButtonElement | null>(null)
const showDiscardConfirm = ref(false)
let previousFocus: HTMLElement | null = null

const NAV_ITEMS: Array<{
  id: SettingsSection
  label: string
  marker: string
  description: string
}> = [
  { id: 'model', label: '模型', marker: '01', description: '连接与回应方式' },
  { id: 'memory', label: '记忆', marker: '02', description: '记住与淡忘' },
  { id: 'appearance', label: '外观', marker: '03', description: '主题与视觉' },
  { id: 'live2d', label: '角色', marker: '04', description: '形象与在场感' },
  { id: 'security', label: '安全', marker: '05', description: '隐私与诊断' },
  { id: 'about', label: '关于', marker: '06', description: '版本与更新' },
  // C0-5：高级分区仅开发构建进入导航（生产构建 settings-ui 同步拦截 advanced）
  ...(import.meta.env.DEV
    ? [
        {
          id: 'advanced' as const,
          label: '高级',
          // 角色分区插入后编号整体后移；高级仍排在关于（06）之后。
          marker: '07',
          description: '开发者诊断（仅开发构建）'
        }
      ]
    : [])
]

const resolvedSection = computed<SettingsSection>(() =>
  activeSection.value === 'advanced' && !import.meta.env.DEV ? 'appearance' : activeSection.value
)
const currentNav = computed(
  () => NAV_ITEMS.find((item) => item.id === resolvedSection.value) ?? NAV_ITEMS[2]
)

function requestClose(): void {
  if (configStore.isDirty) {
    showDiscardConfirm.value = true
    return
  }
  settingsUi.close()
}

function discardAndClose(): void {
  configStore.discard()
  showDiscardConfirm.value = false
  settingsUi.close()
}

function keepEditing(): void {
  showDiscardConfirm.value = false
  void nextTick(() => closeButton.value?.focus())
}

function onBackdropClick(event: MouseEvent): void {
  if (event.target === event.currentTarget) requestClose()
}

function focusableElements(): HTMLElement[] {
  if (!dialog.value) return []
  return Array.from(
    dialog.value.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
    )
  )
}

function onKeydown(event: KeyboardEvent): void {
  if (!isOpen.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    if (showDiscardConfirm.value) keepEditing()
    else requestClose()
    return
  }
  if (event.key !== 'Tab') return

  const focusable = focusableElements()
  if (focusable.length === 0) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

watch(isOpen, async (open) => {
  if (open) {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    document.addEventListener('keydown', onKeydown)
    await nextTick()
    closeButton.value?.focus()
  } else {
    document.removeEventListener('keydown', onKeydown)
    showDiscardConfirm.value = false
    previousFocus?.focus()
    previousFocus = null
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="settings-fade">
      <div v-if="isOpen" class="settings-backdrop" @mousedown="onBackdropClick">
        <section
          ref="dialog"
          class="settings-drawer"
          role="dialog"
          aria-modal="true"
          aria-labelledby="settings-title"
        >
          <aside class="settings-rail">
            <header class="rail-brand">
              <span class="brand-seal" aria-hidden="true">N</span>
              <span>
                <strong id="settings-title">Nacime</strong>
                <small>PERSONAL SPACE</small>
              </span>
            </header>

            <nav class="settings-nav" aria-label="设置分类">
              <button
                v-for="item in NAV_ITEMS"
                :key="item.id"
                class="nav-item"
                :class="{ active: activeSection === item.id }"
                :aria-current="activeSection === item.id ? 'page' : undefined"
                @click="settingsUi.navigate(item.id)"
              >
                <span class="nav-marker">{{ item.marker }}</span>
                <span class="nav-copy">
                  <strong>{{ item.label }}</strong>
                  <small>{{ item.description }}</small>
                </span>
                <span class="nav-arrow" aria-hidden="true">›</span>
              </button>
            </nav>

            <footer class="rail-footer">
              <span class="privacy-dot" aria-hidden="true"></span>
              <span>设置保存在本机</span>
            </footer>
          </aside>

          <main class="settings-main">
            <header class="drawer-header">
              <div>
                <span>{{ currentNav.marker }}</span>
                <strong>{{ currentNav.label }}</strong>
              </div>
              <button
                ref="closeButton"
                class="close-btn"
                aria-label="关闭设置"
                title="关闭设置"
                @click="requestClose"
              >
                <span aria-hidden="true">×</span>
              </button>
            </header>

            <div class="settings-scroll">
              <ModelSettingsSection v-if="resolvedSection === 'model'" />
              <MemorySettingsSection v-else-if="resolvedSection === 'memory'" />
              <AppearanceSection v-else-if="resolvedSection === 'appearance'" />
              <Live2dSettingsSection v-else-if="resolvedSection === 'live2d'" />
              <AboutSection v-else-if="resolvedSection === 'about'" />
              <AdvancedSection v-else-if="resolvedSection === 'advanced'" />
              <SecuritySettingsSection v-else />
            </div>
          </main>

          <Transition name="confirm-rise">
            <div
              v-if="showDiscardConfirm"
              class="discard-layer"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="discard-title"
            >
              <div class="discard-card">
                <span class="discard-mark" aria-hidden="true">!</span>
                <div>
                  <p class="discard-kicker">UNSAVED CHANGES</p>
                  <h2 id="discard-title">要放下这次修改吗？</h2>
                  <p>
                    尚未保存的配置会恢复到上一次状态。主题选择通常会即时保存，因此这里只保护其他草稿。
                  </p>
                </div>
                <div class="discard-actions">
                  <button class="keep-btn" @click="keepEditing">继续编辑</button>
                  <button class="discard-btn" @click="discardAndClose">放弃修改</button>
                </div>
              </div>
            </div>
          </Transition>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.settings-backdrop {
  position: fixed;
  z-index: 900;
  inset: 0;
  display: flex;
  align-items: stretch;
  justify-content: flex-end;
  padding: 14px;
  background: color-mix(in srgb, var(--color-bg) 34%, rgba(8, 10, 16, 0.58));
  backdrop-filter: blur(10px) saturate(92%);
}

.settings-drawer {
  position: relative;
  display: grid;
  width: min(920px, calc(100vw - 28px));
  height: calc(100vh - 28px);
  grid-template-columns: 224px minmax(0, 1fr);
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--color-border) 86%, transparent);
  border-radius: 26px 26px 26px 10px;
  background: var(--color-surface-elevated);
  box-shadow: var(--shadow-drawer);
}

.settings-rail {
  position: relative;
  display: flex;
  min-width: 0;
  flex-direction: column;
  padding: 22px 13px 16px;
  overflow: hidden;
  border-right: 1px solid var(--color-border-subtle);
  background:
    radial-gradient(circle at 0 0, var(--color-companion-soft), transparent 38%),
    linear-gradient(180deg, var(--color-bg-tertiary), var(--color-surface));
}

.settings-rail::after {
  position: absolute;
  right: -78px;
  bottom: -90px;
  width: 210px;
  height: 210px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 50%;
  content: '';
  opacity: 0.58;
}

.rail-brand {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 7px 22px;
}

.brand-seal {
  display: grid;
  width: 40px;
  height: 40px;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--color-companion) 35%, var(--color-border));
  border-radius: 50% 50% 50% 11px;
  background: var(--color-surface-elevated);
  box-shadow: var(--shadow-sm);
  color: var(--color-companion);
  font-family: var(--font-family-display);
  font-size: 20px;
  font-weight: 600;
}

.rail-brand > span:last-child {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.rail-brand strong {
  color: var(--color-text);
  font-family: var(--font-family-display);
  font-size: 17px;
  font-weight: 600;
}

.rail-brand small {
  color: var(--color-text-tertiary);
  font-size: 8px;
  font-weight: 750;
  letter-spacing: 0.16em;
}

.settings-nav {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.nav-item {
  display: grid;
  min-height: 54px;
  grid-template-columns: 24px 1fr auto;
  align-items: center;
  gap: 8px;
  padding: 8px 9px;
  border: 1px solid transparent;
  border-radius: 13px 13px 13px 4px;
  color: var(--color-text-muted);
  text-align: left;
}

.nav-item:hover {
  border-color: var(--color-border-subtle);
  background: color-mix(in srgb, var(--color-surface-elevated) 66%, transparent);
  color: var(--color-text);
}

.nav-item.active {
  border-color: color-mix(in srgb, var(--color-accent) 28%, var(--color-border));
  background: var(--color-surface-elevated);
  box-shadow: var(--shadow-sm);
  color: var(--color-text);
}

.nav-marker {
  color: var(--color-text-tertiary);
  font-family: var(--font-family-display);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.nav-item.active .nav-marker,
.nav-item.active .nav-arrow {
  color: var(--color-accent);
}

.nav-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 1px;
}

.nav-copy strong {
  font-size: var(--font-size-sm);
  font-weight: 650;
}

.nav-copy small {
  overflow: hidden;
  color: var(--color-text-tertiary);
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nav-arrow {
  font-size: 18px;
}

.rail-footer {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: auto;
  padding: 12px 7px 0;
  color: var(--color-text-tertiary);
  font-size: 9px;
}

.privacy-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-success);
  box-shadow: 0 0 0 4px var(--color-success-bg);
}

.settings-main {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  background:
    radial-gradient(circle at 100% 0, var(--color-accent-soft), transparent 29%),
    var(--color-bg-secondary);
}

.drawer-header {
  display: flex;
  min-height: 64px;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  padding: 11px 17px 10px 24px;
  border-bottom: 1px solid var(--color-border-subtle);
  background: color-mix(in srgb, var(--color-surface-translucent) 84%, transparent);
  backdrop-filter: blur(18px);
}

.drawer-header > div {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.drawer-header > div span {
  color: var(--color-text-tertiary);
  font-family: var(--font-family-display);
  font-size: 10px;
}

.drawer-header > div strong {
  color: var(--color-text);
  font-size: var(--font-size-sm);
  font-weight: 650;
  letter-spacing: 0.04em;
}

.close-btn {
  display: grid;
  width: 38px;
  height: 38px;
  place-items: center;
  border: 1px solid var(--color-border-subtle);
  border-radius: 50%;
  background: var(--color-surface-elevated);
  color: var(--color-text-muted);
  font-family: var(--font-family-display);
  font-size: 25px;
  line-height: 1;
}

.close-btn:hover {
  border-color: var(--color-border);
  color: var(--color-text);
  transform: rotate(4deg);
}

.settings-scroll {
  min-height: 0;
  flex: 1;
  padding: clamp(24px, 4vw, 46px);
  overflow-y: auto;
}

.discard-layer {
  position: absolute;
  z-index: 10;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 20px;
  background: color-mix(in srgb, var(--color-bg) 38%, rgba(10, 12, 18, 0.6));
  backdrop-filter: blur(9px);
}

.discard-card {
  display: grid;
  width: min(100%, 460px);
  grid-template-columns: auto 1fr;
  gap: 15px;
  padding: 23px;
  border: 1px solid var(--color-warning-border);
  border-radius: var(--radius-xl);
  background: var(--color-surface-elevated);
  box-shadow: var(--shadow-lg);
}

.discard-mark {
  display: grid;
  width: 38px;
  height: 38px;
  place-items: center;
  border: 1px solid var(--color-warning-border);
  border-radius: 50%;
  background: var(--color-warning-bg);
  color: var(--color-warning);
  font-family: var(--font-family-display);
  font-size: 20px;
}

.discard-kicker {
  color: var(--color-warning);
  font-size: 8px;
  font-weight: 800;
  letter-spacing: 0.16em;
}

.discard-card h2 {
  margin-top: 5px;
  color: var(--color-text);
  font-family: var(--font-family-display);
  font-size: 24px;
  font-weight: 560;
}

.discard-card p:not(.discard-kicker) {
  margin-top: 8px;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.65;
}

.discard-actions {
  display: flex;
  grid-column: 1 / -1;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 5px;
}

.keep-btn,
.discard-btn {
  min-height: 40px;
  padding: 8px 15px;
  border-radius: var(--radius-full);
  font-weight: 650;
}

.keep-btn {
  border: 1px solid var(--color-border);
  background: var(--color-surface);
}

.discard-btn {
  background: var(--color-error);
  color: var(--color-text-on-accent);
}

.settings-fade-enter-active,
.settings-fade-leave-active {
  transition: opacity 0.24s ease;
}

.settings-fade-enter-active .settings-drawer,
.settings-fade-leave-active .settings-drawer {
  transition:
    transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1),
    opacity 0.24s ease;
}

.settings-fade-enter-from,
.settings-fade-leave-to {
  opacity: 0;
}

.settings-fade-enter-from .settings-drawer,
.settings-fade-leave-to .settings-drawer {
  opacity: 0;
  transform: translateX(36px) scale(0.985);
}

.confirm-rise-enter-active,
.confirm-rise-leave-active {
  transition: opacity 0.18s ease;
}

.confirm-rise-enter-active .discard-card,
.confirm-rise-leave-active .discard-card {
  transition: transform 0.2s ease;
}

.confirm-rise-enter-from,
.confirm-rise-leave-to {
  opacity: 0;
}

.confirm-rise-enter-from .discard-card,
.confirm-rise-leave-to .discard-card {
  transform: translateY(10px) scale(0.98);
}

@media (min-width: 1440px) {
  .settings-backdrop {
    justify-content: center;
  }

  .settings-drawer {
    width: clamp(1100px, 64vw, 1280px);
    grid-template-columns: 248px minmax(0, 1fr);
    border-radius: 26px;
  }
}

@media (max-width: 700px) {
  .settings-backdrop {
    padding: 0;
  }

  .settings-drawer {
    width: 100%;
    height: 100%;
    grid-template-columns: 72px minmax(0, 1fr);
    border: 0;
    border-radius: 0;
  }

  .settings-rail {
    padding-inline: 8px;
  }

  .rail-brand {
    justify-content: center;
    padding-inline: 0;
  }

  .rail-brand > span:last-child,
  .nav-copy,
  .nav-arrow,
  .rail-footer span:last-child {
    display: none;
  }

  .nav-item {
    min-height: 48px;
    grid-template-columns: 1fr;
    justify-items: center;
    padding: 7px;
  }

  .nav-marker {
    font-size: 11px;
  }

  .rail-footer {
    justify-content: center;
  }

  .settings-scroll {
    padding: 20px 15px 32px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .settings-fade-enter-active,
  .settings-fade-leave-active,
  .settings-fade-enter-active .settings-drawer,
  .settings-fade-leave-active .settings-drawer,
  .confirm-rise-enter-active,
  .confirm-rise-leave-active,
  .confirm-rise-enter-active .discard-card,
  .confirm-rise-leave-active .discard-card {
    transition: none;
  }
}
</style>
