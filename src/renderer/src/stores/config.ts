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
import type { DeepPartial } from '@shared/config/types'
import { ANOMALY_RULE_IDS } from '@shared/memory/dmae-config'

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
   * P2-31.5A（S-005-补充 §1.8）：DMAE 嵌套草稿 merge。
   *
   * 现有 patch('memory', { dmae: { decayAlpha: 0.8 } }) 只做一层展开，
   * 连续改两个参数时第二次会覆盖第一次的 dmae 对象。
   * patchDmae 对 anomaly.muted / anomaly.windows 做正确的嵌套合并，
   * 确保多参数草稿不丢值。
   */
  function patchDmae(patch: DeepPartial<MemoryConfig['dmae']>): void {
    if (!state.draft) return
    const current = state.draft.memory.dmae
    // 解构排除 anomaly：anomaly 由下面的嵌套 merge 单独处理，
    // 不能从 patch 展开（DeepPartial 类型会与完整 anomaly 类型冲突）
    const { anomaly: patchAnomaly, ...restPatch } = patch

    // restPatch 是 DeepPartial（maxScore:100 等字面量类型变 100|undefined），
    // 展开后结果类型不满足 MemoryConfig['dmae'] 的字面量约束。
    // IPC validator 已保证 patch 值合法，这里用类型断言收窄。
    const nextDmae = {
      ...current,
      ...restPatch,
      anomaly: patchAnomaly
        ? {
            muted: { ...current.anomaly.muted, ...(patchAnomaly.muted ?? {}) },
            windows: mergeWindowPatches(current.anomaly.windows, patchAnomaly.windows)
          }
        : current.anomaly
    } as MemoryConfig['dmae']

    state.draft.memory = { ...state.draft.memory, dmae: nextDmae }
  }

  /** 窗口 patch 按 13 规则逐键合并，保留未改的键 */
  function mergeWindowPatches(
    current: MemoryConfig['dmae']['anomaly']['windows'],
    patch?: DeepPartial<MemoryConfig['dmae']['anomaly']['windows']>
  ): MemoryConfig['dmae']['anomaly']['windows'] {
    if (!patch) return current
    // 不用 structuredClone：Vue reactive proxy 不能被 structuredClone 克隆。
    // 手动构造新对象：先浅拷贝每个规则的窗口对象，再覆盖被 patch 的规则。
    const next = {} as MemoryConfig['dmae']['anomaly']['windows']
    for (const ruleId of ANOMALY_RULE_IDS) {
      const cur = current[ruleId]
      const rp = patch[ruleId]
      next[ruleId] = rp ? { ...cur, ...rp } : { ...cur }
    }
    return next
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
    // S-04 修复：保存前清除上一次的失败标记，允许失败后重试。
    // 旧行为：失败写入 validationErrors.save 后 canSave 恒为 false，
    // 只有"放弃修改/成功保存"才能解除——一次网络抖动就把保存永久锁死。
    state.validationErrors = {}

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
        model: model.model,
        // test-model 合同上限为 30s；聊天配置可到 300s，测试连接取较小值。
        timeoutMs: Math.min(model.timeoutMs, 30_000)
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
      // state.saved 是 Vue reactive proxy；structuredClone(proxy) 会抛 DataCloneError。
      // 配置仅含 JSON 基本类型/对象/数组，与 save() 的去代理策略保持一致。
      state.draft = JSON.parse(JSON.stringify(state.saved)) as PublicConfigSnapshot
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
    patchDmae,
    setApiKey,
    save,
    testConnection,
    discard,
    reset
  }
})
