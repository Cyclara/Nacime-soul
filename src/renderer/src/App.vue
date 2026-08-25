<script setup lang="ts">
// P1-24/P2-31/C-β: App 根组件
// 依据：S-001 P1-24、S-006 §1.2、S-002-补充-bootstrap生命周期
// 职责：RouterView + DebugPanel + 应用级 bootstrap/teardown + 主题应用

import { onMounted, onUnmounted, watch } from 'vue'
import { useAppStore } from './stores/app'
import { useConfigStore } from './stores/config'
import { bootstrapApp } from './orchestrators/bootstrap'
import type { Unsubscribe } from '@shared/ipc/contracts'
import type { ThemeSetting } from '@shared/config/themes'
import { isThemeId } from '@shared/config/themes'
import DebugPanel from './components/debug/DebugPanel.vue'
import SettingsDrawer from './components/settings/SettingsDrawer.vue'
import AppErrorBanner from './components/common/AppErrorBanner.vue'
import AppContextMenu from './components/common/AppContextMenu.vue'
import UpdateToast from './components/common/UpdateToast.vue'
import ZoomOverlay from './components/common/ZoomOverlay.vue'

const appStore = useAppStore()
const configStore = useConfigStore()
const isAutomatedTest = window.location.search.includes('automation-test=1')

let bootstrapTeardown: Unsubscribe | null = null
let bootstrapInFlight = false
let bootstrapAttempt = 0
let isMounted = false
let colorSchemeMedia: MediaQueryList | null = null

/**
 * 应用主题：把配置值映射到 documentElement.dataset.theme。
 * 主题注册表在 @shared/config/themes（THEME_IDS）——新增主题只需注册表加 id + CSS 加一块。
 * - 已知主题（light/dark/…）-> 直接设置
 * - 'system' -> 跟随 OS prefers-color-scheme
 * - undefined/未知 -> 默认浅色（config 加载前避免闪黑）
 */
function applyTheme(theme: ThemeSetting | undefined): void {
  const root = document.documentElement
  if (theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    root.dataset.theme = prefersDark ? 'dark' : 'light'
  } else if (theme !== undefined && isThemeId(theme)) {
    root.dataset.theme = theme
  } else {
    root.dataset.theme = 'light'
  }
}

function onColorSchemeChange(): void {
  if (configStore.state.draft?.ui.theme === 'system') {
    applyTheme('system')
  }
}

async function runBootstrap(): Promise<void> {
  if (bootstrapInFlight) return
  bootstrapInFlight = true
  const attempt = ++bootstrapAttempt
  bootstrapTeardown?.()
  bootstrapTeardown = null

  try {
    const teardown = await bootstrapApp()
    // HMR/根卸载或更新尝试已取代本次结果：立即释放，不能把 listener 留在旧 scope。
    if (!isMounted || attempt !== bootstrapAttempt) {
      teardown()
      return
    }
    bootstrapTeardown = teardown
  } finally {
    if (attempt === bootstrapAttempt) bootstrapInFlight = false
  }
}

watch(
  () => configStore.state.draft?.ui.theme,
  (theme) => {
    applyTheme(theme)
  },
  { immediate: true }
)

// 启动失败后，ChatView 的“重试”会把 blocked reset 为 idle；App 仍是唯一重试所有者。
watch(
  () => appStore.state.bootStage,
  (stage, previous) => {
    if (isMounted && previous === 'blocked' && stage === 'idle') {
      void runBootstrap()
    }
  }
)

onMounted(() => {
  isMounted = true
  colorSchemeMedia = window.matchMedia('(prefers-color-scheme: dark)')
  colorSchemeMedia.addEventListener('change', onColorSchemeChange)
  void runBootstrap()
})

onUnmounted(() => {
  isMounted = false
  bootstrapAttempt++
  bootstrapInFlight = false
  bootstrapTeardown?.()
  bootstrapTeardown = null
  colorSchemeMedia?.removeEventListener('change', onColorSchemeChange)
  colorSchemeMedia = null
})
</script>

<template>
  <div v-if="isAutomatedTest" class="automation-test-banner" role="status">
    自动化测试窗口 · 使用临时虚构数据 · 不写入正式资料
  </div>
  <!-- M-32：错误横幅提升到根组件，所有路由（聊天/记忆/成长/DMAE）都能看到全局错误 -->
  <AppErrorBanner />
  <RouterView />
  <SettingsDrawer />
  <DebugPanel />
  <!-- 验收反馈⑤：主题化右键菜单（替代 M-38 原生菜单） -->
  <AppContextMenu />
  <!-- M-50：更新提示（右下角；store init/dispose 由组件自持） -->
  <UpdateToast />
  <!-- M-51：UI 缩放 pill + Ctrl+滚轮/±0 快捷键（监听器由组件自持） -->
  <ZoomOverlay />
</template>

<style scoped>
.automation-test-banner {
  position: fixed;
  z-index: 1200;
  top: 8px;
  left: 50%;
  padding: 6px 13px;
  border: 1px solid var(--color-warning-border);
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--color-warning-bg) 88%, var(--color-surface-elevated));
  box-shadow: var(--shadow-md);
  color: var(--color-warning);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.03em;
  pointer-events: none;
  transform: translateX(-50%);
}
</style>
