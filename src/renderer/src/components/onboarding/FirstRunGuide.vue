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

const configStore = useConfigStore()
const { state } = storeToRefs(configStore)

type Step = 'form' | 'testing' | 'success'

const step = ref<Step>('form')
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
      step.value = 'success'
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

const exampleQuestions = [
  '你好，请介绍一下你自己',
  '今天天气怎么样？',
  '帮我写一首短诗',
  '推荐一本好书'
]

const emit = defineEmits<{
  startChat: [text: string]
}>()

function startWithExample(text: string): void {
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

    <!-- 步骤 3: 成功 -> 欢迎语 + 示例问题 -->
    <div v-else-if="step === 'success'" class="step success-step">
      <h2>连接成功！</h2>
      <p class="welcome">你好！我是 Nacime，很高兴认识你。</p>
      <p class="hint">试试这些问题开始对话：</p>
      <div class="examples">
        <button
          v-for="q in exampleQuestions"
          :key="q"
          class="example-btn"
          @click="startWithExample(q)"
        >
          {{ q }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.first-run-guide {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: var(--spacing-lg);
}
.step {
  max-width: 420px;
  width: 100%;
}
h2 {
  font-size: 20px;
  margin-bottom: var(--spacing-sm);
  color: var(--color-accent);
}
.hint {
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  margin-bottom: var(--spacing-lg);
}
.welcome {
  font-size: var(--font-size-lg);
  margin-bottom: var(--spacing-md);
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
  margin-bottom: var(--spacing-md);
}
.field span {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}
.field input {
  padding: var(--spacing-sm) var(--spacing-md);
  border-radius: var(--radius);
  border: 1px solid var(--color-border);
  background: var(--color-bg-tertiary);
  color: var(--color-text);
  font-size: var(--font-size-base);
}
.field input:focus {
  border-color: var(--color-accent);
}
.primary-btn {
  width: 100%;
  padding: var(--spacing-sm) var(--spacing-lg);
  border-radius: var(--radius);
  background: var(--color-accent);
  color: var(--color-bg);
  font-size: var(--font-size-base);
  font-weight: 600;
  margin-top: var(--spacing-sm);
}
.primary-btn:hover {
  background: var(--color-accent-hover);
}
.error-msg {
  padding: var(--spacing-sm) var(--spacing-md);
  border-radius: var(--radius);
  background: rgba(247, 118, 142, 0.15);
  color: var(--color-error);
  font-size: var(--font-size-sm);
  margin-bottom: var(--spacing-md);
}
.info-msg {
  padding: var(--spacing-sm) var(--spacing-md);
  border-radius: var(--radius);
  background: rgba(154, 165, 206, 0.1);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  margin-bottom: var(--spacing-md);
}
.testing-step {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-md);
  color: var(--color-text-secondary);
}
.spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--color-border);
  border-top-color: var(--color-accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.examples {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}
.example-btn {
  text-align: left;
  padding: var(--spacing-sm) var(--spacing-md);
  border-radius: var(--radius);
  background: var(--color-bg-tertiary);
  color: var(--color-text);
  font-size: var(--font-size-base);
  border: 1px solid var(--color-border);
}
.example-btn:hover {
  border-color: var(--color-accent);
  background: var(--color-bg-secondary);
}
.success-step {
  text-align: center;
}
</style>
