<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import type { ReasoningEffort } from '@shared/config/types'
import { useConfigStore } from '../../stores/config'
import SettingsSectionFrame from './SettingsSectionFrame.vue'

const configStore = useConfigStore()
const { state } = storeToRefs(configStore)
const apiKeyInput = ref('')
const feedback = ref('')

const model = computed(() => state.value.draft?.model)

function patch(values: Partial<NonNullable<typeof model.value>>): void {
  configStore.patch('model', values)
}

// M-29：数值输入清空时不写 0（旧实现 Number('')===0，清空温度等字段会被静默写成 0）
function patchNumeric(
  key: 'temperature' | 'topP' | 'maxTokens' | 'timeoutMs',
  value: string
): void {
  const trimmed = value.trim()
  if (trimmed === '') return
  const num = Number(trimmed)
  if (Number.isNaN(num)) return
  patch({ [key]: num } as Partial<NonNullable<typeof model.value>>)
}

function onApiKeyInput(event: Event): void {
  const value = (event.target as HTMLInputElement).value
  apiKeyInput.value = value
  configStore.setApiKey('model', value)
}

async function save(): Promise<void> {
  feedback.value = ''
  const ok = await configStore.save()
  feedback.value = ok ? '模型配置已保存' : (state.value.validationErrors.save ?? '保存失败')
  if (ok) apiKeyInput.value = ''
}

async function testConnection(): Promise<void> {
  feedback.value = ''
  await configStore.testConnection()
  const result = state.value.connectionResult
  feedback.value = result?.ok
    ? `连接成功${result.latencyMs !== undefined ? ` · ${result.latencyMs}ms` : ''}`
    : `连接失败${result?.code ? ` · ${result.code}` : ''}`
}
</script>

<template>
  <SettingsSectionFrame
    kicker="MODEL · 模型"
    title="决定她如何回应你"
    description="配置当前对话模型与生成参数。API Key 只会进入系统安全存储，不会出现在页面状态或配置文件中。"
  >
    <div v-if="model" class="settings-card">
      <div class="form-grid">
        <label class="field">
          <span>服务商标识</span>
          <input
            :value="model.provider"
            autocomplete="off"
            @input="patch({ provider: ($event.target as HTMLInputElement).value })"
          />
        </label>
        <label class="field">
          <span>协议</span>
          <select
            :value="model.protocol"
            @change="
              patch({
                protocol: ($event.target as HTMLSelectElement).value as
                  'openai-compatible' | 'anthropic'
              })
            "
          >
            <option value="openai-compatible">OpenAI Compatible</option>
            <option value="anthropic" disabled>Anthropic（暂未实现）</option>
          </select>
          <small>当前版本只执行 OpenAI Compatible；Anthropic 仅保留配置合同。</small>
        </label>
        <label class="field full">
          <span>显示名称</span>
          <input
            :value="model.displayName"
            autocomplete="off"
            @input="patch({ displayName: ($event.target as HTMLInputElement).value })"
          />
        </label>
        <label class="field full">
          <span>Base URL</span>
          <input
            :value="model.baseUrl"
            autocomplete="url"
            @input="patch({ baseUrl: ($event.target as HTMLInputElement).value })"
          />
        </label>
        <label class="field">
          <span>模型名称</span>
          <input
            :value="model.model"
            autocomplete="off"
            @input="patch({ model: ($event.target as HTMLInputElement).value })"
          />
        </label>
        <label class="field">
          <span>API Key</span>
          <input
            type="password"
            :value="apiKeyInput"
            :placeholder="model.hasApiKey ? '已安全保存；输入可替换' : '输入 API Key'"
            autocomplete="new-password"
            @input="onApiKeyInput"
          />
        </label>
      </div>

      <div class="parameter-grid">
        <label class="field compact">
          <span>Temperature</span>
          <input
            type="number"
            min="0"
            max="2"
            step="0.05"
            :value="model.temperature"
            @input="patchNumeric('temperature', ($event.target as HTMLInputElement).value)"
          />
        </label>
        <label class="field compact">
          <span>Top P</span>
          <input
            type="number"
            min="0"
            max="1"
            step="0.05"
            :value="model.topP"
            @input="patchNumeric('topP', ($event.target as HTMLInputElement).value)"
          />
        </label>
        <p class="thinking-note">
          思考模式开启时，DeepSeek 会忽略 Temperature 与 Top P（官方行为），关闭思考后生效。
        </p>
        <label class="field compact">
          <span>最大输出 Token</span>
          <input
            type="number"
            min="64"
            max="65536"
            step="64"
            :value="model.maxTokens"
            @input="patchNumeric('maxTokens', ($event.target as HTMLInputElement).value)"
          />
        </label>
        <label class="field compact">
          <span>超时（毫秒）</span>
          <input
            type="number"
            min="1000"
            max="300000"
            step="1000"
            :value="model.timeoutMs"
            @input="patchNumeric('timeoutMs', ($event.target as HTMLInputElement).value)"
          />
        </label>
        <label class="field compact full">
          <span>思考力度</span>
          <select
            :value="model.reasoningEffort"
            :disabled="!model.supportsThinking"
            @change="
              patch({
                reasoningEffort: ($event.target as HTMLSelectElement).value as ReasoningEffort
              })
            "
          >
            <option value="off">关闭</option>
            <option value="low">低</option>
            <option value="medium">中</option>
            <option value="high">高</option>
          </select>
          <small v-if="!model.supportsThinking">当前服务商兼容配置未声明思考模式。</small>
        </label>
      </div>
    </div>

    <footer class="section-actions">
      <p class="feedback" role="status">{{ feedback }}</p>
      <button class="secondary-btn" :disabled="state.testing" @click="testConnection">
        {{ state.testing ? '测试中…' : '测试连接' }}
      </button>
      <button class="primary-btn" :disabled="state.saving" @click="save">
        {{ state.saving ? '保存中…' : '保存模型设置' }}
      </button>
    </footer>
  </SettingsSectionFrame>
