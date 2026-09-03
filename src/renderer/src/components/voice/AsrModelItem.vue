<script setup lang="ts">
// P3V-13：一张详细 ASR 模型卡（纯展示 + emit）。
// 首次设置/设置页复用的不是两份“长得一样”的模板，而是同一个组件实例树。

import { computed } from 'vue'
import {
  asrBadgeLabel,
  asrModeLabel,
  asrResourceLevelLabel,
  formatAsrDownloadSize,
  type AsrModelCatalogEntry
} from '@shared/voice/asr-catalog'
import type { AsrEngineOverview } from '@shared/voice/asr-settings-types'

const props = defineProps<{
  readonly model: AsrModelCatalogEntry
  readonly status: AsrEngineOverview | null
  /** 首次设置的自定义勾选；设置页省略时不显示勾选框。 */
  readonly checked?: boolean
  /** true=显示自定义勾选。 */
  readonly selectable?: boolean
  /** 首次设置尚未落盘时，用拟定值覆盖 overview 中的现行主要/备用状态。 */
  readonly primary?: boolean
  readonly fallback?: boolean
  /** 首次设置允许模型下载前先指定主要/备用；普通设置仍只配置已校验模型。 */
  readonly configureBeforeReady?: boolean
  /** 首次设置统一由页底 CTA 排队，卡内不提前启动单个下载。 */
  readonly allowDirectDownload?: boolean
}>()

const emit = defineEmits<{
  download: [engineId: AsrModelCatalogEntry['engineId']]
  cancel: [engineId: AsrModelCatalogEntry['engineId']]
  delete: [engineId: AsrModelCatalogEntry['engineId']]
  selectPrimary: [engineId: AsrModelCatalogEntry['engineId']]
  selectFallback: [engineId: AsrModelCatalogEntry['engineId']]
  toggle: [engineId: AsrModelCatalogEntry['engineId'], checked: boolean]
}>()

const isPrimary = computed(() => props.primary ?? props.status?.selected ?? false)
const isFallback = computed(() => props.fallback ?? props.status?.fallback ?? false)
const modelState = computed(() => props.status?.modelState ?? 'not-downloaded')
const percent = computed(() => Math.round((props.status?.progressRatio ?? 0) * 100))
const stateLabel = computed(() => {
  if (props.status?.download?.state === 'paused') return `已暂停 ${percent.value}%`
  if (modelState.value === 'downloading') return `下载中 ${percent.value}%`
  if (modelState.value === 'ready') return '已安装并校验'
  if (modelState.value === 'error') return '出现错误，可重试'
  return '尚未下载'
})
const stateTone = computed(() => {
  if (modelState.value === 'ready') return 'ready'
  if (modelState.value === 'error') return 'error'
  if (props.status?.download?.state === 'paused') return 'paused'
  if (modelState.value === 'downloading') return 'working'
  return 'idle'
})

function onToggle(event: Event): void {
  emit('toggle', props.model.engineId, (event.target as HTMLInputElement).checked)
}
</script>

