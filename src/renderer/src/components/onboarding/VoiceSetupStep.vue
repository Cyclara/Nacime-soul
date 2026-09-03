<script setup lang="ts">
// P3V-14：首次语音资源设置。
// 顺序严格遵循 S-023：资源位置 → 听力模型 → GPT-SoVITS → 音色 → 总量/开始。
// APP 与文字聊天已经可用；开始只排后台下载，不等待数百 MB/GB 资源完成。

import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  findAsrPreset,
  formatAsrDownloadTotal,
  totalAsrDownloadBytes
} from '@shared/voice/asr-catalog'
import type { AsrEngineId } from '@shared/voice/asr-settings-types'
import { useVoiceStore } from '../../stores/voice'
import AssetRootPicker from '../voice/AssetRootPicker.vue'
import AsrDownloadCenter from '../voice/AsrDownloadCenter.vue'
import AsrModelCard from '../voice/AsrModelCard.vue'
import GptRuntimeCard from '../voice/GptRuntimeCard.vue'
import GptVoiceLibrary from '../voice/GptVoiceLibrary.vue'

interface AsrSelection {
  readonly presetId: 'standard' | 'light' | 'custom'
  readonly engineIds: readonly AsrEngineId[]
  readonly primaryEngineId: AsrEngineId | null
  readonly fallbackEngineId: AsrEngineId | null
  readonly totalBytes: number
}

interface AsrModelCardExposed {
  startSelectedDownloads(): Promise<boolean>
}

const emit = defineEmits<{
  continue: [result: { readonly downloadsStarted: boolean }]
}>()

const standardPreset = findAsrPreset('standard')
if (standardPreset === undefined || standardPreset.primaryEngineId === null) {
  throw new Error('standard ASR preset is missing')
}

const voice = useVoiceStore()
const asrCard = ref<AsrModelCardExposed | null>(null)
const selection = ref<AsrSelection>({
  presetId: 'standard',
  engineIds: standardPreset.engineIds,
  primaryEngineId: standardPreset.primaryEngineId,
  fallbackEngineId: standardPreset.fallbackEngineId,
  totalBytes: totalAsrDownloadBytes(standardPreset.engineIds)
})
const starting = ref(false)
const errorMessage = ref<string | null>(null)
let unsubscribe: (() => void) | null = null

const canStart = computed(
  () =>
    selection.value.engineIds.length > 0 &&
    selection.value.primaryEngineId !== null &&
    voice.state.assetRoot?.state === 'ok' &&
    !voice.state.assetRootRestartRequired &&
    !starting.value
)

const startHint = computed(() => {
  if (voice.state.assetRootRestartRequired) {
    return '存储位置已更改。请先重启 Nacime，再回来开始下载，避免资源落到旧位置。'
  }
  if (voice.state.assetRoot?.state === 'missing') return '自定义磁盘当前未连接，暂时不能下载。'
  if (voice.state.assetRoot?.state === 'unwritable') return '资源位置不可写，请先更换位置。'
  if (selection.value.engineIds.length === 0) return '至少选择一个听力模型。'
  if (selection.value.primaryEngineId === null) return '请指定一个主要听力模型。'
  return '下载会在后台继续；你可以马上进入第一次对话。'
})

onMounted(async () => {
  // 先订阅后 hydrate，避免下载状态在首个快照返回前丢失。
  unsubscribe = voice.subscribe()
  await Promise.all([voice.hydrate(), voice.hydrateAssetRoot(), voice.hydrateGptRuntime()])
})

onBeforeUnmount(() => {
  unsubscribe?.()
  unsubscribe = null
})

function onSelectionChange(next: AsrSelection): void {
  selection.value = next
  errorMessage.value = null
}

function skip(): void {
  emit('continue', { downloadsStarted: false })
}

async function start(): Promise<void> {
  if (!canStart.value || asrCard.value === null) return
  errorMessage.value = null
  starting.value = true
  try {
    const ok = await asrCard.value.startSelectedDownloads()
    if (!ok) {
      errorMessage.value = voice.state.overviewError ?? '没能保存听力模型选择，请重试'
      return
    }
    emit('continue', { downloadsStarted: true })
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : '启动后台下载时发生未知错误'
  } finally {
    starting.value = false
  }
}
</script>

