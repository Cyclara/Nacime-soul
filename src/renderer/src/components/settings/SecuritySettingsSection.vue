<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useConfigStore } from '../../stores/config'
import SettingsSectionFrame from './SettingsSectionFrame.vue'
import { parseNumericInput } from '../../utils/parse-numeric'

const configStore = useConfigStore()
const { state } = storeToRefs(configStore)
const feedback = ref('')
const security = computed(() => state.value.draft?.security)

function patchDiagnostics(
  values: Partial<NonNullable<typeof security.value>['diagnostics']>
): void {
  if (!security.value) return
  configStore.patch('security', {
    diagnostics: { ...security.value.diagnostics, ...values }
  })
}

function patchPrivacy(values: Partial<NonNullable<typeof security.value>['privacy']>): void {
  if (!security.value) return
  configStore.patch('security', {
    privacy: { ...security.value.privacy, ...values }
  })
}

// M-29：数值输入清空时不写 0
function patchDiagnosticsNumeric(key: 'retentionDays' | 'maxTotalMb', value: string): void {
  const num = parseNumericInput(value)
  if (num === undefined) return
  patchDiagnostics({ [key]: num })
}

async function save(): Promise<void> {
  feedback.value = ''
  const ok = await configStore.save()
  feedback.value = ok ? '安全与诊断设置已保存' : (state.value.validationErrors.save ?? '保存失败')
}
</script>

<template>
  <SettingsSectionFrame
    kicker="SECURITY · 安全"
    title="让边界清楚，也让诊断可控"
    description="不可关闭的 Electron 安全常量不会暴露为偏好。这里仅管理日志保留、诊断导出和开发环境网络例外。"
  >
    <div v-if="security" class="security-grid">
      <section class="settings-card">
        <header>
          <p>DIAGNOSTICS</p>
          <h3>诊断与日志</h3>
        </header>
        <label class="field">
          <span>日志级别</span>
          <select
            :value="security.diagnostics.logLevel"
            @change="
              patchDiagnostics({
                logLevel: ($event.target as HTMLSelectElement).value as
                  'error' | 'warn' | 'info' | 'debug'
              })
            "
          >
            <option value="error">仅错误</option>
            <option value="warn">警告及以上</option>
            <option value="info">常规信息</option>
            <option value="debug">开发调试</option>
          </select>
        </label>
        <label class="field">
          <span>日志保留天数</span>
          <input
            type="number"
            min="1"
            max="30"
            :value="security.diagnostics.retentionDays"
            @input="
              patchDiagnosticsNumeric('retentionDays', ($event.target as HTMLInputElement).value)
            "
          />
        </label>
        <label class="field">
          <span>日志总容量上限（MB）</span>
          <input
            type="number"
            min="10"
            max="500"
            :value="security.diagnostics.maxTotalMb"
            @input="
              patchDiagnosticsNumeric('maxTotalMb', ($event.target as HTMLInputElement).value)
            "
          />
        </label>
      </section>

      <section class="settings-card">
        <header>
          <p>PRIVACY</p>
          <h3>隐私与导出</h3>
        </header>
        <label class="check-row">
          <span>
            <strong>诊断导出包含崩溃转储</strong>
            <small>崩溃转储可能包含运行环境细节，默认关闭。</small>
          </span>
          <input
            type="checkbox"
            :checked="security.privacy.includeCrashDumpsInExport"
            @change="
              patchPrivacy({
                includeCrashDumpsInExport: ($event.target as HTMLInputElement).checked
              })
            "
          />
        </label>
        <label class="check-row">
          <span>
            <strong>每月清理摘要</strong>
            <small>记录本地记忆清理的月度摘要，不包含聊天正文。</small>
          </span>
          <input
            type="checkbox"
            :checked="security.privacy.monthlyGcDigest"
            @change="patchPrivacy({ monthlyGcDigest: ($event.target as HTMLInputElement).checked })"
          />
        </label>
        <label class="check-row">
          <span>
            <strong>开发环境允许 localhost HTTP</strong>
            <small>仅供本地模型和开发服务使用；生产网络策略仍会限制其他 HTTP 出口。</small>
          </span>
          <input
            type="checkbox"
            :checked="security.allowHttpLocalhostInDev"
            @change="
              configStore.patch('security', {
                allowHttpLocalhostInDev: ($event.target as HTMLInputElement).checked
              })
            "
          />
        </label>
      </section>
    </div>

    <footer class="section-actions">
      <p role="status">{{ feedback }}</p>
      <button :disabled="state.saving" @click="save">
        {{ state.saving ? '保存中…' : '保存安全设置' }}
      </button>
    </footer>
  </SettingsSectionFrame>
</template>

<style scoped>
.security-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.settings-card {
  display: flex;
  flex-direction: column;
  gap: 15px;
  padding: clamp(18px, 3vw, 26px);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-xl);
  background: var(--color-surface-elevated);
  box-shadow: var(--shadow-md);
}

.settings-card header p {
  color: var(--color-accent);
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.16em;
}

.settings-card header h3 {
  margin-top: 5px;
  color: var(--color-text);
  font-family: var(--font-family-display);
  font-size: 22px;
  font-weight: 560;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.field span {
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  font-weight: 650;
}

.field input,
.field select {
  min-height: 42px;
  padding: 9px 11px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-secondary);
  color: var(--color-text);
  font-size: var(--font-size-sm);
}

.check-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 15px;
  padding: 13px 0;
  border-bottom: 1px solid var(--color-border-subtle);
}

.check-row:last-child {
  border-bottom: 0;
}

.check-row > span {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.check-row strong {
  color: var(--color-text);
  font-size: var(--font-size-sm);
}

.check-row small {
  color: var(--color-text-muted);
  font-size: 10px;
  line-height: 1.5;
}

.check-row input {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  accent-color: var(--color-accent);
}

.section-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
}

.section-actions p {
  margin-right: auto;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.section-actions button {
  min-height: 42px;
  padding: 8px 17px;
  border-radius: var(--radius-full);
  background: var(--color-accent);
  color: var(--color-text-on-accent);
  font-weight: 650;
}

@media (max-width: 760px) {
  .security-grid {
    grid-template-columns: 1fr;
  }
}
</style>
