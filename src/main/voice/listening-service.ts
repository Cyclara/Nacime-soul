// src/main/voice/listening-service.ts
// P3B-14：语音输入会话服务（main 侧编排）——接 mic port 帧 → VAD → ASR → 转写事件。
//
// 与 renderer capture session / P3B-13 传输的配对：
//   start()：确保主引擎（失败→备用，P3V-09）与 VAD 模型就绪
//            （主备都失败抛 AppError('ASR_MODEL_MISSING'/'ASR_INIT_FAIL')），
//            建 VadProcessor；随后等待 renderer 经 `voice:mic-port` 转发来的 port
//            （acceptMicPort）。
//   帧流动 → MicInputSession → VadProcessor 事件：
//     speech_start → voice-state 'vad-state active'（UI 说话指示）
//     speech_end   → engine.recognize(audio) → voice-state 'transcript'；
//                    识别失败 → 'asr-error'（会话继续，可重试）
//   stop()/port close → 冲刷未完话语（可能再出一次 transcript）→ 清理。
//
// P3V-09 主/备回退（S-023 §4.3：一次、不链式、必须发 asr-error 让用户看见）：
//   启动期：主引擎获取失败 → 发 asr-error → 尝试用户指定的备用 →
//           备用成功则整场会话跑在备用上；主备都失败按现行 IPC 合同抛 AppError
//           （此时麦克风/VAD 还没起来，没有「会话可继续」可言）。
//   识别期：feed/recognize 抛错 → 发 asr-error → 本会话至多一次切换到备用
//           （异步完成，下一句生效；切换失败只再发一条 asr-error，不再链式）。
//           会话不因识别失败终止——这是「明确报错但监听会话可继续」的落点。
//   自动回退绝不写回 config：引擎切换仅用户显式路径（P3B-11 冻结政策）。
//
// 单例：同时至多一个活跃监听会话；重复 start 幂等；stop 幂等。

import { AppError } from '@shared/errors'
import type { MetricsRegistry } from '@shared/observability/types'
import { AsrEngineError } from './asr/engine-error'
import type { AsrEngineManager } from './asr/engine-manager'
import { isStreamingAsrEngineId, type AsrEngineId } from '@shared/voice/asr-settings-types'
import type { AsrErrorCode } from '@shared/voice/asr-types'
import type { AsrStreamSession } from '@shared/voice/asr-stream-types'
import type { VadProcessor } from './vad/vad-processor'
import { createMicInputSession, type MicInputSession } from './mic/mic-input-session'
import type { MicPortMainLike } from './mic/mic-input-session'
import type { VoiceEvent, VoiceVadState } from '@shared/voice/voice-events'

export type { MicPortMainLike }

export interface VoiceListeningDeps {
  readonly engineManager: AsrEngineManager
  /** VAD 管线工厂：给定模型路径产 VadProcessor（组合根注入 vadBinding）。 */
  readonly createVadProcessor: (modelPath: string) => VadProcessor
  readonly emitEvent: (event: VoiceEvent) => void
  /**
   * P3B-19：VAD speech_start（用户开口）回调——barge-in 打断当前 TTS/早播。
   * 可选：未注入时监听仍工作，只是不打断。防自打断依赖 P3B-13 的
   * echoCancellation（扬声器回声在采集端被抑制），此处不再重复实现回声门。
   */
  readonly onSpeechStart?: () => void
  /** P3B-21：ASR 延迟/错误/进程 RSS；未注入时语音行为不变。 */
  readonly metrics?: MetricsRegistry
  readonly now?: () => number
  readonly processRssBytes?: () => number
}

export interface VoiceListeningService {
  /** 幂等开始：引擎（主→备）+VAD 就绪检查 + 建 VAD 管线；主备都缺抛 AppError。 */
  start(): Promise<void>
  /** 接 renderer 转交的 mic port（每次 start 恰好一个）。 */
  acceptMicPort(port: MicPortMainLike): void
  /** 停止（用户路径）：冲刷未完话语后清理。幂等。 */
  stop(): Promise<void>
  readonly active: boolean
  readonly vadState: VoiceVadState
}

