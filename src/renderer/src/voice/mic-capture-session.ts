// src/renderer/src/voice/mic-capture-session.ts
// P3B-13：麦克风采集会话（renderer 侧）——getUserMedia → AudioContext(16k) →
// AudioWorklet → 512 样本 s16le 帧 → 专用 port 转发给 main。
//
// 验收对位（S-Phase3 P3B-13）：
//   - 「不复制全量 buffer」：worklet 产帧即 transfer（worklet→页面→main 两跳
//     全是 transferable），页面线程不做任何整段拷贝；话语缓冲（60s 上限）只在
//     main 侧 VadProcessor 内存在。
//   - 「权限失败可恢复」：getUserMedia 拒绝 → 会话回到 idle + lastError
//     （kind=permission-denied），再次 start() 即重试（用户授权后）。
//   - 「停止后 track 关闭」：stop()/出错清理都 track.stop()（麦克风灯灭）+
//     AudioContext.close()；output port 由本会话独占，stop() 时关闭——port
//     生命周期 = 采集会话生命周期，main 侧靠 close 事件收尾。
//   - 「设备拔出」：track 'ended' 事件 → 清理 + device-lost 错误（可恢复，
//     换设备重开）。
//
// 全依赖注入（getUserMedia/AudioContext/worklet node/port 都是 Like 接口）：
// 单测在 node 环境跑，不碰真实浏览器 API（S-004）。真实浏览器装配见
// browserMicCaptureDeps()（仅供生产装配调用，测试不触）。

import { isMicFrameMessage } from '@shared/voice/mic-types'

export type MicCaptureStatus = 'idle' | 'starting' | 'capturing'

export type MicCaptureErrorKind =
  | 'permission-denied' /** getUserMedia 拒绝：可重试（用户授权后） */
  | 'not-found' /** 无满足约束的设备：可换设备重试 */
  | 'device-lost' /** 采集中设备移除/失效：清理后可重开 */
  | 'failed' /** 其他失败（worklet 加载失败等） */

export interface MicCaptureError {
  readonly kind: MicCaptureErrorKind
  readonly message: string
}

export interface MicTrackLike {
  stop(): void
  addEventListener(type: 'ended', listener: () => void): void
}

export interface MicStreamLike {
  getAudioTracks(): readonly MicTrackLike[]
}

/** 消息 port（浏览器 MessagePort / AudioWorkletNode.port 的最小面）。 */
export interface MicPortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void
  close(): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
}

export interface MicCaptureContextLike {
  readonly audioWorklet: { addModule(url: string): Promise<void> }
  createWorkletNode(name: string): MicPortLike
  close(): Promise<void>
}

export interface MicCaptureConstraints {
  audio: {
    channelCount: number
    echoCancellation: boolean
    noiseSuppression: boolean
    autoGainControl: boolean
    deviceId?: { exact: string }
  }
}

export interface MicCaptureSessionDeps {
  readonly getUserMedia: (constraints: MicCaptureConstraints) => Promise<MicStreamLike>
  readonly createAudioContext: (options: { sampleRate: number }) => MicCaptureContextLike
  readonly workletUrl: string
  /** 输出 port（转交 main 的 MessageChannel 本端）；会话独占，stop() 时 close。 */
  readonly outputPort: MicPortLike
  readonly onStatusChange?: (status: MicCaptureStatus) => void
  readonly onError?: (error: MicCaptureError) => void
  /** 每帧输入电平 RMS 0..1（UI 电平表；renderer 本地，不走 IPC）。 */
  readonly onLevel?: (level: number) => void
}

export interface MicCaptureSession {
  readonly status: MicCaptureStatus
  readonly lastError: MicCaptureError | null
  /** 开始采集；权限拒绝等以 typed 错误 reject（同时记录 lastError）。 */
  start(deviceId?: string): Promise<void>
  /** 停止采集（幂等）：track.stop + ctx.close + outputPort.close。 */
  stop(): Promise<void>
}

/** getUserMedia 错误名 → 分类。 */
export function classifyCaptureError(err: unknown): MicCaptureErrorKind {
  const name = err instanceof Error ? err.name : ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'permission-denied'
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'not-found'
    default:
      return 'failed'
  }
}

/** 帧电平（RMS，0..1）。 */
export function frameLevel(samples: Int16Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] / 32_768
    sum += v * v
  }
  return Math.sqrt(sum / samples.length)
}

