<script setup lang="ts">
// P2-31: L0ProfileCard -- 画像字段网格（"未知/待发现"灰态 + 已知值 + pin 图标）。
// 依据：S-006 §1.2、S-011 §1.3（L0 按白名单固定顺序）、S-006 §1.4（空态人格化）。
// 功能版（视觉待前端模型美化）。
// M-44：字段内联编辑（功能版）——草稿取 rawValue（显示 value 已做人称转换）；
//       保存非空 -> setPinned（user_pinned 防自动覆盖）；保存空串 -> clearField。
// 2026-08-21 布局改进①：视觉权重反转——已填字段放大成主角富卡片（衬线大字、
//       长值跨列），未填字段收成"她还不了解"低调 chips 行（点 chip 直接补答）。
//       布局随数据生长：她越了解你，富卡片区越大、chips 越短。

import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useMemoryStore } from '../../stores/memory'

const memoryStore = useMemoryStore()
const { state } = storeToRefs(memoryStore)

// 已填/未填分区：filled 做主角卡片，unknown 收 chips
const filledFields = computed(() => (state.value.l0?.fields ?? []).filter((f) => f.value !== null))
const unknownFields = computed(() => (state.value.l0?.fields ?? []).filter((f) => f.value === null))

/** 长值跨两列（让"喜好/长期备注"这类长文本有呼吸空间） */
const LONG_VALUE_THRESHOLD = 18
function isLongValue(value: string | null): boolean {
  return (value?.length ?? 0) > LONG_VALUE_THRESHOLD
}

// M-44：内联编辑状态（一次只编一个字段）
const editingKey = ref<string | null>(null)
const editDraft = ref('')
const saving = ref(false)

function startEdit(key: string, rawValue: string | null): void {
  editingKey.value = key
  // 草稿取原始值（rawValue）：显示值已做人称转换，直接编辑会把"你…"写回库
  editDraft.value = rawValue ?? ''
}

function cancelEdit(): void {
  editingKey.value = null
  editDraft.value = ''
}

