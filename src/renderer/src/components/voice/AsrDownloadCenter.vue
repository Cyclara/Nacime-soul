<script setup lang="ts">
// P3V-15：ASR 下载中心。只读 main 投影的 AssetDownloadStatus：安全 basename、
// 已收/总量、速度、阶段、可续传能力；绝不接收 URL 或本机路径。

import { computed } from 'vue'
import { ASR_VAD_CATALOG_ENTRY, formatAsrDownloadSize } from '@shared/voice/asr-catalog'
import type { AssetDownloadPhase, AssetDownloadStatus } from '@shared/voice/asset-root-types'
import type { AsrEngineId, AsrEngineOverview } from '@shared/voice/asr-settings-types'
import { useVoiceStore } from '../../stores/voice'

interface DownloadJob {
  readonly id: AsrEngineId | 'vad'
  readonly label: string
  readonly status: AssetDownloadStatus
  readonly engine?: AsrEngineOverview
}

const voice = useVoiceStore()

const jobs = computed<DownloadJob[]>(() => {
  const list: DownloadJob[] = []
  const vad = voice.state.asrOverview?.vadModel.download
  if (vad !== undefined && vad.state !== 'idle' && vad.state !== 'done') {
    list.push({ id: 'vad', label: ASR_VAD_CATALOG_ENTRY.label, status: vad })
  }
  for (const engine of voice.engineList) {
    const status = engine.download
    if (
      status !== undefined &&
      status.state !== 'idle' &&
      status.state !== 'done' &&
      status.state !== 'cancelled'
    ) {
      list.push({ id: engine.engineId, label: engine.label, status, engine })
    }
  }
  return list
})

const active = computed(() =>
  jobs.value.filter((job) => job.status.state === 'downloading' || job.status.state === 'paused')
)
const queued = computed(() =>
  voice.state.asrDownloadQueue.filter((id) => !active.value.some((job) => job.id === id))
)
const failed = computed(() => jobs.value.filter((job) => job.status.state === 'error'))
const visible = computed(
  () => active.value.length > 0 || queued.value.length > 0 || failed.value.length > 0
)

function percent(status: AssetDownloadStatus): number {
  if (status.totalBytes <= 0) return 0
  return Math.min(100, Math.round((status.receivedBytes / status.totalBytes) * 100))
}

function remainingBytes(status: AssetDownloadStatus): number {
  return Math.max(0, status.totalBytes - status.receivedBytes)
}

function speedLabel(status: AssetDownloadStatus): string {
  const speed = status.speedBytesPerSec ?? 0
  if (status.state === 'paused') return '已暂停，断点已保留'
  if (status.phase === 'verifying') return '正在校验 SHA-256'
  if (status.phase === 'extracting') return '正在解压'
  if (status.phase === 'installing') return '正在安全安装'
  if (speed <= 0) return '正在建立连接…'
  return `${formatAsrDownloadSize(speed)}/s`
}

