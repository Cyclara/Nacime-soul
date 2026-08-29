// src/shared/live2d/stage-global.d.ts
// P3A-05：第二 renderer 的唯一 preload 全局。它与 window.companion 互斥。

import type { Live2dStageApi } from '../../preload/live2d-stage'

declare global {
  interface Window {
    live2dStage: Readonly<Live2dStageApi>
  }
}

export {}
