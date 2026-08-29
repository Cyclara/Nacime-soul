// src/renderer/src/orchestrators/live2d-settings.test.ts
// P3A-25：缩放/置顶只有 config 单写路径，保存成功后再从 main 投影补水。

import { describe, expect, it, vi } from 'vitest'
import type { PublicConfigSnapshot, UiConfig } from '@shared/config/types'
import type { ConfigState } from '../stores/config'
import type { Live2dState } from '../stores/live2d'
import {
  createLive2dSettingsOrchestrator,
  type Live2dSettingsOrchestrator
} from './live2d-settings'

type Framing = { zoom: number; offsetX: number; offsetY: number }

interface Harness {
  orchestrator: Live2dSettingsOrchestrator
  patch: ReturnType<typeof vi.fn<(domain: 'ui', value: Partial<UiConfig>) => void>>
  save: ReturnType<typeof vi.fn<() => Promise<boolean>>>
  discard: ReturnType<typeof vi.fn<() => void>>
  hydrate: ReturnType<typeof vi.fn<() => Promise<void>>>
  previewFraming: ReturnType<typeof vi.fn<(framing: Framing | null) => Promise<void>>>
  draft: PublicConfigSnapshot
}

function createHarness(saveResult: boolean): Harness {
  // patch 真的写回草稿：预览读的是草稿，不落到草稿就断言不出「预览跟着滑块走」。
  const patch = vi.fn<(domain: 'ui', value: Partial<UiConfig>) => void>((_domain, value) => {
    if (value.live2d !== undefined) draft.ui.live2d = { ...draft.ui.live2d, ...value.live2d }
  })
  const save = vi.fn(async () => saveResult)
  const discard = vi.fn()
  const hydrate = vi.fn(async () => {})
  const previewFraming = vi.fn<(framing: Framing | null) => Promise<void>>(async () => {})
  const draft: PublicConfigSnapshot = {
    ui: {
      live2d: {
        enabled: true,
        zoom: 1,
        alwaysOnTop: true,
        offsetX: 0,
        offsetY: 0,
        selectedModelId: 'mao'
      }
    }
  } as PublicConfigSnapshot
  const orchestrator = createLive2dSettingsOrchestrator({
    config: {
      state: { draft } as Pick<ConfigState, 'draft'>,
      patch,
      save,
      discard
    },
    live2d: {
      state: {
        window: {
          visible: true,
          alwaysOnTop: true,
          zoom: 1,
          offsetX: 0,
          offsetY: 0,
          stageStatus: 'ready'
        }
      } as Pick<Live2dState, 'window'>,
      hydrate,
      previewFraming
    },
    // 同步执行帧回调，让「每帧只发一次」的合并逻辑在测试中可断言。
    scheduleFrame: (callback) => {
      callback()
    }
  })
  return { orchestrator, patch, save, discard, hydrate, previewFraming, draft }
}

