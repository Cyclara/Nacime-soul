<script setup lang="ts">
// P2-35: DmaeParamsPanel -- DMAE 参数编辑面板（8 参数滑条 + 预设栏）。
// 依据：S-006 §1.2（设置抽屉 memory section）、S-005-补充 §1.9（设置页落点）、F5-002 §3.5（预设系统）。
// 功能版（视觉待前端模型美化）。
//
// 设计要点：
//   1. 参数编辑走 config store 的 patchDmae（草稿态 + 脏检查），不直接写 main
//   2. Bm/λ 标注"当前公式下几乎不起作用"（§2.1 事实 A，R08）
//   3. 预设栏显示内置 4 + 用户预设；选择只填草稿，不立即保存
//   4. 保存按钮调 configStore.save()：main 校验落盘 + subscribe 触发写 annotation + 清 muted（P2-35 main 侧）
//
// 落点说明（2026-08-12）：本面板已迁移到设置抽屉 memory section。
// /dmae 只保留诊断、体检和“打开记忆设置”入口，维持 F5-002 的诊断/编辑分离。

import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useConfigStore } from '../../stores/config'
import DmaePresetBar from './DmaePresetBar.vue'
import { parseNumericInput } from '../../utils/parse-numeric'

const configStore = useConfigStore()
const { state } = storeToRefs(configStore)

const dmae = computed(() => state.value.draft?.memory.dmae)
const isDirty = computed(() => configStore.isDirty)
const isSaving = computed(() => state.value.saving)

async function saveChanges(): Promise<void> {
  await configStore.save()
}

interface ParamConfig {
  key: string
  label: string
  description: string
  min: number
  max: number
  step: number
  weak?: boolean // 标注"当前公式下几乎不起作用"
}

const params: ParamConfig[] = [
  {
    key: 'promptThreshold',
    label: '进入门槛',
    description: 'activation 达到多少才能进入思考。调低=更容易想起，调高=只有反复提到的才进得来。',
    min: 1,
    max: 99,
    step: 1
  },
  {
    key: 'userRewardBase',
    label: '记忆力度 Bu',
    description: '你提到一件事时，她的记忆强度提升多少。调高=一次提到就更难忘。',
    min: 10,
    max: 30,
    step: 1
  },
  {
    key: 'wakeGamma',
    label: '重复提及增长 γ',
    description: '隔了一阵子再提到同一件事时，记忆力度额外增加多少。调高=久别重逢时记得更牢。',
    min: 0.3,
    max: 0.8,
    step: 0.05
  },
  {
    key: 'decayAlpha',
    label: '遗忘速度 α',
    description: '你没提到一件事时，它淡忘的速度。调低=记得更久，调高=忘得更快。',
    min: 0.3,
    max: 2,
    step: 0.05
  },
  {
    key: 'decayBeta',
    label: '模型侧遗忘 β',
    description: '她没主动提起时，记忆淡忘的速度（与 α 同方向）。',
    min: 0.05,
    max: 0.5,
    step: 0.01
  },
  {
    key: 'modelRewardBase',
    label: '主动提及权重 Bm',
    description: '她主动提起旧事时的记忆力度。当前公式下几乎不起作用（见面板 R08）。',
    min: 5,
    max: 12,
    step: 0.5,
    weak: true
  },
  {
    key: 'wakeLambda',
    label: '主动提及衰减 λ',
    description: '她主动提起旧事的力度衰减率。当前公式下几乎不起作用。',
    min: 0.1,
    max: 0.5,
    step: 0.01,
    weak: true
  },
  {
    key: 'historySampleEveryTurns',
    label: '历史采样频率',
    description: '每几轮采样一次记忆状态（1=每轮采，2=隔轮采）。调高=历史数据更稀疏但更省空间。',
    min: 1,
    max: 10,
    step: 1
  }
]

function getParam(key: string): number {
  const d = dmae.value
  if (!d) return 0
  return (d as unknown as Record<string, number>)[key] ?? 0
}

function setParam(key: string, value: number): void {
  configStore.patchDmae({ [key]: value } as never)
}

// M-29：数值输入清空时不写 0（Number('')===0 会把草稿静默写成 0）
function onParamInput(key: string, value: string): void {
  const num = parseNumericInput(value)
  if (num === undefined) return
  setParam(key, num)
}

function discardChanges(): void {
  configStore.discard()
}
</script>

