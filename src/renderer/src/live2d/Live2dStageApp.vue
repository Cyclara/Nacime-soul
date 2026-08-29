<!-- src/renderer/src/live2d/Live2dStageApp.vue -->
<!-- P3A-06：独立 Live2D stage 根。没有 router/Pinia/chat bootstrap，只持有 Pixi 生命周期。 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { PixiLive2DRenderer } from './PixiLive2DRenderer'
import { createStageController, type StageController } from './stage-controller'
import { startLive2dStage, type Live2dStageBootstrapHandle } from './stage-bootstrap'
import type { Live2dStageControllerState } from './stage-controller'
import Live2dErrorOverlay from './Live2dErrorOverlay.vue'

const props = defineProps<{
  ensureCubismCore?: (url: string | null) => Promise<void>
  ensureCubism2?: (url: string | null) => Promise<void>
}>()

const canvas = ref<HTMLCanvasElement | null>(null)
const stageState = ref<Live2dStageControllerState>({
  stageInstanceId: null,
  status: 'starting',
  errorCode: null
})

const statusCopy = computed(() => {
  switch (stageState.value.status) {
    case 'starting':
      return '正在准备她出现的地方…'
    case 'loading-model':
      return '正在让她醒过来…'
    case 'ready':
      return ''
    case 'degraded':
      return '她暂时没有显示出来，但文字聊天还在。'
    case 'error':
      return '她暂时没能出现在桌面上，但文字聊天还在。'
    default:
      return ''
  }
})

let controller: StageController | null = null
let bootstrapHandle: Live2dStageBootstrapHandle | null = null
let resizeObserver: ResizeObserver | null = null

onMounted(async () => {
  const target = canvas.value
  if (target === null) return

  const nextController = createStageController({
    renderer: new PixiLive2DRenderer(),
    report: (report) => window.live2dStage.reportState(report),
    ensureCubismCore: props.ensureCubismCore,
    ensureCubism2: props.ensureCubism2,
    onStateChange: (nextState) => {
      stageState.value = nextState
    }
  })
  controller = nextController
  window.addEventListener('pagehide', disposeStage, { once: true })
  nextController.attach(target)
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry === undefined) return
      nextController.resize(
        Math.max(1, Math.round(entry.contentRect.width)),
        Math.max(1, Math.round(entry.contentRect.height))
      )
    })
    resizeObserver.observe(target)
  }

  bootstrapHandle = await startLive2dStage(window.live2dStage, {
    onBootstrap: (bootstrap) => nextController.initialize(bootstrap),
    onCommand: (command) => nextController.handleCommand(command)
  })
})

function retryStage(): void {
  void controller?.retry()
}

function disposeStage(): void {
  window.removeEventListener('pagehide', disposeStage)
  resizeObserver?.disconnect()
  resizeObserver = null
  bootstrapHandle?.dispose()
  bootstrapHandle = null
  controller?.dispose()
  controller = null
}

onBeforeUnmount(disposeStage)
</script>

<template>
  <main class="live2d-stage" :aria-busy="stageState.status === 'starting' || stageState.status === 'loading-model'">
    <canvas ref="canvas" class="live2d-canvas" aria-label="Nacime 的 Live2D 形象" />

    <Live2dErrorOverlay
      v-if="stageState.status === 'error'"
      :code="stageState.errorCode"
      @retry="retryStage"
    />

    <div
      v-else-if="stageState.status !== 'ready'"
      class="stage-status"
      role="status"
      aria-live="polite"
    >
      <span class="stage-status__dot" aria-hidden="true" />
      <span>{{ statusCopy }}</span>
      <small v-if="stageState.errorCode">{{ stageState.errorCode }}</small>
    </div>
  </main>
</template>

<style scoped>
.live2d-stage {
  position: fixed;
  inset: 0;
  overflow: hidden;
  background: transparent;
  cursor: grab;
  user-select: none;
  -webkit-app-region: drag;
}

.live2d-stage:active {
  cursor: grabbing;
}

.live2d-canvas {
  display: block;
  width: 100%;
  height: 100%;
  outline: none;
}

.stage-status {
  position: absolute;
  inset-inline: 1.25rem;
  bottom: 1.25rem;
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.7rem 0.9rem;
  border: 1px solid rgb(255 255 255 / 20%);
  border-radius: 0.8rem;
  background: rgb(24 21 33 / 78%);
  color: rgb(255 255 255 / 92%);
  box-shadow: 0 0.5rem 1.5rem rgb(0 0 0 / 28%);
  font-size: 0.8rem;
  line-height: 1.35;
  backdrop-filter: blur(0.75rem);
}

.stage-status--error {
  border-color: rgb(255 166 166 / 56%);
}

.stage-status__dot {
  width: 0.45rem;
  height: 0.45rem;
  flex: 0 0 auto;
  border-radius: 999px;
  background: rgb(193 177 255);
  box-shadow: 0 0 0.55rem rgb(193 177 255 / 72%);
}

.stage-status--error .stage-status__dot {
  background: rgb(255 145 145);
  box-shadow: 0 0 0.55rem rgb(255 145 145 / 72%);
}

.stage-status small {
  margin-left: auto;
  color: rgb(255 255 255 / 62%);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
</style>
