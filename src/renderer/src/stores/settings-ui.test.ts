// @vitest-environment jsdom
// P2-46: settingsUi 只管理抽屉开关与 section，不承担配置持久化。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSettingsUiStore } from './settings-ui'

describe('settingsUi store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('默认关闭并以 appearance 作为首选 section', () => {
    const store = useSettingsUiStore()
    expect(store.isOpen).toBe(false)
    expect(store.activeSection).toBe('appearance')
  })

  it('open/navigate/close 只更新 UI 状态', () => {
    const store = useSettingsUiStore()
    store.open('memory')
    expect(store.isOpen).toBe(true)
    expect(store.activeSection).toBe('memory')

    store.navigate('security')
    expect(store.activeSection).toBe('security')

    store.close()
    expect(store.isOpen).toBe(false)
    expect(store.activeSection).toBe('security')
  })

  it('C0-5：开发构建 advanced 可进入；生产构建回退 appearance', () => {
    // 测试环境 import.meta.env.DEV === true，等价开发构建：advanced 有真实页面（F5-001 C0-5）
    const store = useSettingsUiStore()
    store.open('advanced')
    expect(store.isOpen).toBe(true)
    expect(store.activeSection).toBe('advanced')

    // 生产构建行为：DEV=false 时 advanced 仍回退 appearance（普通用户不可见合规审查入口）
    vi.stubEnv('DEV', false)
    try {
      store.navigate('advanced')
      expect(store.activeSection).toBe('appearance')
      store.close()
      store.open('advanced')
      expect(store.activeSection).toBe('appearance')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
