// src/main/voice/mic/mic-input-session.ts
// P3B-13：main 侧麦克风输入会话——专用 port 收 512 样本 s16le 帧，喂
// VadProcessor（P3B-12），话语事件（speech_start/speech_end）回调给消费者
// （P3B-14 测试录音 / P3B-18 orchestrator）。
//
// 与 renderer 侧 mic-capture-session 的生命周期配对：
//   renderer openMicPort()（preload 建口转交本端）→ attach(port)
//   → 帧流动 → renderer stop()/出错关闭对端 → 本端 'close' 事件 → 自动收尾
//   （冲刷未完话语 + 释放）。dispose() 供 main 主动收尾（如引擎切换）。
//
// 有界性：帧本身是瞬态（VadProcessor 对保留窗做防御拷贝），话语缓冲 60s
// 上限在 VadProcessor 强制切段——本会话不再额外攒任何音频。
// 协议违规（非帧消息/超限帧）：丢弃 + 计数（不崩会话；错误经 onError 上报）。

import { isMicFrameMessage, isValidMicFrameSamples } from '@shared/voice/mic-types'
import type { VadEvent } from '../vad/vad'
import type { VadProcessor } from '../vad/vad-processor'

/** MessagePortMain 的最小面（测试用假 port）。 */
export interface MicPortMainLike {
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  on(event: 'close', listener: () => void): void
  start(): void
  close(): void
}

export interface MicInputSessionDeps {
  readonly processor: VadProcessor
  /** 话语事件（speech_start/speech_end，含 audio）。 */
  readonly onEvent: (event: VadEvent) => void
  /**
   * P3V-09：每个通过校验的原始帧（流式 ASR 要连续喂，不能只拿 VAD 切好的段）。
   *
   * 为什么必须**每一帧**都给、而不是只在说话期间给：VAD 需要累计几帧才敢判定
   * speech_start，等它开口了再喂，开头那几帧已经错过——流式识别会吃掉第一个字。
   * 让流式引擎自己吞下前面的静音，代价只是一点 CPU。
   *
   * 调用顺序在 processChunk **之后**：VAD 事件（含 barge-in）优先于识别喂料。
   */
  readonly onFrame?: (samples: Int16Array) => void
  /** 协议违规上报（计数由本会话持有，供状态查询/日志）。 */
  readonly onProtocolError?: (detail: string) => void
  /**
   * 对端（renderer）主动关闭 port 时回调——用于编排层复位「会话仍活跃」的
   * 状态（P3B-14 listening-service 借此把 active 置 false、丢弃实例，供
   * 下一次 start 重新起全链路）。main 主动 dispose 不触发。
   */
  readonly onRemoteClose?: () => void
}

export interface MicInputSession {
  /** 接管 port（幂等保护：仅一次）。 */
  attach(port: MicPortMainLike): void
  /** main 主动收尾：冲刷未完话语 + 关 port（幂等）。 */
  dispose(): void
  readonly attached: boolean
  readonly frames: number
  readonly protocolErrors: number
}

export function createMicInputSession(deps: MicInputSessionDeps): MicInputSession {
  let port: MicPortMainLike | null = null
  let frames = 0
  let protocolErrors = 0
  let disposed = false

  function emitFlush(): void {
    try {
      const event = deps.processor.flush()
      if (event !== null) deps.onEvent(event)
    } catch {
      /* 冲刷失败不阻断收尾 */
    }
  }

  function handleFrame(data: unknown): void {
    if (disposed) return
    if (!isMicFrameMessage(data)) {
      protocolErrors++
      deps.onProtocolError?.('non-frame message on mic port')
      return
    }
    if (!isValidMicFrameSamples(data.samples)) {
      protocolErrors++
      deps.onProtocolError?.(`invalid frame samples: ${data.samples.length}`)
      return
    }
    frames++
    for (const event of deps.processor.processChunk(data.samples)) {
      deps.onEvent(event)
    }
    if (deps.onFrame !== undefined) {
      try {
        deps.onFrame(data.samples)
      } catch {
        // 流式识别单帧出错不该打断采集：错误已由消费者自行上报
      }
    }
  }

  function handleClose(): void {
    if (disposed) return
    disposed = true
    // 对端关闭（renderer stop/出错）：冲刷未完话语后释放
    emitFlush()
    try {
      port?.close()
    } catch {
      /* 已关 */
    }
    port = null
    deps.processor.close()
    deps.onRemoteClose?.()
  }

  return {
    get attached(): boolean {
      return port !== null
    },
    get frames(): number {
      return frames
    },
    get protocolErrors(): number {
      return protocolErrors
    },

    attach(nextPort) {
      if (port !== null || disposed) {
        throw new Error('mic input session already attached or disposed')
      }
      port = nextPort
      nextPort.on('message', (event) => handleFrame(event.data))
      nextPort.on('close', handleClose)
      nextPort.start()
    },

    dispose() {
      if (disposed) {
        if (port !== null) {
          try {
            port.close()
          } catch {
            /* 已关 */
          }
          port = null
        }
        return
      }
      disposed = true
      emitFlush()
      try {
        port?.close()
      } catch {
        /* 已关 */
      }
      port = null
      deps.processor.close()
    }
  }
}
