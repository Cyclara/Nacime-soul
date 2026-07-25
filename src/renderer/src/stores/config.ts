// src/renderer/src/stores/config.ts
// P1-24: config store - 脱敏配置快照、编辑草稿、保存/连接测试
// 依据：S-002 §3.3、S-001 P1-24、S-005 §3.2
//
// 安全红线（S-002 §3.3）：
//   - API Key 输入由组件 @input 直接传 setApiKey()
//   - store 内使用模块闭包 let pendingSecrets，保存后清空
//   - 不得进入 reactive state、Pinia devtools、localStorage
//   - config:get 返回值永不含明文 API Key（只有 hasApiKey）

import { reactive, computed } from 'vue'
import { defineStore } from 'pinia'
import type { ErrorCode } from '@shared/errors'
import type {
  PublicConfigSnapshot,
  ConfigUpdateRequest,
  ModelConnectionTestRequest,
  ConnectionTestResult,
  ModelConfig,
  TtsConfig,
  MemoryConfig,
  UiConfig,
  SecurityConfig
} from '@shared/config/types'

export interface ConfigState {
  saved: PublicConfigSnapshot | null
  draft: PublicConfigSnapshot | null
  loading: boolean
  saving: boolean
  testing: boolean
  validationErrors: Record<string, string>
  connectionResult: { ok: boolean; latencyMs?: number; code?: ErrorCode } | null
}

// 模块闭包：API Key 不进入 reactive state（S-002 §3.3）
let pendingSecrets: { modelApiKey?: string; ttsApiKey?: string } = {}

function stableHash(obj: unknown): string {
  return JSON.stringify(obj)
}

