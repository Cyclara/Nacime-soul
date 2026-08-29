<script setup lang="ts">
// P1-24A: FirstRunGuide - 首次体验引导
// 依据：S-001 P1-24A、S-004 §3.3.1 合同门禁 #6
//   无 Key -> 引导 -> 保存 -> 连接测试 -> 欢迎语/示例问题 -> 首轮聊天
//   失败重试保留草稿（S-001 P1-24A 验收）
//
// 无业务逻辑进组件：只调用 config store actions
// API Key 由 @input 直传 setApiKey（不进 reactive state，S-002 §3.3）

import { ref, computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useConfigStore } from '../../stores/config'
import FirstConversationGuide from './FirstConversationGuide.vue'

const configStore = useConfigStore()
const { state } = storeToRefs(configStore)

type Step = 'form' | 'testing' | 'first-conversation'

const step = ref<Step>(state.value.draft?.ui.onboarding.stage === 'first-conversation' ? 'first-conversation' : 'form')
const errorMessage = ref<string | null>(null)

const hasApiKey = computed(() => state.value.draft?.model.hasApiKey ?? false)
const provider = ref('')
const baseUrl = ref('')
const model = ref('')
const apiKeyInput = ref('')
const apiKeyInputRef = ref<HTMLInputElement | null>(null)

// 初始化表单值
function initFromConfig(): void {
  if (state.value.draft) {
    provider.value = state.value.draft.model.provider
    baseUrl.value = state.value.draft.model.baseUrl
    model.value = state.value.draft.model.model
  }
}

// 组件挂载时初始化
initFromConfig()

function onApiKeyInput(e: Event): void {
  const target = e.target as HTMLInputElement
  apiKeyInput.value = target.value
  configStore.setApiKey('model', target.value)
}

async function onTestAndSave(): Promise<void> {
  errorMessage.value = null
  step.value = 'testing'

  try {
    // HMR 后组件 ref 可能被重置，但 DOM input 仍保留用户输入。
    // 保存前从 DOM 读取最新 API Key，确保 pendingSecrets 一定被写入。
    const domApiKey = apiKeyInputRef.value?.value ?? ''
    if (domApiKey.length > 0) {
      configStore.setApiKey('model', domApiKey)
    }

    // 先保存配置
    if (state.value.draft) {
      configStore.patch('model', {
        provider: provider.value,
        baseUrl: baseUrl.value,
        model: model.value
      })
    }

    const saveOk = await configStore.save()
    if (!saveOk) {
      // save 内部已处理错误提示；优先显示具体错误信息
      step.value = 'form'
      const saveError = state.value.validationErrors.save
      errorMessage.value = saveError ? `配置保存失败: ${saveError}` : '配置保存失败，请重试'
      return
    }

    // 连接测试（带整体超时保护，防止任何原因导致永远 pending）
    const TEST_TIMEOUT_MS = 25_000
    const testPromise = configStore.testConnection()
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error('连接测试超时')), TEST_TIMEOUT_MS)
    })
    await Promise.race([testPromise, timeoutPromise])

    const result = state.value.connectionResult
    if (result?.ok) {
      if (!state.value.draft) {
        step.value = 'form'
        errorMessage.value = '配置状态已过期，请重新保存后再试'
        return
      }
      configStore.patch('ui', { onboarding: { ...state.value.draft.ui.onboarding, stage: 'first-conversation' } })
      const progressSaved = await configStore.save()
      if (!progressSaved) {
        step.value = 'form'
        errorMessage.value = '连接已通过，但引导进度没有保存，请重试'
        return
      }
      step.value = 'first-conversation'
    } else {
      // 失败：返回表单步骤，保留输入（草稿保留，S-001 P1-24A 验收）
      step.value = 'form'
      errorMessage.value = result?.code ? `连接失败: ${result.code}` : '连接失败，请检查配置'
    }
  } catch (err) {
    // 任何未捕获异常都不应让 UI 永远卡在 testing
    step.value = 'form'
    errorMessage.value =
      err instanceof Error ? `保存/测试出错: ${err.message}` : '保存/测试时发生未知错误'
  }
}

const emit = defineEmits<{
  startChat: [text: string]
}>()

async function startFirstConversation(text: string): Promise<void> {
  if (state.value.draft) {
    configStore.patch('ui', {
      onboarding: {
        ...state.value.draft.ui.onboarding,
        stage: 'complete',
        completedAt: Date.now()
      }
    })
    const saved = await configStore.save()
    if (!saved) {
      errorMessage.value = '第一次见面的进度没有保存，请重试'
      return
    }
  }
  emit('startChat', text)
}
</script>

<template>
  <div class="first-run-guide">
    <!-- 步骤 1: 配置表单 -->
    <div v-if="step === 'form'" class="step form-step">
      <h2>欢迎使用 Nacime</h2>
      <p class="hint">配置 AI 模型以开始对话。你的 API Key 会安全存储，不会出现在配置文件中。</p>

      <div v-if="errorMessage" class="error-msg">{{ errorMessage }}</div>
      <div v-if="hasApiKey" class="info-msg">已配置 API Key。如需更换请直接输入新 Key。</div>

      <label class="field">
        <span>Provider</span>
        <input v-model="provider" placeholder="deepseek" />
      </label>

      <label class="field">
        <span>Base URL</span>
        <input v-model="baseUrl" placeholder="https://api.deepseek.com" />
      </label>

      <label class="field">
        <span>Model</span>
        <input v-model="model" placeholder="deepseek-v4-flash" />
      </label>

      <label class="field">
        <span>API Key</span>
        <input
          ref="apiKeyInputRef"
          type="password"
          :value="apiKeyInput"
          placeholder="sk-..."
          @input="onApiKeyInput"
        />
      </label>

      <button class="primary-btn" @click="onTestAndSave">保存并测试连接</button>
    </div>

    <!-- 步骤 2: 测试中 -->
    <div v-else-if="step === 'testing'" class="step testing-step">
      <div class="spinner"></div>
      <p>正在测试连接...</p>
    </div>

    <!-- 步骤 3: 第一次见面；opening 是展示层，不写入 SessionStore -->
    <FirstConversationGuide
      v-else-if="step === 'first-conversation'"
      @start-chat="startFirstConversation"
    />
  </div>
