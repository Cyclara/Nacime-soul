<script setup lang="ts">
// P3V-16/17/20：GPT-SoVITS 运行环境卡。首次设置与设置页复用同一张卡。
// 路径红线：本组件只见 GptRuntimeOverview（来源模式、是否在用、变体、下载进度、
// 空间三态），绝不接收或显示安装目录；目录选择由 main 原生 dialog 完成。

import { computed, ref } from 'vue'
import { formatAsrDownloadSize, formatAsrDownloadTotal } from '@shared/voice/asr-catalog'
import type { AssetDownloadPhase, AssetDownloadStatus } from '@shared/voice/asset-root-types'
import type { GptRuntimeVariantId } from '@shared/voice/gpt-runtime-types'
import { useVoiceStore } from '../../stores/voice'

const voice = useVoiceStore()

/** 用户在卡里选中的变体；未选时跟随 GPU 推荐项，检测不出就用第一项。 */
const pickedVariant = ref<GptRuntimeVariantId | null>(null)

const overview = computed(() => voice.state.gptRuntime)
const variants = computed(() => overview.value?.variants ?? [])
const installed = computed(() => overview.value?.installed ?? null)
const download = computed(() => overview.value?.download ?? null)

const selectedVariant = computed<GptRuntimeVariantId | null>(() => {
  if (pickedVariant.value !== null) return pickedVariant.value
  const recommended = variants.value.find((option) => option.recommended)
  return recommended?.variant ?? variants.value[0]?.variant ?? null
})

/** 进行中的安装任务；done/error/cancelled 不算「正在装」（口径由 store 统一）。 */
const activeJob = computed<AssetDownloadStatus | null>(() => voice.gptRuntimeDownload)

const failedJob = computed<AssetDownloadStatus | null>(() => {
  const status = download.value
  return status !== null && status.state === 'error' ? status : null
})

/** 正在下载的那一份对应哪个变体（assetId 形如 gpt-runtime-standard）。 */
const jobVariant = computed<GptRuntimeVariantId | null>(() => {
  const id = activeJob.value?.assetId ?? failedJob.value?.assetId
  if (id === undefined) return null
  const suffix = id.replace('gpt-runtime-', '')
  return variants.value.find((option) => option.variant === suffix)?.variant ?? null
})

const statusPill = computed<{ tone: 'ok' | 'warn' | 'off'; text: string }>(() => {
  const current = overview.value
  if (current === null) return { tone: 'off', text: '正在读取…' }
  if (activeJob.value !== null) return { tone: 'warn', text: '正在安装' }
  if (current.source.active) {
    return {
      tone: 'ok',
      text: current.source.mode === 'custom' ? '正在使用（你指定的）' : '正在使用'
    }
  }
  if (current.source.restartRequired) return { tone: 'warn', text: '重启后生效' }
  if (current.installed !== null) return { tone: 'warn', text: '已安装 · 未启用' }
  if (current.externalDetected) return { tone: 'warn', text: '发现本机整合包' }
  return { tone: 'off', text: '未安装' }
})

/** 安装被挡住的原因；null = 可以装。空间不够就说清差多少，不让下载跑到一半才失败。 */
const installBlockReason = computed<string | null>(() => {
  const current = overview.value
  if (current === null) return '正在读取存储位置…'
  if (current.rootState === 'missing') {
    return '自定义存储位置当前不存在。请接回对应磁盘，或先更换位置。'
  }
  if (current.rootState === 'unwritable') return '存储位置不可写，请先更换位置。'
  if (current.freeBytes < current.minFreeBytes) {
    return `剩余空间不足：解压期间至少需要 ${formatAsrDownloadTotal(current.minFreeBytes)}，当前只有 ${formatAsrDownloadTotal(current.freeBytes)}。`
  }
  return null
})

const canInstall = computed(
  () =>
    installBlockReason.value === null && activeJob.value === null && selectedVariant.value !== null
)

const installedAtLabel = computed(() => {
  const info = installed.value
  if (info === null) return null
  return new Date(info.installedAt).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })
})

function percent(status: AssetDownloadStatus): number {
  if (status.totalBytes <= 0) return 0
  return Math.min(100, Math.round((status.receivedBytes / status.totalBytes) * 100))
}

function phaseLabel(phase: AssetDownloadPhase | undefined): string {
  switch (phase) {
    case 'verifying':
      return '校验中'
    case 'extracting':
      return '解压中'
    case 'installing':
      return '安装中'
    default:
      return '下载中'
  }
}

