// src/renderer/src/orchestrators/voice-chat.ts
// P3B-18/19（S-006-补充 §1.5 / §1.7.6）：voice ↔ chat 的跨 store 编排——语音输入闭环。
//
//   用户按麦克风 → start()：main start-listening（引擎/VAD 就绪）→ openMicPort →
//     采集会话（P3B-13）；帧流 → main VAD → ASR → `transcript` 事件回 voice store
//   → 本 orchestrator 订阅 voice store 的 lastTranscript 变化 → acceptTranscript：
//     mode='draft'（默认）：写入 chat draft，用户确认后发送；
//     mode='send'：直接 chat.send()（用户在设置中显式选择，不由组件临时决定）。
//   用户开口打断 TTS（barge-in）由 main 侧 listening-service→orchestrator.onBargeIn 完成，
//   renderer 不参与；interruptSpeech() 只服务 UI 上的「让她停下」按钮。
//
// 纪律（S-002/S-006）：voice store 不 import chat store；跨 store 只在这里。组件只调
// 本 orchestrator 与两个 store 的 getter，不拼 IPC。
//
// 与 voice-test-recording 的关系：同一条采集/监听链路（复用 startListening/openMicPort/
// createMicCaptureSession 的顺序合同），差别只在转写去向——测试面板停在 lastTranscript，
// 本 orchestrator 把它送进聊天。

import { watch } from 'vue'
import type { WatchStopHandle } from 'vue'
import {
  browserMicCaptureDeps,
  createMicCaptureSession,
  type MicCaptureErrorKind,
  type MicPortLike
} from '../voice/mic-capture-session'
import type { VoiceStore } from '../stores/voice'
import type { ChatStore } from '../stores/chat'

export type VoiceSendMode = 'draft' | 'send'

export interface VoiceChatOrchestrator {
  /** 用户按下麦克风：开始一段语音输入会话。幂等。 */
  start(deviceId?: string | null): Promise<void>
  /** 用户松开/再次点击：停止采集（main 冲刷未完话语，可能再出一条 transcript）。幂等。 */
  stop(): Promise<void>
  /**
   * ASR final 后写入 chat draft；`send` 模式直接发送。公开给测试与「重新提交上一句」；
   * 正常路径由内部对 voice store 的订阅自动调用。
   */
  acceptTranscript(text: string, mode: VoiceSendMode): Promise<void>
  /** 用户点「让她停下」：停止当前 TTS（不取消 LLM turn，文字继续）。 */
  interruptSpeech(): Promise<void>
  readonly listening: boolean
  /** 最近一次采集/会话错误（用户可读文案，无路径/无原始错误）。 */
  readonly lastError: string | null
  dispose(): void
}

export interface VoiceChatOrchestratorDeps {
  readonly voice: VoiceStore
  readonly chat: ChatStore
  /** 发送模式真源：config `ui.onboarding.voiceSendMode`（undefined = draft）。 */
  readonly getSendMode: () => VoiceSendMode
  /** 测试注入：不真开 getUserMedia/worklet。 */
  readonly createCapture?: typeof createMicCaptureSession
  readonly workletUrl?: () => string
  readonly waitForMicPort?: (timeoutMs: number) => Promise<MicPortLike>
}

const MIC_WORKLET_PROCESSOR_NAME = 'mic-frame-processor'
const MIC_PORT_MESSAGE = 'voice:mic-port'
const MIC_PORT_TIMEOUT_MS = 2_000

function defaultWorkletUrl(): string {
  return new URL(`voice/${MIC_WORKLET_PROCESSOR_NAME}.js`, document.baseURI).href
}

function defaultWaitForMicPort(timeoutMs: number): Promise<MicPortLike> {
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

function micErrorCopy(kind: MicCaptureErrorKind): string {
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

export function createVoiceChatOrchestrator(
  deps: VoiceChatOrchestratorDeps
): VoiceChatOrchestrator {
  const createCapture = deps.createCapture ?? createMicCaptureSession
  const workletUrl = deps.workletUrl ?? defaultWorkletUrl
  const waitForMicPort = deps.waitForMicPort ?? defaultWaitForMicPort

  let listening = false
  let lastError: string | null = null
  let capture: ReturnType<typeof createMicCaptureSession> | null = null
  let disposed = false
  let stopWatch: WatchStopHandle | null = null
  /** 已消费过的转写（同一段文字重复到达不重复写入 draft）。 */
  let consumedTranscript = ''

  // transcript 到达（voice store 只投影，不知道 chat）→ 送进聊天
  stopWatch = watch(
    () => deps.voice.state.lastTranscript,
    (text) => {
      if (disposed || text.length === 0 || text === consumedTranscript) return
      consumedTranscript = text
      void acceptTranscript(text, deps.getSendMode())
    }
  )

  async function acceptTranscript(text: string, mode: VoiceSendMode): Promise<void> {
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    if (mode === 'send') {
      // 自动发送：draft 先写入再走既有 send（复用 canSend/busy 守卫；活跃轮时退为 draft）
      deps.chat.setDraft(trimmed)
      if (deps.chat.canSend) await deps.chat.send()
      return
    }
    // 默认「确认后发送」：追加到 draft（用户可能已打了一半），用户按发送才真正提交
    const existing = deps.chat.state.draft
    deps.chat.setDraft(existing.length === 0 ? trimmed : `${existing}${trimmed}`)
  }

  async function stopInternal(): Promise<void> {
    const current = capture
    capture = null
    if (current !== null) await current.stop()
    await window.companion.voice.stopListening()
  }

  return {
    get listening() {
      return listening
    },
    get lastError() {
      return lastError
    },

    async start(deviceId) {
      if (disposed || listening) return
      listening = true
      lastError = null
      try {
        const started = await window.companion.voice.startListening()
        if (!started.ok) {
          const code = started.error?.code ?? 'UNKNOWN'
          lastError =
            code === 'ASR_MODEL_MISSING'
              ? '语音模型还没下载，先去「设置 → 语音」准备一下'
              : (started.error?.message ?? '语音会话启动失败')
          listening = false
          return
        }
        window.companion.voice.openMicPort()
        const port = await waitForMicPort(MIC_PORT_TIMEOUT_MS)
        capture = createCapture({
          ...browserMicCaptureDeps(workletUrl()),
          outputPort: port,
          onError: (error) => {
            deps.voice.setMicPermission(
              error.kind === 'permission-denied'
                ? 'denied'
                : error.kind === 'device-lost'
                  ? 'device-lost'
                  : deps.voice.state.micPermission
            )
            lastError = micErrorCopy(error.kind)
            listening = false
            void stopInternal()
          },
          onLevel: (level) => deps.voice.setMicLevel(level)
        })
        await capture.start(deviceId ?? undefined)
        deps.voice.setMicPermission('granted')
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
        listening = false
        await stopInternal()
      }
    },

    async stop() {
      if (!listening && capture === null) return
      listening = false
      await stopInternal()
      deps.voice.setMicLevel(0)
    },

    acceptTranscript,

    async interruptSpeech() {
      await deps.voice.cancelSpeaking()
    },

    dispose() {
      if (disposed) return
      disposed = true
      stopWatch?.()
      stopWatch = null
      void this.stop()
    }
  }
}
