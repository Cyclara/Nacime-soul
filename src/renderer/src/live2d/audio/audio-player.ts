// src/renderer/src/live2d/audio/audio-player.ts
// P3B-16（F5-007 §1.14）：stage 同一 AudioContext 的 PCM 播放 + 本地电平分析。
//
// 职责：
//   - 实现 StageFrameSink：AudioBufferSourceNode 顺序调度播放（后一帧排在当前播放
//     之后；设备追上进度即立即开播），帧真正播完/取消时恰好一次 onReleased——
//     PlaybackHost 只有收到它才回收 credit（§1.14 第 3 条：驻留期间一直占容量）。
//   - AnalyserNode 本地 RMS → 0..1 开口度目标值（噪声底/增益可注入）；平滑与
//     写参数在 motion/lipsync.ts（P3B-17），本模块不做任何 Live2D 写入。
//   - 不做 viseme/FFT 音素级口型（F5-008 调研结论留 Phase 5）：RMS 幅度已满足
//     「静音闭嘴、语音有变化、参数 0..1」验收，成本也低两个数量级。
//
// WebAudio 全部走窄 seam（AudioContextLike 等），单测注入内存假图——S-004 红线：
// 测试不加载真实声音设备。

import type { StageFrameSink } from './playback-host'

/** 窄 AudioContext seam（生产 = 真实 WebAudio；测试 = 内存假图）。 */
export interface AudioContextLike {
  readonly currentTime: number
  readonly sampleRate: number
  readonly destination: unknown
  /** DOM AudioContextState 还有 'interrupted'（iOS）；这里只关心是否 suspended。 */
  readonly state: string
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike
  createBufferSource(): AudioBufferSourceNodeLike
  createAnalyser(): AnalyserNodeLike
  resume(): Promise<void>
  close(): Promise<void>
}

export interface AudioBufferLike {
  getChannelData(channel: number): Float32Array
}

export interface AudioBufferSourceNodeLike {
  buffer: AudioBufferLike | null
  connect(destination: unknown): void
  start(when?: number): void
  stop(): void
  /** DOM 的 onended 是 (this, ev: Event) => any；seam 收敛为 (event: Event) => void。 */
  onended: ((event: Event) => void) | null
}

export interface AnalyserNodeLike {
  fftSize: number
  connect(destination: unknown): void
  getFloatTimeDomainData(target: Float32Array): void
}

/**
 * P3B-18：segment 播放回报（stage → main，经 playback-host.forwardToMain 转发）。
 * §1.14「started 才把 segment 标 playing；PCM ready 不等于用户已经听见」——
 * started = 首个 source 真正进入播放队列；ended = 末帧 source 播完释放。
 * cancel 路径不发 ended（playback-host 的 cancel 处理已回报 cancelled）。
 */
export interface StageSegmentPlaybackEvent {
  readonly type: 'started' | 'ended'
  readonly generation: string
  readonly segmentId: string
  /** started：source 计划开始时刻（墙钟 ms，有限整数）。 */
  readonly audioStartAt?: number
  /** ended：首帧调度到末帧释放的实际墙钟时长（ms）。 */
  readonly playedMs?: number
}

/** 生产 AudioContext 工厂。惰性调用（首次 play 才建），避免无手势窗口告警。 */
function createRealAudioContext(): AudioContextLike {
  return new AudioContext()
}

export interface StageAudioPlayer extends StageFrameSink {
  /** 最近一次分析的开口度目标（0..1）；从未播放/静音 = 0。 */
  readonly level: number
  /** 建图/调度/播放失败累计（诊断；不影响 credit 一致性）。 */
  readonly playErrors: number
  /** 当前电平目标：读 AnalyserNode 算 RMS → clamp((rms - noiseFloor) * gain, 0, 1)。 */
  readLevel(): number
  dispose(): void
}

