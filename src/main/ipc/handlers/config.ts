// src/main/ipc/handlers/config.ts
// Config IPC handlers：get/update/test-model/reset-domain
// 依据：S-001 P1-15、S-003 §3.2、S-005 §3.2
//
// 安全红线：
//   - config:get 返回值永不含明文 API Key（只有 hasApiKey boolean）
//   - config:update 提取 apiKey 写入 SecretStore，不进入 config.json
//   - 保存空 key 不覆盖旧 key（空字符串 = 不修改）

import type { Logger } from '@shared/observability/types'
import type { AppConfigV1, ModelConfig, PublicConfigSnapshot } from '@shared/config/types'
import type { ConfigStore } from '@shared/config/types'
import type { SecretStore } from '../../security/secret-store'
import { AppError } from '@shared/errors'
import { createProvider } from '../../llm/provider'
import { resolveCompat } from '../../llm/compat/detect-compat'
import { testConnection } from '../../llm/connection-test'
import { registerValidatedHandler } from '../register'

/** 将内部 AppConfigV1 转为公开快照（去除 API Key） */
function toPublicSnapshot(
  config: Readonly<AppConfigV1>,
  secretStore: SecretStore
): PublicConfigSnapshot {
  // 用 compat 层判断当前 provider/model 是否支持思考模式（UI toggle 是否可用）
  const compat = resolveCompat(
    config.model.provider,
    config.model.baseUrl,
    config.model.compatOverrides
  )
  return {
    schemaVersion: config.schemaVersion,
    model: {
      provider: config.model.provider,
      baseUrl: config.model.baseUrl,
      model: config.model.model,
      temperature: config.model.temperature,
      maxTokens: config.model.maxTokens,
      reasoningEffort: config.model.reasoningEffort,
      supportsThinking: compat.thinkingFormat !== 'none',
      hasApiKey: secretStore.has('modelApiKey'),
      validated: false
    },
    ui: config.ui,
    tts: {
      ...config.tts,
      hasApiKey: secretStore.has('ttsApiKey')
    },
    memory: config.memory,
    security: config.security
  }
}

/** 从 API Key 字段名映射到 SecretStore 中的 key 名 */
const API_KEY_SECRET_MAP: Record<string, string> = {
  model: 'modelApiKey',
  tts: 'ttsApiKey'
}

/** 提取并保存 API Key 到 SecretStore，返回不含 apiKey 的 patch */
function extractApiKeys(
  domains: Record<string, Record<string, unknown> | undefined>,
  secretStore: SecretStore
): void {
  for (const [domain, domainPatch] of Object.entries(domains)) {
    if (!domainPatch) continue
    const secretName = API_KEY_SECRET_MAP[domain]
    if (!secretName) continue

    const apiKey = domainPatch['apiKey']
    if (apiKey === undefined) continue

    if (typeof apiKey === 'string' && apiKey.length > 0) {
      // 保存非空 key
      secretStore.set(secretName, apiKey)
    } else if (apiKey === '') {
      // 空字符串 = 不修改（依据 S-001 P1-15 "保存空 key 不覆盖旧 key"）
      // 不做任何事
    }

    // 删除 apiKey 字段，防止进入 config.json
    delete domainPatch['apiKey']
  }
}

/** Config handler 依赖 */
export interface ConfigHandlerDeps {
  configStore: ConfigStore
  secretStore: SecretStore
  logger: Logger
  /**
   * 创建"测试连接"用的 fetch（P1-09B Layer 2）。
   *
   * 安全红线（2026-08-03 审计 B-1）：test-model 会带着 API Key 访问用户填写的
   * 任意 baseUrl，必须与正式聊天路径（index.ts providerFactory）走同一套
   * createSecureFetch，否则整套私网/SSRF 防护被绕过。
   *
   * 用工厂而非现成 fetch：每次测试都要读当前 config.security
   * （allowHttpLocalhostInDev 等运行时可变）。
   */
  createTestFetch: () => typeof globalThis.fetch
}

/**
 * 注册所有 config IPC handler。
 * 在 main/index.ts 中调用，需在 configureIpcGuard 之后。
 */
