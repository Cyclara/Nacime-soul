<script setup lang="ts">
// P3V-13/14/15：ASR 模型目录容器——预设 + 6 张详细卡 + 批量下载。
// 首次设置与设置页复用本组件；每张卡由 AsrModelItem 统一渲染，不复制模板。
// 组件只调 voice store，不拼 IPC；全部模型 localOnly，无云识别入口。

import { computed, ref, watch } from 'vue'
import {
  ASR_MODEL_CATALOG,
  ASR_PRESETS,
  ASR_VAD_CATALOG_ENTRY,
  findAsrPreset,
  formatAsrDownloadSize,
  formatAsrDownloadTotal,
  totalAsrDownloadBytes,
  type AsrPresetId
} from '@shared/voice/asr-catalog'
import type { AsrEngineId } from '@shared/voice/asr-settings-types'
import { useVoiceStore } from '../../stores/voice'
import AsrModelItem from './AsrModelItem.vue'

const props = withDefaults(
  defineProps<{
    /** setup=首次引导（底部 CTA 由父组件控制）；settings=普通设置页（本组件显示应用按钮）。 */
    mode?: 'setup' | 'settings'
  }>(),
  { mode: 'settings' }
)

const emit = defineEmits<{
  selectionChange: [selection: AsrSelection]
}>()

interface AsrSelection {
  readonly presetId: AsrPresetId
  readonly engineIds: readonly AsrEngineId[]
  readonly primaryEngineId: AsrEngineId | null
  readonly fallbackEngineId: AsrEngineId | null
  readonly totalBytes: number
}

function sameEngineSet(left: readonly AsrEngineId[], right: readonly AsrEngineId[]): boolean {
  return left.length === right.length && left.every((engineId) => right.includes(engineId))
}

function matchingPresetId(
  engineIds: readonly AsrEngineId[],
  primaryEngineId: AsrEngineId,
  fallbackEngineId: AsrEngineId | null
): AsrPresetId {
  const preset = ASR_PRESETS.find(
    (entry) =>
      entry.id !== 'custom' &&
      sameEngineSet(entry.engineIds, engineIds) &&
      entry.primaryEngineId === primaryEngineId &&
      entry.fallbackEngineId === fallbackEngineId
  )
  return preset?.id ?? 'custom'
}

const voice = useVoiceStore()
const presetId = ref<AsrPresetId>('standard')
const selectedIds = ref<AsrEngineId[]>([])
const proposedPrimary = ref<AsrEngineId | null>(null)
const proposedFallback = ref<AsrEngineId | null>(null)
const applying = ref(false)
const initializedFromOverview = ref(props.mode === 'setup')

function applyPresetLocally(id: AsrPresetId): void {
  presetId.value = id
  const preset = findAsrPreset(id)
  if (preset === undefined) return
  selectedIds.value = [...preset.engineIds]
  proposedPrimary.value = preset.primaryEngineId
  proposedFallback.value = preset.fallbackEngineId
}

// 首次设置默认「标准推荐」（用户已确认的产品默认）。设置页则从已持久化 overview 初始化，
// 绝不因为打开页面就把既有自定义配置悄悄改成标准预设。
if (props.mode === 'setup') applyPresetLocally('standard')

watch(
  () => voice.state.asrOverview,
  (overview) => {
    if (props.mode !== 'settings' || initializedFromOverview.value || overview === null) return
    const selected: AsrEngineId[] = [overview.selectedEngineId]
    if (overview.fallbackEngineId !== null) selected.push(overview.fallbackEngineId)
    selectedIds.value = selected
    proposedPrimary.value = overview.selectedEngineId
    proposedFallback.value = overview.fallbackEngineId
    presetId.value = matchingPresetId(
      selected,
      overview.selectedEngineId,
      overview.fallbackEngineId
    )
    initializedFromOverview.value = true
  },
  { immediate: true }
)

const selection = computed<AsrSelection>(() => ({
  presetId: presetId.value,
  engineIds: selectedIds.value,
  primaryEngineId: proposedPrimary.value,
  fallbackEngineId: proposedFallback.value,
  totalBytes: totalAsrDownloadBytes(selectedIds.value)
}))

