// src/renderer/src/live2d-main.ts
// P3A-06：Live2D 独立 renderer entry。严禁调用现有 main.ts / bootstrapApp()。

import '@pixi/unsafe-eval'
import { createApp } from 'vue'
import Live2dStageApp from './live2d/Live2dStageApp.vue'
import { ensureCubism2, ensureCubismCore } from './live2d/cubism-core-loader'

createApp(Live2dStageApp, {
  ensureCubismCore,
  ensureCubism2
}).mount('#live2d-stage')
