// @vitest-environment jsdom
// src/renderer/src/stores/update.test.ts
// M-50: update store——补水/订阅/toast 可见性/dismissal/dispose 防御。

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useUpdateStore } from './update'
import type { UpdateStatus } from '@shared/update/types'

type StatusCallback = (status: UpdateStatus) => void

function setupCompanion(opts: { hydrate?: UpdateStatus; hydrateFails?: boolean } = {}): {
  api: {
    app: {
      getUpdateStatus: Mock
      checkForUpdates: Mock
      quitAndInstall: Mock
      onUpdateStatus: Mock
    }
  }
  emit: (status: UpdateStatus) => void
  subscriberCount: () => number
} {
  const subscribers = new Set<StatusCallback>()
  const api = {
    app: {
      getUpdateStatus: vi.fn(async () => {
        if (opts.hydrateFails) throw new Error('ipc down')
        return { ok: true as const, data: opts.hydrate ?? { state: 'idle' } }
      }),
      checkForUpdates: vi.fn(async () => ({ ok: true as const, data: undefined })),
      quitAndInstall: vi.fn(async () => ({ ok: true as const, data: undefined })),
      onUpdateStatus: vi.fn((cb: StatusCallback) => {
        subscribers.add(cb)
        return () => subscribers.delete(cb)
      })
    }
  }
  ;(window as unknown as { companion: unknown }).companion = api
  return {
    api,
    emit(status: UpdateStatus) {
      for (const cb of [...subscribers]) cb(status)
    },
    subscriberCount: () => subscribers.size
  }
}

describe('M-50 update store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    window.localStorage.clear()
  })

  it('init 补水 + 订阅；事件推进状态；dispose 后事件不再生效', async () => {
    const env = setupCompanion({ hydrate: { state: 'available', version: '1.1.0' } })
    const store = useUpdateStore()
    await store.init()

    expect(store.status).toEqual({ state: 'available', version: '1.1.0' })
    expect(env.subscriberCount()).toBe(1)

    env.emit({ state: 'downloaded', version: '1.1.0' })
    expect(store.status.state).toBe('downloaded')

    store.dispose()
    expect(env.subscriberCount()).toBe(0)
    env.emit({ state: 'idle' })
    expect(store.status.state).toBe('downloaded')
  })

  it('toastVisible：downloaded 弹出；dismiss 同版本后不再弹', async () => {
    const env = setupCompanion()
    const store = useUpdateStore()
    await store.init()

    env.emit({ state: 'downloaded', version: '1.1.0' })
    expect(store.toastVisible).toBe(true)

    store.dismiss('1.1.0')
    expect(store.toastVisible).toBe(false)
    expect(window.localStorage.getItem('nacime.update.dismissedVersion')).toBe('1.1.0')

    // 新版本出现 → dismissal 不挡
    env.emit({ state: 'downloaded', version: '1.2.0' })
    expect(store.toastVisible).toBe(true)
  })

  it('toastVisible：手动触发的 checking/not-available/error 才可见', async () => {
    const env = setupCompanion()
    const store = useUpdateStore()
    await store.init()

    env.emit({ state: 'checking', userInitiated: false })
    expect(store.toastVisible).toBe(false)
    env.emit({ state: 'checking', userInitiated: true })
    expect(store.toastVisible).toBe(true)
    env.emit({ state: 'not-available', userInitiated: true })
    expect(store.toastVisible).toBe(true)
    env.emit({ state: 'not-available', userInitiated: false })
    expect(store.toastVisible).toBe(false)
    env.emit({ state: 'error', message: '后台更新检查失败', userInitiated: false })
    expect(store.toastVisible).toBe(false)
    env.emit({ state: 'error', message: '检查更新失败，请确认网络连接后重试', userInitiated: true })
    expect(store.toastVisible).toBe(true)
  })

  it('checkNow/install 走 preload 通道；init 失败与 API 缺失不炸启动链', async () => {
    const env = setupCompanion()
    const store = useUpdateStore()
    await store.init()
    await store.checkNow()
    expect(env.api.app.checkForUpdates).toHaveBeenCalledTimes(1)
    await store.install()
    expect(env.api.app.quitAndInstall).toHaveBeenCalledTimes(1)

    // init 失败（IPC 抛错）→ 保持 idle，不向外抛
    setActivePinia(createPinia())
    setupCompanion({ hydrateFails: true })
    const store2 = useUpdateStore()
    await expect(store2.init()).resolves.toBeUndefined()
    expect(store2.status.state).toBe('idle')

    // preload 整体缺失（极端场景）→ 不抛
    setActivePinia(createPinia())
    ;(window as unknown as { companion: unknown }).companion = undefined
    const store3 = useUpdateStore()
    await expect(store3.init()).resolves.toBeUndefined()
    await expect(store3.checkNow()).resolves.toBeUndefined()
    await expect(store3.install()).resolves.toBeUndefined()
  })
})
