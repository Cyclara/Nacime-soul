<!-- src/renderer/src/live2d/Live2dStageApp.vue -->
<!-- P3A-06：独立 Live2D stage 根。没有 router/Pinia/chat bootstrap，只持有 Pixi 生命周期。 -->
<!-- P3B-15：stage 也是唯一 TTS PlaybackHost——bootstrap.mode === 'audio-only' 时不建
     Pixi/模型（窗口保持隐藏），只接收专用 audio port 播放 PCM。两种模式都挂 host。 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Live2dStageBootstrap } from '@shared/live2d/stage-types'
import { PixiLive2DRenderer } from './PixiLive2DRenderer'
import {
  createStageController,
  type StageController,
  type Live2dStageControllerState
} from './stage-controller'
import { startLive2dStage, type Live2dStageBootstrapHandle } from './stage-bootstrap'
import { createStagePlaybackHost, type StagePlaybackHost } from './audio/playback-host'
import { createStageAudioPlayer, type StageAudioPlayer } from './audio/audio-player'
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
let playbackHost: StagePlaybackHost | null = null
let audioPlayer: StageAudioPlayer | null = null

/**
 * S-006-补充 §1.9「reduceMotion=true：降低随机眼跳/大幅 motion，保留最低限度呼吸」。
 * 读系统偏好（stage 没有 config store，也不该为此扩 preload）；变化时插件下一帧生效。
 */
const reduceMotionQuery =
  typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null
function prefersReducedMotion(): boolean {
  return reduceMotionQuery?.matches === true
}

function initLive2d(bootstrap: Live2dStageBootstrap): void {
  const target = canvas.value
  if (target === null) return

  const nextController = createStageController({
    renderer: new PixiLive2DRenderer(),
    report: (report) => window.live2dStage.reportState(report),
    ensureCubismCore: props.ensureCubismCore,
    ensureCubism2: props.ensureCubism2,
    reduceMotion: prefersReducedMotion,
    onStateChange: (nextState) => {
      stageState.value = nextState
    }
  })
  controller = nextController
  // P3B-16/17：电平来源接入口型插件（缺 ParamMouthOpenY 的模型只禁 lip-sync，音频照播）。
  if (audioPlayer !== null) nextController.setLipSyncSource(audioPlayer)
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
  void nextController.initialize(bootstrap)
}

function initAudioOnly(bootstrap: Live2dStageBootstrap): void {
  // 音频宿主模式：无 Pixi/模型可加载，直接报 ready（窗口由 main 保持隐藏）。
  stageState.value = {
    stageInstanceId: bootstrap.stageInstanceId,
    status: 'ready',
    errorCode: null
  }
  void window.live2dStage.reportState({
    stageInstanceId: bootstrap.stageInstanceId,
    status: 'ready'
  })
}

onMounted(async () => {
  // PlaybackHost 先行：port 随 ready 转交到达；两种模式都要接收。
  // P3B-16 起 sink = AudioContext 播放器：真播放 + 本地 RMS 电平（口型由 controller 消费）。
  // P3B-18：播放器的 segment started/ended 回报经 host 转发 main（queue 的「started 才
  // 标 playing / ended 推进队列」依赖它；generation 不符的迟到回报由 host 丢弃）。
  audioPlayer = createStageAudioPlayer({
    onSegmentEvent: (event) => playbackHost?.forwardToMain(event)
  })
  playbackHost = createStagePlaybackHost({ sink: audioPlayer })
  window.addEventListener('message', onStageAudioPortMessage)
  window.addEventListener('pagehide', disposeStage, { once: true })

  bootstrapHandle = await startLive2dStage(window.live2dStage, {
    onBootstrap: (bootstrap) => {
      if (bootstrap.mode === 'audio-only') {
        initAudioOnly(bootstrap)
        return
      }
      initLive2d(bootstrap)
    },
    onCommand: (command) => {
      if (command.type === 'dispose') playbackHost?.dispose()
      else controller?.handleCommand(command)
    }
  })
})

/** preload 经 window.postMessage 转交的 audio port（P3B-15；与 mic port 同机制）。 */
function onStageAudioPortMessage(event: MessageEvent): void {
  if (event.source !== window) return
  const data = event.data as { type?: unknown; generation?: unknown }
  if (data?.type !== 'voice:audio-port') return
  const port = event.ports[0]
  if (typeof data.generation !== 'string' || port === undefined) return
  playbackHost?.attach(data.generation, port)
}

function retryStage(): void {
  void controller?.retry()
}

// ── S-006-补充 §1.9：拖动区域与模型 hit area 分离；拖动后短时间抑制点击 ──
// 整个窗口是 `-webkit-app-region: drag`（P3A-25 移动窗口），Chromium 在 drag 区域内
// 不派发 click，但 pointerdown/pointerup 仍到达页面。用「按下→抬起位移 < 阈值且
// 抬起时刻距上次拖动结束 > 抑制窗」判定一次真正的点击，再交 controller 做 hitTest。
const TAP_MAX_MOVE_PX = 6
const POST_DRAG_SUPPRESS_MS = 250
let pointerDownAt: { x: number; y: number; time: number } | null = null
let lastDragEndedAt = -Infinity

function onStagePointerDown(event: PointerEvent): void {
  if (event.button !== 0) return
  pointerDownAt = { x: event.clientX, y: event.clientY, time: performance.now() }
}

function onStagePointerUp(event: PointerEvent): void {
  const down = pointerDownAt
  pointerDownAt = null
  if (down === null || event.button !== 0) return
  const now = performance.now()
  const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y)
  if (moved > TAP_MAX_MOVE_PX) {
    // 一次拖动：记下结束时刻，抑制紧随其后的误触
    lastDragEndedAt = now
    return
  }
  if (now - lastDragEndedAt < POST_DRAG_SUPPRESS_MS) return
  const target = canvas.value
  if (target === null) return
  const rect = target.getBoundingClientRect()
  controller?.interact(event.clientX - rect.left, event.clientY - rect.top)
}

function onStagePointerCancel(): void {
  pointerDownAt = null
}

function disposeStage(): void {
  window.removeEventListener('pagehide', disposeStage)
  window.removeEventListener('message', onStageAudioPortMessage)
  resizeObserver?.disconnect()
  resizeObserver = null
  bootstrapHandle?.dispose()
  bootstrapHandle = null
  playbackHost?.dispose()
  playbackHost = null
  audioPlayer?.dispose()
  audioPlayer = null
  controller?.dispose()
  controller = null
}

onBeforeUnmount(disposeStage)
</script>

<template>
  <main
    class="live2d-stage"
    :aria-busy="stageState.status === 'starting' || stageState.status === 'loading-model'"
    @pointerdown="onStagePointerDown"
    @pointerup="onStagePointerUp"
    @pointercancel="onStagePointerCancel"
  >
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
