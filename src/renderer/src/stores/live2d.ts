// src/renderer/src/stores/live2d.ts
// P3A-23：chat renderer 的 Live2D 公开投影 store。
//
// store 不保存 Pixi/Live2D 对象、文件句柄或绝对路径；只调用 typed preload API。窗口状态由
// main manager 单真源通过 getState + revision/sequence event 投影回来。

import { computed, reactive } from 'vue'
import { defineStore } from 'pinia'
import type { Live2dImportResult, Live2dPublicSnapshot, Live2dStateEvent } from '@shared/live2d/public-types'
import type { Live2dLoadError, Live2dModelListItem } from '@shared/live2d/types'
import type { Unsubscribe } from '@shared/ipc/contracts'

export interface Live2dState {
  models: Live2dModelListItem[]
  selectedModelId: string | null
  loadedModelId: string | null
  window: Live2dPublicSnapshot['window']
  loading: boolean
  lastError: Live2dLoadError | null
  revision: number
  lastEventSequence: number
}

function initialState(): Live2dState {
  return {
    models: [],
    selectedModelId: null,
    loadedModelId: null,
    window: { visible: false, alwaysOnTop: true, zoom: 1, offsetX: 0, offsetY: 0, stageStatus: 'closed' },
    loading: false,
    lastError: null,
    revision: 0,
    lastEventSequence: -1
  }
}

export const useLive2dStore = defineStore('live2d', () => {
  const state = reactive<Live2dState>(initialState())
  let unsubscribe: Unsubscribe | null = null
  let hydrateEpoch = 0

  const currentModel = computed(() => state.models.find((model) => model.id === state.selectedModelId) ?? null)
  const isReady = computed(() => state.window.stageStatus === 'ready' && state.loadedModelId !== null)

  function applyState(event: Live2dStateEvent): void {
    if (event.revision < state.revision) return
    if (event.revision === state.revision && event.sequence <= state.lastEventSequence) return
    state.models = [...event.models]
    state.selectedModelId = event.selectedModelId
    state.loadedModelId = event.loadedModelId
    state.window = { ...event.window }
    state.loading = event.loading
    state.lastError = event.lastError === null ? null : { ...event.lastError }
    state.revision = event.revision
    state.lastEventSequence = event.sequence
  }

  async function hydrate(): Promise<void> {
    const epoch = ++hydrateEpoch
    if (!window.companion?.live2d) return
    const result = await window.companion.live2d.getState()
    if (epoch !== hydrateEpoch || !result.ok) return
    applyState({ ...result.data, sequence: result.data.lastEventSequence })
  }

  async function setVisible(visible: boolean): Promise<void> {
    const result = await window.companion.live2d.setVisible({ visible })
    if (result.ok) await hydrate()
  }

  async function resetWindowPlacement(): Promise<void> {
    const result = await window.companion.live2d.resetWindowPlacement()
    if (result.ok) await hydrate()
  }

  /**
   * P3A-25：取景实时预览。只让 main 把草稿构图推给 stage，不写 config、不改本 store 的
   * window 投影——window 始终反映已保存值，因此放弃草稿后 UI 不会显示假状态。
   */
  async function previewFraming(
    framing: { zoom: number; offsetX: number; offsetY: number } | null
  ): Promise<void> {
    if (!window.companion?.live2d) return
    await window.companion.live2d.previewFraming({ framing })
  }

  async function chooseImportSource(): Promise<Live2dImportResult> {
    state.loading = true
    const result = await window.companion.live2d.chooseImportSource()
    state.loading = false
    if (result.ok) {
      await hydrate()
      return result.data
    }
    return {
      ok: false,
      modelId: null,
      displayName: null,
      warnings: [],
      error: { code: 'MODEL_JSON_INVALID', retryable: true, suggestedAction: 'retry' }
    }
  }

  async function selectModel(modelId: string): Promise<void> {
    state.loading = true
    const result = await window.companion.live2d.selectModel({ modelId })
    state.loading = false
    if (result.ok) await hydrate()
  }

  async function retryLoad(): Promise<void> {
    state.loading = true
    const result = await window.companion.live2d.retryLoad()
    state.loading = false
    if (result.ok) await hydrate()
  }

  function subscribe(): Unsubscribe {
    unsubscribe?.()
    unsubscribe = window.companion.live2d.onState(applyState)
    return unsubscribe
  }

  function reset(): void {
    unsubscribe?.()
    unsubscribe = null
    hydrateEpoch++
    Object.assign(state, initialState())
  }

  return {
    state,
    currentModel,
    isReady,
    hydrate,
    setVisible,
    resetWindowPlacement,
    previewFraming,
    chooseImportSource,
    selectModel,
    retryLoad,
    applyState,
    subscribe,
    reset
  }
})
