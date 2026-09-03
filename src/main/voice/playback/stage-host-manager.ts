// src/main/voice/playback/stage-host-manager.ts
// P3B-15（F5-007 §1.14）：PlaybackHost 生命周期的 main 侧组合根。
//
// 职责：
//   - 生产 transport：stage ready 后建 MessageChannelMain，把 renderer port 经
//     `webContents.postMessage('voice:audio-port', {generation}, [port2])` 转交 stage
//     （专用数据面，普通 invoke/event 绝不承载 PCM——账本 §4.2 红线）。
//   - generation 生命周期：每次 stage ready = 新 generation + 新 port；port 关闭/
//     stage 销毁即失效，acquire() 返回 null（播放侧按 playback-host-unavailable
//     处理：当前轮 text-only），直到下一 stage ready 重建。
//   - credit/帧协议本身在 audio-port.ts（StageAudioPort）；本模块只负责
//     「什么时候有 host、host 是哪个 generation」。
//
// 传输抽象：StageWebContentsLike 面向 webContents.postMessage；测试注入内存假 channel。

import { randomUUID } from 'node:crypto'
import type { MessagePortMain } from 'electron'
import type { Logger } from '@shared/observability/types'
import type { Unsubscribe } from '@shared/ipc/contracts'
import { createStageAudioPort } from './audio-port'
import type { MessagePortMainLike, StageAudioPort } from './types'

/** 转交 port 的专用通道名（与 TTS PCM 同红线：不登记账本通道表）。 */
export const STAGE_AUDIO_PORT_CHANNEL = 'voice:audio-port'

export interface StageWebContentsLike {
  readonly id: number
  isDestroyed(): boolean
  postMessage(channel: string, message: unknown, transfer: MessagePortMain[]): void
}

/** 生产 channel 工厂（惰性 require：ELECTRON_RUN_AS_NODE 的 vitest 没有完整 electron 模块）。 */
function realChannel(): { port1: MessagePortMain; port2: MessagePortMain } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { MessageChannelMain } = require('electron') as typeof import('electron')
  const channel = new MessageChannelMain()
  return { port1: channel.port1, port2: channel.port2 }
}

/**
 * 生产 transport：MessageChannelMain + webContents.postMessage 转交 stage 端。
 * 返回 main 端（已 start）；stage 不可用/转交失败返回 null。单测注入假 channel 工厂。
 */
export function createMessageChannelStagePort(
  webContents: StageWebContentsLike,
  generation: string,
  channelFactory?: () => { port1: MessagePortMain; port2: MessagePortMain }
): MessagePortMainLike | null {
  if (webContents.isDestroyed()) return null
  const created = channelFactory?.() ?? realChannel()
  try {
    webContents.postMessage(STAGE_AUDIO_PORT_CHANNEL, { generation }, [created.port2])
  } catch {
    created.port1.close()
    created.port2.close()
    return null
  }
  created.port1.start()
  return created.port1
}

export interface PlaybackHostManagerDeps {
  /** 建 channel 并把 stage 端转交；返回 main 端。stage 不可用返回 null。 */
  createStageChannel: (
    webContents: StageWebContentsLike,
    generation: string
  ) => MessagePortMainLike | null
  /** 包一层 StageAudioPort（协议校验/credit）。生产 = createStageAudioPort；测试可记录。 */
  createPort?: (options: {
    generation: string
    port: MessagePortMainLike
    logger: Logger
  }) => StageAudioPort
  logger: Logger
  /** generation 唯一性（生产 randomUUID；测试注入计数器）。 */
  newGenerationId?: () => string
}

export interface PlaybackHostManager {
  /** stage ready 后调用（新 generation；旧 port 先关闭——旧窗口迟到事件全部作废）。 */
  attachStage(webContents: StageWebContentsLike): void
  /** stage 销毁/崩溃后调用；若当前 host 属于该 stage 则释放并通知 host 不可用。 */
  detachStage(webContentsId: number): void
  /** 当前 generation 的 live port；null = host 不可用（本轮/后续 text-only 直到重建）。 */
  acquire(): StageAudioPort | null
  /** 当前已挂载 generation（便于诊断/测试）。 */
  readonly generation: string | null
  /** app quit teardown。 */
  dispose(): void
  /** port 意外关闭/销毁时通知（后续 turn 也 text-only，直到 stage 重建恢复）。 */
  onHostUnavailable(handler: () => void): Unsubscribe
}

export function createPlaybackHostManager(deps: PlaybackHostManagerDeps): PlaybackHostManager {
  const logger = deps.logger
  const newGenerationId = deps.newGenerationId ?? randomUUID
  const createPort = deps.createPort ?? createStageAudioPort

  let current: { webContentsId: number; port: StageAudioPort } | null = null
  const unavailableHandlers = new Set<() => void>()

  function notifyUnavailable(): void {
    for (const handler of [...unavailableHandlers]) {
      try {
        handler()
      } catch {
        /* 通知者是播放层，异常不影响 host 生命周期 */
      }
    }
  }

  function dropCurrent(): void {
    if (current === null) return
    const dropped = current
    current = null
    dropped.port.close()
    notifyUnavailable()
  }

  return {
    get generation() {
      return current?.port.generation ?? null
    },

    attachStage(webContents) {
      // 旧 host 先释放：新 generation 从零开始（旧窗口/旧 port 迟到事件一律作废，§1.14）
      if (current !== null) dropCurrent()
      const generation = newGenerationId()
      const transportPort = deps.createStageChannel(webContents, generation)
      if (transportPort === null) {
        logger.warn('playback host: stage channel creation failed; staying unavailable', {
          scope: 'tts',
          tags: { generation }
        })
        notifyUnavailable()
        return
      }
      const port = createPort({ generation, port: transportPort, logger })
      port.onClosed(() => {
        // port 关闭 = host 失效（stage 销毁/崩溃/reload）：当前轮 text-only，
        // 后续轮也 text-only 直到新 stage ready 再次 attachStage。
        if (current !== null && current.port === port) dropCurrent()
      })
      current = { webContentsId: webContents.id, port }
    },

    detachStage(webContentsId) {
      if (current !== null && current.webContentsId === webContentsId) dropCurrent()
    },

    acquire() {
      return current !== null && current.port.isAlive ? current.port : null
    },

    dispose() {
      dropCurrent()
      unavailableHandlers.clear()
    },

    onHostUnavailable(handler) {
      unavailableHandlers.add(handler)
      return () => unavailableHandlers.delete(handler)
    }
  }
}
