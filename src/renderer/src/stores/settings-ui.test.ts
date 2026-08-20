// @vitest-environment jsdom
// P2-46: settingsUi 只管理抽屉开关与 section，不承担配置持久化。

import { beforeEach, describe, expect, it } from 'vitest'
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

  it('冻结合同中的 advanced 在无真实页面时回退到 appearance', () => {
    const store = useSettingsUiStore()
    store.open('advanced')
    expect(store.isOpen).toBe(true)
    expect(store.activeSection).toBe('appearance')

    store.navigate('advanced')
    expect(store.activeSection).toBe('appearance')
  })
})
