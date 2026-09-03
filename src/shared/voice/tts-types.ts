// src/shared/voice/tts-types.ts
// P3B-01：TTS provider 的跨进程共享 DTO 与**冻结基础 ABI**。
//
// 依据：F5-007 §1.3（早期播放架构，2026-08-23）+ 2026-08-03 审计裁定二。
// 四条不可协商的合同：
//   1. 基础 ABI 精确为 `synthesize(text, voice) => Promise<Float32Array>`——不得增加
//      第三参数（signal/options 都不行），也不得靠可变全局配置暗改行为。
//   2. 流式能力只能通过**可选** `openStream?()` 叠加，不替换、不改写基础方法。
//   3. speed/pitch/volume/requestedSampleRate 与 AbortSignal 在 `TtsProviderFactory.bind()`
//      阶段一次性绑定，此后 provider 生命周期内不可变（所以 bind 收的是 Readonly）。
//   4. 生产定制音色不可用时只保留文字（`TtsTextOnlyDecision`），**绝不**切换 Edge /
//      系统 / 其他通用音色——音色是角色身份的一部分。
//
// 本文件只有类型与一个判别式守卫：Registry/Factory 实现在 main 侧（P3B-02），
// 具体 provider 在 P3B-03（Edge dev 占位）与 P3B-06（GPT-SoVITS）。

/**
 * 每轮合成参数。**唯一 voiceId 真源**——provider、capabilities、stream session 一律
 * 不再各自持有 voice 字段，避免"配置里一个、adapter 里一个"的双真源。
 *
 * voiceId 为空时不得自动挑一个系统 voice 顶上：生产环境应直接判 `voice-missing`
 * 退为纯文字（裁定二）。
 */
export interface TtsSynthesisOptions {
  voiceId: string
  speed: number
  pitch: number
  volume: number
  requestedSampleRate: 16000 | 22050 | 24000 | 44100 | 48000
}

/**
 * 所有 provider 在交给播放器前必须归一到这个可验证格式。
 *
 * 只有 sampleRate 是变量：容器解码、声道下混与重采样都在 adapter 内部完成（P3B-06），
 * 播放侧永远只面对 mono / f32le / interleaved 一种排布。`requestedSampleRate` 是"想要"，
 * 本 format 是"实际"，两者可以不同，但必须**可知**。
 */
export interface PcmFormat {
  sampleRate: number
  channels: 1
  sampleFormat: 'f32le'
  interleaved: true
}

export interface TtsProviderCapabilities {
  streamingText: boolean
  streamingAudio: boolean
  supportsCancel: boolean
  /** Edge 等占位 provider 必须为 true；packaged production main policy 硬拒绝。 */
  devTestOnly: boolean
  /** 协议能否把 audio event 可靠关联到 segmentId；false 时只允许一个 in-flight commit。 */
  segmentCorrelation: boolean
}

/**
 * 每 turn 由 Registry/Factory 绑定 options 与 AbortSignal 后创建。
 * 这样基础 ABI 仍严格是任务书冻结的两个参数，不靠可变全局配置或第三参数传取消。
 */
export interface BoundTtsProvider {
  readonly id: string
  readonly capabilities: TtsProviderCapabilities
  readonly format: PcmFormat
  /** 冻结基础 ABI：不得增加 signal/options 第三参数。 */
  synthesize(text: string, voice: string): Promise<Float32Array>
  /** 只有 capabilities 声明支持时才存在。 */
  openStream?(): Promise<TtsStreamSession>
  health(): Promise<TtsHealthResult>
  cancel(reason: TtsCancelReason): Promise<void> | void
  dispose(): Promise<void> | void
}

/**
 * 探测结果。**F5-007 引用了 `TtsHealthResult` 但未给出字段定义**，此处按最小必要补全：
 * 只放 P3B-05（health check + 有界自动重启）判活与退避真正需要的量。
 *
 * 不携带原因文本：错误码是固定枚举串，路径 / 命令行 / 端口 URL / 密钥一律不进这里
 * （F5-011 脱敏纪律；health 结果会进日志与指标）。
 */
export interface TtsHealthResult {
  healthy: boolean
  /** 固定错误码，不是给人读的自由文本。 */
  errorCode?: string
  /** 本次探测耗时；provider 无法测量时省略。 */
  latencyMs?: number
  checkedAt: number
}

/**
 * bind 拒绝提供 provider 时的判别式结果：本轮退为纯文字。
 *
 * F5-007 §1.3 写作内联的 `{ textOnly: true; reason }`，这里只是给同一形状起个名字，
 * 便于 P3B-02/07 消费与守卫，字段一字未改。
 */
