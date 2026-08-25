// @vitest-environment jsdom
// M-50 回归：#app 使用 isolation:isolate，更新提示必须 Teleport 到 body 才能盖过设置抽屉。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import UpdateToast from './UpdateToast.vue'

describe('M-50: UpdateToast 层级', () => {
  let wrapper: VueWrapper | null = null
  let appHost: HTMLDivElement

  beforeEach(() => {
    const pinia = createPinia()
    setActivePinia(pinia)
    window.localStorage.clear()
    appHost = document.createElement('div')
    appHost.id = 'app'
    document.body.appendChild(appHost)
    Object.defineProperty(window, 'companion', {
      value: {
        app: {
          getUpdateStatus: vi.fn(async () => ({
            ok: true,
            data: {
              state: 'error',
              message: '当前环境不支持自动更新（开发环境或未打包）',
              userInitiated: true
            }
          })),
          onUpdateStatus: vi.fn(() => vi.fn()),
          checkForUpdates: vi.fn(),
          quitAndInstall: vi.fn()
        }
      },
      writable: true,
      configurable: true
    })
    wrapper = mount(UpdateToast, {
      attachTo: appHost,
      global: { plugins: [pinia] }
    })
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    appHost.remove()
  })

  it('把可见 toast 直接挂到 body，而不是困在 #app stacking context', async () => {
    await flushPromises()

    const toast = document.body.querySelector('.update-toast')
    expect(toast).not.toBeNull()
    expect(document.body.contains(toast)).toBe(true)
    expect(appHost.contains(toast)).toBe(false)
    expect(toast?.closest('#app')).toBeNull()
    expect(toast?.textContent).toContain('更新检查未完成')
  })
})
