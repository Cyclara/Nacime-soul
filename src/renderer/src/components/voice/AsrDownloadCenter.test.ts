// @vitest-environment jsdom
// P3V-15：下载中心展示真实细粒度 DTO，并只为可续传模型提供暂停/继续。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { ASR_MODEL_CATALOG } from '@shared/voice/asr-catalog'
import type { AsrEngineId, AsrOverview } from '@shared/voice/asr-settings-types'
import { useVoiceStore } from '../../stores/voice'
import AsrDownloadCenter from './AsrDownloadCenter.vue'

function overview(
  states: Partial<Record<AsrEngineId, 'downloading' | 'paused' | 'archive'>>
): AsrOverview {
  return {
    selectedEngineId: 'zipformer-bilingual-zh-en',
    fallbackEngineId: 'sherpa-sensevoice',
    engines: ASR_MODEL_CATALOG.map((model) => {
      const state = states[model.engineId]
      const paused = state === 'paused'
      const archive = state === 'archive'
      return {
        engineId: model.engineId,
        label: model.label,
        localOnly: true as const,
        modelState: state === undefined ? ('not-downloaded' as const) : ('downloading' as const),
        progressRatio: state === undefined ? undefined : 0.25,
        downloadBytes: model.downloadBytes,
        download:
          state === undefined
            ? {
                assetId: model.engineId,
                state: 'idle' as const,
                receivedBytes: 0,
                totalBytes: model.downloadBytes,
                resumable: model.engineId.startsWith('zipformer')
              }
            : {
                assetId: model.engineId,
                state: paused ? ('paused' as const) : ('downloading' as const),
                receivedBytes: 25_000_000,
                totalBytes: 100_000_000,
                currentFile: archive ? 'sense-voice.tar.bz2' : 'encoder.int8.onnx',
                phase: 'receiving' as const,
                speedBytesPerSec: paused ? 0 : 5_000_000,
                resumable: !archive
              },
        selected: model.engineId === 'zipformer-bilingual-zh-en',
        fallback: model.engineId === 'sherpa-sensevoice'
      }
    }),
    vadModel: {
      state: 'downloading',
      progressRatio: 0.5,
      download: {
        assetId: 'vad',
        state: 'downloading',
        receivedBytes: 321_927,
        totalBytes: 643_854,
        currentFile: 'silero_vad.onnx',
        phase: 'receiving',
        speedBytesPerSec: 100_000,
        resumable: false
      }
    }
  }
}

let pinia: Pinia

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
})

describe('P3V-15 AsrDownloadCenter', () => {
  it('显示 VAD、当前文件、已收/总量、剩余、速度、ETA 与 ARIA 进度', () => {
    const voice = useVoiceStore(pinia)
    voice.state.asrOverview = overview({ 'zipformer-bilingual-zh-en': 'downloading' })
    const wrapper = mount(AsrDownloadCenter, { global: { plugins: [pinia] } })

    expect(wrapper.text()).toContain('Silero VAD（说话检测）')
    expect(wrapper.text()).toContain('silero_vad.onnx')
    expect(wrapper.text()).toContain('encoder.int8.onnx')
    expect(wrapper.text()).toContain('25 MB / 100 MB')
    expect(wrapper.text()).toContain('剩余 75 MB')
    expect(wrapper.text()).toContain('5 MB/s')
    expect(wrapper.text()).toContain('约 15 秒')
    const bars = wrapper.findAll('[role="progressbar"]')
    expect(bars).toHaveLength(2)
    expect(bars.every((bar) => bar.attributes('aria-valuenow') !== undefined)).toBe(true)
  })

  it('多文件下载显示暂停并调用 store；paused 显示继续；归档不显示暂停', async () => {
    const voice = useVoiceStore(pinia)
    const pause = vi.spyOn(voice, 'pauseDownload').mockResolvedValue(true)
    const resume = vi.spyOn(voice, 'resumeDownload').mockResolvedValue(true)

    voice.state.asrOverview = overview({ 'zipformer-bilingual-zh-en': 'downloading' })
    const downloading = mount(AsrDownloadCenter, { global: { plugins: [pinia] } })
    const pauseButton = downloading.findAll('button').find((button) => button.text() === '暂停')
    expect(pauseButton).toBeDefined()
    await pauseButton!.trigger('click')
    expect(pause).toHaveBeenCalledWith('zipformer-bilingual-zh-en')
    downloading.unmount()

    voice.state.asrOverview = overview({ 'zipformer-bilingual-zh-en': 'paused' })
    const paused = mount(AsrDownloadCenter, { global: { plugins: [pinia] } })
    expect(paused.text()).toContain('已暂停，断点已保留')
    const resumeButton = paused.findAll('button').find((button) => button.text() === '继续')
    await resumeButton!.trigger('click')
    expect(resume).toHaveBeenCalledWith('zipformer-bilingual-zh-en')
    paused.unmount()

    voice.state.asrOverview = overview({ 'sherpa-sensevoice': 'archive' })
    const archive = mount(AsrDownloadCenter, { global: { plugins: [pinia] } })
    expect(archive.text()).toContain('sense-voice.tar.bz2')
    expect(archive.findAll('button').some((button) => button.text() === '暂停')).toBe(false)
    expect(archive.findAll('button').some((button) => button.text() === '取消')).toBe(true)
  })
})