</template>

<style scoped>
.settings-card {
  padding: clamp(18px, 3vw, 28px);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-xl);
  background: var(--color-surface-elevated);
  box-shadow: var(--shadow-md);
}

.form-grid,
.parameter-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 15px;
}

.parameter-grid {
  margin-top: 22px;
  padding-top: 22px;
  border-top: 1px solid var(--color-border-subtle);
}

.field {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 7px;
}

.field.full {
  grid-column: 1 / -1;
}

.field > span {
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  font-weight: 650;
}

.field small {
  color: var(--color-text-muted);
  font-size: 10px;
  line-height: 1.5;
}

/* 思考模式忽略采样参数的提示：横跨参数网格整行，视觉与 .field small 一致 */
.thinking-note {
  grid-column: 1 / -1;
  margin: -6px 0 0;
  color: var(--color-text-muted);
  font-size: 10px;
  line-height: 1.5;
}

input,
select {
  width: 100%;
  min-height: 42px;
  padding: 9px 11px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-secondary);
  color: var(--color-text);
  font-size: var(--font-size-sm);
}

input:focus,
select:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}

.section-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 9px;
}

.feedback {
  margin-right: auto;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.primary-btn,
.secondary-btn {
  min-height: 42px;
  padding: 8px 16px;
  border-radius: var(--radius-full);
  font-weight: 650;
}

.primary-btn {
  background: var(--color-accent);
  color: var(--color-text-on-accent);
}

.secondary-btn {
  border: 1px solid var(--color-border);
  background: var(--color-surface-elevated);
  color: var(--color-text-secondary);
}

@media (max-width: 620px) {
  .form-grid,
  .parameter-grid {
    grid-template-columns: 1fr;
  }

  .field.full {
    grid-column: auto;
  }

  .section-actions {
    align-items: stretch;
    flex-direction: column;
  }

  .feedback {
    margin-right: 0;
  }
}
</style>
