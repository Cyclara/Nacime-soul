<script setup lang="ts">
// P3B-14/18：语音设置区——语音朗读（TTS 卡：开关/音色/提前朗读/发送模式/试听）
// + ASR 模型、麦克风、测试录音。只调 voice store + orchestrator，不拼 IPC。
import { onMounted, onBeforeUnmount, ref } from 'vue'
import type { AsrEngineId } from '@shared/voice/asr-settings-types'
import { useVoiceStore } from '../../stores/voice'
import TtsProviderCard from '../voice/TtsProviderCard.vue'
import AssetRootPicker from '../voice/AssetRootPicker.vue'
import AsrDownloadCenter from '../voice/AsrDownloadCenter.vue'
import AsrModelCard from '../voice/AsrModelCard.vue'
import GptRuntimeCard from '../voice/GptRuntimeCard.vue'
import GptVoiceLibrary from '../voice/GptVoiceLibrary.vue'
import MicrophoneSelector from '../voice/MicrophoneSelector.vue'
import VoiceTestPanel from '../voice/VoiceTestPanel.vue'

interface AsrSelection {
  readonly presetId: 'standard' | 'light' | 'custom'
  readonly engineIds: readonly AsrEngineId[]
  readonly primaryEngineId: AsrEngineId | null
  readonly fallbackEngineId: AsrEngineId | null
  readonly totalBytes: number
}

const voice = useVoiceStore()
const selectedDownloadBytes = ref<number | undefined>(undefined)
let unsubscribe: (() => void) | null = null

onMounted(async () => {
  // 先订阅后 hydrate，下载/状态事件不会在首个快照返回前丢失。
  unsubscribe = voice.subscribe()
  await Promise.all([
    voice.hydrate(),
    voice.hydrateTts(),
    voice.hydrateAssetRoot(),
    voice.hydrateGptRuntime()
  ])
  await voice.refreshDevices()
})
onBeforeUnmount(() => {
  unsubscribe?.()
  unsubscribe = null
})

function onAsrSelectionChange(selection: AsrSelection): void {
  selectedDownloadBytes.value = selection.totalBytes
}

function vadStateLabel(state: string): string {
  if (state === 'ready') return '语音检测模型已就绪'
  if (state === 'downloading') return '语音检测模型下载中…'
  if (state === 'error') return '语音检测模型下载失败'
  return '语音检测模型未下载'
}
</script>

<template>
  <section class="voice-settings" aria-labelledby="voice-settings-title">
    <header class="voice-settings__header">
      <div>
        <p class="voice-settings__kicker">听得见，也说得出口</p>
        <h2 id="voice-settings-title">语音设置</h2>
        <p class="voice-settings__intro">
          语音识别与语音检测全部在本地运行，音频不会上传到任何服务器。
        </p>
      </div>
      <span class="voice-settings__spark" aria-hidden="true">♬</span>
    </header>

    <TtsProviderCard />

    <p class="voice-settings__group">她怎么开口</p>
    <GptRuntimeCard />
    <GptVoiceLibrary />

    <p class="voice-settings__group">资源与下载</p>
    <AssetRootPicker :required-bytes="selectedDownloadBytes" />
    <AsrDownloadCenter />

    <p class="voice-settings__group">听你说</p>
    <div class="voice-settings__vad" role="status">
      <span class="voice-settings__vad-label">{{
        vadStateLabel(voice.state.asrOverview?.vadModel.state ?? 'not-downloaded')
      }}</span>
    </div>

    <AsrModelCard mode="settings" @selection-change="onAsrSelectionChange" />
    <MicrophoneSelector />
    <VoiceTestPanel />
  </section>
</template>

<style scoped>
.voice-settings {
  display: grid;
  gap: 0.8rem;
  max-width: 38rem;
  padding: 0.25rem 0;
  color: var(--color-text-primary, white);
}
.voice-settings__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.25rem 0 0.35rem;
}
.voice-settings__kicker {
  margin: 0 0 0.3rem;
  color: var(--color-text-tertiary);
  font-size: 0.72rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.voice-settings__header h2 {
  margin: 0;
  font-size: 1.15rem;
}
.voice-settings__intro {
  max-width: 26rem;
  margin: 0.3rem 0 0;
  color: var(--color-text-secondary);
  font-size: 0.8rem;
}
.voice-settings__spark {
  color: var(--color-accent);
  font-size: 1.3rem;
}
.voice-settings__vad {
  color: var(--color-text-secondary);
  font-size: 0.78rem;
}
.voice-settings__group {
  margin: 0.4rem 0 -0.35rem;
  color: var(--color-text-tertiary);
  font-size: 0.68rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
</style>
