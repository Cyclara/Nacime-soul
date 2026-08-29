// src/shared/live2d/public-types.ts
// P3A-23：chat renderer 只能消费的 Live2D DTO，不含路径、文件句柄或 Pixi 对象。

import type { Live2dLoadError, Live2dModelListItem } from './types'
import type { Live2dStageStatus } from './stage-types'

export type Live2dStageStatusView = 'closed' | Live2dStageStatus

export interface Live2dPublicSnapshot {
  readonly models: readonly Live2dModelListItem[]
  readonly selectedModelId: string | null
  readonly loadedModelId: string | null
  readonly window: {
    readonly visible: boolean
    readonly alwaysOnTop: boolean
    readonly zoom: number
    /** 取景偏移（画布百分比）；与 zoom 同源于 ui.live2d，供设置页显示当前构图。 */
    readonly offsetX: number
    readonly offsetY: number
    readonly stageStatus: Live2dStageStatusView
  }
  readonly loading: boolean
  readonly lastError: Live2dLoadError | null
  readonly revision: number
  readonly lastEventSequence: number
}

export interface Live2dStateEvent extends Live2dPublicSnapshot {
  readonly sequence: number
}

/** 取景实时预览载荷；framing=null 表示结束预览并回到已保存构图。 */
export interface Live2dFramingPreviewRequest {
  readonly framing: {
    readonly zoom: number
    readonly offsetX: number
    readonly offsetY: number
  } | null
}

export interface Live2dImportResult {
  readonly ok: boolean
  readonly modelId: string | null
  readonly displayName: string | null
  readonly warnings: readonly string[]
  readonly error: Live2dLoadError | null
}