export function registerConfigHandlers(deps: ConfigHandlerDeps): void {
  const { configStore, secretStore, logger, createTestFetch } = deps

  // === companion:config:get ===
  registerValidatedHandler('companion:config:get', async () => {
    const config = configStore.get()
    return toPublicSnapshot(config, secretStore)
  })

  // === companion:config:update ===
  registerValidatedHandler('companion:config:update', async (_ctx, payload) => {
    // 1. 提取并保存 API Key 到 SecretStore
    const domains = payload.domains as Record<string, Record<string, unknown> | undefined>
    extractApiKeys(domains, secretStore)

    // 2. 乐观锁：schemaVersion 不匹配时拒绝（S-005 §3.2 expectedSchemaVersion）
    //    Phase 1 单窗口不会触发，但防止将来多窗口/多进程并发覆盖
    if (payload.expectedSchemaVersion !== configStore.get().schemaVersion) {
      throw new AppError({
        code: 'CFG_INVALID',
        userMessage: '配置版本已变化，请刷新后重试',
        severity: 'error',
        retryable: true
      })
    }

    // 3. 应用配置更新
    //    ⚠️ 必须传 payload.domains，不能传整个 payload：
    //    ConfigStore.update 期望 DeepPartial<AppConfigV1>（顶层 key 是 model/tts/...），
    //    而 payload 顶层 key 是 expectedSchemaVersion/domains。
    //    之前 `payload as unknown as ...` 强转导致 deepMergeWithDefaults 找不到
    //    任何匹配的 key，静默丢弃全部更新——配置从未真正写入。
    const updated = await configStore.update(
      payload.domains as Parameters<typeof configStore.update>[0]
    )

    return toPublicSnapshot(updated, secretStore)
  })

  // === companion:config:test-model ===
  // P1-20: 通过 provider 抽象进行连接测试（不使用 raw fetch /models）
  // 依据：S-001 P1-20 验收"Faux 连接成功；401->LLM_AUTH；5xx->LLM_SERVER"
  //       S-001 P1-20 "连接测试不写日志正文"
  registerValidatedHandler('companion:config:test-model', async (_ctx, payload) => {
    const { provider, baseUrl, model, apiKey, timeoutMs } = payload

    // API Key：优先用请求中的（测试未保存的新 key），否则回退到 SecretStore
    const effectiveApiKey = apiKey ?? secretStore.get('modelApiKey') ?? ''
    if (!effectiveApiKey) {
      logger.warn('model connection test: no API key', {
        scope: 'config',
        code: 'LLM_AUTH',
        tags: { provider, model }
      })
      return { ok: false, code: 'LLM_AUTH' as const }
    }

    const effectiveTimeout = timeoutMs ?? 15000

    // 构建最小 ModelConfig（Phase 1 只支持 openai-compatible）
    const testConfig: ModelConfig = {
      provider,
      protocol: 'openai-compatible',
      baseUrl,
      model,
      displayName: provider,
      temperature: 0.8,
      topP: 0.95,
      maxTokens: 16,
      timeoutMs: effectiveTimeout,
      reasoningEffort: 'off',
      compatOverrides: {}
    }

    // 通过 createProvider 创建 provider（复用 compat 检测 + adapter）
    // 必须注入 secureFetch：测试连接同样携带 API Key 访问用户填写的 baseUrl，
    // 不注入会回退到 provider.ts 的裸 globalThis.fetch，绕过全部私网防护（审计 B-1）。
    const llmProvider = createProvider(
      { config: testConfig, apiKey: effectiveApiKey, fetchFn: createTestFetch() },
      { logger }
    )

    // testConnection 发送最小 ping 消息，收到首个 chunk 即判定成功
    return testConnection(llmProvider, {
      timeoutMs: effectiveTimeout,
      logger,
      tags: { provider, model }
    })
  })

  // === companion:config:reset-domain ===
  registerValidatedHandler('companion:config:reset-domain', async (_ctx, payload) => {
    const { domain } = payload

    logger.info('resetting config domain', {
      scope: 'config',
      tags: { domain }
    })

    try {
      const updated = await configStore.resetDomain(domain)
      return toPublicSnapshot(updated, secretStore)
    } catch (e) {
      throw new AppError({
        code: 'CFG_INVALID',
        userMessage: '重置配置域失败',
        severity: 'error',
        retryable: false,
        cause: e
      })
    }
  })
}
