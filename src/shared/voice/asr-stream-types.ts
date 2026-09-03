// src/shared/voice/asr-stream-types.ts
// P3V-02：流式识别的共享 ABI（**新增**，不动 asr-types.ts 的冻结离线 ABI）。
//
// 为什么必须新开一个接口而不是改 AsrEngine：
//   `AsrEngine.recognize(audio: Int16Array) => Promise<AsrTranscriptResult>` 是
//   「整段话进、最终文本出」的合同，asr-types.ts 底部还有编译期护栏钉死它的
//   参数个数与类型。流式模型是「一帧一帧进、随时能取半成品、到 endpoint 才算
//   一句」——语义完全不同，塞进同一个方法只能靠隐藏状态，那会让离线路径也变得
//   不可推理。两条 ABI 并存、各自穷举实现（OfflineAsrEngineId / StreamingAsrEngineId）。
//
// 继承自离线 ABI 的不变量（一条都不放宽）：
//   - 音频恒 16kHz / mono / s16le（ASR_AUDIO_FORMAT），入参恒 Int16Array；
//     Float32 归一化在 main 侧绑定层做，不上浮到本合同。
//   - localOnly 恒 true：审计裁定 3，语音数据不得离开本机。
//   - 文本有界：复用 ASR_TRANSCRIPT_TEXT_MAX_CHARS。
//
// 为什么 partial 是**拉取**而不是回调：喂音频由 VAD 帧驱动（32ms/帧），
// 回调会在 main 侧多一层调度与重入风险。拉取让 listening-service 保持既有的
// 「帧进 → 读状态」同步结构，和 VadProcessor.processChunk 形状一致。

import {
  ASR_TRANSCRIPT_TEXT_MAX_CHARS,
  type AsrRecognizeOptions,
  type AsrModelState
} from './asr-types'

/** 半成品文本：还会被后续音频改写，UI 只做灰色预览，不入对话历史。 */
export interface AsrStreamPartial {
  readonly text: string
}

/** 一句话定稿：endpoint 命中或输入结束时产生，可以进对话。 */
export interface AsrStreamFinal {
  readonly text: string
}

/**
 * 一次连续说话的识别会话。生命周期由 main 侧监听服务持有；
 * 一个会话对应一个原生 OnlineStream，dispose 后不可再用。
 */
export interface AsrStreamSession {
  /** 注册表 id；非路径。 */
  readonly engineId: string
  /** 审计裁定 3：恒 true。 */
  readonly localOnly: true
  /**
   * 喂入一帧音频（16kHz/mono/s16le）。同步返回——解码在原生层内部完成，
   * 不返回 Promise 是为了让调用点保持「帧进→读状态」的直线结构。
   * 违反格式的输入由实现拒绝（抛 AsrEngineError('audio-invalid')），不得截断后继续。
   */
  feed(audio: Int16Array): void
  /**
   * 取当前半成品。没有新内容（或文本与上次相同）返回 null，
   * 让调用方能直接用「非 null 即需要刷新 UI」判断，不必自己去重。
   */
  partial(): AsrStreamPartial | null
  /**
   * 识别器**自己**判定 endpoint 时取定稿并重置，准备下一句；未命中返回 null。
   *
   * 本项目里话语边界的主判据是 Silero VAD（它也负责 barge-in，必须先响应），
   * 所以这条路径实际只在「用户一口气说了很久、VAD 一直没等到静音」时兜底
   * （rule3MinUtteranceLength = 20s 强制切断），避免一条消息无限增长。
   */
  takeFinalAtEndpoint(): AsrStreamFinal | null
  /**
   * **VAD 判定这句说完了**：无条件把当前文本定稿并重置，准备下一句。
   * 与 takeFinalAtEndpoint 的区别只是判据来自外部；没有文本时返回 null。
   */
  takeFinalNow(): AsrStreamFinal | null
  /**
   * 输入结束（用户松手/停止监听）：冲刷剩余音频并返回最后一段定稿；
   * 没有剩余内容返回 null。调用后会话仍需 dispose。
   */
  finish(): AsrStreamFinal | null
  /** 丢弃原生引用；幂等；dispose 后任何方法调用都应抛错而不是静默返回旧值。 */
  dispose(): void
}

/**
 * 流式引擎。与离线 `AsrEngine` 并列，不互相继承——
 * 两者唯一共享的是模型状态枚举与音频格式。
 */
export interface AsrStreamingEngine {
  readonly id: string
  readonly localOnly: true
  /** 判别字段：让持有联合类型的调用方无需查表即可分流。 */
  readonly streaming: true
  readonly state: AsrModelState
  /** 懒加载模型；ready 后幂等。 */
  loadModel(): Promise<void>
  /**
   * 开一个新会话。模型未 ready 时抛 AsrEngineError('model-missing')——
   * 不隐式 await loadModel，避免在音频帧回调里做长任务。
   */
  startStream(options?: AsrRecognizeOptions): AsrStreamSession
  /** 关闭全部活跃 stream 并丢弃原生 recognizer；幂等，调用后不可再 load/start。 */
  dispose(): void
}

// ── 运行时校验 ──

/** 定稿/半成品文本的界（与离线转写同界，防原生层异常输出撑爆 UI）。 */
export function isValidAsrStreamText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= ASR_TRANSCRIPT_TEXT_MAX_CHARS
}

// === 编译期护栏（同 asr-types.ts 手法：反模式 = 暗改新合同）===

type AssertIsLiteral<T, V> = T extends V ? true : never

/** 会话 localOnly 恒 true（审计裁定 3）。 */
export const asrStreamLocalOnlyAssertion: AssertIsLiteral<AsrStreamSession['localOnly'], true> =
  true

/** 引擎 streaming 判别字段恒 true。 */
export const asrStreamingFlagAssertion: AssertIsLiteral<AsrStreamingEngine['streaming'], true> =
  true

/** feed 入参恒 Int16Array（改成 Float32 = 改合同，必须走勘误）。 */
export const asrStreamFeedParamAssertion: AssertIsLiteral<
  Parameters<AsrStreamSession['feed']>[0],
  Int16Array
> = true

/** feed 恰一个参数：不许悄悄塞第二个「选项」把语义改掉。 */
export const asrStreamFeedParamCountAssertion: AssertIsLiteral<
  Parameters<AsrStreamSession['feed']>['length'],
  1
> = true
