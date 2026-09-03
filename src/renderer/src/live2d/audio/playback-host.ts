// src/renderer/src/live2d/audio/playback-host.ts
// P3B-15（F5-007 §1.14）：stage 侧唯一 PlaybackHost 的传输层。
//
// 契约引用（§1.14）：
//   - main 建 MessageChannelMain 后经 `voice:audio-port`（preload 桥）把
//     {generation} + port 交到这里；port 生命周期 = stage 会话。
//   - attach 后立即发 creditSequence=0 的绝对 credit 冻结 capacityBytes；此后只在
//     帧真正释放时递增 creditSequence 并报告新的绝对 availableBytes（绝不做加法）。
//   - 帧从到达起一直占容量，直到播放结束/取消/错误释放（P3B-16 接入 AudioContext
//     播放器后由 ended 触发；本任务默认 sink 立即释放并计数——不谎称在播）。
//   - 所有消息带 generation；旧 generation/迟到帧直接丢弃。
//
// 与 main 的对称校验：入站消息用 shared 的 isMainToStageAudioMessage 做 shape/size/token
// 校验（renderer 侧是不可信输入面）；出站形状由 main 的 isStageToMainAudioMessage 认。

import { isMainToStageAudioMessage, isStageToMainAudioMessage } from '@shared/voice/playback-types'
import type { PcmPlaybackRequest } from '@shared/voice/playback-types'

/** 单个 generation 的帧驻留预算（协议上限内）。15s@24kHz f32 ≈ 1.44MB。 */
export const STAGE_PLAYBACK_CAPACITY_BYTES = 1_440_000

/** DOM MessagePort 形状（renderer 侧 port 来自 window.postMessage event.ports）。 */
export interface StageAudioPortLike {
  start(): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(message: unknown): void
  close(): void
}

/**
 * 帧消费 sink。P3B-16 用 AudioContext 播放器实现真播放：play 后持帧，ended/cancel/
 * error 时调用 onReleased。P3B-15 默认 DiscardFrameSink（立即释放 + 计数）。
 */
export interface StageFrameSink {
  play(frame: PcmPlaybackRequest, onReleased: (frameId: string) => void): void
  /** 当前所有在播/驻留帧的释放入口（cancel/dispose/换 generation 时）。 */
  stop(): void
}

/** P3B-15 默认 sink：不播放（无 AudioContext），帧立即释放回容量——绝不谎称在播。 */
export interface DiscardFrameSinkStats {
  droppedFrames: number
  droppedBytes: number
}

export function createDiscardFrameSink(stats: DiscardFrameSinkStats): StageFrameSink {
  return {
    play(frame, onReleased) {
      stats.droppedFrames += 1
      stats.droppedBytes += frame.pcm.byteLength
      onReleased(frame.frameId)
    },
    stop() {
      /* 无驻留 */
    }
  }
}

export interface StagePlaybackHost {
  /** 当前挂载的 generation（未 attach = null）。 */
  readonly generation: string | null
  /** 仍驻留（未释放）的帧数。 */
  readonly residentFrameCount: number
  /** 仍驻留的字节数（供诊断/测试断言 credit 正确性）。 */
  readonly residentBytes: number
  /** 收到的非法入站消息计数（shape/generation/frameId/容量违规）。 */
  readonly protocolErrors: number
  /** 转交来新 port 时替换旧 generation（旧 port 关闭、旧帧全部作废）。 */
  attach(generation: string, port: StageAudioPortLike): void
  /**
   * P3B-18：把 sink（音频播放器）的 segment started/ended 回报转发给 main。
   * 只放行当前 generation 的合法 StageToMainAudioMessage；无 port/旧 generation 静默丢弃。
   */
  forwardToMain(message: unknown): void
  /** stage teardown：停 sink、释放帧、关 port。幂等。 */
  dispose(): void
}