watch(
  selection,
  (value) => {
    emit('selectionChange', value)
  },
  { immediate: true }
)

const statusById = computed(() => {
  const map = new Map<AsrEngineId, (typeof voice.engineList)[number]>()
  for (const status of voice.engineList) map.set(status.engineId, status)
  return map
})

const selectedPreset = computed(() => findAsrPreset(presetId.value))
const downloadableCount = computed(
  () => selectedIds.value.filter((id) => statusById.value.get(id)?.modelState !== 'ready').length
)

function choosePreset(id: AsrPresetId): void {
  if (id === 'custom') {
    // 自定义是“从当前方案继续改”，不是清空重来；避免误丢主要/备用选择。
    presetId.value = 'custom'
    return
  }
  applyPresetLocally(id)
}

function toggleEngine(engineId: AsrEngineId, checked: boolean): void {
  if (presetId.value !== 'custom') presetId.value = 'custom'
  const next = new Set(selectedIds.value)
  if (checked) next.add(engineId)
  else next.delete(engineId)
  selectedIds.value = [...next]

  if (!next.has(proposedPrimary.value as AsrEngineId)) {
    proposedPrimary.value = selectedIds.value[0] ?? null
  }
  if (!next.has(proposedFallback.value as AsrEngineId)) {
    proposedFallback.value = null
  }
  if (proposedFallback.value === proposedPrimary.value) proposedFallback.value = null
}

async function selectPrimary(engineId: AsrEngineId): Promise<void> {
  if (props.mode === 'setup') {
    if (!selectedIds.value.includes(engineId)) selectedIds.value = [...selectedIds.value, engineId]
    proposedPrimary.value = engineId
    if (proposedFallback.value === engineId) proposedFallback.value = null
    presetId.value = 'custom'
    return
  }
  const ok = await voice.selectEngine(engineId)
  if (ok) {
    if (!selectedIds.value.includes(engineId)) selectedIds.value = [...selectedIds.value, engineId]
    proposedPrimary.value = engineId
    if (proposedFallback.value === engineId) proposedFallback.value = null
    presetId.value = matchingPresetId(selectedIds.value, engineId, proposedFallback.value)
  }
}

async function selectFallback(engineId: AsrEngineId): Promise<void> {
  if (props.mode === 'setup') {
    if (proposedFallback.value === engineId) {
      proposedFallback.value = null
      return
    }
    if (proposedPrimary.value === engineId) return
    if (!selectedIds.value.includes(engineId)) selectedIds.value = [...selectedIds.value, engineId]
    proposedFallback.value = engineId
    presetId.value = 'custom'
    return
  }
  const next = voice.fallbackEngineId === engineId ? null : engineId
  const ok = await voice.setFallbackEngine(next)
  if (ok) {
    if (next !== null && !selectedIds.value.includes(next))
      selectedIds.value = [...selectedIds.value, next]
    proposedFallback.value = next
    if (proposedPrimary.value !== null) {
      presetId.value = matchingPresetId(selectedIds.value, proposedPrimary.value, next)
    }
  }
}

function download(engineId: AsrEngineId): void {
  voice.enqueueModelDownload(engineId)
}

function cancel(engineId: AsrEngineId): void {
  if (voice.state.asrDownloadQueue.includes(engineId)) {
    void voice.cancelQueuedDownload(engineId)
  } else {
    void voice.cancelDownload(engineId)
  }
}

async function deleteModel(engineId: AsrEngineId): Promise<void> {
  const model = ASR_MODEL_CATALOG.find((entry) => entry.engineId === engineId)
  const confirmed = window.confirm(
    `删除 ${model?.label ?? '这个模型'}？下次使用时需要重新下载 ${formatAsrDownloadSize(
      model?.downloadBytes ?? 0
    )}。`
  )
  if (!confirmed) return
  await voice.deleteModel(engineId)
}

/**
 * 首次设置底部「开始下载」与设置页「应用并下载」共用。
 * 顺序：先写主/备配置，再排下载（VAD 由 manager 在首个模型下载时自动补齐）。
 */
