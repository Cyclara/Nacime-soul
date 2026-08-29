// @vitest-environment jsdom
// src/renderer/src/live2d/Live2dErrorOverlay.test.ts
// P3A-26/27：七类公开错误码都有可见安全反馈，且只出现固定码/文案。

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import Live2dErrorOverlay from './Live2dErrorOverlay.vue'
import { LIVE2D_LOAD_ERROR_CODES } from '@shared/live2d/types'

describe('P3A-26 Live2dErrorOverlay', () => {
  it('七个错误码都有文案与恢复按钮，不渲染 stack/path', async () => {
    for (const code of LIVE2D_LOAD_ERROR_CODES) {
      const wrapper = mount(Live2dErrorOverlay, { props: { code } })
      expect(wrapper.get('[role="alert"]').text()).toContain(code)
      expect(wrapper.get('button').text()).toContain('再试一次')
      expect(wrapper.text()).not.toContain('C:\\Users')
      expect(wrapper.text()).not.toContain('/home/')
      await wrapper.get('button').trigger('click')
      expect(wrapper.emitted('retry')).toHaveLength(1)
    }
  })

  // P3A-26 的第二条恢复入口：遮罩出现时降级链已耗尽，「切默认」无意义，「打开模型管理」
  // 又需要扩大 stage 能力面；因此每个错误码都必须给出一条可执行的去处，而不是只留重试。
  it('七个错误码各有可执行的去处；显卡类错误指向驱动而非换模型入口', () => {
    for (const code of LIVE2D_LOAD_ERROR_CODES) {
      const hint = mount(Live2dErrorOverlay, { props: { code } }).get('.error-overlay__hint').text()
      expect(hint).toMatch(/设置 → 角色|显卡驱动/)
    }
    const webgl = mount(Live2dErrorOverlay, { props: { code: 'WEBGL_UNSUPPORTED' } })
    expect(webgl.get('.error-overlay__hint').text()).toContain('显卡驱动')
    expect(webgl.get('.error-overlay__hint').text()).not.toContain('设置 → 角色')

    // 未知/空错误码也不能变成死路一条。
    expect(
      mount(Live2dErrorOverlay, { props: { code: null } })
        .get('.error-overlay__hint')
        .text()
    ).toContain('设置 → 角色')
  })
})