export interface TtsTextOnlyDecision {
  textOnly: true
  reason: EarlyTtsDegradedReason
}

export interface TtsProviderFactory {
  bind(input: {
    options: Readonly<TtsSynthesisOptions>
    turnId: string
    requestId: string
    signal: AbortSignal
    runtime: 'dev' | 'test' | 'packaged-production'
  }): Promise<BoundTtsProvider | TtsTextOnlyDecision>
}

/** 判别 `bind()` 的两种结果；避免每个调用点各写一遍 `'textOnly' in result`。 */
export function isTtsTextOnly(
  result: BoundTtsProvider | TtsTextOnlyDecision
): result is TtsTextOnlyDecision {
  return (result as TtsTextOnlyDecision).textOnly === true
}

export interface TtsTextCommit {
  segmentId: string
  sequence: number
  text: string
}

export interface TtsAudioChunk {
  type: 'chunk'
  segmentId: string
  sequence: number
  /** 每个 segment 从 0 开始、严格连续；重复/缺口均为 protocol error。 */
  chunkIndex: number
  format: PcmFormat
  pcm: Float32Array
}

export interface TtsStreamTerminal {
  type: 'terminal'
  segmentId: string
  sequence: number
  status: 'completed' | 'partial' | 'failed' | 'cancelled' | 'timeout'
  errorCode?: string
}

export type TtsStreamEvent = TtsAudioChunk | TtsStreamTerminal

/**
 * 流式一致性硬约束（F5-007 §1.3）：每个 commit 恰有一个 terminal；chunkIndex 从 0 连续；
 * terminal 后不再接受该 segment 的 data；`partial/failed/timeout` 永不冒充 completed。
 *
 * 三个收尾方法语义不可混用：`endInput()` = 没有更多文本了，`cancel()` = 放弃，
 * `close()` = 只清理资源。close 永远不能代替正常的 endInput。
 */
export interface TtsStreamSession {
  append(input: TtsTextCommit): Promise<void>
  commit(segmentId: string): Promise<void>
  /** 所有已提交 segment 之后显式结束输入；与 cancel/close 语义分离。 */
  endInput(): Promise<void>
  audio(): AsyncIterable<TtsStreamEvent>
  cancel(reason: TtsCancelReason): Promise<void> | void
  close(): Promise<void> | void
}

export type TtsCancelReason =
  'user-cancel' | 'barge-in' | 'new-turn' | 'provider-failed' | 'window-destroyed' | 'app-quit'

/**
 * 本轮退为纯文字的原因。
 *
 * F5-007 把它写在 §1.5 的 `early-controller.ts` 代码块里，但 §1.3 的
 * `TtsProviderFactory.bind()` 返回值就要用到它——shared 不能反向依赖 main，
 * 所以真源放这里，`early-controller.ts`（P3B-07）re-export 即可，形状不变。
 */
export type EarlyTtsDegradedReason =
  | 'disabled'
  | 'voice-missing'
  | 'provider-unhealthy'
  | 'segmenter-error'
  | 'synthesis-error'
  | 'queue-overflow'
  | 'unsupported-format'
  | 'playback-host-unavailable'
  | 'chat-render-ack-timeout'

// === 编译期护栏（P3B-01 反模式：通过第三参数/全局可变配置暗改冻结 ABI）===
// 与 config/types.ts 的 AssertMutuallyAssignable 同一手法：这些 const 的类型永远应当
// 是 true，任何人把 ABI 改宽（加第三参、openStream 变必选、PcmFormat 字段放宽成
// number/string/boolean）都会让 typecheck 立即失败。值永不使用。

type AssertIsLiteral<T, V> = T extends V ? true : never
type AssertOptional<T> = undefined extends T ? true : never

/** synthesize 必须恰好两个参数（text, voice）。 */
export const ttsSynthesizeParamCountAssertion: AssertIsLiteral<
  Parameters<BoundTtsProvider['synthesize']>['length'],
  2
> = true

/** openStream 只能是可选叠加能力；把它改成必选就改写了基础合同。 */
export const ttsOpenStreamOptionalAssertion: AssertOptional<BoundTtsProvider['openStream']> = true

/** PcmFormat 三个字面量字段不许放宽（后续 IPC validator 依赖精确字面量判别）。 */
export const pcmFormatChannelsAssertion: AssertIsLiteral<PcmFormat['channels'], 1> = true
export const pcmFormatSampleFormatAssertion: AssertIsLiteral<PcmFormat['sampleFormat'], 'f32le'> =
  true
export const pcmFormatInterleavedAssertion: AssertIsLiteral<PcmFormat['interleaved'], true> = true