async function startSelectedDownloads(): Promise<boolean> {
  if (applying.value || selectedIds.value.length === 0 || proposedPrimary.value === null)
    return false
  applying.value = true
  try {
    const primaryOk = await voice.selectEngine(proposedPrimary.value)
    if (!primaryOk) return false
    const fallbackOk = await voice.setFallbackEngine(proposedFallback.value)
    if (!fallbackOk) return false
    voice.queueModelDownloads(selectedIds.value)
    return true
  } finally {
    applying.value = false
  }
}

defineExpose({ startSelectedDownloads, selection })
</script>

<template>
  <section class="asr-catalog" aria-labelledby="asr-catalog-title">
    <header class="asr-catalog__header">
      <div>
        <p class="asr-catalog__eyebrow">全部在本机识别 · 音频不上传</p>
        <h3 id="asr-catalog-title">选择她的“听力”</h3>
        <p class="asr-catalog__intro">
          流式模型会边说边出字；离线模型要等一句说完，但适合做稳定备用。
        </p>
      </div>
      <div
        class="asr-catalog__vad"
        :class="`asr-catalog__vad--${voice.state.asrOverview?.vadModel.state ?? 'not-downloaded'}`"
      >
        <strong>{{ ASR_VAD_CATALOG_ENTRY.label }}</strong>
        <span>{{ formatAsrDownloadSize(ASR_VAD_CATALOG_ENTRY.downloadBytes) }} · 每套都需要</span>
      </div>
    </header>

    <div class="asr-catalog__presets" role="radiogroup" aria-label="语音识别安装预设">
      <button
        v-for="preset in ASR_PRESETS"
        :key="preset.id"
        type="button"
        class="asr-catalog__preset"
        :class="{ 'asr-catalog__preset--active': presetId === preset.id }"
        role="radio"
        :aria-checked="presetId === preset.id"
        @click="choosePreset(preset.id)"
      >
        <span class="asr-catalog__preset-label">{{ preset.label }}</span>
        <span>{{ preset.description }}</span>
        <strong v-if="preset.id !== 'custom'">
          {{ formatAsrDownloadTotal(totalAsrDownloadBytes(preset.engineIds)) }}
        </strong>
      </button>
    </div>

    <div class="asr-catalog__summary" role="status" aria-live="polite">
      <span>
        {{ selectedPreset?.label ?? '自定义' }}：已选 {{ selectedIds.length }} 个识别模型， 总下载
        {{ formatAsrDownloadTotal(selection.totalBytes) }}（含 Silero VAD）
      </span>
      <span v-if="proposedPrimary"
        >主要：{{ ASR_MODEL_CATALOG.find((m) => m.engineId === proposedPrimary)?.label }}</span
      >
      <span v-if="proposedFallback"
        >备用：{{ ASR_MODEL_CATALOG.find((m) => m.engineId === proposedFallback)?.label }}</span
      >
      <span v-else>未设备用</span>
    </div>

    <div class="asr-catalog__list">
      <AsrModelItem
        v-for="model in ASR_MODEL_CATALOG"
        :key="model.engineId"
        :model="model"
        :status="statusById.get(model.engineId) ?? null"
        :selectable="presetId === 'custom'"
        :checked="selectedIds.includes(model.engineId)"
        :primary="proposedPrimary === model.engineId"
        :fallback="proposedFallback === model.engineId"
        :configure-before-ready="mode === 'setup'"
        :allow-direct-download="mode === 'settings'"
        @download="download"
        @cancel="cancel"
        @delete="deleteModel"
        @select-primary="selectPrimary"
        @select-fallback="selectFallback"
        @toggle="toggleEngine"
      />
    </div>

    <p v-if="voice.state.overviewError" class="asr-catalog__error" role="alert">
      {{ voice.state.overviewError }}
    </p>

    <footer v-if="mode === 'settings'" class="asr-catalog__footer">
      <div>
        <strong>{{ downloadableCount }} 个模型需要下载</strong>
        <span>下载可取消；已完成文件会保留，重试不从头来。</span>
      </div>
      <button
        type="button"
        class="asr-catalog__apply"
        :disabled="applying || selectedIds.length === 0 || proposedPrimary === null"
        @click="startSelectedDownloads"
      >
        {{ applying ? '正在应用…' : '应用并开始下载' }}
      </button>
    </footer>
  </section>
</template>

