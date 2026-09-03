// @vitest-environment jsdom
// P3V-13/15：首次设置与设置页复用的六模型详细目录。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import type { AsrEngineId, AsrOverview } from '@shared/voice/asr-settings-types'
import { ASR_MODEL_CATALOG } from '@shared/voice/asr-catalog'
import { useVoiceStore } from '../../stores/voice'
import AsrModelCard from './AsrModelCard.vue'

function overview(options?: {
  readonly selected?: AsrEngineId
  readonly fallback?: AsrEngineId | null
  readonly ready?: readonly AsrEngineId[]
}): AsrOverview {
  const selected = options?.selected ?? 'zipformer-bilingual-zh-en'
  const fallback = options?.fallback ?? 'sherpa-sensevoice'
  const ready = new Set(options?.ready ?? [])
  return {
    selectedEngineId: selected,
    fallbackEngineId: fallback,
    engines: ASR_MODEL_CATALOG.map((model) => ({
      engineId: model.engineId,
      label: model.label,
      localOnly: true,
      modelState: ready.has(model.engineId) ? 'ready' : 'not-downloaded',
      downloadBytes: model.downloadBytes,
      selected: model.engineId === selected,
      fallback: model.engineId === fallback
    })),
    vadModel: { state: 'ready' }
  }
}

function findCard(wrapper: VueWrapper, engineId: AsrEngineId): DOMWrapper<Element> {
  const model = ASR_MODEL_CATALOG.find((entry) => entry.engineId === engineId)
  const card = wrapper
    .findAll('article.model-item')
    .find((item) => item.find('h4').text() === model!.label)
  if (card === undefined) throw new Error(`card not found: ${engineId}`)
  return card
}

function buttonByText(
  wrapper: { findAll(selector: string): DOMWrapper<Element>[] },
  text: string
): DOMWrapper<Element> {
  const button = wrapper.findAll('button').find((item) => item.text().includes(text))
  if (button === undefined) throw new Error(`button not found: ${text}`)
  return button
}

let pinia: Pinia

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  Object.defineProperty(window, 'confirm', {
    value: vi.fn(() => true),
    writable: true,
    configurable: true
  })
})