async function saveEdit(key: string): Promise<void> {
  if (saving.value) return
  saving.value = true
  try {
    // 空串 = 清空该字段（main 侧 clearField）；非空 = setPinned
    const ok = await memoryStore.setL0Field(key, editDraft.value.trim())
    if (ok) cancelEdit()
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section class="l0-card" aria-label="她了解的你">
    <div class="card-header">
      <div>
        <h2 class="card-title">她了解的你</h2>
        <p v-if="state.l0?.filledCount === 0" class="card-subtitle">
          目前还是空白，所有字段都等待由你亲口告诉她。
        </p>
      </div>
      <span v-if="state.l0" class="field-count"
        >{{ state.l0.filledCount }}/{{ state.l0.totalCount }}</span
      >
    </div>

    <div v-if="!state.l0" class="l0-skeleton" aria-label="正在加载画像字段">
      <span v-for="index in 9" :key="index"></span>
    </div>

    <template v-else>
      <!-- 已了解的字段：主角富卡片 -->
      <div v-if="filledFields.length" class="l0-grid">
        <div
          v-for="(field, index) in filledFields"
          :key="field.key"
          class="l0-field"
          :class="{ pinned: field.isPinned, 'span-2': isLongValue(field.value) }"
          :style="{ '--i': index }"
        >
          <div class="field-header">
            <span class="field-label">{{ field.label }}</span>
            <span class="field-tools">
              <span
                v-if="field.isPinned"
                v-tooltip="'已固定，不会被自动覆盖'"
                class="pin-badge"
                aria-label="已固定，不会被自动覆盖"
                >📌</span
              >
              <button
                v-if="editingKey !== field.key"
                v-tooltip="'编辑'"
                class="field-edit-btn"
                :aria-label="`编辑${field.label}`"
                @click="startEdit(field.key, field.rawValue)"
              >
                ✎
              </button>
            </span>
          </div>
          <div v-if="editingKey !== field.key" class="field-value">
            <span>{{ field.value }}</span>
          </div>
          <div v-else class="field-edit">
            <div class="field-edit-row">
              <input
                v-model="editDraft"
                class="field-edit-input"
                type="text"
                maxlength="120"
                :aria-label="`编辑${field.label}（留空保存 = 清空）`"
                @keydown.enter="saveEdit(field.key)"
                @keydown.esc.stop="cancelEdit"
              />
              <div class="field-edit-actions">
                <button
                  class="field-edit-action primary"
                  :disabled="saving"
                  @click="saveEdit(field.key)"
                >
                  {{ saving ? '…' : '✓' }}
                </button>
                <button class="field-edit-action" :disabled="saving" @click="cancelEdit">✕</button>
              </div>
            </div>
            <span v-if="field.rawValue && field.rawValue !== field.value" class="field-edit-hint">
              这是她记下的原文，保存后这里会自动换成「你」的说法
            </span>
          </div>
        </div>
      </div>

      <!-- 尚未了解的字段：低调 chips，点一下就能补答 -->
      <div v-if="unknownFields.length" class="unknown-strip">
        <span class="unknown-label">她还不了解</span>
        <template v-for="(field, index) in unknownFields" :key="field.key">
          <span v-if="editingKey === field.key" class="chip-edit" :style="{ '--i': index }">
            <input
              v-model="editDraft"
              class="field-edit-input chip-input"
              type="text"
              maxlength="120"
              :placeholder="field.label"
              :aria-label="`告诉她${field.label}`"
              @keydown.enter="saveEdit(field.key)"
              @keydown.esc.stop="cancelEdit"
            />
            <button
              class="field-edit-action primary"
              :disabled="saving"
              :aria-label="`保存${field.label}`"
              @click="saveEdit(field.key)"
            >
              {{ saving ? '…' : '✓' }}
            </button>
            <button
              class="field-edit-action"
              :disabled="saving"
              aria-label="取消编辑"
              @click="cancelEdit"
            >
              ✕
            </button>
          </span>
          <button
            v-else
            v-tooltip="'点一下，亲口告诉她'"
            class="unknown-chip"
            :style="{ '--i': index }"
            :aria-label="`告诉她${field.label}`"
            @click="startEdit(field.key, field.rawValue)"
          >
            {{ field.label }}
          </button>
        </template>
      </div>
    </template>
  </section>
</template>

<style scoped>
.l0-card {
  flex-shrink: 0;
  padding: 20px clamp(16px, 3vw, 30px) 22px;
  border-bottom: 1px solid var(--color-border-subtle);
  background:
    linear-gradient(180deg, var(--color-companion-soft), transparent 54%),
    color-mix(in srgb, var(--color-bg-secondary) 88%, transparent);
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}

.card-header > div {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.card-title {
  color: var(--color-text);
  font-family: var(--font-family-display);
  font-size: var(--font-size-lg);
  font-weight: 600;
  letter-spacing: 0.01em;
}

.card-subtitle {
  margin-top: 4px;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  line-height: 1.5;
}

.field-count {
  min-width: 40px;
  padding: 3px 8px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-full);
  background: var(--color-surface-translucent);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.l0-skeleton,
.l0-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 9px;
}

.l0-skeleton span {
  min-height: 74px;
  border: 1px dashed var(--color-border-subtle);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--color-border-subtle) 70%, transparent);
}

.l0-field {
  display: flex;
  min-height: 84px;
  flex-direction: column;
  gap: 8px;
  padding: 13px 14px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--color-surface) 76%, transparent);
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease;
  /* 布局④：staggered entrance（--i 由 v-for 注入，前 8 张错开 26ms） */
  animation: card-enter 0.32s cubic-bezier(0.22, 0.8, 0.32, 1) backwards;
  animation-delay: calc(min(var(--i, 0), 8) * 26ms);
}

