// src/main/live2d/public-state.ts
// P3A-23：由 main service/window manager 合成 Live2D 公开状态；只含 DTO。

import type { Live2dLoadError, Live2dModelListItem } from '@shared/live2d/types'
import type { Live2dPublicSnapshot, Live2dStateEvent } from '@shared/live2d/public-types'
import type { Live2dWindowSnapshot } from '../windows/live2d-window-manager'

export interface Live2dPublicStateSource {
  listModels(): readonly Live2dModelListItem[]
  selectedModelId(): string | null
  loadedModelId(): string | null
  window(): Live2dWindowSnapshot
  loading(): boolean
  lastError(): Live2dLoadError | null
  zoom(): number
  offset(): { readonly x: number; readonly y: number }
}

export function createLive2dPublicState(source: Live2dPublicStateSource): {
  snapshot(): Live2dPublicSnapshot
  event(): Live2dStateEvent
  bump(): Live2dStateEvent
} {
  let revision = 0
  let sequence = 0
  const snapshot = (): Live2dPublicSnapshot => {
    const window = source.window()
    const offset = source.offset()
    return {
      models: [...source.listModels()],
      selectedModelId: source.selectedModelId(),
      loadedModelId: source.loadedModelId() ?? window.loadedModelId,
      window: {
        visible: window.visible,
        alwaysOnTop: window.alwaysOnTop,
        zoom: source.zoom(),
        offsetX: offset.x,
        offsetY: offset.y,
        stageStatus: window.status
      },
      loading: source.loading(),
      lastError: source.lastError(),
      revision,
      lastEventSequence: sequence
    }
  }
  return {
    snapshot,
    event: () => ({ ...snapshot(), sequence }),
    bump: () => {
      revision++
      sequence++
      return { ...snapshot(), sequence }
    }
  }
}