function speedLabel(status: AssetDownloadStatus): string {
  if (status.state === 'paused') return '已暂停，断点已保留'
  if (status.phase === 'verifying') return '正在校验 SHA-256'
  if (status.phase === 'extracting') return '正在解压（这一步比较慢）'
  if (status.phase === 'installing') return '正在安全安装'
  const speed = status.speedBytesPerSec ?? 0
  if (speed <= 0) return '正在建立连接…'
  return `${formatAsrDownloadSize(speed)}/s`
}

function variantLabel(variant: GptRuntimeVariantId | null): string {
  if (variant === null) return '运行环境'
  return variants.value.find((option) => option.variant === variant)?.displayName ?? variant
}

function selectVariant(variant: GptRuntimeVariantId): void {
  pickedVariant.value = variant
}

function install(): void {
  const variant = selectedVariant.value
  if (variant === null) return
  void voice.installGptRuntime(variant)
}

function pause(): void {
  const variant = jobVariant.value
  if (variant !== null) void voice.pauseGptRuntime(variant)
}

function resume(): void {
  const variant = jobVariant.value
  if (variant !== null) void voice.resumeGptRuntime(variant)
}

function cancel(): void {
  const variant = jobVariant.value
  if (variant !== null) void voice.cancelGptRuntime(variant)
}

function retry(): void {
  const variant = jobVariant.value ?? selectedVariant.value
  if (variant !== null) void voice.installGptRuntime(variant)
}

function chooseExisting(): void {
  void voice.chooseGptRuntimeDir()
}

function clearExisting(): void {
  void voice.clearGptRuntimeDir()
}

function removeRuntime(): void {
  void voice.deleteGptRuntime()
}
</script>

