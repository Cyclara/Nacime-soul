// src/main/voice/tts/registry.ts
// P3B-02：TTS provider 注册表 + turn-bound 工厂入口。
//
// 依据：F5-007 §1.3（生产 provider 资格门）+ S-Phase3 P3B-02。
// 职责边界：
//   - 注册表只存 descriptor（id + 静态 capabilities + factory），**永不存 provider 实例**；
//     实例是 turn 生命周期的（bind 创建、turn 结束 dispose），配置文件也只存 ID/voice。
//   - `bind()` 是唯一入口，按顺序做三道判定：
//       1. 未注册 provider -> 抛 AppError(CFG_INVALID)（安全错误：无 stack/路径/正文）
//       2. voiceId 为空 -> {textOnly, 'voice-missing'}（F5-007 §1.3：不得自动挑系统 voice）
//       3. runtime==='packaged-production' && devTestOnly -> {textOnly,'provider-unhealthy'}
//          **不调用 factory.bind**，Edge 永远不会被实例化（ETTS-C19；T-09 裁定二）
//   - descriptor 与 bound capabilities 的 devTestOnly 交叉校验：任一方向不一致都视为
//     provider 实现缺陷，立即 dispose 并退纯文字--宁可这轮没声音，不让 Edge 悄悄变生产兜底。
//   - 追踪所有仍存活的 turn-bound provider（包装 dispose 自动出册），app quit 时
//     disposeAll() 有界 best-effort 清理，不留全局单例 WebSocket/进程泄漏（ETTS-C16）。
//
// 调用方（P3B-18 VoiceOrchestrator）对 bind 抛出的 AppError 应捕获并降级为本轮纯文字；
// 注册表自己只在「配置指向不存在的 provider」时抛错，其余失败路径全部走 textOnly 判别结果。

import { AppError } from '@shared/errors'
import type { Logger } from '@shared/observability/types'
import {
  isTtsTextOnly,
  type BoundTtsProvider,
  type TtsProviderCapabilities,
  type TtsProviderFactory,
  type TtsSynthesisOptions,
  type TtsTextOnlyDecision,
  type TtsCancelReason
} from '@shared/voice/tts-types'

/** 注册期静态声明。capabilities 与 bound provider 的 capabilities 交叉校验 devTestOnly。 */
export interface TtsProviderDescriptor {
  readonly id: string
  readonly capabilities: Readonly<TtsProviderCapabilities>
  readonly factory: TtsProviderFactory
}

/** list() 的对外视图：只有 id + capabilities，不含 factory 引用，可安全序列化/进日志。 */
export interface TtsProviderInfo {
  readonly id: string
  readonly capabilities: Readonly<TtsProviderCapabilities>
}

export interface TtsRegistryBindInput {
  readonly providerId: string
  readonly options: Readonly<TtsSynthesisOptions>
  readonly turnId: string
  readonly requestId: string
  readonly signal: AbortSignal
  readonly runtime: 'dev' | 'test' | 'packaged-production'
}

export interface TtsRegistry {
  /** 注册 provider。重复 id 直接抛错（静默覆盖会让后注册的占位 provider 顶掉正式 provider）。 */
  register(descriptor: TtsProviderDescriptor): void
  has(id: string): boolean
  /** 按注册顺序列出 provider 元信息（P3B-14 语音设置页用）。 */
  list(): readonly TtsProviderInfo[]
  /** 创建 turn-bound provider；三道判定见文件头。 */
  bind(input: TtsRegistryBindInput): Promise<BoundTtsProvider | TtsTextOnlyDecision>
  /** app quit / 紧急清理：对仍存活的 provider 先 cancel 再 dispose。幂等、不抛错。 */
  disposeAll(reason: TtsCancelReason): Promise<void>
  /** 仍存活（已 bind、未 dispose）的 provider 数；测试与自检用。 */
  activeCount(): number
}

const MAX_PROVIDER_ID_LENGTH = 64 // 与 LogFields.tags 短字符串上限一致

function isValidCapabilities(value: unknown): value is TtsProviderCapabilities {
  if (typeof value !== 'object' || value === null) return false
  const caps = value as Partial<TtsProviderCapabilities>
  return (
    typeof caps.streamingText === 'boolean' &&
    typeof caps.streamingAudio === 'boolean' &&
    typeof caps.supportsCancel === 'boolean' &&
    typeof caps.devTestOnly === 'boolean' &&
    typeof caps.segmentCorrelation === 'boolean'
  )
}

/**
 * 包装 bound provider：registry 借 dispose 出册，调用方拿到的仍是纯 BoundTtsProvider
 * 接口（F5-007 冻结合同不变）。dispose 幂等：唯一两条出册路径是本包装与 disposeAll，
 * 已不在册即说明清理已发生过（app quit 后迟到的 controller teardown、重复 dispose）。
 */
