<script setup lang="ts">
// P2-35: DmaePresetBar -- 预设选择栏（内置 4 + 用户预设）。
// 依据：F5-002 §3.5（预设系统）、F5-002-补充 §1.5（选择与预览 UX）。
//
// 设计要点：
//   1. 选择预设只填草稿（config store patchDmae），不立即保存
//   2. 内置预设 builtin=true 不可删除/编辑，可"另存为"派生副本
//   3. 显示列表 = BUILTIN_PRESETS（shared 唯一真源，2026-08-10 审计：修掉双份复制）
//   4. Bm/λ 不出现在任何内置预设里（§2.1 事实 A）
//   5. P2-35 修复（2026-08-10 审计）：
//      - matchesPreset 解析 baseline 后全量比对（修复前：空 overrides 的 default 恒匹配 -> 恒显"默认"）
//      - applyPreset 解析 baseline 后 patch 全参数子集（修复前只叠 overrides -> 切预设残留旧值）

import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useConfigStore } from '../../stores/config'
import { BUILTIN_PRESETS, DEFAULT_DMAE_PARAMS, TUNABLE_PARAMS } from '@shared/memory/dmae-config'
import type { DmaePreset } from '@shared/memory/dmae-config'

const configStore = useConfigStore()
const { state } = storeToRefs(configStore)

const userPresets = computed(() => state.value.draft?.memory.dmae.presets ?? [])
const allPresets = computed(() => [...BUILTIN_PRESETS, ...userPresets.value])

/** 解析预设为完整参数（baseline 展开 + overrides 覆盖） */
function resolvePresetParams(preset: DmaePreset): Record<string, number> {
  const resolved: Record<string, number> = { ...DEFAULT_DMAE_PARAMS }
  for (const [key, value] of Object.entries(preset.overrides)) {
    resolved[key] = value
  }
  return resolved
}

// 当前参数匹配哪个预设（与 resolved 全量比对，不是只比对 overrides）
const currentPresetId = computed(() => {
  const dmae = state.value.draft?.memory.dmae
  if (!dmae) return null
  for (const p of allPresets.value) {
    if (matchesPreset(dmae, p)) return p.id
  }
  return null
})

function matchesPreset(dmae: Record<string, unknown>, preset: DmaePreset): boolean {
  const resolved = resolvePresetParams(preset)
  return TUNABLE_PARAMS.every((key) => (dmae as Record<string, number>)[key] === resolved[key])
}

function applyPreset(preset: DmaePreset): void {
  // 选择预设 -> 填草稿（不保存）。应用解析后的全参数子集（baseline 语义），
  // 修复前只叠 overrides，切换"温柔体贴"->"活在当下"会残留 Bu=25。
  configStore.patchDmae(resolvePresetParams(preset) as never)
}
</script>

<template>
  <div class="preset-bar">
    <div class="preset-label">预设</div>
    <div class="preset-list" role="radiogroup" aria-label="DMAE 预设">
      <button
        v-for="preset in allPresets"
        :key="preset.id"
        :class="['preset-chip', { active: currentPresetId === preset.id }]"
        role="radio"
        :aria-checked="currentPresetId === preset.id"
        :title="preset.description"
        @click="applyPreset(preset)"
      >
        {{ preset.name }}
        <span v-if="preset.builtin" class="builtin-tag">内置</span>
      </button>
    </div>
    <p v-if="currentPresetId" class="preset-desc">
      {{ allPresets.find((p) => p.id === currentPresetId)?.description }}
    </p>
  </div>
</template>

<style scoped>
.preset-bar {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
  background:
    linear-gradient(145deg, var(--color-companion-soft), transparent 58%),
    color-mix(in srgb, var(--color-surface) 76%, transparent);
}

.preset-label {
  color: var(--color-text);
  font-family: var(--font-family-display);
  font-size: var(--font-size-lg);
  font-weight: 600;
}

.preset-list {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}

.preset-chip {
  display: inline-flex;
  min-height: 34px;
  align-items: center;
  gap: 6px;
  padding: 5px 11px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-full);
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.preset-chip:hover {
  border-color: color-mix(in srgb, var(--color-accent) 24%, var(--color-border));
  background: var(--color-accent-soft);
  color: var(--color-text);
}

/* 低强度选中态，避免抢过参数说明的视觉层级。 */
.preset-chip.active {
  border-color: color-mix(in srgb, var(--color-accent) 42%, var(--color-border));
  background: var(--color-accent-soft-hover);
  color: var(--color-accent);
  box-shadow: inset 0 0 0 1px var(--color-accent-soft);
}

.builtin-tag {
  padding: 1px 5px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, currentColor 9%, transparent);
  color: var(--color-text-muted);
  font-size: 9px;
}

.preset-desc {
  max-width: 72ch;
  margin-top: 1px;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  line-height: 1.6;
}
</style>