describe('P3A-25 Live2dSettingsOrchestrator', () => {
  const base = {
    enabled: true,
    zoom: 1,
    alwaysOnTop: true,
    offsetX: 0,
    offsetY: 0,
    selectedModelId: 'mao'
  }

  it('缩放先钳到合同范围，置顶与缩放都只 patch config', () => {
    const harness = createHarness(true)

    harness.orchestrator.patchZoom(9)
    harness.orchestrator.patchZoom(0.1)
    harness.orchestrator.patchAlwaysOnTop(false)

    // patch 是增量的：第三次只改 alwaysOnTop，前两次钳过的 zoom 必须原样保留。
    expect(harness.patch).toHaveBeenNthCalledWith(1, 'ui', { live2d: { ...base, zoom: 3 } })
    expect(harness.patch).toHaveBeenNthCalledWith(2, 'ui', { live2d: { ...base, zoom: 0.25 } })
    expect(harness.patch).toHaveBeenNthCalledWith(3, 'ui', {
      live2d: { ...base, zoom: 0.25, alwaysOnTop: false }
    })
  })

  it('取景偏移钳到 -100..100，且不动 zoom/置顶/已选模型', () => {
    const harness = createHarness(true)

    harness.orchestrator.patchOffset(-320, 40)
    harness.orchestrator.patchOffset(12, 250)

    expect(harness.patch).toHaveBeenNthCalledWith(1, 'ui', {
      live2d: { ...base, offsetX: -100, offsetY: 40 }
    })
    expect(harness.patch).toHaveBeenNthCalledWith(2, 'ui', {
      live2d: { ...base, offsetX: 12, offsetY: 100 }
    })
  })

  it('取景预设一次写入 zoom 与偏移：半身回归一化基准，全身缩到一屏高并抬到中线', () => {
    const harness = createHarness(true)

    harness.orchestrator.applyFraming('full-body')
    harness.orchestrator.applyFraming('upper-body')
    harness.orchestrator.resetFraming()

    expect(harness.patch).toHaveBeenNthCalledWith(1, 'ui', {
      live2d: { ...base, zoom: 0.5, offsetX: 0, offsetY: 50 }
    })
    expect(harness.patch).toHaveBeenNthCalledWith(2, 'ui', {
      live2d: { ...base, zoom: 1, offsetX: 0, offsetY: 0 }
    })
    expect(harness.patch).toHaveBeenNthCalledWith(3, 'ui', {
      live2d: { ...base, zoom: 1, offsetX: 0, offsetY: 0 }
    })
  })

  it('保存成功后从 main 投影补水；失败则丢弃草稿且不伪造 stage 状态', async () => {
    const success = createHarness(true)
    await expect(success.orchestrator.saveAndApply()).resolves.toBeUndefined()
    expect(success.save).toHaveBeenCalledTimes(1)
    expect(success.hydrate).toHaveBeenCalledTimes(1)
    expect(success.discard).not.toHaveBeenCalled()

    const failure = createHarness(false)
    await expect(failure.orchestrator.saveAndApply()).rejects.toThrow('Live2D 配置保存失败')
    expect(failure.discard).toHaveBeenCalledTimes(1)
    expect(failure.hydrate).not.toHaveBeenCalled()
  })

  it('调节取景时逐帧推预览草稿，同一帧内的连续滑动只发一次', () => {
    const harness = createHarness(true)
    let frame: (() => void) | null = null
    const deferred = createLive2dSettingsOrchestrator({
      config: {
        state: { draft: harness.draft } as Pick<ConfigState, 'draft'>,
        patch: harness.patch,
        save: harness.save,
        discard: harness.discard
      },
      live2d: {
        state: {
          window: {
            visible: true,
            alwaysOnTop: true,
            zoom: 1,
            offsetX: 0,
            offsetY: 0,
            stageStatus: 'ready'
          }
        } as Pick<Live2dState, 'window'>,
        hydrate: harness.hydrate,
        previewFraming: harness.previewFraming
      },
      scheduleFrame: (callback) => {
        frame = callback
      }
    })

    deferred.patchZoom(2)
    deferred.patchOffset(10, 20)
    deferred.patchOffset(10, 35)
    expect(harness.previewFraming).not.toHaveBeenCalled()

    ;(frame as unknown as () => void)()
    // 只发最后一次草稿状态，而不是三条命令。
    expect(harness.previewFraming).toHaveBeenCalledTimes(1)
    expect(harness.previewFraming).toHaveBeenCalledWith({ zoom: 2, offsetX: 10, offsetY: 35 })
  })

  it('预览是临时的：保存成功、保存失败与放弃草稿都会让 stage 归位到落盘构图', async () => {
    const saved = createHarness(true)
    saved.orchestrator.patchZoom(2)
    expect(saved.previewFraming).toHaveBeenLastCalledWith({ zoom: 2, offsetX: 0, offsetY: 0 })
    await saved.orchestrator.saveAndApply()
    expect(saved.previewFraming).toHaveBeenLastCalledWith(null)

    const failed = createHarness(false)
    failed.orchestrator.patchOffset(0, 60)
    expect(failed.previewFraming).toHaveBeenLastCalledWith({ zoom: 1, offsetX: 0, offsetY: 60 })
    await expect(failed.orchestrator.saveAndApply()).rejects.toThrow('Live2D 配置保存失败')
    expect(failed.previewFraming).toHaveBeenLastCalledWith(null)

    const abandoned = createHarness(true)
    abandoned.orchestrator.applyFraming('full-body')
    expect(abandoned.previewFraming).toHaveBeenLastCalledWith({
      zoom: 0.5,
      offsetX: 0,
      offsetY: 50
    })
    abandoned.orchestrator.discard()
    expect(abandoned.previewFraming).toHaveBeenLastCalledWith(null)
  })

  it('没开始预览时 endPreview 不产生多余 IPC，重复调用幂等', () => {
    const harness = createHarness(true)
    harness.orchestrator.endPreview()
    expect(harness.previewFraming).not.toHaveBeenCalled()

    harness.orchestrator.patchZoom(1.5)
    harness.orchestrator.endPreview()
    harness.orchestrator.endPreview()
    expect(harness.previewFraming.mock.calls.map(([framing]) => framing)).toEqual([
      { zoom: 1.5, offsetX: 0, offsetY: 0 },
      null
    ])
  })

  it('置顶不参与取景预览', () => {
    const harness = createHarness(true)
    harness.orchestrator.patchAlwaysOnTop(false)
    expect(harness.previewFraming).not.toHaveBeenCalled()
  })
})
