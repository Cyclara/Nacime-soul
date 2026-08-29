// @vitest-environment jsdom
// src/renderer/src/components/live2d/Live2dPreviewControls.test.ts
// P3A-25：预览控件只发 UI intent；缩放/置顶由 orchestrator 单写 config。

import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it, vi } from 'vitest'
import type { Live2dSettingsOrchestrator } from '../../orchestrators/live2d-settings'
import { useLive2dStore } from '../../stores/live2d'
import Live2dPreviewControls from './Live2dPreviewControls.vue'

function createHarness(options?: { readonly saveFails?: boolean }): {
  wrapper: ReturnType<typeof mount>
  orchestrator: Live2dSettingsOrchestrator
  resetWindowPlacement: ReturnType<typeof vi.spyOn>
} {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useLive2dStore(pinia)
  store.state.window = {
    visible: true,
    alwaysOnTop: true,
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
    stageStatus: 'ready'
  }
  store.state.loadedModelId = 'mao'
  const resetWindowPlacement = vi.spyOn(store, 'resetWindowPlacement').mockResolvedValue()
  const orchestrator: Live2dSettingsOrchestrator = {
    patchZoom: vi.fn(),
    patchOffset: vi.fn(),
    patchAlwaysOnTop: vi.fn(),
    applyFraming: vi.fn(),
    resetFraming: vi.fn(),
    endPreview: vi.fn(),
    saveAndApply: options?.saveFails
      ? vi.fn(async () => {
          throw new Error('save failed')
        })
      : vi.fn(async () => {}),
    discard: vi.fn()
  }
  const wrapper = mount(Live2dPreviewControls, {
    props: { orchestrator },
    global: { plugins: [pinia] }
  })
  return { wrapper, orchestrator, resetWindowPlacement }
}

describe('P3A-25 Live2dPreviewControls', () => {
  it('缩放、置顶和重置只发给既定边界，并展示可拖动提示', async () => {
    const harness = createHarness()
    const ranges = harness.wrapper.findAll('input[type="range"]')
    const checkbox = harness.wrapper.get('input[type="checkbox"]')

    expect(ranges[0]!.attributes()).toMatchObject({ min: '0.25', max: '3', step: '0.05' })
    expect(harness.wrapper.text()).toContain('拖住她即可移动窗口')

    await ranges[0]!.setValue('1.5')
    await checkbox.setValue(false)
    await harness.wrapper.get('.control--quiet').trigger('click')
    await harness.wrapper.get('.save-settings').trigger('click')

    expect(harness.orchestrator.patchZoom).toHaveBeenCalledWith(1.5)
    expect(harness.orchestrator.patchAlwaysOnTop).toHaveBeenCalledWith(false)
    expect(harness.resetWindowPlacement).toHaveBeenCalledTimes(1)
    expect(harness.orchestrator.saveAndApply).toHaveBeenCalledTimes(1)
  })

  it('左右/上下滑块按 -100..100 发出取景偏移，预设按钮一次切半身或全身', async () => {
    const harness = createHarness()
    const ranges = harness.wrapper.findAll('input[type="range"]')
    expect(ranges).toHaveLength(3)
    expect(ranges[1]!.attributes()).toMatchObject({ min: '-100', max: '100', step: '1' })
    expect(ranges[2]!.attributes()).toMatchObject({ min: '-100', max: '100', step: '1' })

    await ranges[1]!.setValue('-30')
    await ranges[2]!.setValue('45')
    expect(harness.orchestrator.patchOffset).toHaveBeenNthCalledWith(1, -30, 0)
    expect(harness.orchestrator.patchOffset).toHaveBeenNthCalledWith(2, -30, 45)

    const presets = harness.wrapper.findAll('.framing__preset')
    expect(presets.map((button) => button.text())).toEqual(['半身', '全身'])
    await presets[1]!.trigger('click')
    expect(harness.orchestrator.applyFraming).toHaveBeenCalledWith('full-body')
    // 预设点完滑块要跟着跳到预设值，否则用户看到的数字与实际构图不一致。
    expect(harness.wrapper.findAll<HTMLInputElement>('input[type="range"]')[2]!.element.value).toBe(
      '50'
    )
  })

  it('保存失败时显示恢复文案，不伪造成功状态', async () => {
    const harness = createHarness({ saveFails: true })

    await harness.wrapper.get('.save-settings').trigger('click')
    await Promise.resolve()

    expect(harness.wrapper.get('[role="alert"]').text()).toContain('设置没有保存')
  })
})