describe('P3V-13 AsrModelCard 详细模型目录', () => {
  it('同一组件渲染六张完整卡、十进制 MB、场景/限制与精确预设总量', () => {
    const voice = useVoiceStore(pinia)
    voice.state.asrOverview = overview()
    const wrapper = mount(AsrModelCard, {
      props: { mode: 'setup' },
      global: { plugins: [pinia] }
    })

    const cards = wrapper.findAll('article.model-item')
    expect(cards).toHaveLength(6)
    for (const model of ASR_MODEL_CATALOG) {
      const card = findCard(wrapper, model.engineId)
      expect(card.text()).toContain(model.label)
      expect(card.text()).toContain('适合：')
      expect(card.text()).toContain(model.scenario)
      expect(card.text()).toContain('限制：')
      expect(card.text()).toContain(model.limitation)
      expect(card.text()).toContain(model.languages.join(' / '))
    }
    expect(findCard(wrapper, 'zipformer-bilingual-zh-en').text()).toContain('357 MB')
    expect(findCard(wrapper, 'zipformer-streaming-zh-14m').text()).toContain('56 MB')
    expect(findCard(wrapper, 'parakeet-tdt-v2').text()).toContain('661 MB')
    expect(wrapper.text()).toContain('520.5 MB')
    expect(wrapper.text()).toContain('56.3 MB')
    expect(wrapper.findAll('[role="radio"]')).toHaveLength(3)
    expect(wrapper.find('[role="radiogroup"]').attributes('aria-label')).toBe('语音识别安装预设')
  })

  it('自定义从当前标准方案继续；可在下载前拟定主要和备用模型', async () => {
    const voice = useVoiceStore(pinia)
    voice.state.asrOverview = overview()
    const wrapper = mount(AsrModelCard, {
      props: { mode: 'setup' },
      global: { plugins: [pinia] }
    })

    await buttonByText(wrapper, '自定义').trigger('click')
    const checks = wrapper.findAll<HTMLInputElement>('input[type="checkbox"]')
    expect(checks).toHaveLength(6)
    expect(checks.filter((check) => check.element.checked)).toHaveLength(2)

    const paraformer = findCard(wrapper, 'paraformer-bilingual-zh-en')
    await paraformer.get('input[type="checkbox"]').setValue(true)
    await buttonByText(paraformer, '设为主要').trigger('click')
    expect(paraformer.text()).toContain('主要模型')

    const funasr = findCard(wrapper, 'funasr-paraformer')
    await funasr.get('input[type="checkbox"]').setValue(true)
    await buttonByText(funasr, '设为备用').trigger('click')
    expect(funasr.text()).toContain('备用模型')

    const events = wrapper.emitted('selectionChange') as unknown[][]
    const latest = events.at(-1)?.[0] as {
      engineIds: AsrEngineId[]
      primaryEngineId: AsrEngineId
      fallbackEngineId: AsrEngineId
    }
    expect(latest.engineIds).toEqual(
      expect.arrayContaining([
        'zipformer-bilingual-zh-en',
        'sherpa-sensevoice',
        'paraformer-bilingual-zh-en',
        'funasr-paraformer'
      ])
    )
    expect(latest.primaryEngineId).toBe('paraformer-bilingual-zh-en')
    expect(latest.fallbackEngineId).toBe('funasr-paraformer')
  })

  it('paused 细节态在卡片显示“已暂停”而不是“下载中”', () => {
    const voice = useVoiceStore(pinia)
    const paused = overview()
    const engines = paused.engines.map((engine) =>
      engine.engineId === 'zipformer-bilingual-zh-en'
        ? {
            ...engine,
            modelState: 'downloading' as const,
            progressRatio: 0.4,
            download: {
              assetId: engine.engineId,
              state: 'paused' as const,
              receivedBytes: 40,
              totalBytes: 100,
              currentFile: 'encoder.onnx',
              phase: 'receiving' as const,
              speedBytesPerSec: 0,
              resumable: true
            }
          }
        : engine
    )
    voice.state.asrOverview = { ...paused, engines }
    const wrapper = mount(AsrModelCard, {
      props: { mode: 'settings' },
      global: { plugins: [pinia] }
    })
    expect(findCard(wrapper, 'zipformer-bilingual-zh-en').text()).toContain('已暂停 40%')
  })

  it('设置页取消备用映射为 null；删除必须二次确认', async () => {
    const ready = ASR_MODEL_CATALOG.map((model) => model.engineId)
    const voice = useVoiceStore(pinia)
    voice.state.asrOverview = overview({ ready })
    const setFallback = vi.spyOn(voice, 'setFallbackEngine').mockResolvedValue(true)
    const deleteModel = vi.spyOn(voice, 'deleteModel').mockResolvedValue(true)
    const wrapper = mount(AsrModelCard, {
      props: { mode: 'settings' },
      global: { plugins: [pinia] }
    })

    await buttonByText(findCard(wrapper, 'sherpa-sensevoice'), '取消备用').trigger('click')
    expect(setFallback).toHaveBeenCalledWith(null)

    const parakeetDelete = buttonByText(findCard(wrapper, 'parakeet-tdt-v2'), '删除模型')
    vi.mocked(window.confirm).mockReturnValueOnce(false)
    await parakeetDelete.trigger('click')
    expect(deleteModel).not.toHaveBeenCalled()

    vi.mocked(window.confirm).mockReturnValueOnce(true)
    await parakeetDelete.trigger('click')
    await flushPromises()
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('661 MB'))
    expect(deleteModel).toHaveBeenCalledWith('parakeet-tdt-v2')
  })
})