@keyframes card-enter {
  from {
    opacity: 0;
    transform: translateY(6px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.l0-field:hover {
  background: var(--color-surface);
  border-color: color-mix(in srgb, var(--color-border) 76%, var(--color-companion) 24%);
}

/* 长值跨两列：让"喜好/长期备注"有呼吸空间 */
.l0-field.span-2 {
  grid-column: span 2;
}

.l0-field.pinned {
  border-color: color-mix(in srgb, var(--color-accent) 28%, var(--color-border));
  background: var(--color-accent-soft);
}

.l0-field.pinned:hover {
  background: var(--color-accent-soft-hover);
}

.field-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-xs);
}

.field-label {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-weight: 600;
  letter-spacing: 0.015em;
}

.field-tools {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.pin-badge {
  filter: grayscale(1);
  font-size: 10px;
  cursor: help;
  opacity: 0.72;
}

/* M-44：字段内联编辑（2026-08-21 视觉 polish：focus 光晕/进入过渡/hover 细节） */
@keyframes edit-in {
  from {
    opacity: 0;
    transform: translateY(3px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.field-edit-btn {
  padding: 1px 5px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  font-size: 11px;
  opacity: 0.6;
  transition:
    opacity 0.15s ease,
    background-color 0.15s ease,
    border-color 0.15s ease,
    color 0.15s ease;
}

.field-edit-btn:hover {
  border-color: var(--color-border-subtle);
  background: var(--color-bg-tertiary);
  color: var(--color-text);
  opacity: 1;
}

.field-edit {
  display: flex;
  flex-direction: column;
  gap: 6px;
  animation: edit-in 0.16s ease;
}

.field-edit-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.field-edit-hint {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  line-height: 1.5;
}

.field-edit-input {
  min-width: 0;
  flex: 1;
  padding: 5px 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-tertiary);
  color: var(--color-text);
  font-size: var(--font-size-sm);
  transition:
    border-color 0.16s ease,
    background-color 0.16s ease,
    box-shadow 0.16s ease;
}

.field-edit-input:focus {
  border-color: color-mix(in srgb, var(--color-accent) 55%, var(--color-border));
  background: var(--color-surface-elevated);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
  outline: none;
}

.field-edit-actions {
  display: inline-flex;
  flex-shrink: 0;
  gap: 4px;
}

.field-edit-action {
  width: 26px;
  height: 26px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-size: 12px;
}

.field-edit-action:hover {
  border-color: var(--color-border);
  color: var(--color-text);
}

.field-edit-action.primary {
  border-color: color-mix(in srgb, var(--color-accent) 42%, var(--color-border));
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.field-edit-action.primary:hover {
  border-color: color-mix(in srgb, var(--color-accent) 58%, var(--color-border));
  background: var(--color-accent-soft-hover);
}

.field-edit-action:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.field-value {
  color: var(--color-text);
  font-family: var(--font-family-display);
  font-size: var(--font-size-lg);
  line-height: 1.55;
  word-break: break-word;
  user-select: text;
}

/* === 2026-08-21 布局①：未填字段收 chips === */
.unknown-strip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 13px;
  padding-top: 12px;
  border-top: 1px dashed var(--color-border-subtle);
}

.unknown-label {
  margin-right: 2px;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  letter-spacing: 0.02em;
}

.unknown-chip {
  padding: 4px 11px;
  border: 1px dashed var(--color-border-subtle);
  border-radius: var(--radius-full);
  background: transparent;
  /* 2026-08-21 验收反馈：11px 太小，13px(sm) 又压过 chips 的低调气质 -> 取 12px 中间档，
     颜色从 muted 提到 secondary 补可读性 */
  color: var(--color-text-secondary);
  font-size: 12px;
  transition:
    color 0.15s ease,
    border-color 0.15s ease,
    background-color 0.15s ease;
  /* chips 跟在富卡片后入场，延迟起点错开 80ms */
  animation: card-enter 0.28s ease backwards;
  animation-delay: calc(80ms + min(var(--i, 0), 8) * 18ms);
}

.unknown-chip:hover {
  border-style: solid;
  border-color: var(--color-border);
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}

.chip-edit {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.chip-input {
  width: 132px;
  flex: none;
}

@media (max-width: 480px) {
  .l0-card {
    padding-inline: 12px;
  }

  .l0-skeleton,
  .l0-grid {
    grid-template-columns: repeat(auto-fill, minmax(142px, 1fr));
  }
}
</style>
