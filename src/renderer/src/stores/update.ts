// src/renderer/src/stores/update.ts
// M-50: 更新状态 store——main Updater 状态机的 renderer 镜像 + toast 可见性决策。
// 依据：台账 §4.3 新增通道的消费侧；S-002 §3.4（UI 状态与持久化分离：
//   状态在内存 + dismissal 在 localStorage，均不进 config）。

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { UpdateStatus } from '@shared/update/types'
import type { Unsubscribe } from '@shared/ipc/contracts'

/** 按版本记住「暂不更新」：同一个版本关掉 toast 后本次不再弹，换版本自动复位 */
const DISMISSED_KEY = 'nacime.update.dismissedVersion'

export const useUpdateStore = defineStore('update', () => {
  const status = ref<UpdateStatus>({ state: 'idle' })
  const dismissedVersion = ref<string | null>(null)
  let unsubscribe: Unsubscribe | null = null
  let initialized = false

  try {
    dismissedVersion.value = window.localStorage.getItem(DISMISSED_KEY)
  } catch {
    /* localStorage 不可用（隐私模式等）时 dismissal 退化为会话级 */
  }

  /**
   * 启动补水 + 订阅。由 UpdateToast onMounted 调用（组件常驻 App 根）。
   * 防御：preload API 缺失/调用失败时保持 idle，绝不让更新检查拖垮启动链。
   */
  async function init(): Promise<void> {
    if (initialized) return
    initialized = true
    if (!window.companion?.app?.getUpdateStatus) return
    try {
      const result = await window.companion.app.getUpdateStatus()
      if (result.ok) status.value = result.data
      unsubscribe = window.companion.app.onUpdateStatus((next) => {
        status.value = next
      })
    } catch {
      unsubscribe = null
    }
  }

  function dispose(): void {
    unsubscribe?.()
    unsubscribe = null
    initialized = false
  }

  /** 设置页「检查更新」：结果经事件回流到 status，这里只负责触发 */
  async function checkNow(): Promise<void> {
    if (!window.companion?.app?.checkForUpdates) return
    await window.companion.app.checkForUpdates()
  }

  /** toast「立即更新」：仅 downloaded 态在 UI 上出现该按钮 */
  async function install(): Promise<void> {
    if (!window.companion?.app?.quitAndInstall) return
    await window.companion.app.quitAndInstall()
  }

  function dismiss(version: string): void {
    dismissedVersion.value = version
    try {
      window.localStorage.setItem(DISMISSED_KEY, version)
    } catch {
      /* 同上：退化为会话级 */
    }
  }

  /** toast 是否可见。后台静默态（checking/downloading 非手动）也给一条 slim 进度，但不强制 */
  const toastVisible = computed(() => {
    const s = status.value
    switch (s.state) {
      case 'downloaded':
        return dismissedVersion.value !== s.version
      case 'checking':
      case 'not-available':
      case 'error':
        return s.userInitiated
      case 'available':
      case 'downloading':
        return true
      default:
        return false
    }
  })

  return { status, dismissedVersion, toastVisible, init, dispose, checkNow, install, dismiss }
})
