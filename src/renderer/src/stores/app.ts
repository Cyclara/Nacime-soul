// src/renderer/src/stores/app.ts
// P1-24: app store - 启动门控、全局错误、窗口状态
// 依据：S-002 §3.1、S-001 P1-24
//
// 安全红线：
//   - Store 不直接调用其他 store 的 action（S-002 §3.1 铁律 1）
//   - 跨域流程由 orchestrator 协调
//   - 事件订阅返回幂等 unsubscribe

import { reactive, computed } from 'vue'
import { defineStore } from 'pinia'
import type { PublicAppError } from '@shared/errors'
import type { Unsubscribe } from '@shared/ipc/contracts'

export type BootStage = 'idle' | 'loading-config' | 'registering-events' | 'ready' | 'blocked'

export interface AppState {
  bootStage: BootStage
  appVersion: string | null
  fatalError: PublicAppError | null
  transientErrors: PublicAppError[]
  isWindowMaximized: boolean
  isOnline: boolean
}

export const useAppStore = defineStore('app', () => {
  const state = reactive<AppState>({
    bootStage: 'idle',
    appVersion: null,
    fatalError: null,
    transientErrors: [],
    isWindowMaximized: false,
    isOnline: navigator.onLine
  })

  const isReady = computed(() => state.bootStage === 'ready')
  const isBlocked = computed(() => state.bootStage === 'blocked')

  function setBootStage(stage: BootStage): void {
    state.bootStage = stage
  }

  function setAppVersion(version: string): void {
    state.appVersion = version
  }

  function reportError(error: PublicAppError): void {
    if (error.severity === 'fatal') {
      state.fatalError = error
      state.bootStage = 'blocked'
    } else {
      state.transientErrors.push(error)
    }
  }

  function dismissError(code: string): void {
    state.transientErrors = state.transientErrors.filter((e) => e.code !== code)
  }

  function clearTransientErrors(): void {
    state.transientErrors = []
  }

  function setWindowMaximized(maximized: boolean): void {
    state.isWindowMaximized = maximized
  }

  function setOnline(online: boolean): void {
    state.isOnline = online
  }

  async function refreshWindowState(): Promise<void> {
    if (!window.companion) return
    const result = await window.companion.window.getState()
    if (result.ok) {
      state.isWindowMaximized = result.data.maximized
    }
  }

  function subscribe(): Unsubscribe {
    const unsubs: Unsubscribe[] = []

    if (window.companion) {
      unsubs.push(
        window.companion.app.onError((e) => {
          reportError(e)
        })
      )
      unsubs.push(
        window.companion.window.onState((s) => {
          state.isWindowMaximized = s.maximized
        })
      )
    }

    // 浏览器网络状态
    const onOnline = (): void => setOnline(true)
    const onOffline = (): void => setOnline(false)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)

    return () => {
      for (const unsub of unsubs) unsub()
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }

  function reset(): void {
    state.bootStage = 'idle'
    state.appVersion = null
    state.fatalError = null
    state.transientErrors = []
    state.isWindowMaximized = false
    state.isOnline = navigator.onLine
  }

  return {
    state,
    isReady,
    isBlocked,
    setBootStage,
    setAppVersion,
    reportError,
    dismissError,
    clearTransientErrors,
    setWindowMaximized,
    setOnline,
    refreshWindowState,
    subscribe,
    reset
  }
})