function trackBound(
  active: Set<BoundTtsProvider>,
  bound: BoundTtsProvider,
  logger: Logger
): BoundTtsProvider {
  active.add(bound)
  const openStream = bound.openStream
  const tracked: BoundTtsProvider = {
    id: bound.id,
    capabilities: bound.capabilities,
    format: bound.format,
    synthesize: (text, voice) => bound.synthesize(text, voice),
    openStream: openStream === undefined ? undefined : () => openStream.call(bound),
    health: () => bound.health(),
    cancel: (reason) => bound.cancel(reason),
    dispose: async () => {
      if (!active.delete(bound)) return
      try {
        await bound.dispose()
      } catch (err) {
        logger.warn('tts provider dispose failed', {
          scope: 'tts',
          tags: { provider: bound.id },
          detail: err instanceof Error ? err.message : String(err)
        })
      }
    }
  }
  return tracked
}

export function createTtsRegistry(logger: Logger): TtsRegistry {
  const descriptors = new Map<string, TtsProviderDescriptor>()
  const active = new Set<BoundTtsProvider>()

  return {
    register(descriptor) {
      if (
        typeof descriptor.id !== 'string' ||
        descriptor.id.length === 0 ||
        descriptor.id.length > MAX_PROVIDER_ID_LENGTH
      ) {
        throw new Error(`tts provider id must be a non-empty string (<=${MAX_PROVIDER_ID_LENGTH})`)
      }
      if (!isValidCapabilities(descriptor.capabilities)) {
        throw new Error(`tts provider "${descriptor.id}" has malformed capabilities`)
      }
      if (typeof descriptor.factory?.bind !== 'function') {
        throw new Error(`tts provider "${descriptor.id}" has no factory.bind`)
      }
      if (descriptors.has(descriptor.id)) {
        throw new Error(`tts provider "${descriptor.id}" already registered`)
      }
      descriptors.set(descriptor.id, descriptor)
    },

    has(id) {
      return descriptors.has(id)
    },

    list() {
      return [...descriptors.values()].map((d) => ({
        id: d.id,
        capabilities: d.capabilities
      }))
    },

    async bind(input) {
      const descriptor = descriptors.get(input.providerId)
      if (descriptor === undefined) {
        // 配置指向不存在的 provider：安全错误，不回显动态配置值以外的任何内容。
        throw new AppError({
          code: 'CFG_INVALID',
          userMessage: '当前语音提供方不可用，请在设置中重新选择。',
          severity: 'error',
          retryable: false,
          cause: new Error(`unregistered tts provider: ${input.providerId}`)
        })
      }

      // 2) voiceId 唯一真源为空：不自动挑系统 voice，直接判 voice-missing（F5-007 §1.3）。
      if (input.options.voiceId.length === 0) {
        return { textOnly: true, reason: 'voice-missing' as const }
      }

      // 3) 生产资格门：devTestOnly provider 在 packaged-production 下永不实例化。
      if (input.runtime === 'packaged-production' && descriptor.capabilities.devTestOnly) {
        logger.warn('tts provider rejected: dev-test-only in packaged production', {
          scope: 'tts',
          turnId: input.turnId,
          tags: { provider: descriptor.id }
        })
        return { textOnly: true, reason: 'provider-unhealthy' as const }
      }

      const bound = await descriptor.factory.bind({
        options: input.options,
        turnId: input.turnId,
        requestId: input.requestId,
        signal: input.signal,
        runtime: input.runtime
      })
      if (isTtsTextOnly(bound)) return bound

      // descriptor 与 bound 的 devTestOnly 必须一致；不一致说明有人撒谎，安全侧处置。
      if (bound.capabilities.devTestOnly !== descriptor.capabilities.devTestOnly) {
        logger.warn('tts provider capability mismatch: descriptor vs bound devTestOnly', {
          scope: 'tts',
          turnId: input.turnId,
          tags: { provider: descriptor.id }
        })
        try {
          await bound.dispose()
        } catch (err) {
          logger.warn('tts provider dispose failed after capability mismatch', {
            scope: 'tts',
            tags: { provider: bound.id },
            detail: err instanceof Error ? err.message : String(err)
          })
        }
        return { textOnly: true, reason: 'provider-unhealthy' as const }
      }

      return trackBound(active, bound, logger)
    },

    async disposeAll(reason) {
      // 先整体出册再清理：并发到达的迟 dispose 看到「不在册」直接跳过，不双清。
      const stillActive = [...active]
      active.clear()
      for (const bound of stillActive) {
        try {
          await bound.cancel(reason)
        } catch (err) {
          logger.warn('tts provider cancel failed during shutdown', {
            scope: 'tts',
            tags: { provider: bound.id },
            detail: err instanceof Error ? err.message : String(err)
          })
        }
        try {
          await bound.dispose()
        } catch (err) {
          logger.warn('tts provider dispose failed during shutdown', {
            scope: 'tts',
            tags: { provider: bound.id },
            detail: err instanceof Error ? err.message : String(err)
          })
        }
      }
    },

    activeCount() {
      return active.size
    }
  }
}