<template>
  <section class="gpt-runtime" aria-labelledby="gpt-runtime-title">
    <header class="gpt-runtime__header">
      <div>
        <p class="gpt-runtime__eyebrow">本地发声运行环境</p>
        <h3 id="gpt-runtime-title">GPT-SoVITS</h3>
      </div>
      <span class="gpt-runtime__pill" :class="`gpt-runtime__pill--${statusPill.tone}`">
        {{ statusPill.text }}
      </span>
    </header>

    <p class="gpt-runtime__description">
      定制音色在这台电脑上本地合成，文本不会上传。可以指向你已经有的整合包， 也可以让 Nacime
      单独装一份；Nacime 不会修改你已有的 GPT-SoVITS 文件。
    </p>

    <div v-if="installed !== null" class="gpt-runtime__installed">
      <div>
        <strong>{{ installed.displayName }}</strong>
        <span v-if="installedAtLabel">安装于 {{ installedAtLabel }}</span>
      </div>
      <button
        type="button"
        class="gpt-runtime__button gpt-runtime__button--quiet"
        :disabled="activeJob !== null"
        @click="removeRuntime"
      >
        删除这份安装
      </button>
    </div>

    <p v-if="overview?.externalDetected && installed === null" class="gpt-runtime__hint">
      已在本机发现可用的 GPT-SoVITS 整合包，可以直接用，不必再下载一份。
    </p>

    <!-- 安装进度：只读 main 投影的安全 basename / 已收总量 / 阶段 -->
    <div v-if="activeJob !== null" class="gpt-runtime__job" aria-live="polite">
      <div class="gpt-runtime__job-head">
        <strong>{{ variantLabel(jobVariant) }} · {{ phaseLabel(activeJob.phase) }}</strong>
        <span v-if="activeJob.currentFile" class="gpt-runtime__file" :title="activeJob.currentFile">
          {{ activeJob.currentFile }}
        </span>
      </div>

      <div
        class="gpt-runtime__progress"
        role="progressbar"
        aria-label="GPT-SoVITS 安装进度"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="percent(activeJob)"
      >
        <span :style="{ width: `${percent(activeJob)}%` }" />
      </div>

      <div class="gpt-runtime__metrics">
        <strong>{{ percent(activeJob) }}%</strong>
        <span>
          {{ formatAsrDownloadSize(activeJob.receivedBytes) }} /
          {{ formatAsrDownloadSize(activeJob.totalBytes) }}
        </span>
        <span>{{ speedLabel(activeJob) }}</span>
      </div>

      <div class="gpt-runtime__actions">
        <button
          v-if="
            activeJob.state === 'downloading' &&
            activeJob.resumable &&
            activeJob.phase === 'receiving'
          "
          type="button"
          class="gpt-runtime__button gpt-runtime__button--quiet"
          @click="pause"
        >
          暂停
        </button>
        <button
          v-if="activeJob.state === 'paused'"
          type="button"
          class="gpt-runtime__button"
          @click="resume"
        >
          继续
        </button>
        <button
          type="button"
          class="gpt-runtime__button gpt-runtime__button--quiet"
          @click="cancel"
        >
          取消
        </button>
      </div>
    </div>

    <div v-else-if="failedJob !== null" class="gpt-runtime__failure" role="alert">
      <span>
        {{ variantLabel(jobVariant) }} 安装失败（{{ failedJob.errorCode ?? 'download-failed' }}）；
        已下载的部分保留，可以直接重试。
      </span>
      <button type="button" class="gpt-runtime__button gpt-runtime__button--quiet" @click="retry">
        重试
      </button>
    </div>

    <!-- 一键安装：变体由用户拍板，GPU 检测只给推荐标记 -->
    <fieldset v-if="activeJob === null" class="gpt-runtime__variants">
      <legend>让 Nacime 装一份</legend>
      <label v-for="option in variants" :key="option.variant" class="gpt-runtime__variant">
        <input
          type="radio"
          name="gpt-runtime-variant"
          :value="option.variant"
          :checked="selectedVariant === option.variant"
          @change="selectVariant(option.variant)"
        />
        <span class="gpt-runtime__variant-copy">
          <strong>{{ option.displayName }}</strong>
          <small>
            {{ formatAsrDownloadTotal(option.downloadBytes) }}
            <template v-if="option.recommended"> · 与你的显卡匹配</template>
          </small>
        </span>
      </label>
      <p v-if="variants.every((option) => !option.recommended)" class="gpt-runtime__hint">
        没能读出显卡型号，两个版本都没标推荐——RTX 50 系显卡选 RTX 版，其余选通用版。
      </p>
    </fieldset>

    <p v-if="installBlockReason" class="gpt-runtime__blocked" role="status">
      {{ installBlockReason }}
    </p>

    <p v-if="overview?.source.restartRequired" class="gpt-runtime__notice" role="status">
      运行环境的变更会在重启 Nacime 后生效；这一轮对话仍按当前状态进行。
    </p>

    <p v-if="voice.state.gptRuntimeNotice" class="gpt-runtime__notice" role="status">
      {{ voice.state.gptRuntimeNotice }}
    </p>

    <div class="gpt-runtime__bar">
      <button
        type="button"
        class="gpt-runtime__button gpt-runtime__button--quiet"
        @click="chooseExisting"
      >
        选择已有整合包
      </button>
      <button
        v-if="overview?.source.mode === 'custom'"
        type="button"
        class="gpt-runtime__button gpt-runtime__button--quiet"
        @click="clearExisting"
      >
        恢复自动发现
      </button>
      <button
        v-if="activeJob === null"
        type="button"
        class="gpt-runtime__button"
        :disabled="!canInstall"
        @click="install"
      >
        安装 {{ variantLabel(selectedVariant) }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.gpt-runtime {
  display: grid;
  gap: 0.65rem;
  padding: 0.9rem 1rem;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
  background: var(--color-surface-elevated);
}

.gpt-runtime__header,
.gpt-runtime__job-head,
.gpt-runtime__metrics,
.gpt-runtime__actions,
.gpt-runtime__bar,
.gpt-runtime__installed,
.gpt-runtime__failure {
  display: flex;
  align-items: center;
}

.gpt-runtime__header,
.gpt-runtime__job-head,
.gpt-runtime__installed,
.gpt-runtime__failure {
  justify-content: space-between;
  gap: 0.75rem;
}

.gpt-runtime h3,
.gpt-runtime p {
  margin: 0;
}

.gpt-runtime__eyebrow {
  color: var(--color-text-tertiary);
  font-size: 0.64rem;
  font-weight: 650;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}

.gpt-runtime h3 {
  margin-top: 0.1rem;
  color: var(--color-text);
  font-size: 0.88rem;
}

.gpt-runtime__pill {
  padding: 0.15rem 0.5rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  font-size: 0.68rem;
  white-space: nowrap;
}

.gpt-runtime__pill--ok {
  border-color: transparent;
  background: var(--color-companion-soft);
  color: var(--color-success);
}

.gpt-runtime__pill--warn {
  border-color: var(--color-warning-border);
  color: var(--color-warning);
}

.gpt-runtime__pill--off {
  color: var(--color-text-muted);
}

.gpt-runtime__description,
.gpt-runtime__hint {
  color: var(--color-text-secondary);
  font-size: 0.74rem;
  line-height: 1.55;
}

.gpt-runtime__hint {
  color: var(--color-text-muted);
  font-size: 0.68rem;
}

.gpt-runtime__installed {
  padding: 0.55rem 0.65rem;
  border-radius: var(--radius);
  background: var(--color-bg-tertiary);
}

.gpt-runtime__installed div {
  display: grid;
  gap: 0.15rem;
  min-width: 0;
}

.gpt-runtime__installed strong {
  color: var(--color-text);
  font-size: 0.76rem;
}

.gpt-runtime__installed span {
  color: var(--color-text-muted);
  font-size: 0.66rem;
}

.gpt-runtime__job {
  display: grid;
  gap: 0.5rem;
  padding: 0.65rem;
  border-radius: var(--radius);
  background: var(--color-bg-tertiary);
}

.gpt-runtime__job-head strong {
  color: var(--color-text);
  font-size: 0.74rem;
}

.gpt-runtime__file {
  overflow: hidden;
  max-width: min(52%, 18rem);
  color: var(--color-text-muted);
  font-family: ui-monospace, 'Cascadia Mono', monospace;
  font-size: 0.64rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gpt-runtime__progress {
  height: 0.38rem;
  overflow: hidden;
  border-radius: var(--radius-full);
  background: var(--color-surface);
}

.gpt-runtime__progress span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--color-accent);
  transition: width 0.15s linear;
}

