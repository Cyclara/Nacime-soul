<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'
import { useConfigStore } from '../../stores/config'
import { useSettingsUiStore } from '../../stores/settings-ui'
import SettingsSectionFrame from './SettingsSectionFrame.vue'
import { parseNumericInput } from '../../utils/parse-numeric'
import DmaeParamsPanel from './DmaeParamsPanel.vue'

const configStore = useConfigStore()
const settingsUi = useSettingsUiStore()
const router = useRouter()
const { state } = storeToRefs(configStore)
const feedback = ref('')

const memory = computed(() => state.value.draft?.memory)
const savedMemoryEnabled = computed(() => state.value.saved?.memory.enabled ?? false)
const memoryRestartRequired = computed(
  () => memory.value !== undefined && memory.value.enabled !== savedMemoryEnabled.value
)

function patch(values: Partial<NonNullable<typeof memory.value>>): void {
  configStore.patch('memory', values)
}

// M-29：数值输入清空时不写 0（Number('')===0 会把草稿静默写成 0）
function patchNumeric(
  key: 'embeddingDimension' | 'maxActive' | 'minRetrievalScore',
  value: string
): void {
  const num = parseNumericInput(value)
  if (num === undefined) return
  patch({ [key]: num } as Partial<NonNullable<typeof memory.value>>)
}

async function saveCore(): Promise<void> {
  feedback.value = ''
  const ok = await configStore.save()
  feedback.value = ok ? '记忆设置已保存' : (state.value.validationErrors.save ?? '保存失败')
}

function openDiagnostics(): void {
  settingsUi.close()
  void router.push('/dmae')
}
</script>

<template>
  <SettingsSectionFrame
    kicker="MEMORY · 记忆"
    title="决定她如何记住与淡忘"
    description="记忆数据保存在本机。总开关在应用启动时装配，保存后需重启 Nacime 才生效；Embedding 未配置时，语义检索与部分长期记忆能力会保持不可用。"
  >
    <div v-if="memory" class="memory-stack">
      <section class="settings-card core-card">
        <label class="switch-row">
          <span>
            <strong>启用记忆</strong>
            <small>允许从明确的伙伴陈述中提取、保存和引用记忆。</small>
          </span>
          <input
            type="checkbox"
            :checked="memory.enabled"
            @change="patch({ enabled: ($event.target as HTMLInputElement).checked })"
          />
        </label>
        <p v-if="memoryRestartRequired" class="restart-note" role="status">
          保存后需要重启 Nacime，记忆基础设施才会按新开关重新装载。
        </p>

        <div class="form-grid">
          <label class="field">
            <span>Embedding 服务商</span>
            <input
              :value="memory.embeddingProvider"
              placeholder="留空则不启用向量检索"
              @input="patch({ embeddingProvider: ($event.target as HTMLInputElement).value })"
            />
          </label>
          <label class="field">
            <span>Embedding 模型</span>
            <input
              :value="memory.embeddingModel"
              placeholder="模型名称"
              @input="patch({ embeddingModel: ($event.target as HTMLInputElement).value })"
            />
          </label>
          <label class="field">
            <span>向量维度</span>
            <input
              type="number"
              min="64"
              max="8192"
              step="1"
              :value="memory.embeddingDimension"
              @input="patchNumeric('embeddingDimension', ($event.target as HTMLInputElement).value)"
            />
          </label>
          <label class="field">
            <span>最大活跃记忆</span>
            <input
              type="number"
              min="1"
              max="50"
              step="1"
              :value="memory.maxActive"
              @input="patchNumeric('maxActive', ($event.target as HTMLInputElement).value)"
            />
          </label>
          <label class="field full">
            <span>最低检索分数</span>
            <input
              type="number"
              min="-1"
              max="1"
              step="0.01"
              :value="memory.minRetrievalScore"
              @input="patchNumeric('minRetrievalScore', ($event.target as HTMLInputElement).value)"
            />
          </label>
        </div>

        <footer class="card-actions">
          <p class="feedback" role="status">{{ feedback }}</p>
          <button class="diagnostic-btn" @click="openDiagnostics">打开记忆引擎诊断</button>
          <button class="save-btn" :disabled="state.saving" @click="saveCore">
            {{ state.saving ? '保存中…' : '保存基础设置' }}
          </button>
        </footer>
      </section>

      <section class="dmae-card">
        <header>
          <p>DMAE · 记忆动力参数</p>
          <h3>细调她记住与淡忘的节奏</h3>
        </header>
        <DmaeParamsPanel />
      </section>
    </div>
  </SettingsSectionFrame>
</template>

<style scoped>
.memory-stack {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.settings-card,
.dmae-card {
  padding: clamp(18px, 3vw, 28px);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-xl);
  background: var(--color-surface-elevated);
  box-shadow: var(--shadow-md);
}

.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--color-border-subtle);
}

.switch-row > span {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.switch-row strong {
  color: var(--color-text);
  font-size: var(--font-size-base);
}

.switch-row small {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  line-height: 1.5;
}

.switch-row input {
  width: 42px;
  height: 22px;
  accent-color: var(--color-accent);
}

.restart-note {
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px solid var(--color-warning-border);
  border-radius: var(--radius-sm);
  background: var(--color-warning-bg);
  color: var(--color-warning);
  font-size: var(--font-size-xs);
  line-height: 1.55;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 15px;
  margin-top: 20px;
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

.field span {
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  font-weight: 650;
}

.field input {
  min-height: 42px;
  padding: 9px 11px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-secondary);
  color: var(--color-text);
  font-size: var(--font-size-sm);
}

.field input:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}

.card-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 9px;
  margin-top: 20px;
}

.feedback {
  margin-right: auto;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.diagnostic-btn,
.save-btn {
  min-height: 40px;
  padding: 8px 14px;
  border-radius: var(--radius-full);
  font-weight: 650;
}

.diagnostic-btn {
  border: 1px solid var(--color-border);
  color: var(--color-text-secondary);
}

.save-btn {
  background: var(--color-accent);
  color: var(--color-text-on-accent);
}

.dmae-card > header {
  margin-bottom: 18px;
}

.dmae-card > header p {
  color: var(--color-companion);
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.16em;
}

.dmae-card > header h3 {
  margin-top: 5px;
  color: var(--color-text);
  font-family: var(--font-family-display);
  font-size: 22px;
  font-weight: 560;
}

@media (max-width: 620px) {
  .form-grid {
    grid-template-columns: 1fr;
  }

  .field.full {
    grid-column: auto;
  }

  .card-actions {
    align-items: stretch;
    flex-direction: column;
  }

  .feedback {
    margin-right: 0;
  }
}
</style>
