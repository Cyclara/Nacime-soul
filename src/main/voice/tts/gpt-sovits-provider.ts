// src/main/voice/tts/gpt-sovits-provider.ts
// P3B-06：GPT-SoVITS adapter--turn-bound provider，把冻结 ABI 的
// `synthesize(text, voice) -> Float32Array` 落到本地 api_v2 HTTP `/tts` 上。
//
// 请求形制（以本地已安装版 api_v2.py 为准，2026-08-30 实测克隆）：
//   POST {baseUrl}/tts  {text, text_lang, ref_audio_path, prompt_text?, prompt_lang,
//                        speed_factor, media_type:'wav', streaming_mode:false}
//   200 -> WAV 音频流；400 -> JSON {"message": ...}
//   注意 api_v2 **没有** /health 端点（health 由 P3B-05 服务管理器探测 GET /），
//   也**没有**采样率参数（输出采样率由模型代次决定）。
//
// 关键合同：
//   - voiceId -> GPT-SoVITS 语音参数的映射由注入的 resolveVoice 完成（组合根决定
//     从配置/音色目录怎么解析）；adapter 不持有任何音色注册表。
//   - 输出归一：WAV 解码（wav.ts：mono 下混、f32、clamp、NaN/Inf/坏容器拒绝）+
//     重采样到 requestedSampleRate（不变速变调）。`format` 是权威实际格式。
//   - speed 走 api_v2 原生 speed_factor，bind 时冻结；pitch api_v2 不支持（忽略，
//     注释明示）；volume 归播放侧（PcmPlaybackRequest.volume），不进请求也不预乘。
//   - 绑定时服务未就绪（冷启动可达分钟级）-> 本轮 textOnly 并后台预热，
//     绝不阻塞 turn 启动；合成时按需取**当前** baseUrl，服务中途重启换端口也能续上。
//   - 失败映射：网络/5xx/400 -> TTS_ENGINE_DOWN(retryable)；超时 -> TTS_TIMEOUT；
//     坏容器/超界 -> TTS_DECODE；用户取消 -> AbortError 原样穿透。
//   - 本地服务无任何 API key：请求永不带 Authorization 头；TTS 文本与音色路径
//     不进日志（只记 code/计数）。
//
// capabilities：非流式（F5-007 §1.3 明确非流式 GPT-SoVITS 每 segment 一次整段合成；
// api_v2 的 streaming_mode 是单响应内分块，不是 TtsStreamSession 的 append/commit 协议，
// 不伪装成 openStream 能力）。

import { AppError, isAppError } from '@shared/errors'
import type { Logger } from '@shared/observability/types'
import type {
  BoundTtsProvider,
  TtsProviderCapabilities,
  TtsProviderFactory
} from '@shared/voice/tts-types'
import type { GptSovitsService } from './gpt-sovits-service'
import { decodeWavToMonoF32, resampleLinearF32 } from './wav'

/** 结构化最小 Response 形状：secure fetch 的产物与测试假件都满足。 */
export interface GptSovitsHttpResponse {
  readonly status: number
  readonly headers?: { get(name: string): string | null }
  arrayBuffer(): Promise<ArrayBuffer>
}

export { GPT_SOVITS_PROVIDER_ID } from './gpt-sovits-constants'

export const GPT_SOVITS_CAPABILITIES: Readonly<TtsProviderCapabilities> = Object.freeze({
  streamingText: false,
  streamingAudio: false,
  supportsCancel: true,
  devTestOnly: false,
  segmentCorrelation: false
})

/** GPT-SoVITS 的音色参数（由组合根从配置解析；adapter 只消费）。 */
export interface GptSovitsVoiceConfig {
  readonly refAudioPath: string
  readonly promptText?: string
  /** 参考音频的语言，api_v2 必填。 */
  readonly promptLang: string
  /** 合成文本默认语言；api_v2 的 text_lang 必填。 */
  readonly defaultTextLang: string
  /**
   * P3V-19：该音色的 GPT 权重。声明了就在合成前确保已加载（/set_gpt_weights）；
   * 省略 = 用安装 tts_infer.yaml 里已加载的那套（P3B 单音色的老行为）。
   */
  readonly gptWeightsPath?: string
  /** P3V-19：该音色的 SoVITS 权重（/set_sovits_weights）。 */
  readonly sovitsWeightsPath?: string
}