export function createMicCaptureSession(deps: MicCaptureSessionDeps): MicCaptureSession {
  let status: MicCaptureStatus = 'idle'
  let lastError: MicCaptureError | null = null
  let track: MicTrackLike | null = null
  let context: MicCaptureContextLike | null = null
  let nodePort: MicPortLike | null = null
  let nodeListener: ((event: { data: unknown }) => void) | null = null
  let cleaning = false

  function setStatus(next: MicCaptureStatus): void {
    status = next
    deps.onStatusChange?.(next)
  }

  function fail(error: MicCaptureError): void {
    lastError = error
    deps.onError?.(error)
  }

  const onTrackEnded = (): void => {
    if (status !== 'capturing' || track === null) return
    void cleanup()
    setStatus('idle')
    fail({ kind: 'device-lost', message: '麦克风设备已移除或失效' })
  }

  async function cleanup(): Promise<void> {
    if (cleaning) return
    cleaning = true
    const currentTrack = track
    const currentContext = context
    const currentNodePort = nodePort
    const currentNodeListener = nodeListener
    track = null
    context = null
    nodePort = null
    nodeListener = null
    if (currentNodePort !== null && currentNodeListener !== null) {
      currentNodePort.removeEventListener('message', currentNodeListener)
    }
    // 数据面先同步关闭（main 立即收到 close 收尾），再释放设备侧资源
    deps.outputPort.close()
    if (currentTrack !== null) currentTrack.stop()
    if (currentContext !== null) {
      try {
        await currentContext.close()
      } catch {
        /* context 已坏（设备拔出常见）：忽略，资源随 ctx 回收 */
      }
    }
    cleaning = false
  }

  return {
    get status(): MicCaptureStatus {
      return status
    },
    get lastError(): MicCaptureError | null {
      return lastError
    },

    async start(deviceId) {
      if (status !== 'idle') {
        throw new Error(`mic capture busy: ${status}`)
      }
      setStatus('starting')
      try {
        const stream = await deps.getUserMedia({
          audio: {
            channelCount: 1,
            // P3B-19 前置：回声消除必须开（不把扬声器回声送 ASR/触发 barge-in）
            echoCancellation: true,
            // 浏览器 NS 会畸变语音伤 ASR 准确率；噪声由 Silero 概率门扛
            noiseSuppression: false,
            autoGainControl: true,
            ...(deviceId !== undefined ? { deviceId: { exact: deviceId } } : {})
          }
        })
        const audioTrack = stream.getAudioTracks()[0]
        if (audioTrack === undefined) {
          throw Object.assign(new Error('no audio track'), { name: 'NotFoundError' })
        }
        track = audioTrack
        track.addEventListener('ended', onTrackEnded)

        const ctx = deps.createAudioContext({ sampleRate: 16_000 })
        context = ctx
        await ctx.audioWorklet.addModule(deps.workletUrl)
        const port = ctx.createWorkletNode('mic-frame-processor')
        nodePort = port
        const listener = (event: { data: unknown }): void => {
          const data = event.data
          if (!isMicFrameMessage(data)) return
          deps.onLevel?.(frameLevel(data.samples))
          deps.outputPort.postMessage(data, [data.samples.buffer])
        }
        nodeListener = listener
        port.addEventListener('message', listener)
        setStatus('capturing')
      } catch (err) {
        await cleanup()
        setStatus('idle')
        const kind = classifyCaptureError(err)
        const message = err instanceof Error ? err.message : String(err)
        fail({ kind, message })
        throw Object.assign(new Error(`${kind}: ${message}`), { kind })
      }
    },

    async stop() {
      // 无条件 cleanup：即使从未 start 过也关闭 outputPort（会话独占语义，
      // 不关就漏——port 生命周期 = 会话生命周期）
      await cleanup()
      if (status !== 'idle') setStatus('idle')
    }
  }
}

/** 生产装配：真实浏览器 API → Like 接口（测试不触）。 */
export function browserMicCaptureDeps(
  workletUrl: string
): Omit<MicCaptureSessionDeps, 'outputPort'> {
  return {
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    createAudioContext: (options) => {
      const ctx = new AudioContext(options)
      return {
        audioWorklet: ctx.audioWorklet,
        createWorkletNode: (name) => new AudioWorkletNode(ctx, name).port,
        close: () => ctx.close()
      }
    },
    workletUrl
  }
}
