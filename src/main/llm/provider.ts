// src/main/llm/provider.ts
// P1-18: LLMProvider 中立接口 + Provider 工厂
// 依据：S-001 P1-18、技术分析 §4.5.1（协议层 + 兼容层）、S-004 §3.3.1 合同门禁 #5
//
// 设计要点：
//   1. LLMProvider 接口与 vendor SDK 完全解耦，只暴露 stream(request, signal)
//   2. createProvider 按 config.protocol 选择 adapter：
//      - openai-compatible -> OpenAICompatibleProvider
//      - anthropic -> throw（Phase 1 不执行，依据合同门禁 #5）
//   3. Faux Provider（P1-22）直接构造，不经 createProvider（它是测试替身，非生产协议）
//   4. 不导入 vendor SDK 类型到上层（P1-18 风险："把 vendor SDK 类型泄到上层"）

import { AppError } from '@shared/errors'
import type { Logger } from '@shared/observability/types'
import type { LLMProvider, ProviderCreateParams } from './types'
import { resolveCompat } from './compat/detect-compat'
import { OpenAICompatibleProvider } from './providers/openai-compatible'

// re-export 供外部从 provider.ts 统一导入
export type { LLMProvider } from './types'

/**
 * Provider 工厂依赖（注入 Logger，避免模块级全局状态）。
 */
export interface ProviderFactoryDeps {
  logger: Logger
}

/**
 * 根据 ModelConfig 创建对应的 LLMProvider。
 *
 * Phase 1 只支持 openai-compatible 协议：
 *   - openai-compatible -> OpenAICompatibleProvider（含 compat 检测）
 *   - anthropic -> throw AppError（合同门禁 #5："anthropic 配置不可被执行"）
 *
 * Faux Provider（P1-22）不经此工厂，测试时直接构造 FauxProvider 实例。
 */
export function createProvider(
  params: ProviderCreateParams,
  deps: ProviderFactoryDeps
): LLMProvider {
  const { config, apiKey } = params
  const fetchFn = params.fetchFn ?? globalThis.fetch

  switch (config.protocol) {
    case 'openai-compatible': {
      const compat = resolveCompat(config.provider, config.baseUrl, config.compatOverrides)
      return new OpenAICompatibleProvider(
        {
          baseUrl: config.baseUrl,
          model: config.model,
          temperature: config.temperature,
          topP: config.topP,
          maxTokens: config.maxTokens,
          timeoutMs: config.timeoutMs,
          reasoningEffort: config.reasoningEffort
        },
        apiKey,
        compat,
        fetchFn,
        deps.logger
      )
    }

    case 'anthropic':
      // 合同门禁 #5：anthropic 配置不可被执行（Phase 1 不实现 Anthropic Adapter）
      throw new AppError({
        code: 'CFG_INVALID',
        userMessage: 'Anthropic 协议尚未实现，请使用 openai-compatible',
        severity: 'error',
        retryable: false
      })

    default:
      throw new AppError({
        code: 'CFG_INVALID',
        userMessage: `不支持的协议: ${config.protocol}`,
        severity: 'error',
        retryable: false
      })
  }
}
