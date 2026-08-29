<script setup lang="ts">
// F5-001 C0-5：persona 合规设置子区（仅开发构建可见，S-005-补充 §1.6）。
// 冻结行为：
//   - 审计开关/采样率等 audit 字段可编辑；gate 字段（开关/scope/阈值/预算/重生成次数）C1 期间只读
//   - disabledRuleIds 的规则开关列表等 C1 规则元数据落地后填充，此处只读展示当前配置
//   - debugCaptureText 启用前二次确认"日志可能包含回复片段"
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useConfigStore } from '../../stores/config'
import SettingsSectionFrame from './SettingsSectionFrame.vue'
import { parseNumericInput } from '../../utils/parse-numeric'

const configStore = useConfigStore()
const { state } = storeToRefs(configStore)
const feedback = ref('')
const compliance = computed(() => state.value.draft?.persona.compliance)

const SCOPE_LABELS: Record<string, string> = {
  'first-segment': '仅首段干预',
  'all-segments': '全段判定（诊断）',
  observe: '仅观察记录（默认，不干预输出）',
  off: '完全关闭'
}

function patchAudit(values: Partial<NonNullable<typeof compliance.value>['audit']>): void {
  configStore.patchPersonaCompliance({ audit: values })
}

function patchAuditNumeric(
  key: 'sampleRate' | 'timeoutMs' | 'recentTurnWindow',
  value: string
): void {
  const num = parseNumericInput(value)
  if (num === undefined) return
  patchAudit({ [key]: num })
}

function onToggleDebugCapture(event: Event): void {
  const input = event.target as HTMLInputElement
  if (input.checked) {
    const confirmed = window.confirm(
      '启用后诊断日志可能包含回复片段（经脱敏截断）。仅用于本机调试，确定启用？'
    )
    if (!confirmed) {
      input.checked = false
      return
    }
  }
  configStore.patchPersonaCompliance({ debugCaptureText: input.checked })
}

async function save(): Promise<void> {
  feedback.value = ''
  const ok = await configStore.save()
  feedback.value = ok ? '合规审查设置已保存' : (state.value.validationErrors.save ?? '保存失败')
}
</script>

<template>
  <SettingsSectionFrame
    kicker="COMPLIANCE · 合规审查（开发者）"
    title="观察输出合规，不干预对话"
    description="当前为仅观察（observe）模式：系统只做匹配与记录，从不拦截或修改回复。门控参数在 C1 期间只读；审计采集参数可在此调整。"
  >
    <div v-if="compliance" class="compliance-grid">
      <section class="settings-card">
        <header>
          <p>GATE · 只读</p>
          <h3>门控（C1 期间锁定）</h3>
        </header>
        <dl class="readonly-list">
          <div class="readonly-row">
            <dt>总开关</dt>
            <dd>{{ compliance.gate.enabled ? '开启' : '关闭（kill switch）' }}</dd>
          </div>
          <div class="readonly-row">
            <dt>作用范围</dt>
            <dd>{{ SCOPE_LABELS[compliance.gate.scope] ?? compliance.gate.scope }}</dd>
          </div>
          <div class="readonly-row">
            <dt>首段最小字符</dt>
            <dd>{{ compliance.gate.firstSegmentMinChars }}</dd>
          </div>
          <div class="readonly-row">
            <dt>分段最大字符</dt>
            <dd>{{ compliance.gate.segmentMaxChars }}</dd>
          </div>
          <div class="readonly-row">
            <dt>单轮预算</dt>
            <dd>{{ compliance.gate.budgetMs }} ms</dd>
          </div>
          <div class="readonly-row">
            <dt>最大重生成次数</dt>
            <dd>{{ compliance.gate.maxRegenerations }}</dd>
          </div>
          <div class="readonly-row">
            <dt>首段持留上限</dt>
            <dd>{{ compliance.gate.maxHoldMs }} ms</dd>
          </div>
        </dl>
        <p class="card-note">
          门控参数的编辑权限由 C2/C3 门禁决定；当前如需修改请手改 config.json。
        </p>
      </section>

      <section class="settings-card">
        <header>
          <p>AUDIT</p>
          <h3>审计采集</h3>
        </header>
        <label class="check-row">
          <span>
            <strong>启用审计</strong>
            <small>按采样率把对话轮次送独立审计模型；审计不可用只记指标不影响对话</small>
          </span>
          <input
            type="checkbox"
            :checked="compliance.audit.enabled"
            @change="patchAudit({ enabled: ($event.target as HTMLInputElement).checked })"
          />
        </label>
        <label class="field">
          <span>采样率（0–1，规则命中/用户反馈轮强制送审）</span>
          <input
            type="number"
            min="0"
            max="1"
            step="0.05"
            :value="compliance.audit.sampleRate"
            @input="patchAuditNumeric('sampleRate', ($event.target as HTMLInputElement).value)"
          />
        </label>
        <label class="field">
          <span>审计超时（毫秒，1000–120000）</span>
          <input
            type="number"
            min="1000"
            max="120000"
            step="1000"
            :value="compliance.audit.timeoutMs"
            @input="patchAuditNumeric('timeoutMs', ($event.target as HTMLInputElement).value)"
          />
        </label>
        <label class="field">
          <span>审计上下文轮数（1–20）</span>
          <input
            type="number"
            min="1"
            max="20"
            :value="compliance.audit.recentTurnWindow"
            @input="
              patchAuditNumeric('recentTurnWindow', ($event.target as HTMLInputElement).value)
            "
          />
        </label>
      </section>

      <section class="settings-card">
        <header>
          <p>RULES · 只读</p>
          <h3>禁用规则</h3>
        </header>
        <p v-if="compliance.disabledRuleIds.length === 0" class="card-note">
          当前没有禁用任何规则。逐规则开关列表将在 C1 规则元数据落地后提供。
        </p>
        <ul v-else class="rule-list">
          <li v-for="id in compliance.disabledRuleIds" :key="id">{{ id }}</li>
        </ul>
        <label class="check-row">
          <span>
            <strong>调试文本采集</strong>
            <small>仅开发构建生效；启用前需二次确认，日志经脱敏截断</small>
          </span>
          <input
            type="checkbox"
            :checked="compliance.debugCaptureText"
            @change="onToggleDebugCapture"
          />
        </label>
      </section>

      <div class="section-actions">
        <p>{{ feedback }}</p>
        <button :disabled="!configStore.canSave || state.saving" @click="save">
          {{ state.saving ? '保存中…' : '保存修改' }}
        </button>
      </div>
    </div>
  </SettingsSectionFrame>
</template>

<style scoped>
.compliance-grid {
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

.readonly-list {
  display: flex;
  flex-direction: column;
  margin: 0;
}

.readonly-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 15px;
  padding: 8px 0;
  border-bottom: 1px solid var(--color-border-subtle);
}

.readonly-row:last-child {
  border-bottom: 0;
}

.readonly-row dt {
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  font-weight: 650;
}

.readonly-row dd {
  margin: 0;
  color: var(--color-text);
  font-size: var(--font-size-sm);
  font-variant-numeric: tabular-nums;
}

.card-note {
  color: var(--color-text-muted);
  font-size: 10px;
  line-height: 1.6;
}

.rule-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.rule-list li {
  padding: 3px 9px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-full);
  color: var(--color-text-secondary);
  font-family: var(--font-family-mono, monospace);
  font-size: 10px;
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

.field input {
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
  grid-column: 1 / -1;
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

.section-actions button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

@media (max-width: 760px) {
  .compliance-grid {
    grid-template-columns: 1fr;
  }
}
</style>