export function createStageAudioPlayer(options?: {
  readonly createAudioContext?: () => AudioContextLike
  /** RMS 低于此值视为静音（默认 0.006 ≈ -44dBFS）。 */
  readonly noiseFloor?: number
  /** 电平增益（默认 14：普通说话 RMS ≈ 0.05..0.15 → 0.6..1）。 */
  readonly gain?: number
  /** 分析窗长（样本数；默认 1024 @24kHz ≈ 43ms）。 */
  readonly fftSize?: number
  /** P3B-18：segment started/ended 回报（转发给 playback-host → main）。 */
  readonly onSegmentEvent?: (event: StageSegmentPlaybackEvent) => void
  readonly now?: () => number
  readonly warn?: (message: string) => void
}): StageAudioPlayer {
  const noiseFloor = options?.noiseFloor ?? 0.006
  const gain = options?.gain ?? 14
  const fftSize = options?.fftSize ?? 1024
  const warn = options?.warn ?? ((message: string): void => console.warn(message))
  const createAudioContext = options?.createAudioContext ?? createRealAudioContext
  const onSegmentEvent = options?.onSegmentEvent
  const now = options?.now ?? Date.now

  let context: AudioContextLike | null = null
  let analyser: AnalyserNodeLike | null = null
  let analysisBuffer: Float32Array | null = null
  // 顺序调度游标：下一帧不得早于此时刻开始；设备追上（游标落后当前时间）即立即播。
  let nextStartAt = 0
  let level = 0
  let playErrors = 0
  let disposed = false
  interface ActiveFrame {
    frameId: string
    source: AudioBufferSourceNodeLike
    released: boolean
    onReleased: (frameId: string) => void
    /** P3B-18：segment 回报所需的帧元数据。 */
    readonly generation: string
    readonly segmentId: string
    readonly finalFrame: boolean
  }

  const active = new Set<ActiveFrame>()
  /** 在播 segment 账本：framesPending 归零且末帧已释放 → ended（恰好一次）。 */
  const openSegments = new Map<
    string,
    { framesPending: number; startedReported: boolean; startAtMs: number; endedReported: boolean }
  >()

  function ensureGraph(): AudioContextLike | null {
    if (context !== null) return context
    try {
      context = createAudioContext()
    } catch (error) {
      playErrors += 1
      warn(`audio player: AudioContext unavailable (${describeError(error)})`)
      return null
    }
    analyser = context.createAnalyser()
    analyser.fftSize = fftSize
    analyser.connect(context.destination)
    analysisBuffer = new Float32Array(fftSize)
    return context
  }

  function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  /** 恰好一次释放（onended 与 stop() 竞态都只回一次容量）+ segment ended 回报。 */
  function finishEntry(entry: ActiveFrame): void {
    if (entry.released) return
    entry.released = true
    active.delete(entry)
    entry.onReleased(entry.frameId)
    // P3B-18：segment 终报。stop()（cancel/dispose/换 generation）路径清空
    // openSegments，这里查不到就不报——cancelled 由 playback-host 的 cancel 处理回报。
    const segment = openSegments.get(entry.segmentId)
    if (segment === undefined) return
    segment.framesPending -= 1
    if (entry.finalFrame && segment.framesPending <= 0 && !segment.endedReported) {
      segment.endedReported = true
      openSegments.delete(entry.segmentId)
      onSegmentEvent?.({
        type: 'ended',
        generation: entry.generation,
        segmentId: entry.segmentId,
        playedMs: Math.max(0, now() - segment.startAtMs)
      })
    }
  }

  function stopAll(): void {
    // cancel/dispose/换 generation：静默清账（不发 ended——cancel 语义由 host 回报）
    openSegments.clear()
    for (const entry of [...active]) {
      try {
        entry.source.stop()
      } catch {
        /* 已停止/未启动的 source 再 stop 是合法 no-op 或抛错，均不影响释放 */
      }
      finishEntry(entry)
    }
  }

  return {
    get level() {
      return level
    },
    get playErrors() {
      return playErrors
    },

    readLevel() {
      if (disposed || analyser === null || analysisBuffer === null) return 0
      analyser.getFloatTimeDomainData(analysisBuffer)
      let sumSquares = 0
      for (let i = 0; i < analysisBuffer.length; i += 1) {
        sumSquares += analysisBuffer[i]! * analysisBuffer[i]!
      }
      const rms = Math.sqrt(sumSquares / analysisBuffer.length)
      const scaled = (rms - noiseFloor) * gain
      level = Math.min(1, Math.max(0, scaled))
      return level
    },

    play(frame, onReleased) {
      if (disposed) {
        onReleased(frame.frameId)
        return
      }
      const graph = ensureGraph()
      if (graph === null || analyser === null) {
        // 建图失败 fail-open：立即释放容量（不卡 credit），音频缺失只是没有声音。
        // playErrors/warn 已在 ensureGraph 记过一次，这里不重复计数。
        onReleased(frame.frameId)
        return
      }
      if (graph.state === 'suspended') {
        // 自动播放策略/设备暂挂：尽力恢复；本帧仍照常调度，恢复后继续出声。
        void graph.resume().catch(() => {
          /* 恢复失败保持静音；credit 一致性不受影响 */
        })
      }
      try {
        const input = new Float32Array(frame.pcm)
        const channels = Math.max(1, frame.format.channels)
        const samples = Math.floor(input.length / channels)
        if (samples === 0) {
          onReleased(frame.frameId)
          return
        }
        const buffer = graph.createBuffer(channels, samples, frame.format.sampleRate)
        for (let ch = 0; ch < channels; ch += 1) {
          const target = buffer.getChannelData(ch)
          for (let i = 0; i < samples; i += 1) {
            target[i] = input[i * channels + ch]! * frame.volume
          }
        }
        const source = graph.createBufferSource()
        source.buffer = buffer
        source.connect(analyser)
        const when = Math.max(graph.currentTime, nextStartAt)
        nextStartAt = when + samples / frame.format.sampleRate
        // P3B-18：首帧调度即报 started（audioStartAt=墙钟；「PCM ready ≠ 已听见」
        // 的对立面——started 表示真的进入播放时间线）。
        let segment = openSegments.get(frame.segmentId)
        if (segment === undefined) {
          segment = {
            framesPending: 0,
            startedReported: false,
            startAtMs: now(),
            endedReported: false
          }
          openSegments.set(frame.segmentId, segment)
        }
        segment.framesPending += 1
        if (!segment.startedReported) {
          segment.startedReported = true
          onSegmentEvent?.({
            type: 'started',
            generation: frame.generation,
            segmentId: frame.segmentId,
            audioStartAt: segment.startAtMs
          })
        }
        const entry: ActiveFrame = {
          frameId: frame.frameId,
          source,
          released: false,
          onReleased,
          generation: frame.generation,
          segmentId: frame.segmentId,
          finalFrame: frame.finalFrame
        }
        active.add(entry)
        source.onended = () => finishEntry(entry)
        source.start(when)
      } catch (error) {
        // 调度失败（buffer 分配/设备错误）：释放容量并继续收帧——错误时释放（§1.14）。
        playErrors += 1
        warn(`audio player: frame playback failed (${describeError(error)})`)
        onReleased(frame.frameId)
      }
    },

    stop: stopAll,

    dispose() {
      if (disposed) return
      disposed = true
      stopAll()
      const graph = context
      context = null
      analyser = null
      analysisBuffer = null
      nextStartAt = 0
      if (graph !== null) {
        void graph.close().catch(() => {
          /* 关闭竞态：进程退出路径，不影响一致性 */
        })
      }
    }
  }
}