<style scoped>
.asr-catalog {
  display: grid;
  gap: 0.875rem;
}

.asr-catalog__header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 1rem;
}

.asr-catalog h3,
.asr-catalog p {
  margin: 0;
}

.asr-catalog__eyebrow {
  color: var(--color-success);
  font-size: 0.68rem;
  font-weight: 650;
  letter-spacing: 0.06em;
}

.asr-catalog h3 {
  margin-top: 0.25rem;
  color: var(--color-text);
  font-family: var(--font-family-display);
  font-size: 1.05rem;
}

.asr-catalog__intro {
  margin-top: 0.35rem !important;
  color: var(--color-text-secondary);
  font-size: 0.78rem;
  line-height: 1.55;
}

.asr-catalog__vad {
  display: grid;
  gap: 0.125rem;
  min-width: 9rem;
  padding: 0.625rem 0.75rem;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius);
  background: var(--color-bg-tertiary);
}

.asr-catalog__vad strong {
  color: var(--color-text);
  font-size: 0.72rem;
}

.asr-catalog__vad span {
  color: var(--color-text-muted);
  font-size: 0.64rem;
}

.asr-catalog__vad--ready {
  border-color: var(--color-success-border);
  background: var(--color-success-bg);
}

.asr-catalog__vad--downloading {
  border-color: var(--color-warning-border);
  background: var(--color-warning-bg);
}

.asr-catalog__vad--error {
  border-color: var(--color-error-border);
  background: var(--color-error-bg);
}

.asr-catalog__presets {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.5rem;
}

.asr-catalog__preset {
  display: grid;
  gap: 0.25rem;
  min-height: 5.25rem;
  padding: 0.75rem;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius);
  background: var(--color-surface-elevated);
  color: var(--color-text-secondary);
  font-size: 0.68rem;
  line-height: 1.4;
  text-align: left;
}

.asr-catalog__preset:hover {
  border-color: var(--color-border);
  background: var(--color-accent-soft);
}

.asr-catalog__preset--active {
  border-color: var(--color-accent);
  background: var(--color-accent-soft);
}

.asr-catalog__preset-label,
.asr-catalog__preset strong {
  color: var(--color-text);
  font-size: 0.78rem;
}

.asr-catalog__preset strong {
  color: var(--color-accent);
  font-variant-numeric: tabular-nums;
}

.asr-catalog__summary {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem 1rem;
  padding: 0.625rem 0.75rem;
  border-left: 3px solid var(--color-accent);
  background: var(--color-accent-soft);
  color: var(--color-text-secondary);
  font-size: 0.7rem;
  line-height: 1.5;
}

.asr-catalog__summary span:first-child {
  flex-basis: 100%;
  color: var(--color-text);
  font-weight: 620;
}

.asr-catalog__list {
  display: grid;
  /* 按组件实际可用宽度换列，不拿整个窗口宽度猜设置抽屉有多宽。 */
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr));
  gap: 0.625rem;
}

.asr-catalog__error {
  padding: 0.625rem 0.75rem;
  border: 1px solid var(--color-error-border);
  border-radius: var(--radius);
  background: var(--color-error-bg);
  color: var(--color-error);
  font-size: 0.75rem;
}

.asr-catalog__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.75rem 0;
}

.asr-catalog__footer div {
  display: grid;
  gap: 0.125rem;
}

.asr-catalog__footer strong {
  color: var(--color-text);
  font-size: 0.78rem;
}

.asr-catalog__footer span {
  color: var(--color-text-muted);
  font-size: 0.68rem;
}

.asr-catalog__apply {
  min-height: 2.5rem;
  padding: 0.5rem 0.875rem;
  border-radius: var(--radius);
  background: var(--color-accent);
  color: var(--color-text-on-accent);
  font-size: 0.75rem;
  font-weight: 650;
}

.asr-catalog__apply:hover:not(:disabled) {
  background: var(--color-accent-hover);
}

.asr-catalog__apply:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

@media (max-width: 620px) {
  .asr-catalog__header,
  .asr-catalog__presets {
    grid-template-columns: 1fr;
  }

  .asr-catalog__vad {
    min-width: 0;
  }

  .asr-catalog__footer {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
