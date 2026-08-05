<script setup lang="ts">
// P1-24/P2-31/C-β: App 根组件
// 依据：S-001 P1-24、S-006 §1.2、S-002-补充-bootstrap生命周期
// 职责：RouterView + DebugPanel + 应用级 bootstrap/teardown + 主题应用

import { onMounted, onUnmounted, watch } from 'vue'
import { useAppStore } from './stores/app'
import { useConfigStore } from './stores/config'
import { bootstrapApp } from './orchestrators/bootstrap'
import type { Unsubscribe } from '@shared/ipc/contracts'
import DebugPanel from './components/debug/DebugPanel.vue'

const appStore = useAppStore()
const configStore = useConfigStore()

let bootstrapTeardown: Unsubscribe | null = null
let bootstrapInFlight = false
let bootstrapAttempt = 0
let isMounted = false
let colorSchemeMedia: MediaQueryList | null = null

function applyTheme(theme: 'system' | 'light' | 'dark' | undefined): void {
  const root = document.documentElement
  if (theme === 'light') {
    root.dataset.theme = 'light'
  } else if (theme === 'dark' || theme === undefined) {
    // config 加载前默认暗色，避免闪白
    root.dataset.theme = 'dark'
  } else {
    // system
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    root.dataset.theme = prefersDark ? 'dark' : 'light'
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
  <RouterView />
  <DebugPanel />
</template>
