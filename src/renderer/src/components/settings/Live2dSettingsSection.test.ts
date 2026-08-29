// @vitest-environment jsdom
// src/renderer/src/components/settings/Live2dSettingsSection.test.ts

import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import Live2dSettingsSection from './Live2dSettingsSection.vue'
import { useLive2dStore } from '../../stores/live2d'

vi.mock('../live2d/CurrentModelCard.vue', () => ({ default: { template: '<div data-test="current" />' } }))
vi.mock('../live2d/Live2dPreviewControls.vue', () => ({ default: { template: '<div data-test="controls" />' } }))
vi.mock('../live2d/ModelList.vue', () => ({ default: { template: '<div data-test="list" />' } }))
vi.mock('../live2d/ModelImportDropzone.vue', () => ({ default: { template: '<div data-test="dropzone" />' } }))
vi.mock('../live2d/ModelValidationResult.vue', () => ({ default: { template: '<div data-test="validation" />' } }))

describe('P3A-24 Live2dSettingsSection', () => {
  it('挂载时 hydrate 并订阅 main state，渲染功能子区', async () => {
    Object.defineProperty(window, 'companion', { value: { live2d: {
      getState: vi.fn(async () => ({ ok: true as const, data: {
        models: [], selectedModelId: null, loadedModelId: null,
        window: { visible: false, alwaysOnTop: true, zoom: 1, stageStatus: 'closed' as const },
        loading: false, lastError: null, revision: 0, lastEventSequence: 0
      } })),
      setVisible: vi.fn(), chooseImportSource: vi.fn(), selectModel: vi.fn(),
      resetWindowPlacement: vi.fn(), retryLoad: vi.fn(), onState: vi.fn(() => () => {})
    } }, configurable: true })
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useLive2dStore(pinia)
    const hydrate = vi.spyOn(store, 'hydrate')
    const subscribe = vi.spyOn(store, 'subscribe')
    const wrapper = mount(Live2dSettingsSection, { global: { plugins: [pinia] } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(hydrate).toHaveBeenCalled()
    expect(subscribe).toHaveBeenCalled()
    expect(wrapper.find('[data-test="current"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="controls"]').exists()).toBe(true)
  })
})
