<script setup lang="ts">
// P3V-10/14/15：大资源位置选择。首次设置与普通设置页复用同一组件。
// 路径红线：本组件只见 AssetRootStatus（默认/自定义、空间、三态），绝不接收或显示
// 绝对路径；目录选择由 main 原生 dialog 完成。

import { computed } from 'vue'
import { formatAsrDownloadSize, formatAsrDownloadTotal } from '@shared/voice/asr-catalog'
import { useVoiceStore } from '../../stores/voice'

const props = defineProps<{
  /** 首次设置尚未落盘时，由父组件传入当前勾选的即时总量。 */
  readonly requiredBytes?: number
}>()

const voice = useVoiceStore()

const status = computed(() => voice.state.assetRoot)
const locationLabel = computed(() =>
  status.value?.isDefault === false ? '自定义位置' : '默认位置'
)
const freeLabel = computed(() =>
  status.value?.state === 'ok' ? formatAsrDownloadSize(status.value.freeBytes) : '暂时不可用'
)
const requiredLabel = computed(() => {
  if (props.requiredBytes !== undefined) return formatAsrDownloadTotal(props.requiredBytes)
  return status.value === null ? '—' : formatAsrDownloadTotal(status.value.totalRequiredBytes)
})
const stateMessage = computed(() => {
  if (status.value === null) return '正在读取存储位置…'
  if (status.value.state === 'missing') {
    return '自定义位置当前不存在。请接回对应磁盘，Nacime 不会偷偷改回系统盘。'
  }
  if (status.value.state === 'unwritable') {
    return '这个位置目前不可写，请检查权限或选择其他文件夹。'
  }
  return `${locationLabel.value}可用，剩余 ${freeLabel.value}`
})

function chooseRoot(): void {
  void voice.chooseAssetRoot()
}

function resetRoot(): void {
  void voice.resetAssetRoot()
}
</script>

<template>
  <section class="asset-root" aria-labelledby="asset-root-title">
    <div class="asset-root__copy">
      <div class="asset-root__heading-row">
        <h3 id="asset-root-title">资源存储位置</h3>
        <span class="asset-root__location">{{ locationLabel }}</span>
      </div>
      <p class="asset-root__description">
        语音模型、GPT-SoVITS 与音色包放在这里；配置和聊天记录仍留在应用数据目录。
      </p>
      <dl class="asset-root__facts">
        <div>
          <dt>可用空间</dt>
          <dd>{{ freeLabel }}</dd>
        </div>
        <div>
          <dt>当前选择需下载</dt>
          <dd>{{ requiredLabel }}</dd>
        </div>
      </dl>
      <p
        class="asset-root__state"
        :class="{ 'asset-root__state--error': status?.state !== 'ok' && status !== null }"
        role="status"
        aria-live="polite"
      >
        {{ stateMessage }}
      </p>
      <p v-if="voice.state.assetRootNotice" class="asset-root__notice" role="status">
        {{ voice.state.assetRootNotice }}
      </p>
    </div>

    <div class="asset-root__actions">
      <button type="button" class="asset-root__button" @click="chooseRoot">更改位置</button>
      <button
        v-if="status?.isDefault === false"
        type="button"
        class="asset-root__button asset-root__button--quiet"
        @click="resetRoot"
      >
        恢复默认
      </button>
    </div>
  </section>
</template>

<style scoped>
.asset-root {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 1rem;
  padding: 1rem;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
  background: var(--color-surface-elevated);
}

.asset-root__copy {
  min-width: 0;
}

.asset-root__heading-row,
.asset-root__actions,
.asset-root__facts {
  display: flex;
  align-items: center;
}

.asset-root__heading-row {
  gap: 0.625rem;
}

.asset-root h3,
.asset-root p,
.asset-root dl,
.asset-root dd {
  margin: 0;
}

.asset-root h3 {
  color: var(--color-text);
  font-size: 0.95rem;
}

.asset-root__location {
  padding: 0.15rem 0.5rem;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  color: var(--color-text-secondary);
  font-size: 0.7rem;
}

.asset-root__description {
  margin-top: 0.375rem !important;
  color: var(--color-text-secondary);
  font-size: 0.78rem;
  line-height: 1.55;
}

.asset-root__facts {
  flex-wrap: wrap;
  gap: 0.75rem 1.5rem;
  margin-top: 0.75rem !important;
}

.asset-root__facts div {
  display: grid;
  gap: 0.125rem;
}

.asset-root__facts dt {
  color: var(--color-text-muted);
  font-size: 0.68rem;
}

.asset-root__facts dd {
  color: var(--color-text);
  font-size: 0.86rem;
  font-weight: 650;
}

.asset-root__state,
.asset-root__notice {
  margin-top: 0.625rem !important;
  color: var(--color-success);
  font-size: 0.74rem;
  line-height: 1.5;
}

.asset-root__state--error {
  color: var(--color-error);
}

.asset-root__notice {
  padding: 0.5rem 0.625rem;
  border: 1px solid var(--color-warning-border);
  border-radius: var(--radius);
  background: var(--color-warning-bg);
  color: var(--color-warning);
}

.asset-root__actions {
  align-self: start;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.5rem;
}

.asset-root__button {
  min-height: 2.25rem;
  padding: 0.45rem 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-accent);
  color: var(--color-text-on-accent);
  font-size: 0.76rem;
  font-weight: 650;
}

.asset-root__button--quiet {
  background: transparent;
  color: var(--color-text-secondary);
}

.asset-root__button:hover {
  background: var(--color-accent-hover);
}

.asset-root__button--quiet:hover {
  background: var(--color-accent-soft-hover);
  color: var(--color-text);
}

@media (max-width: 640px) {
  .asset-root {
    grid-template-columns: 1fr;
  }

  .asset-root__actions {
    justify-content: flex-start;
  }
}
</style>
