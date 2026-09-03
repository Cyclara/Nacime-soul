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
  MemoryConfig,
  PersonaConfig
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

/** JSON 配置的最小深层 patch；数组一旦变化整体替换，普通对象递归到叶子。 */
function diffConfigValue(saved: unknown, draft: unknown): unknown {
  if (stableHash(saved) === stableHash(draft)) return undefined
  if (
    draft === null ||
    typeof draft !== 'object' ||
    Array.isArray(draft) ||
    saved === null ||
    typeof saved !== 'object' ||
    Array.isArray(saved)
  ) {
    return draft
  }

  const patch: Record<string, unknown> = {}
  const savedRecord = saved as Record<string, unknown>
  for (const [key, value] of Object.entries(draft as Record<string, unknown>)) {
    const nested = diffConfigValue(savedRecord[key], value)
    if (nested !== undefined) patch[key] = nested
  }
  return Object.keys(patch).length === 0 ? undefined : patch
}

/** 去掉 PublicConfigSnapshot 里的只读投影字段，留下 main ConfigUpdateRequest 可写形状。 */
function writableSnapshot(snapshot: PublicConfigSnapshot): PublicConfigSnapshot {
  const plain = JSON.parse(JSON.stringify(snapshot)) as PublicConfigSnapshot
  const model = plain.model as unknown as Record<string, unknown>
  delete model.hasApiKey
  delete model.validated
  delete model.supportsThinking
  delete (plain.tts as unknown as Record<string, unknown>).hasApiKey
  return plain
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
   * F5-001 C0（patchDmae 同款模式）：persona.compliance 嵌套草稿 merge。
   * gate/audit 子对象做二级展开，避免连续改两个键时后一次覆盖前一次的子对象。
   */
  function patchPersonaCompliance(patch: DeepPartial<PersonaConfig['compliance']>): void {
    if (!state.draft) return
    const current = state.draft.persona.compliance
    // 解构排除 gate/audit：由下面的嵌套 merge 单独处理
    const { gate: patchGate, audit: patchAudit, ...restPatch } = patch
    const next = {
      ...current,
      ...restPatch,
      gate: patchGate ? { ...current.gate, ...patchGate } : current.gate,
      audit: patchAudit ? { ...current.audit, ...patchAudit } : current.audit
    } as PersonaConfig['compliance']
    state.draft.persona = { ...state.draft.persona, compliance: next }
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
      // 深拷贝 draft/saved，解除 Vue reactive proxy，并移除只读投影字段。
      // 只发送「saved → draft」的最小深层 patch，不再把六个域的完整旧快照全量回写。
      //
      // ROOT CAUSE（2026-09-02 真机）：Live2D 显示按钮由 main 直接持久化 `ui.live2d.enabled=true`，
      // renderer config store 的 saved/draft 仍是旧 false。随后只切主题时，旧 save() 把整个 ui 域
      //（含 stale enabled=false）发回 main，于是主题切换顺手关闭 Live2D。最小 patch 只发
      // `{ui:{theme}}`，main 保留它刚写入的 enabled=true，并在响应快照里把 renderer 同步回来。
      const plainDraft = writableSnapshot(state.draft)
      const plainSaved = writableSnapshot(state.saved ?? state.draft)
      const domains = {} as ConfigUpdateRequest['domains']
      const domainNames = ['model', 'tts', 'memory', 'ui', 'security', 'persona', 'voice'] as const
      for (const domain of domainNames) {
        const patch = diffConfigValue(plainSaved[domain], plainDraft[domain])
        if (patch !== undefined) {
          ;(domains as Record<string, unknown>)[domain] = patch
        }
      }

      // 附加 pending API keys（空字符串不附加，见上方 hasPendingSecrets 注释）。
      // 即使对应配置域没有其他变化，也创建该域的最小对象。
      if (pendingSecrets.modelApiKey !== undefined && pendingSecrets.modelApiKey.length > 0) {
        const modelDomain = (domains.model ??= {}) as Record<string, unknown>
        modelDomain.apiKey = pendingSecrets.modelApiKey
      }
      if (pendingSecrets.ttsApiKey !== undefined && pendingSecrets.ttsApiKey.length > 0) {
        const ttsDomain = (domains.tts ??= {}) as Record<string, unknown>
        ttsDomain.apiKey = pendingSecrets.ttsApiKey
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
    patchPersonaCompliance,
    setApiKey,
    save,
    testConnection,
    discard,
    reset
  }
})
