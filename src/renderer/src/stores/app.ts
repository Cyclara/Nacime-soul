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

/** transient 错误条目（带稳定 id，供实例级关闭与 :key） */
export interface TransientErrorEntry {
  id: number
  error: PublicAppError
}

export interface AppState {
  bootStage: BootStage
  appVersion: string | null
  fatalError: PublicAppError | null
  transientErrors: TransientErrorEntry[]
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

  // M-32：transient 错误 6s 后自动消失（此前只进不出、长会话越堆越多）；上限 5 条。
  const TRANSIENT_MAX = 5
  const TRANSIENT_TTL_MS = 6000
  let nextErrorId = 1
  const transientTimers = new Map<number, ReturnType<typeof setTimeout>>()

  function reportError(error: PublicAppError): void {
    if (error.severity === 'fatal') {
      state.fatalError = error
      state.bootStage = 'blocked'
    } else {
      const entry: TransientErrorEntry = { id: nextErrorId++, error }
      state.transientErrors.push(entry)
      while (state.transientErrors.length > TRANSIENT_MAX) {
        const oldest = state.transientErrors.shift()
        if (oldest) {
          const t = transientTimers.get(oldest.id)
          if (t) clearTimeout(t)
          transientTimers.delete(oldest.id)
        }
      }
      const timer = setTimeout(() => {
        transientTimers.delete(entry.id)
        state.transientErrors = state.transientErrors.filter((e) => e.id !== entry.id)
      }, TRANSIENT_TTL_MS)
      transientTimers.set(entry.id, timer)
    }
  }

  function dismissError(id: number): void {
    const timer = transientTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      transientTimers.delete(id)
    }
    state.transientErrors = state.transientErrors.filter((e) => e.id !== id)
  }

  function clearTransientErrors(): void {
    for (const t of transientTimers.values()) clearTimeout(t)
    transientTimers.clear()
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

  // C-β：store 实例内只允许一组 app listener。旧 teardown 不能误拆新订阅。
  let currentSubscription: Unsubscribe | null = null

  function subscribe(): Unsubscribe {
    currentSubscription?.()

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

    let disposed = false
    const teardown: Unsubscribe = () => {
      if (disposed) return
      disposed = true
      for (const unsub of unsubs) unsub()
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      if (currentSubscription === teardown) currentSubscription = null
    }
    currentSubscription = teardown
    return teardown
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