<template>
  <section class="voice-setup" aria-labelledby="voice-setup-title">
    <header class="voice-setup__hero">
      <div class="voice-setup__step-mark" aria-hidden="true">02</div>
      <div>
        <p class="voice-setup__eyebrow">可选设置 · 稍后也能改</p>
        <h2 id="voice-setup-title">让 Nacime 听见你，也准备好开口</h2>
        <p>文字聊天已经可以使用。语音资源全部在本地运行，可以现在后台下载，也可以先跳过。</p>
      </div>
    </header>

    <ol class="voice-setup__flow" aria-label="语音设置顺序">
      <li>
        <span class="voice-setup__number">1</span>
        <div class="voice-setup__section">
          <AssetRootPicker :required-bytes="selection.totalBytes" />
        </div>
      </li>

      <li>
        <span class="voice-setup__number">2</span>
        <div class="voice-setup__section">
          <AsrModelCard ref="asrCard" mode="setup" @selection-change="onSelectionChange" />
          <AsrDownloadCenter />
        </div>
      </li>

      <li>
        <span class="voice-setup__number">3</span>
        <div class="voice-setup__section">
          <GptRuntimeCard />
        </div>
      </li>

      <li>
        <span class="voice-setup__number">4</span>
        <div class="voice-setup__section">
          <GptVoiceLibrary />
        </div>
      </li>
    </ol>

    <footer class="voice-setup__footer">
      <div class="voice-setup__total">
        <span>本次立即下载</span>
        <strong>{{ formatAsrDownloadTotal(selection.totalBytes) }}</strong>
        <small>仅含 Silero VAD 与已选听力模型；GPT-SoVITS / 音色未计入。</small>
      </div>

      <p
        class="voice-setup__start-hint"
        :class="{ 'voice-setup__start-hint--blocked': !canStart }"
        role="status"
        aria-live="polite"
      >
        {{ startHint }}
      </p>
      <p v-if="errorMessage" class="voice-setup__error" role="alert">{{ errorMessage }}</p>

      <div class="voice-setup__actions">
        <button type="button" class="voice-setup__skip" @click="skip">稍后设置</button>
        <button type="button" class="voice-setup__start" :disabled="!canStart" @click="start">
          {{ starting ? '正在排队…' : '开始下载并继续' }}
        </button>
      </div>
    </footer>
  </section>
</template>

<style scoped>
.voice-setup {
  width: min(100%, 70rem);
  margin-block: auto;
  padding: clamp(1rem, 3vw, 2rem);
  color: var(--color-text);
}

.voice-setup__hero {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 1rem;
  margin-bottom: 1.25rem;
}

.voice-setup__step-mark {
  display: grid;
  width: 3rem;
  height: 3rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg) var(--radius-lg) var(--radius-lg) var(--radius-sm);
  background: var(--color-companion-soft);
  color: var(--color-companion);
  font-family: var(--font-family-display);
  font-size: 1rem;
  font-weight: 700;
  place-items: center;
}

.voice-setup h2,
.voice-setup p {
  margin: 0;
}

.voice-setup__eyebrow {
  color: var(--color-text-tertiary);
  font-size: 0.68rem;
  font-weight: 650;
  letter-spacing: 0.075em;
  text-transform: uppercase;
}

.voice-setup h2 {
  margin-top: 0.25rem;
  font-family: var(--font-family-display);
  font-size: clamp(1.35rem, 3vw, 2rem);
  font-weight: 600;
}

.voice-setup__hero p:last-child {
  max-width: 48rem;
  margin-top: 0.4rem;
  color: var(--color-text-secondary);
  font-size: 0.82rem;
  line-height: 1.65;
}

.voice-setup__flow {
  display: grid;
  gap: 0.9rem;
  padding: 0;
  margin: 0;
  list-style: none;
}

.voice-setup__flow > li {
  display: grid;
  grid-template-columns: 1.75rem minmax(0, 1fr);
  align-items: start;
  gap: 0.65rem;
}

.voice-setup__number {
  display: grid;
  width: 1.75rem;
  height: 1.75rem;
  margin-top: 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
  font-size: 0.7rem;
  font-weight: 700;
  place-items: center;
}

.voice-setup__section {
  min-width: 0;
}

.voice-setup__footer {
  display: grid;
  gap: 0.65rem;
  margin: 1.25rem 0 0 2.4rem;
  padding: 1rem;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
  background: var(--color-surface-translucent);
  box-shadow: var(--shadow-sm);
}

.voice-setup__total {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: baseline;
  gap: 0.25rem 0.75rem;
}

.voice-setup__total span {
  color: var(--color-text-secondary);
  font-size: 0.72rem;
}

.voice-setup__total strong {
  color: var(--color-accent);
  font-size: 1.25rem;
  font-variant-numeric: tabular-nums;
}

.voice-setup__total small {
  grid-column: 1 / -1;
  color: var(--color-text-muted);
  font-size: 0.66rem;
}

.voice-setup__start-hint,
.voice-setup__error {
  color: var(--color-success);
  font-size: 0.72rem;
  line-height: 1.5;
}

.voice-setup__start-hint--blocked,
.voice-setup__error {
  color: var(--color-error);
}

.voice-setup__actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.55rem;
}

.voice-setup__actions button {
  min-height: 2.55rem;
  padding: 0.55rem 1rem;
  border-radius: var(--radius);
  font-size: 0.76rem;
  font-weight: 650;
}

.voice-setup__skip {
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-secondary);
}

.voice-setup__skip:hover {
  background: var(--color-accent-soft-hover);
  color: var(--color-text);
}

.voice-setup__start {
  background: var(--color-accent);
  color: var(--color-text-on-accent);
}

.voice-setup__start:hover:not(:disabled) {
  background: var(--color-accent-hover);
}

.voice-setup__start:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

@media (max-width: 640px) {
  .voice-setup {
    padding: 0.75rem;
  }

  .voice-setup__hero,
  .voice-setup__flow > li {
    grid-template-columns: 1fr;
  }

  .voice-setup__number {
    display: none;
  }

  .voice-setup__footer {
    margin-left: 0;
  }

  .voice-setup__actions {
    align-items: stretch;
    flex-direction: column-reverse;
  }
}

@media (prefers-reduced-motion: reduce) {
  .voice-setup * {
    scroll-behavior: auto;
  }
}
</style>
