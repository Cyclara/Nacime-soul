// src/renderer/src/orchestrators/voice-test-recording.ts
// P3B-14：测试录音编排——把 P3B-13 capture 管线与 main 侧 listening-service
// 串成「录音 → VAD → ASR → 转写」全链路，供语音设置页测试面板使用。
//
// 顺序（有依赖，不能乱）：
//   1. main start-listening：引擎+VAD 模型就绪检查、建 VAD 管线（listening 激活）
//   2. openMicPort()：preload 建 MessageChannel，port2 转交 main（registerPortReceiver
//      在 active 时 attach），port1 经 window.postMessage 到达本页面
//   3. 收到 port1 → 建 capture session（outputPort=port1）→ getUserMedia + worklet
//   4. 帧 transferable 流动；转写经 voice-state 事件回 store
// 停止：capture.stop()（track 停 + port 关 → main 收 close 冲刷）→ main stop-listening。
//
// 采集会话生命周期 = 会话独占 port：每次录音新开 port（preload 每次 openMicPort
// 建新 channel）；失败/停止即关。

import {
  browserMicCaptureDeps,
  createMicCaptureSession,
  type MicCaptureErrorKind,
  type MicPortLike
} from '../voice/mic-capture-session'
import type { VoiceStore } from '../stores/voice'

/**
 * worklet 处理器注册名（与 src/renderer/public/voice/mic-worklet-processor.js
 * 的 registerProcessor 名一致；app 代码禁止 import public/ 资产，故本地常量）。
 */
const MIC_WORKLET_PROCESSOR_NAME = 'mic-frame-processor'

/** worklet 模块 URL：public 资产随构建复制到 renderer out 根；dev 由 Vite 同源伺服。 */
function workletUrl(): string {
  return new URL(`voice/${MIC_WORKLET_PROCESSOR_NAME}.js`, document.baseURI).href
}

const MIC_PORT_MESSAGE = 'voice:mic-port'
const MIC_PORT_TIMEOUT_MS = 2_000

/** 等待 preload 经 window.postMessage 转交的 mic port1。 */
function waitForMicPort(timeoutMs: number): Promise<MicPortLike> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      window.removeEventListener('message', onMessage)
      reject(new Error('mic port handoff timed out'))
    }, timeoutMs)
    function onMessage(event: MessageEvent): void {
      if (event.data !== MIC_PORT_MESSAGE) return
      const port = event.ports?.[0]
      if (port === undefined) return
      clearTimeout(timeout)
      window.removeEventListener('message', onMessage)
      resolve(port as unknown as MicPortLike)
    }
    window.addEventListener('message', onMessage)
  })
}

function classifyMicError(kind: MicCaptureErrorKind): string {
  switch (kind) {
    case 'permission-denied':
      return '麦克风权限被拒绝，请在系统设置中允许后重试'
    case 'not-found':
      return '未找到可用麦克风设备'
    case 'device-lost':
      return '麦克风设备已移除或失效'
    default:
      return '麦克风启动失败'
  }
}

export interface VoiceTestRecordingOrchestrator {
  startRecording(deviceId?: string): Promise<void>
  stopRecording(): Promise<void>
  readonly recording: boolean
  dispose(): void
}

export function createVoiceTestRecordingOrchestrator(
  store: VoiceStore
): VoiceTestRecordingOrchestrator {
  let recording = false
  let capture: ReturnType<typeof createMicCaptureSession> | null = null
  let disposed = false

  async function stopInternal(): Promise<void> {
    const current = capture
    capture = null
    if (current !== null) {
      await current.stop()
    }
    await window.companion.voice.stopListening()
  }

  return {
    get recording(): boolean {
      return recording
    },

    async startRecording(deviceId) {
      if (disposed || recording) return
      recording = true
      store.state.listening = true
      store.resetTest()
      try {
        // 1) main 侧就绪（缺模型会抛 IPC 错误）
        const startResult = await window.companion.voice.startListening()
        if (!startResult.ok) {
          const code = startResult.error?.code ?? 'UNKNOWN'
          store.state.testError = {
            code,
            message:
              code === 'ASR_MODEL_MISSING'
                ? '语音模型未下载，请先在上方下载模型'
                : (startResult.error?.message ?? '语音会话启动失败')
          }
          store.state.listening = false
          return
        }
        // 2) 开 mic port（main active 后 attach）
        window.companion.voice.openMicPort()
        const port = await waitForMicPort(MIC_PORT_TIMEOUT_MS)
        // 3) 采集会话（outputPort 独占）
        capture = createMicCaptureSession({
          ...browserMicCaptureDeps(workletUrl()),
          outputPort: port,
          onError: (error) => {
            store.state.micPermission =
              error.kind === 'permission-denied'
                ? 'denied'
                : error.kind === 'device-lost'
                  ? 'device-lost'
                  : store.state.micPermission
            store.state.testError = {
              code: error.kind.toUpperCase(),
              message: classifyMicError(error.kind)
            }
            void stopInternal()
          },
          onLevel: (level) => {
            store.setMicLevel(level)
          }
        })
        await capture.start(deviceId)
        store.setMicPermission('granted')
        await store.refreshDevices()
      } catch (err) {
        store.state.testError = {
          code: 'MIC_FAIL',
          message: err instanceof Error ? err.message : String(err)
        }
        await stopInternal()
      } finally {
        recording = false
        store.state.listening = false
      }
    },

    async stopRecording() {
      if (!recording && capture === null) return
      await stopInternal()
      recording = false
      store.state.listening = false
    },

    dispose() {
      if (disposed) return
      disposed = true
      void this.stopRecording()
    }
  }
}