<template>
  <article
    class="model-item"
    :class="{
      'model-item--primary': isPrimary,
      'model-item--fallback': isFallback
    }"
    :aria-labelledby="`asr-${model.engineId}-title`"
  >
    <div class="model-item__header">
      <label v-if="selectable" class="model-item__check">
        <input type="checkbox" :checked="checked" @change="onToggle" />
        <span class="sr-only">选择 {{ model.label }}</span>
      </label>

      <div class="model-item__identity">
        <div class="model-item__title-line">
          <h4 :id="`asr-${model.engineId}-title`">{{ model.label }}</h4>
          <strong class="model-item__size">{{ formatAsrDownloadSize(model.downloadBytes) }}</strong>
        </div>
        <div class="model-item__badges" aria-label="模型特征">
          <span v-for="badge in model.badges" :key="badge" class="model-item__badge">
            {{ asrBadgeLabel(badge) }}
          </span>
          <span v-if="isPrimary" class="model-item__badge model-item__badge--primary">
            主要模型
          </span>
          <span v-if="isFallback" class="model-item__badge model-item__badge--fallback">
            备用模型
          </span>
        </div>
      </div>

      <span class="model-item__state" :class="`model-item__state--${stateTone}`" role="status">
        {{ stateLabel }}
      </span>
    </div>

    <p class="model-item__summary">{{ model.summary }}</p>

    <dl class="model-item__specs">
      <div>
        <dt>支持语言</dt>
        <dd>{{ model.languages.join(' / ') }}</dd>
      </div>
      <div>
        <dt>识别模式</dt>
        <dd>{{ asrModeLabel(model.mode) }}</dd>
      </div>
      <div>
        <dt>资源占用</dt>
        <dd>{{ asrResourceLevelLabel(model.resourceLevel) }}</dd>
      </div>
    </dl>

    <div class="model-item__notes">
      <p><strong>适合：</strong>{{ model.scenario }}</p>
      <p><strong>限制：</strong>{{ model.limitation }}</p>
    </div>

    <div
      v-if="modelState === 'downloading'"
      class="model-item__progress"
      role="progressbar"
      :aria-label="`${model.label} 下载进度`"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="percent"
    >
      <div class="model-item__progress-track">
        <span :style="{ width: `${percent}%` }" />
      </div>
      <span>{{ percent }}%</span>
    </div>

    <div class="model-item__actions">
      <button
        v-if="
          allowDirectDownload !== false &&
          (modelState === 'not-downloaded' || modelState === 'error')
        "
        type="button"
        class="model-item__button model-item__button--primary"
        @click="emit('download', model.engineId)"
      >
        下载 {{ formatAsrDownloadSize(model.downloadBytes) }}
      </button>
      <button
        v-if="modelState === 'downloading'"
        type="button"
        class="model-item__button"
        @click="emit('cancel', model.engineId)"
      >
        取消下载
      </button>
      <template v-if="modelState === 'ready' || configureBeforeReady">
        <button
          v-if="!isPrimary"
          type="button"
          class="model-item__button model-item__button--primary"
          @click="emit('selectPrimary', model.engineId)"
        >
          设为主要
        </button>
        <button
          v-if="!isFallback && !isPrimary"
          type="button"
          class="model-item__button"
          @click="emit('selectFallback', model.engineId)"
        >
          设为备用
        </button>
        <button
          v-if="isFallback"
          type="button"
          class="model-item__button"
          @click="emit('selectFallback', model.engineId)"
        >
          取消备用
        </button>
      </template>
      <button
        v-if="modelState === 'ready'"
        type="button"
        class="model-item__button model-item__button--danger"
        @click="emit('delete', model.engineId)"
      >
        删除模型
      </button>
    </div>
  </article>
</template>

<style scoped>
.model-item {
  display: grid;
  gap: 0.75rem;
  padding: 1rem;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
  background: var(--color-surface-elevated);
  transition:
    border-color 0.18s ease,
    background 0.18s ease;
}

.model-item--primary {
  border-color: color-mix(in srgb, var(--color-accent) 55%, var(--color-border));
  background: color-mix(in srgb, var(--color-accent-soft) 46%, var(--color-surface-elevated));
}

.model-item--fallback:not(.model-item--primary) {
  border-color: var(--color-info);
}

.model-item__header {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: start;
  gap: 0.625rem;
}

.model-item__check {
  display: grid;
  padding-top: 0.125rem;
  place-items: center;
}

.model-item__check input {
  width: 1.1rem;
  height: 1.1rem;
  accent-color: var(--color-accent);
}

.model-item__identity {
  min-width: 0;
}

.model-item__title-line,
.model-item__badges,
.model-item__actions,
.model-item__progress {
  display: flex;
  align-items: center;
}

.model-item__title-line {
  flex-wrap: wrap;
  gap: 0.375rem 0.625rem;
}