.gpt-runtime__metrics {
  flex-wrap: wrap;
  gap: 0.25rem 0.75rem;
  color: var(--color-text-muted);
  font-size: 0.66rem;
  font-variant-numeric: tabular-nums;
}

.gpt-runtime__metrics strong {
  color: var(--color-text);
}

.gpt-runtime__variants {
  display: grid;
  gap: 0.35rem;
  padding: 0.65rem;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius);
  margin: 0;
}

.gpt-runtime__variants legend {
  padding-inline: 0.25rem;
  color: var(--color-text-tertiary);
  font-size: 0.64rem;
  font-weight: 650;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}

.gpt-runtime__variant {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.3rem 0.25rem;
  cursor: pointer;
}

.gpt-runtime__variant-copy {
  display: grid;
  gap: 0.1rem;
}

.gpt-runtime__variant-copy strong {
  color: var(--color-text);
  font-size: 0.75rem;
}

.gpt-runtime__variant-copy small {
  color: var(--color-text-muted);
  font-size: 0.66rem;
}

.gpt-runtime__blocked,
.gpt-runtime__failure {
  color: var(--color-error);
  font-size: 0.7rem;
  line-height: 1.5;
}

.gpt-runtime__notice {
  padding: 0.5rem 0.625rem;
  border: 1px solid var(--color-warning-border);
  border-radius: var(--radius);
  background: var(--color-warning-bg);
  color: var(--color-warning);
  font-size: 0.7rem;
  line-height: 1.5;
}

.gpt-runtime__actions,
.gpt-runtime__bar {
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.4rem;
}

.gpt-runtime__button {
  min-height: 2.1rem;
  padding: 0.4rem 0.7rem;
  border: 1px solid transparent;
  border-radius: var(--radius);
  background: var(--color-accent);
  color: var(--color-text-on-accent);
  font-size: 0.72rem;
  font-weight: 650;
}

.gpt-runtime__button:hover:not(:disabled) {
  background: var(--color-accent-hover);
}

.gpt-runtime__button--quiet {
  border-color: var(--color-border);
  background: transparent;
  color: var(--color-text-secondary);
}

.gpt-runtime__button--quiet:hover:not(:disabled) {
  background: var(--color-accent-soft-hover);
  color: var(--color-text);
}

.gpt-runtime__button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

@media (max-width: 640px) {
  .gpt-runtime__header,
  .gpt-runtime__job-head,
  .gpt-runtime__installed,
  .gpt-runtime__failure {
    align-items: flex-start;
    flex-direction: column;
  }

  .gpt-runtime__file {
    max-width: 100%;
  }

  .gpt-runtime__actions,
  .gpt-runtime__bar {
    justify-content: flex-start;
  }
}

@media (prefers-reduced-motion: reduce) {
  .gpt-runtime__progress span {
    transition: none;
  }
}
</style>
