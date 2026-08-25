// @vitest-environment jsdom
// M-51 回归：设置抽屉打开时，快捷键不改配置，但必须阻断 Electron 原生缩放。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useSettingsUiStore } from '../../stores/settings-ui'
import ZoomOverlay from './ZoomOverlay.vue'

describe('M-51: ZoomOverlay 设置抽屉守卫', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useSettingsUiStore().open('appearance')
    wrapper = mount(ZoomOverlay, { global: { plugins: [pinia] } })
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it('阻断 Ctrl+滚轮与 Ctrl+±0 的原生缩放，但不吞掉其他 Ctrl 快捷键', () => {
    const wheel = new WheelEvent('wheel', {
      ctrlKey: true,
      deltaY: -100,
      bubbles: true,
      cancelable: true
    })
    const reset = new KeyboardEvent('keydown', {
      ctrlKey: true,
      key: '0',
      bubbles: true,
      cancelable: true
    })
    const unrelated = new KeyboardEvent('keydown', {
      ctrlKey: true,
      key: 'k',
      bubbles: true,
      cancelable: true
    })

    expect(window.dispatchEvent(wheel)).toBe(false)
    expect(wheel.defaultPrevented).toBe(true)
    expect(window.dispatchEvent(reset)).toBe(false)
    expect(reset.defaultPrevented).toBe(true)
    expect(window.dispatchEvent(unrelated)).toBe(true)
    expect(unrelated.defaultPrevented).toBe(false)
  })
})