export function createGptSovitsProviderFactory(deps: {
  readonly logger: Logger
  readonly service: GptSovitsService
  readonly fetch: (
    url: string,
    init?: {
      method?: string
      headers?: Record<string, string>
      body?: string
      signal?: AbortSignal
    }
  ) => Promise<GptSovitsHttpResponse>
  /** voiceId -> 音色参数；null = 未配置该音色。 */
  readonly resolveVoice: (voiceId: string) => GptSovitsVoiceConfig | null
  /** 单次合成超时；GPU 推理慢，默认由组合根定值（建议 60s）。 */
  readonly requestTimeoutMs: number
  /** 响应体上限（字节）：有界 PCM 验收；建议 64MB 级。 */
  readonly maxResponseBytes: number
}): TtsProviderFactory {
  function abortError(): Error {
    const err = new Error('gpt-sovits synthesis aborted')
    err.name = 'AbortError'
    return err
  }

  function isAbortError(err: unknown): boolean {
    return err instanceof Error && err.name === 'AbortError'
  }

  // ── P3V-19：动态权重切换（进程级状态，跨 turn 复用；bind 每轮新建不能持有它）──
  //
  // 「已加载哪套权重」的判据必须带服务代次：api_v2 重启后会按 tts_infer.yaml 重新加载
  // 默认权重，此时上一轮记的「已加载」就作废了。用 baseUrl + restartCount 当代次键。
  let loadedWeightsKey: string | null = null
  /** 串行闸：切权重与 /tts 合成共用一条队列——绝不允许一句话中途换权重。 */
  let queueTail: Promise<void> = Promise.resolve()

  /**
   * 进入临界区，返回释放函数（调用方必须在 finally 里释放）。
   * 前一个任务失败也照常放行下一个——一次失败不该永久卡死队列。
   */
  function acquireQueue(): Promise<() => void> {
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const waitPrevious = queueTail.then(
      () => undefined,
      () => undefined
    )
    queueTail = waitPrevious.then(() => held)
    return waitPrevious.then(() => release)
  }

  function weightsKey(baseUrl: string, gptPath: string, sovitsPath: string): string {
    return `${baseUrl}#${deps.service.restartCount()}#${gptPath}#${sovitsPath}`
  }

  async function callSetWeights(
    url: string,
    what: 'gpt' | 'sovits',
    signal: AbortSignal
  ): Promise<void> {
    const response = await deps.fetch(url, { method: 'GET', signal })
    if (response.status === 200) return
    let serverMessage = ''
    try {
      const raw = await response.arrayBuffer()
      serverMessage = new TextDecoder('utf-8').decode(raw.slice(0, 512)).replace(/\s+/g, ' ').trim()
    } catch {
      /* 诊断信息缺失不影响错误定性 */
    }
    throw new AppError({
      code: 'TTS_ENGINE_DOWN',
      userMessage: '切换音色失败，本轮改为纯文字。',
      severity: 'error',
      retryable: true,
      cause: new Error(
        `gpt-sovits set_${what}_weights http ${response.status}${
          serverMessage ? `: ${serverMessage}` : ''
        }`
      )
    })
  }

  /**
   * 确保 api_v2 已加载该音色的权重。两条 endpoint **串行**调用（官方 api_v2 是单
   * worker，并发切换会互相踩）；任一失败就清空「已加载」记账——此时引擎处于未知
   * 组合，下一次必须重切，绝不拿半套权重发声。
   */
  async function ensureWeightsLoaded(
    baseUrl: string,
    voiceConfig: GptSovitsVoiceConfig,
    signal: AbortSignal
  ): Promise<void> {
    const gptPath = voiceConfig.gptWeightsPath
    const sovitsPath = voiceConfig.sovitsWeightsPath
    // 未声明权重 = 沿用安装配置里已加载的那套（P3B 单音色老行为，不发多余请求）
    if (gptPath === undefined || sovitsPath === undefined) return
    const key = weightsKey(baseUrl, gptPath, sovitsPath)
    if (loadedWeightsKey === key) return
    loadedWeightsKey = null
    await callSetWeights(
      `${baseUrl}/set_gpt_weights?weights_path=${encodeURIComponent(gptPath)}`,
      'gpt',
      signal
    )
    await callSetWeights(
      `${baseUrl}/set_sovits_weights?weights_path=${encodeURIComponent(sovitsPath)}`,
      'sovits',
      signal
    )
    loadedWeightsKey = key
  }

  return {
    async bind(input) {
      if (input.options.voiceId.length === 0) {
        return { textOnly: true, reason: 'voice-missing' }
      }
      if (deps.resolveVoice(input.options.voiceId) === null) {
        return { textOnly: true, reason: 'voice-missing' }
      }
      const baseUrl = deps.service.baseUrl()
      if (baseUrl === null) {
        // 冷启动不阻塞 turn：本轮纯文字 + 后台预热（幂等；failed 时立即拒绝、无副作用）
        void deps.service.ensureReady().catch(() => {
          /* 预热失败已由服务管理器记账为 failed 并降级 */
        })
        return { textOnly: true, reason: 'provider-unhealthy' }
      }

      const requestedSampleRate = input.options.requestedSampleRate
      const speedFactor = input.options.speed
      const controller = new AbortController()
      const onOuterAbort = (): void => controller.abort()
      if (input.signal.aborted) controller.abort()
      else input.signal.addEventListener('abort', onOuterAbort, { once: true })

      const bound: BoundTtsProvider = {
        id: 'gpt-sovits',
        capabilities: GPT_SOVITS_CAPABILITIES,
        format: {
          sampleRate: requestedSampleRate,
          channels: 1,
          sampleFormat: 'f32le',
          interleaved: true
        },
        async synthesize(text, voice) {
          if (controller.signal.aborted) throw abortError()
          if (text.length === 0) return new Float32Array(0)
          if (voice.length === 0) throw new Error('gpt-sovits: voice must not be empty')

          const voiceConfig = deps.resolveVoice(voice)
          if (voiceConfig === null) {
            throw new AppError({
              code: 'TTS_ENGINE_DOWN',
              userMessage: '语音合成失败，本轮改为纯文字。',
              severity: 'error',
              retryable: false,
              cause: new Error(`unknown voice: ${voice}`)
            })
          }
          // 合成时取当前 baseUrl：服务中途崩溃重启换端口后，后续 segment 仍可用
          const currentBase = deps.service.baseUrl()
          if (currentBase === null) {
            throw new AppError({
              code: 'TTS_ENGINE_DOWN',
              userMessage: '语音服务当前不可用，本轮改为纯文字。',
              severity: 'error',
              retryable: true,
              cause: new Error('gpt-sovits service not running at synthesize time')
            })
          }

          // P3V-19：排队进入临界区——权重切换与本次 /tts 之间不能插进别的合成
          const releaseQueue = await acquireQueue()
          // 排队期间被取消（barge-in 打断很常见）：立刻退出，不发注定要丢弃的请求，
          // 更不要为它去切权重
          if (controller.signal.aborted) {
            releaseQueue()
            throw abortError()
          }
          const requestController = new AbortController()
          const onInnerAbort = (): void => requestController.abort()
          if (controller.signal.aborted) requestController.abort()
          else controller.signal.addEventListener('abort', onInnerAbort)
          const timeoutTimer = setTimeout(() => requestController.abort(), deps.requestTimeoutMs)
          // 忙碌账本要覆盖切权重：加载权重期间 api_v2 同样不响应 GET /
          deps.service.beginSynthesis()

          try {
            await ensureWeightsLoaded(currentBase, voiceConfig, requestController.signal)
            const response = await deps.fetch(`${currentBase}/tts`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              // 注意：永不携带 Authorization 等凭据头（本地服务无鉴权，也无 key 可带）
              body: JSON.stringify({
                text,
                text_lang: voiceConfig.defaultTextLang,
                ref_audio_path: voiceConfig.refAudioPath,
                ...(voiceConfig.promptText !== undefined
                  ? { prompt_text: voiceConfig.promptText }
                  : {}),
                prompt_lang: voiceConfig.promptLang,
                speed_factor: speedFactor,
                media_type: 'wav',
                streaming_mode: false
              }),
              signal: requestController.signal
            })

            if (response.status !== 200) {
              // api_v2 失败路径：400 + {"message": ...}；读一小段做诊断（有界）
              let serverMessage = ''
              try {
                const raw = await response.arrayBuffer()
                serverMessage = new TextDecoder('utf-8')
                  .decode(raw.slice(0, 512))
                  .replace(/\s+/g, ' ')
                  .trim()
              } catch {
                /* 诊断信息缺失不影响错误定性 */
              }
              throw new AppError({
                code: 'TTS_ENGINE_DOWN',
                userMessage: '语音合成失败，本轮改为纯文字。',
                severity: 'error',
                retryable: true,
                cause: new Error(
                  `gpt-sovits /tts http ${response.status}${serverMessage ? `: ${serverMessage}` : ''}`
                )
              })
            }

            const declaredLength = response.headers?.get('content-length')
            if (
              declaredLength !== null &&
              declaredLength !== undefined &&
              Number(declaredLength) > deps.maxResponseBytes
            ) {
              throw new AppError({
                code: 'TTS_DECODE',
                userMessage: '语音数据异常，本轮改为纯文字。',
                severity: 'error',
                retryable: false,
                cause: new Error(
                  `response content-length ${declaredLength} exceeds ${deps.maxResponseBytes}`
                )
              })
            }
            const raw = await response.arrayBuffer()
            if (raw.byteLength > deps.maxResponseBytes) {
              throw new AppError({
                code: 'TTS_DECODE',
                userMessage: '语音数据异常，本轮改为纯文字。',
                severity: 'error',
                retryable: false,
                cause: new Error(`response body ${raw.byteLength} exceeds ${deps.maxResponseBytes}`)
              })
            }

            // 解码 + 重采样到 requestedSampleRate（不变速变调）；坏容器由 wav.ts 拒绝
            const decoded = decodeWavToMonoF32(Buffer.from(raw))
            return resampleLinearF32(decoded.pcm, decoded.sampleRate, requestedSampleRate)
          } catch (err) {
            if (controller.signal.aborted) throw abortError()
            if (isAppError(err)) throw err
            if (isAbortError(err)) {
              // 只剩超时一种可能（用户取消已在上一行拦截）
              throw new AppError({
                code: 'TTS_TIMEOUT',
                userMessage: '语音合成超时，本轮改为纯文字。',
                severity: 'error',
                retryable: true,
                cause: new Error(`gpt-sovits /tts exceeded ${deps.requestTimeoutMs}ms`)
              })
            }
            throw new AppError({
              code: 'TTS_ENGINE_DOWN',
              userMessage: '语音合成失败，本轮改为纯文字。',
              severity: 'error',
              retryable: true,
              cause: err instanceof Error ? err : new Error(String(err))
            })
          } finally {
            deps.service.endSynthesis()
            clearTimeout(timeoutTimer)
            controller.signal.removeEventListener('abort', onInnerAbort)
            releaseQueue()
          }
        },

        async health() {
          const healthy = await deps.service.checkHealth()
          return { healthy, checkedAt: Date.now() }
        },
        cancel(reason) {
          deps.logger.info('gpt-sovits synthesis cancelled', {
            scope: 'tts',
            tags: { provider: 'gpt-sovits', reason }
          })
          controller.abort()
        },
        dispose() {
          controller.abort()
        }
      }
      return bound
    }
  }
}