export function createStagePlaybackHost(options?: {
  capacityBytes?: number
  sink?: StageFrameSink
  warn?: (message: string) => void
}): StagePlaybackHost {
  const capacityBytes = options?.capacityBytes ?? STAGE_PLAYBACK_CAPACITY_BYTES
  const warn = options?.warn ?? ((message: string): void => console.warn(message))
  const sink = options?.sink ?? createDiscardFrameSink({ droppedFrames: 0, droppedBytes: 0 })

  let current: { generation: string; port: StageAudioPortLike } | null = null
  let creditSequence = -1
  let protocolErrors = 0
  // frameId -> 驻留字节；唯一（重复帧拒绝）
  const resident = new Map<string, number>()
  let disposed = false

  function residentBytes(): number {
    let total = 0
    for (const bytes of resident.values()) total += bytes
    return total
  }

  function sendCredit(): void {
    if (current === null) return
    creditSequence += 1
    current.port.postMessage({
      type: 'credit',
      generation: current.generation,
      capacityBytes,
      availableBytes: Math.max(0, capacityBytes - residentBytes()),
      creditSequence
    })
  }

  function releaseFrame(frameId: string): void {
    if (resident.delete(frameId)) sendCredit()
  }

  function detachUnsafe(): void {
    const old = current
    current = null
    creditSequence = -1
    resident.clear()
    // P3B-16 接真播放器后：换 generation/dispose 必须同步停声——旧 generation 的
    // 音频不许越过 generation 边界继续播（§1.14 第 5 条）。stop 幂等。
    sink.stop()
    if (old !== null) {
      try {
        old.port.close()
      } catch {
        /* 关闭竞态 */
      }
    }
  }

  function handleMessage(data: unknown): void {
    const host = current
    if (host === null || disposed) return
    if (!isMainToStageAudioMessage(data)) {
      protocolErrors += 1
      warn(`playback host: dropped malformed message (${protocolErrors})`)
      return
    }
    const message = data
    if (message.generation !== host.generation) {
      protocolErrors += 1
      warn(`playback host: dropped stale-generation message (${protocolErrors})`)
      return
    }
    switch (message.type) {
      case 'audio': {
        if (resident.has(message.frameId)) {
          // 重复帧拒绝（§1.14：frameId 是唯一 token）
          protocolErrors += 1
          warn(`playback host: duplicate frame rejected (${protocolErrors})`)
          return
        }
        if (residentBytes() + message.pcm.byteLength > capacityBytes) {
          // main 侧不该超发（发送前已核 credit）；防御性丢弃并回报一次现状 credit
          protocolErrors += 1
          warn(`playback host: frame over capacity dropped (${protocolErrors})`)
          sendCredit()
          return
        }
        resident.set(message.frameId, message.pcm.byteLength)
        try {
          sink.play(message, (frameId) => releaseFrame(frameId))
        } catch (error) {
          // P3B-16：真播放器可能在建图/调度时抛错——错误时释放（§1.14），帧不永久占容量。
          resident.delete(message.frameId)
          sendCredit()
          protocolErrors += 1
          warn(
            `playback host: sink threw on play; frame released (${
              error instanceof Error ? error.message : String(error)
            })`
          )
        }
        return
      }
      case 'cancel': {
        sink.stop()
        // 未播/驻留帧全部作废并恰好一次回容量（§1.14 第 3 条）
        resident.clear()
        sendCredit()
        host.port.postMessage({
          type: 'cancelled',
          generation: host.generation,
          reason: message.reason
        })
        return
      }
      case 'dispose': {
        sink.stop()
        resident.clear()
        sendCredit()
        detachUnsafe()
        return
      }
    }
  }

  return {
    get generation() {
      return current?.generation ?? null
    },
    get residentFrameCount() {
      return resident.size
    },
    get residentBytes() {
      return residentBytes()
    },
    get protocolErrors() {
      return protocolErrors
    },

    attach(generation, port) {
      if (disposed) return
      detachUnsafe() // 旧 generation 全部作废（§1.14 第 5 条）
      current = { generation, port }
      creditSequence = -1
      port.addEventListener('message', (event) => handleMessage(event.data))
      port.start()
      // 首个 credit 冻结 capacity（creditSequence=0，§1.14 第 2 条）
      sendCredit()
    },

    dispose() {
      if (disposed) return
      disposed = true
      sink.stop()
      resident.clear()
      detachUnsafe()
    },

    forwardToMain(message) {
      const host = current
      if (host === null || disposed) return
      if (!isStageToMainAudioMessage(message)) {
        protocolErrors += 1
        warn(`playback host: dropped malformed outbound segment event (${protocolErrors})`)
        return
      }
      if (message.generation !== host.generation) return // 旧 generation 的迟到回报
      try {
        host.port.postMessage(message)
      } catch {
        /* 关闭竞态：port 已死，回报随 generation 作废 */
      }
    }
  }
}