.model-item h4,
.model-item p,
.model-item dl,
.model-item dd {
  margin: 0;
}

.model-item h4 {
  color: var(--color-text);
  font-size: 0.98rem;
  line-height: 1.3;
}

.model-item__size {
  color: var(--color-accent);
  font-size: 0.84rem;
  font-variant-numeric: tabular-nums;
}

.model-item__badges {
  flex-wrap: wrap;
  gap: 0.25rem;
  margin-top: 0.375rem;
}

.model-item__badge,
.model-item__state {
  padding: 0.15rem 0.45rem;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  color: var(--color-text-secondary);
  font-size: 0.66rem;
  line-height: 1.35;
}

.model-item__badge--primary {
  border-color: color-mix(in srgb, var(--color-accent) 45%, var(--color-border));
  background: var(--color-accent-soft);
  color: var(--color-accent);
  font-weight: 650;
}

.model-item__badge--fallback {
  border-color: color-mix(in srgb, var(--color-info) 45%, var(--color-border));
  color: var(--color-info);
  font-weight: 650;
}

.model-item__state {
  white-space: nowrap;
}

.model-item__state--ready {
  border-color: var(--color-success-border);
  background: var(--color-success-bg);
  color: var(--color-success);
}

.model-item__state--error {
  border-color: var(--color-error-border);
  background: var(--color-error-bg);
  color: var(--color-error);
}

.model-item__state--working {
  border-color: var(--color-warning-border);
  background: var(--color-warning-bg);
  color: var(--color-warning);
}

.model-item__state--paused {
  border-color: var(--color-border);
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
}

.model-item__summary {
  color: var(--color-text-secondary);
  font-size: 0.8rem;
  line-height: 1.6;
}

.model-item__specs {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.5rem;
}

.model-item__specs div {
  display: grid;
  gap: 0.125rem;
  padding: 0.5rem 0.625rem;
  border-radius: var(--radius);
  background: var(--color-bg-tertiary);
}

.model-item__specs dt {
  color: var(--color-text-muted);
  font-size: 0.64rem;
}

.model-item__specs dd {
  color: var(--color-text);
  font-size: 0.72rem;
  line-height: 1.45;
}

.model-item__notes {
  display: grid;
  gap: 0.25rem;
  color: var(--color-text-secondary);
  font-size: 0.75rem;
  line-height: 1.55;
}

.model-item__notes strong {
  color: var(--color-text);
  font-weight: 650;
}

.model-item__progress {
  gap: 0.625rem;
  color: var(--color-text-secondary);
  font-size: 0.7rem;
  font-variant-numeric: tabular-nums;
}

.model-item__progress-track {
  height: 0.35rem;
  flex: 1;
  overflow: hidden;
  border-radius: 999px;
  background: var(--color-bg-tertiary);
}

.model-item__progress-track span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--color-accent);
  transition: width 0.15s linear;
}

.model-item__actions {
  flex-wrap: wrap;
  gap: 0.375rem;
}

.model-item__button {
  min-height: 2.1rem;
  padding: 0.4rem 0.65rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 0.7rem;
  font-weight: 620;
}

.model-item__button:hover {
  background: var(--color-accent-soft-hover);
  color: var(--color-text);
}

.model-item__button--primary {
  border-color: transparent;
  background: var(--color-accent);
  color: var(--color-text-on-accent);
}

.model-item__button--primary:hover {
  background: var(--color-accent-hover);
  color: var(--color-text-on-accent);
}

.model-item__button--danger {
  color: var(--color-error);
}

.model-item__button--danger:hover {
  border-color: var(--color-error-border);
  background: var(--color-error-bg);
  color: var(--color-error);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  border: 0;
  margin: -1px;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}

@media (max-width: 620px) {
  .model-item__header {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .model-item__state {
    grid-column: 2;
    justify-self: start;
  }

  .model-item__specs {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .model-item,
  .model-item__progress-track span {
    transition: none;
  }
}
</style>