<template>
  <div v-if="dmae" class="dmae-params-panel">
    <DmaePresetBar />

    <div class="params-list">
      <div v-for="p in params" :key="p.key" class="param-row" :class="{ weak: p.weak }">
        <div class="param-header">
          <label class="param-label" :for="'param-' + p.key">
            {{ p.label }}
            <span v-if="p.weak" class="weak-tag" title="当前公式下此参数几乎不起作用">弱</span>
          </label>
          <input
            :id="'param-' + p.key"
            type="number"
            class="param-input"
            :value="getParam(p.key)"
            :min="p.min"
            :max="p.max"
            :step="p.step"
            @input="onParamInput(p.key, ($event.target as HTMLInputElement).value)"
          />
        </div>
        <input
          type="range"
          class="param-slider"
          :value="getParam(p.key)"
          :min="p.min"
          :max="p.max"
          :step="p.step"
          :aria-label="p.label"
          @input="onParamInput(p.key, ($event.target as HTMLInputElement).value)"
        />
        <p class="param-desc">{{ p.description }}</p>
      </div>
    </div>

    <div class="panel-footer">
      <div class="footer-left">
        <span v-if="isDirty" class="dirty-hint">有未保存的修改</span>
      </div>
      <button class="reset-btn" :disabled="isSaving" @click="discardChanges">放弃修改</button>
      <button class="save-btn" :disabled="isSaving || !isDirty" @click="saveChanges">
        {{ isSaving ? '保存中…' : '保存' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.dmae-params-panel {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.params-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 10px;
}

.param-row {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 9px;
  padding: 14px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--color-surface) 72%, transparent);
}

.param-row.weak {
  border-style: dashed;
  border-color: var(--color-warning-border);
  background:
    linear-gradient(145deg, var(--color-warning-bg), transparent 52%),
    color-mix(in srgb, var(--color-surface) 72%, transparent);
}

.param-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.param-label {
  min-width: 0;
  color: var(--color-text);
  font-size: var(--font-size-sm);
  font-weight: 600;
}

.weak-tag {
  display: inline-flex;
  min-height: 19px;
  align-items: center;
  margin-left: 5px;
  padding: 1px 6px;
  border: 1px solid var(--color-warning-border);
  border-radius: var(--radius-full);
  background: var(--color-warning-bg);
  color: var(--color-warning);
  font-size: 9px;
  font-weight: 500;
}

.param-input {
  width: 72px;
  min-height: 34px;
  flex-shrink: 0;
  padding: 5px 8px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-sm);
  background: var(--color-bg-tertiary);
  color: var(--color-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: var(--font-size-sm);
  font-variant-numeric: tabular-nums;
  text-align: right;
  user-select: text;
}

.param-input:focus {
  border-color: color-mix(in srgb, var(--color-accent) 60%, var(--color-border));
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}

.param-slider {
  width: 100%;
  height: 6px;
  border-radius: var(--radius-full);
  background: linear-gradient(90deg, var(--color-accent-soft-hover), var(--color-bg-tertiary));
  cursor: pointer;
  -webkit-appearance: none;
  appearance: none;
}

.param-slider::-webkit-slider-thumb {
  width: 18px;
  height: 18px;
  border: 3px solid var(--color-surface-elevated);
  border-radius: 50%;
  background: var(--color-accent);
  box-shadow:
    0 0 0 1px var(--color-accent),
    var(--shadow-sm);
  cursor: pointer;
  -webkit-appearance: none;
}

.param-slider::-moz-range-thumb {
  width: 18px;
  height: 18px;
  border: 3px solid var(--color-surface-elevated);
  border-radius: 50%;
  background: var(--color-accent);
  box-shadow:
    0 0 0 1px var(--color-accent),
    var(--shadow-sm);
  cursor: pointer;
}

.param-desc {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  line-height: 1.58;
}

.panel-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding-top: 4px;
  border-top: 1px solid var(--color-border-subtle);
}

.footer-left {
  margin-right: auto;
}

.dirty-hint {
  color: var(--color-warning);
  font-size: var(--font-size-xs);
}

.reset-btn {
  min-height: 36px;
  padding: 6px 13px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-full);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.reset-btn:hover {
  background: var(--color-surface);
  color: var(--color-text);
}

.save-btn {
  min-height: 36px;
  padding: 6px 18px;
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-full);
  background: var(--color-accent);
  color: #fff;
  font-size: var(--font-size-sm);
  font-weight: 600;
}

.save-btn:hover:not(:disabled) {
  background: var(--color-accent-soft-hover);
}

.save-btn:disabled {
  border-color: var(--color-border-subtle);
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
  cursor: not-allowed;
}

@media (max-width: 520px) {
  .params-list {
    grid-template-columns: 1fr;
  }
}
</style>