</template>

<style scoped>
.first-run-guide {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding: clamp(18px, 4vw, 44px);
  background:
    radial-gradient(circle at 16% 16%, var(--color-companion-soft), transparent 34%),
    radial-gradient(circle at 88% 8%, var(--color-accent-soft), transparent 32%);
}

.step {
  position: relative;
  width: min(100%, 480px);
  margin-block: auto;
  padding: clamp(24px, 4vw, 36px);
  overflow: hidden;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-xl);
  background: var(--color-surface-translucent);
  box-shadow:
    var(--shadow-lg),
    inset 0 1px rgba(255, 255, 255, 0.04);
  backdrop-filter: blur(20px) saturate(110%);
}

.step::before {
  display: grid;
  width: 46px;
  height: 46px;
  margin-bottom: 22px;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--color-companion) 28%, var(--color-border));
  border-radius: 17px 17px 17px 7px;
  background:
    linear-gradient(145deg, var(--color-companion-soft), var(--color-accent-soft)),
    var(--color-surface-elevated);
  box-shadow: var(--shadow-sm);
  color: var(--color-companion);
  content: 'N';
  font-family: var(--font-family-display);
  font-size: 22px;
  font-weight: 600;
}

.step::after {
  position: absolute;
  top: -72px;
  right: -56px;
  width: 180px;
  height: 180px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 50%;
  background: radial-gradient(circle, var(--color-accent-soft), transparent 67%);
  content: '';
  pointer-events: none;
}

h2 {
  position: relative;
  z-index: 1;
  margin-bottom: 9px;
  color: var(--color-text);
  font-family: var(--font-family-display);
  font-size: clamp(24px, 4vw, 30px);
  font-weight: 600;
  letter-spacing: 0.01em;
}

.hint {
  position: relative;
  z-index: 1;
  margin-bottom: 24px;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.72;
}

.welcome {
  margin-bottom: var(--spacing-md);
  color: var(--color-text-secondary);
  font-size: var(--font-size-lg);
  line-height: 1.7;
}

.field {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-bottom: 14px;
}

.field span {
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  font-weight: 600;
  letter-spacing: 0.025em;
}

.field input {
  width: 100%;
  min-height: 44px;
  padding: 10px 13px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--color-bg-tertiary) 82%, transparent);
  color: var(--color-text);
  font-size: var(--font-size-base);
  user-select: text;
  transition:
    border-color 0.18s ease,
    background 0.18s ease,
    box-shadow 0.18s ease;
}

.field input::placeholder {
  color: var(--color-text-muted);
}

.field input:focus {
  border-color: color-mix(in srgb, var(--color-accent) 64%, var(--color-border));
  background: var(--color-bg-secondary);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}

.primary-btn {
  position: relative;
  z-index: 1;
  width: 100%;
  min-height: 48px;
  margin-top: 8px;
  padding: 11px 20px;
  border-radius: 14px;
  background: var(--color-accent);
  box-shadow:
    inset 0 1px rgba(255, 255, 255, 0.24),
    var(--shadow-sm);
  color: var(--color-text-on-accent);
  font-size: var(--font-size-base);
  font-weight: 650;
  letter-spacing: 0.02em;
}

.primary-btn:hover {
  background: var(--color-accent-hover);
  box-shadow: var(--shadow-md);
  transform: translateY(-1px);
}

.error-msg,
.info-msg {
  position: relative;
  z-index: 1;
  margin-bottom: var(--spacing-md);
  padding: 10px 12px;
  border: 1px solid;
  border-radius: var(--radius);
  font-size: var(--font-size-sm);
  line-height: 1.55;
}

.error-msg {
  border-color: var(--color-error-border);
  background: var(--color-error-bg);
  color: var(--color-error);
}

.info-msg {
  border-color: color-mix(in srgb, var(--color-info) 26%, transparent);
  background: color-mix(in srgb, var(--color-info) 9%, transparent);
  color: var(--color-text-secondary);
}

.testing-step {
  display: flex;
  min-height: 320px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-md);
  color: var(--color-text-secondary);
  text-align: center;
}

.testing-step::before,
.success-step::before {
  margin-inline: auto;
}

.spinner {
  width: 34px;
  height: 34px;
  border: 2px solid var(--color-border);
  border-top-color: var(--color-accent);
  border-right-color: var(--color-companion);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.examples {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 9px;
}

.example-btn {
  min-height: 64px;
  padding: 11px 13px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius);
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.45;
  text-align: left;
}

.example-btn:hover {
  border-color: color-mix(in srgb, var(--color-accent) 38%, var(--color-border));
  background: var(--color-accent-soft);
  color: var(--color-text);
  transform: translateY(-1px);
}

.success-step {
  text-align: center;
}

@media (max-width: 520px) {
  .first-run-guide {
    align-items: flex-start;
    padding: 12px;
  }

  .step {
    padding: 22px 18px;
  }

  .examples {
    grid-template-columns: 1fr;
  }
}
</style>