export const useConfigStore = defineStore('config', () => {
  const state = reactive<ConfigState>({
    saved: null,
    draft: null,
    loading: false,
    saving: false,
    testing: false,
    validationErrors: {},
    connectionResult: null
  })

  const isDirty = computed(() => stableHash(state.saved) !== stableHash(state.draft))
  const canSave = computed(
    () => isDirty.value && !state.saving && Object.keys(state.validationErrors).length === 0
  )

  async function load(): Promise<void> {
    state.loading = true
    try {
      if (!window.companion) return
      const result = await window.companion.config.get()
      if (result.ok) {
        state.saved = result.data
        state.draft = structuredClone(result.data)
      }
    } finally {
      state.loading = false
    }
  }

  function patch<K extends keyof PublicConfigSnapshot>(
    domain: K,
    patchObj: Partial<PublicConfigSnapshot[K]>
  ): void {
    if (!state.draft) return
    const current = state.draft[domain] as object
    state.draft[domain] = { ...current, ...patchObj } as PublicConfigSnapshot[K]
  }

  /**
   * 设置 API Key。写入模块闭包，不进入 reactive state。
   * 由组件 @input 直接调用。
   */
  function setApiKey(domain: 'model' | 'tts', value: string): void {
    if (domain === 'model') {
      pendingSecrets.modelApiKey = value
    } else {
      pendingSecrets.ttsApiKey = value
    }
  }

  async function save(): Promise<boolean> {
    // canSave 检查配置是否 dirty；有 pendingSecrets 时也允许保存
    // （API Key 通过 setApiKey 写入 pendingSecrets，不改变 draft，isDirty 可能是 false）
    // 空字符串不算有效 pending secret（用户清空输入框），否则会把 apiKey:'' 发到 main
    // 被 validator（minLen:1）拒绝导致整个保存失败
    const hasPendingSecrets =
      (pendingSecrets.modelApiKey !== undefined && pendingSecrets.modelApiKey.length > 0) ||
      (pendingSecrets.ttsApiKey !== undefined && pendingSecrets.ttsApiKey.length > 0)
    if ((!canSave.value && !hasPendingSecrets) || !state.draft || !window.companion) return false

    state.saving = true
    try {
      // 深拷贝 draft，解除 Vue reactive proxy。
      // 不用 structuredClone：state.draft 中可能含 Vue 内部不可 clone 的对象。
      // JSON 序列化是安全的，因为配置只含基本类型/对象/数组。
      const plainDraft = JSON.parse(JSON.stringify(state.draft)) as PublicConfigSnapshot

      const domains: ConfigUpdateRequest['domains'] = {
        model: { ...plainDraft.model } as Partial<ModelConfig>,
        tts: { ...plainDraft.tts } as Partial<TtsConfig>,
        memory: { ...plainDraft.memory } as Partial<MemoryConfig>,
        ui: { ...plainDraft.ui } as Partial<UiConfig>,
        security: { ...plainDraft.security } as Partial<SecurityConfig>
      }

      // 删除 hasApiKey/validated/supportsThinking（不是 ModelConfig 字段，属于 PublicModelConfig 扩展）
      const modelDomain = domains.model as Record<string, unknown>
      delete modelDomain.hasApiKey
      delete modelDomain.validated
      delete modelDomain.supportsThinking
      const ttsDomain = domains.tts as Record<string, unknown>
      delete ttsDomain.hasApiKey

      // 附加 pending API keys（空字符串不附加，见上方 hasPendingSecrets 注释）
      if (pendingSecrets.modelApiKey !== undefined && pendingSecrets.modelApiKey.length > 0) {
        ;(modelDomain as { apiKey?: string }).apiKey = pendingSecrets.modelApiKey
      }
      if (pendingSecrets.ttsApiKey !== undefined && pendingSecrets.ttsApiKey.length > 0) {
        ;(ttsDomain as { apiKey?: string }).apiKey = pendingSecrets.ttsApiKey
      }

      const request: ConfigUpdateRequest = {
        expectedSchemaVersion: plainDraft.schemaVersion,
        domains
      }

      const result = await window.companion.config.update(request)
      if (result.ok) {
        state.saved = result.data
        state.draft = structuredClone(result.data)
        // 清空 pending secrets
        pendingSecrets = {}
        state.validationErrors = {}
        return true
      }

      // IPC 返回业务错误（如 IPC_UNAUTHORIZED / CFG_INVALID）
      state.validationErrors = { save: result.error.message ?? result.error.code }
      return false
    } catch (err) {
      // IPC 调用本身抛错（channel 未注册、主进程无响应等）
      state.validationErrors = {
        save: err instanceof Error ? err.message : '保存时发生未知错误'
      }
      return false
    } finally {
      state.saving = false
    }
  }

  async function testConnection(): Promise<void> {
    if (!state.draft || !window.companion) return

    state.testing = true
    state.connectionResult = null
    try {
      const model = state.draft.model
      const input: ModelConnectionTestRequest = {
        provider: model.provider,
        baseUrl: model.baseUrl,
        model: model.model
      }

      // 优先用 pending key（测试未保存的新 key），否则不传（main 回退到 SecretStore）
      if (pendingSecrets.modelApiKey !== undefined) {
        input.apiKey = pendingSecrets.modelApiKey
      }

      const result = await window.companion.config.testModel(input)
      if (result.ok) {
        const data = result.data as ConnectionTestResult
        state.connectionResult = data
      } else {
        state.connectionResult = {
          ok: false,
          code: result.error.code as ErrorCode
        }
      }
    } catch (err) {
      // IPC 调用本身抛错（channel 未注册、主进程无响应等）
      state.connectionResult = {
        ok: false,
        code: 'UNKNOWN'
      }
      state.validationErrors = {
        test: err instanceof Error ? err.message : '连接测试时发生未知错误'
      }
    } finally {
      state.testing = false
    }
  }

  function discard(): void {
    if (state.saved) {
      state.draft = structuredClone(state.saved)
    }
    pendingSecrets = {}
    state.validationErrors = {}
    state.connectionResult = null
  }

  function reset(): void {
    state.saved = null
    state.draft = null
    state.loading = false
    state.saving = false
    state.testing = false
    state.validationErrors = {}
    state.connectionResult = null
    pendingSecrets = {}
  }

  return {
    state,
    isDirty,
    canSave,
    load,
    patch,
    setApiKey,
    save,
    testConnection,
    discard,
    reset
  }
})