export function createVoiceListeningService(deps: VoiceListeningDeps): VoiceListeningService {
  let processor: VadProcessor | null = null
  let micSession: MicInputSession | null = null
  let active = false
  let vadState: VoiceVadState = 'idle'
  /** 生效引擎的流式会话；离线路径恒为 null（feedStreamFrame 自行判空）。 */
  let streamSession: AsrStreamSession | null = null
  /** P3V-09：当前生效引擎（主，或已切换的备用）；null = 尚未获取。 */
  let activeEngineId: AsrEngineId | null = null
  /** P3V-09：本会话是否已消耗过备用（含启动期那次）——只回退一次，不链式。 */
  let fallbackAttempted = false
  const now = deps.now ?? Date.now
  const processRssBytes = deps.processRssBytes ?? (() => process.memoryUsage().rss)

  function recordAsrError(): void {
    try {
      deps.metrics?.counter('asr.errors').inc()
    } catch {
      /* 指标失败不影响识别 */
    }
  }

  function recordAsrProcessRss(): void {
    try {
      deps.metrics?.gauge('asr.processRssMb').set(processRssBytes() / (1024 * 1024))
    } catch {
      /* 指标失败不影响识别 */
    }
  }

  function emit(event: VoiceEvent): void {
    deps.emitEvent(event)
  }

  function setVadState(next: VoiceVadState): void {
    if (vadState === next) return
    vadState = next
    emit({ type: 'vad-state', state: next })
  }

  function asrCodeOf(err: unknown): AsrErrorCode {
    return err instanceof AsrEngineError ? err.asrCode : 'recognize-failed'
  }

  /**
   * 获取指定引擎（流式→开好会话；离线→加载实例，返回 null 会话）。
   * 抛 AsrEngineError（model-missing / engine-init-failed 等），由调用方决定回退。
   */
  async function acquireEngine(engineId: AsrEngineId): Promise<AsrStreamSession | null> {
    if (isStreamingAsrEngineId(engineId)) {
      // 会话在这里就开：模型加载是长任务，绝不能等到第一帧音频到达才做
      return (await deps.engineManager.ensureStreamingEngineReady(engineId)).startStream()
    }
    await deps.engineManager.ensureEngineReady(engineId)
    return null
  }

  /**
   * P3V-09 识别期回退：本会话至多一次切到用户指定的备用。
   * 异步完成——正在说的这句话已经报过 asr-error 了，切换从下一句开始生效。
   */
  function attemptFallbackSwap(): void {
    if (fallbackAttempted || !active) return
    const fallback = deps.engineManager.fallbackEngineId()
    if (fallback === null || fallback === activeEngineId) return
    fallbackAttempted = true
    void (async () => {
      try {
        const session = await acquireEngine(fallback)
        if (!active) {
          // 等待加载期间会话已结束：刚开的流式会话必须就地归还
          session?.dispose()
          return
        }
        // 先收尾旧路径再交接：旧流式会话冲刷尾巴（可能吐最后一段 transcript）
        disposeStreamSession()
        activeEngineId = fallback
        streamSession = session
      } catch (err) {
        // 备用也没起来：发明确错误，会话继续（保持当前引擎，下一句照旧尝试）
        recordAsrError()
        emit({ type: 'asr-error', code: asrCodeOf(err) })
      }
    })()
  }

  async function recognize(audio: Int16Array): Promise<void> {
    const engineId = activeEngineId
    if (engineId === null) return
    const startedAt = now()
    try {
      const engine = await deps.engineManager.ensureEngineReady(engineId)
      const result = await engine.recognize(audio)
      const text = result.text.trim()
      if (text.length > 0) {
        emit({ type: 'transcript', text })
      }
    } catch (err) {
      recordAsrError()
      emit({ type: 'asr-error', code: asrCodeOf(err) })
      attemptFallbackSwap()
    } finally {
      try {
        deps.metrics?.histogram('asr.latencyMs').observe(Math.max(0, now() - startedAt))
      } catch {
        /* 指标失败不影响识别 */
      }
      recordAsrProcessRss()
    }
  }

  /** 流式：把一帧喂进识别器，产出半成品事件；长独白由识别器自身 endpoint 兜底切段。 */
  function feedStreamFrame(samples: Int16Array): void {
    const session = streamSession
    if (session === null) return
    try {
      session.feed(samples)
      const forced = session.takeFinalAtEndpoint()
      if (forced !== null) {
        // 用户一口气说了很久、VAD 还没等到静音：先把这段交出去，别让消息无限长
        emit({ type: 'transcript', text: forced.text })
        return
      }
      const partial = session.partial()
      if (partial !== null) {
        emit({ type: 'transcript-partial', text: partial.text })
      }
    } catch (err) {
      recordAsrError()
      emit({ type: 'asr-error', code: asrCodeOf(err) })
      attemptFallbackSwap()
    }
  }

  /** 流式：VAD 判定这句说完了，把当前文本定稿。 */
  function commitStreamUtterance(): void {
    const session = streamSession
    if (session === null) return
    const startedAt = now()
    try {
      const final = session.takeFinalNow()
      if (final !== null && final.text.trim().length > 0) {
        emit({ type: 'transcript', text: final.text.trim() })
      }
    } catch (err) {
      recordAsrError()
      emit({ type: 'asr-error', code: asrCodeOf(err) })
      attemptFallbackSwap()
    } finally {
      try {
        deps.metrics?.histogram('asr.latencyMs').observe(Math.max(0, now() - startedAt))
      } catch {
        /* 指标失败不影响识别 */
      }
      recordAsrProcessRss()
    }
  }

  /** 收尾流式会话：冲刷尾巴（可能再出一次 transcript）后释放。 */
  function disposeStreamSession(): void {
    const session = streamSession
    if (session === null) return
    streamSession = null
    try {
      const tail = session.finish()
      if (tail !== null && tail.text.trim().length > 0) {
        emit({ type: 'transcript', text: tail.text.trim() })
      }
    } catch {
      /* 冲刷失败不阻断收尾 */
    }
    session.dispose()
  }

  function teardown(reason: 'user' | 'mic-closed' | 'error'): void {
    if (!active) return
    active = false
    if (micSession !== null) {
      // 必须先让 VAD flush：若它产出 speech_end，回调还需要当前 streamSession
      // 调 takeFinalNow。反过来先置空 stream 会误走离线 recognize 分支。
      micSession.dispose()
      micSession = null
    }
    disposeStreamSession()
    processor?.close()
    processor = null
    activeEngineId = null
    vadState = 'idle'
    emit({ type: 'listening-stopped', reason })
  }

  /** 对端（renderer）主动关闭 mic port：复位会话供下次 start 重起全链路。 */
  function onRemoteMicClosed(): void {
    if (!active) return
    // MicInputSession.handleClose 已在调用本回调前 flush VAD；streamSession 此时仍在，
    // speech_end 已能先定稿。这里只冲刷识别器自身还没形成 VAD 事件的尾巴。
    active = false
    micSession = null
    disposeStreamSession()
    processor?.close()
    processor = null
    activeEngineId = null
    vadState = 'idle'
    emit({ type: 'listening-stopped', reason: 'mic-closed' })
  }

  return {
    get active(): boolean {
      return active
    },
    get vadState(): VoiceVadState {
      return vadState
    },

    async start() {
      if (active) return
      if (!deps.engineManager.vadModelReady()) {
        throw new AppError({
          code: 'ASR_MODEL_MISSING',
          userMessage: '语音检测模型未下载，请先在语音设置中下载模型',
          severity: 'error',
          retryable: true
        })
      }
      activeEngineId = null
      fallbackAttempted = false
      let pendingStreamSession: AsrStreamSession | null = null
      // 主引擎获取失败 → 备用（各发一条 asr-error 让用户看见降级）；
      // 两次都失败才抛 AppError——此时麦克风/VAD 未启动，「会话继续」无从谈起。
      let lastAcquireError: unknown = null
      try {
        const primary = deps.engineManager.selectedEngineId()
        pendingStreamSession = await acquireEngine(primary)
        activeEngineId = primary
      } catch (primaryErr) {
        lastAcquireError = primaryErr
        recordAsrError()
        emit({ type: 'asr-error', code: asrCodeOf(primaryErr) })
        const primaryId = activeEngineId ?? deps.engineManager.selectedEngineId()
        const fallback = deps.engineManager.fallbackEngineId()
        if (fallback !== null && fallback !== primaryId) {
          try {
            pendingStreamSession = await acquireEngine(fallback)
            activeEngineId = fallback
            // 启动期的备用切换同样消耗掉本会话的一次回退名额
            fallbackAttempted = true
          } catch (fallbackErr) {
            lastAcquireError = fallbackErr
            recordAsrError()
            emit({ type: 'asr-error', code: asrCodeOf(fallbackErr) })
          }
        }
        if (activeEngineId === null) {
          if (
            lastAcquireError instanceof AsrEngineError &&
            lastAcquireError.asrCode === 'model-missing'
          ) {
            throw new AppError({
              code: 'ASR_MODEL_MISSING',
              userMessage: '语音识别模型未下载，请先在语音设置中下载模型',
              severity: 'error',
              retryable: true
            })
          }
          throw new AppError({
            code: 'ASR_INIT_FAIL',
            cause: lastAcquireError,
            userMessage: '语音识别初始化失败',
            severity: 'error',
            retryable: true
          })
        }
      }
      recordAsrProcessRss()
      const modelPath = deps.engineManager.vadModelPath()
      if (modelPath === null) {
        // VAD 模型这时才发现不可用：流式会话已经开了，必须还回去再抛
        pendingStreamSession?.dispose()
        throw new AppError({
          code: 'ASR_MODEL_MISSING',
          userMessage: '语音检测模型不可用，请重新下载',
          severity: 'error',
          retryable: true
        })
      }
      let vadProcessor: VadProcessor
      try {
        vadProcessor = deps.createVadProcessor(modelPath)
      } catch (err) {
        // OnlineStream 已经创建，但 VAD 原生构造仍可能失败。若不在这里归还，
        // start() 虽然失败，数百 MB recognizer 下的 stream 引用却会一直挂到进程退出。
        pendingStreamSession?.dispose()
        recordAsrError()
        throw new AppError({
          code: 'ASR_INIT_FAIL',
          cause: err,
          userMessage: '语音检测初始化失败',
          severity: 'error',
          retryable: true
        })
      }
      processor = vadProcessor
      streamSession = pendingStreamSession
      vadState = 'idle'
      micSession = createMicInputSession({
        processor: vadProcessor,
        onEvent: (event) => {
          if (event.type === 'speech_start') {
            setVadState('active')
            // P3B-19：barge-in——用户开口先打断 TTS，再继续采集本轮话语
            try {
              deps.onSpeechStart?.()
            } catch {
              /* 打断失败不阻断监听 */
            }
            return
          }
          if (event.type === 'speech_end') {
            setVadState('idle')
            // 流式：文本已经在逐帧解出来了，这里只是把它定稿；
            // 离线：这时才把整段音频交给识别器。
            if (streamSession !== null) commitStreamUtterance()
            else void recognize(event.audio)
          }
        },
        // 恒接 onFrame：流式引擎要连续喂料（含 VAD 判定开口前的那几帧）；离线路径
        // feedStreamFrame 判空即返回。P3V-09 识别期可能异步切到流式备用——mic 会话
        // 的回调只能在创建时给，到时再想接帧就来不及了。
        onFrame: feedStreamFrame,
        onRemoteClose: onRemoteMicClosed
      })
      active = true
      emit({ type: 'listening-started' })
    },

    acceptMicPort(port) {
      if (micSession === null || !active) {
        // 无活跃会话：拒绝并立即关闭（防陈旧 port 挂死）
        port.close()
        return
      }
      micSession.attach(port)
    },

    async stop() {
      if (!active) return
      teardown('user')
    }
  }
}