function etaLabel(status: AssetDownloadStatus): string | null {
  const speed = status.speedBytesPerSec ?? 0
  if (status.state !== 'downloading' || status.phase !== 'receiving' || speed <= 0) return null
  const seconds = Math.ceil(remainingBytes(status) / speed)
  if (seconds < 60) return `约 ${seconds} 秒`
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `约 ${minutes} 分钟`
  return `约 ${Math.ceil(minutes / 60)} 小时`
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

function labelFor(engineId: AsrEngineId): string {
  return voice.engineList.find((engine) => engine.engineId === engineId)?.label ?? engineId
}

function pause(engineId: AsrEngineId): void {
  void voice.pauseDownload(engineId)
}

function resume(engineId: AsrEngineId): void {
  void voice.resumeDownload(engineId)
}

function cancel(job: DownloadJob): void {
  if (job.id === 'vad') return
  if (voice.state.asrDownloadQueue.includes(job.id)) {
    void voice.cancelQueuedDownload(job.id)
  } else {
    void voice.cancelDownload(job.id)
  }
}

function retry(): void {
  voice.retryDownloadQueue()
}

function retrySingle(engineId: AsrEngineId): void {
  voice.enqueueModelDownload(engineId)
}
</script>

<template>
  <section class="download-center" aria-labelledby="asr-download-center-title">
    <header class="download-center__header">
      <div>
        <p class="download-center__eyebrow">后台任务</p>
        <h3 id="asr-download-center-title">听力模型下载</h3>
      </div>
      <span class="download-center__count">
        {{ visible ? `${active.length} 进行中 · ${queued.length} 排队` : '当前没有下载任务' }}
      </span>
    </header>

    <div v-if="active.length > 0" class="download-center__jobs" aria-live="polite">
      <article v-for="job in active" :key="job.id" class="download-center__job">
        <div class="download-center__job-head">
          <div class="download-center__job-copy">
            <strong>{{ job.label }}</strong>
            <span>{{ phaseLabel(job.status.phase) }}</span>
          </div>
          <span
            v-if="job.status.currentFile"
            class="download-center__file"
            :title="job.status.currentFile"
          >
            {{ job.status.currentFile }}
          </span>
        </div>

        <div
          class="download-center__progress"
          role="progressbar"
          :aria-label="`${job.label} 下载进度`"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="percent(job.status)"
        >
          <span :style="{ width: `${percent(job.status)}%` }" />
        </div>

        <div class="download-center__metrics">
          <strong>{{ percent(job.status) }}%</strong>
          <span>
            {{ formatAsrDownloadSize(job.status.receivedBytes) }} /
            {{ formatAsrDownloadSize(job.status.totalBytes) }}
          </span>
          <span>剩余 {{ formatAsrDownloadSize(remainingBytes(job.status)) }}</span>
          <span>{{ speedLabel(job.status) }}</span>
          <span v-if="etaLabel(job.status)">{{ etaLabel(job.status) }}</span>
        </div>

        <div v-if="job.id !== 'vad'" class="download-center__actions">
          <button
            v-if="
              job.status.state === 'downloading' &&
              job.status.resumable &&
              job.status.phase === 'receiving'
            "
            type="button"
            @click="pause(job.id)"
          >
            暂停
          </button>
          <button
            v-if="job.status.state === 'paused'"
            type="button"
            class="download-center__primary"
            @click="resume(job.id)"
          >
            继续
          </button>
          <button type="button" @click="cancel(job)">取消</button>
        </div>
        <p v-else class="download-center__vad-note">
          说话检测只有 0.64 MB，会先完成并供排队中的听力模型共同使用。
        </p>
      </article>
    </div>

    <div v-if="queued.length > 0" class="download-center__queue">
      <span>接下来：</span>
      <ol>
        <li v-for="engineId in queued" :key="engineId">{{ labelFor(engineId) }}</li>
      </ol>
    </div>

    <div v-if="voice.state.asrQueueError" class="download-center__error" role="alert">
      <span>{{ voice.state.asrQueueError }}</span>
      <button type="button" @click="retry">重试当前项</button>
    </div>

    <div v-else-if="failed.length > 0 && active.length === 0" class="download-center__failures">
      <div v-for="job in failed" :key="job.id">
        <span>{{ job.label }} 下载失败（{{ job.status.errorCode ?? 'download-failed' }}）</span>
        <button v-if="job.id !== 'vad'" type="button" @click="retrySingle(job.id)">重试</button>
      </div>
    </div>

    <p v-if="!visible" class="download-center__empty" role="status">
      选择预设或在模型卡中点下载后，当前文件、速度和断点状态会显示在这里。
    </p>

    <p class="download-center__note">
      多文件模型可暂停并从 `.part` 断点继续；旧归档模型不显示暂停，只能取消后重试。
      下载完成后仍会逐文件校验，全部通过才进入正式目录。
    </p>
  </section>
</template>

<style scoped>
.download-center {
  display: grid;
  gap: 0.65rem;
  padding: 0.9rem 1rem;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
  background: var(--color-surface-elevated);
}

.download-center__header,
.download-center__job-head,
.download-center__metrics,
.download-center__actions,
.download-center__error,
.download-center__failures div {
  display: flex;
  align-items: center;
}

.download-center__header,
.download-center__job-head,
.download-center__error,
.download-center__failures div {
  justify-content: space-between;
  gap: 0.75rem;
}

.download-center p,
.download-center h3,
.download-center ol {
  margin: 0;
}

.download-center__eyebrow {
  color: var(--color-text-tertiary);
  font-size: 0.64rem;
  font-weight: 650;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}

.download-center h3 {
  margin-top: 0.1rem;
  color: var(--color-text);
  font-size: 0.88rem;
}

.download-center__count,
.download-center__job-copy span,
.download-center__file,
.download-center__metrics,
.download-center__queue,
.download-center__empty,
.download-center__note,
.download-center__vad-note {
  color: var(--color-text-muted);
  font-size: 0.66rem;
  line-height: 1.5;
}

.download-center__jobs,
.download-center__job-copy,
.download-center__failures {
  display: grid;
  gap: 0.35rem;
}

.download-center__job {
  display: grid;
  gap: 0.55rem;
  padding: 0.65rem;
  border-radius: var(--radius);
  background: var(--color-bg-tertiary);
}

.download-center__job-copy strong {
  color: var(--color-text);
  font-size: 0.74rem;
}

.download-center__file {
  overflow: hidden;
  max-width: min(52%, 18rem);
  font-family: ui-monospace, 'Cascadia Mono', monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.download-center__progress {
  height: 0.38rem;
  overflow: hidden;
  border-radius: var(--radius-full);
  background: var(--color-surface);
}

.download-center__progress span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--color-accent);
  transition: width 0.15s linear;
}

.download-center__metrics {
  flex-wrap: wrap;
  gap: 0.25rem 0.75rem;
  font-variant-numeric: tabular-nums;
}

.download-center__metrics strong {
  color: var(--color-text);
}

.download-center__actions {
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.35rem;
}

.download-center button {
  min-height: 2rem;
  padding: 0.35rem 0.6rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 0.68rem;
  font-weight: 620;
}

.download-center button:hover {
  background: var(--color-accent-soft-hover);
  color: var(--color-text);
}

.download-center__primary {
  border-color: transparent !important;
  background: var(--color-accent) !important;
  color: var(--color-text-on-accent) !important;
}

.download-center__queue {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 0.55rem;
}

.download-center__queue ol {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 0.75rem;
  padding-left: 1rem;
}

.download-center__error,
.download-center__failures div {
  color: var(--color-error);
  font-size: 0.7rem;
}

.download-center__note {
  padding-top: 0.5rem;
  border-top: 1px solid var(--color-border-subtle);
}

@media (max-width: 640px) {
  .download-center__header,
  .download-center__job-head {
    align-items: flex-start;
    flex-direction: column;
  }

  .download-center__file {
    max-width: 100%;
  }

  .download-center__actions {
    justify-content: flex-start;
  }
}

@media (prefers-reduced-motion: reduce) {
  .download-center__progress span {
    transition: none;
  }
}
</style>
