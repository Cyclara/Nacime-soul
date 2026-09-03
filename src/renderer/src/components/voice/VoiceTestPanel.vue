<script setup lang="ts">
// P3B-14（功能版）：测试录音面板——录音 → VAD → ASR → 转写展示。
// 编排在 orchestrator/voice-test-recording.ts；本组件只调 voice store。
// 视觉朴素待前端模型美化。
import { onBeforeUnmount } from 'vue'
import { useVoiceStore } from '../../stores/voice'
import { createVoiceTestRecordingOrchestrator } from '../../orchestrators/voice-test-recording'

const voice = useVoiceStore()
const orchestrator = createVoiceTestRecordingOrchestrator(voice)

async function toggleRecording(): Promise<void> {
  if (orchestrator.recording) {
    await orchestrator.stopRecording()
  } else {
    await orchestrator.startRecording(voice.state.inputDeviceId ?? undefined)
  }
}

onBeforeUnmount(() => {
  orchestrator.dispose()
})
</script>

<template>
  <div class="voice-test">
    <div class="voice-test__title">测试录音</div>
    <p class="voice-test__intro">
      点击开始后用说话，说完停顿约 1.5 秒自动转写。语音全部在本机处理，不上传。
    </p>

    <div class="voice-test__row">
      <button
        type="button"
        class="voice-test__btn"
        :class="{ 'voice-test__btn--stop': orchestrator.recording }"
        :disabled="!voice.canListen && !orchestrator.recording"
        @click="toggleRecording"
      >
        {{ orchestrator.recording ? '停止录音' : '开始录音' }}
      </button>
      <span
        v-if="orchestrator.recording"
        class="voice-test__indicator"
        :class="{ 'voice-test__indicator--speaking': voice.state.vadActive }"
      >
        {{ voice.state.vadActive ? '正在说话…' : '监听中…' }}
      </span>
    </div>

    <div
      v-if="voice.state.partialTranscript"
      class="voice-test__transcript voice-test__transcript--partial"
    >
      <div class="voice-test__transcript-label">正在识别（尚未发送）</div>
      {{ voice.state.partialTranscript }}
    </div>

    <div v-if="voice.state.lastTranscript" class="voice-test__transcript">
      <div class="voice-test__transcript-label">转写结果</div>
      {{ voice.state.lastTranscript }}
    </div>

    <p v-if="voice.state.testError" class="voice-test__error">
      {{ voice.state.testError.message }}
    </p>
  </div>
</template>

<style scoped>
.voice-test {
  display: grid;
  gap: 0.55rem;
  padding: 0.85rem;
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.12));
  border-radius: 10px;
  background: var(--color-surface, rgba(255, 255, 255, 0.05));
}
.voice-test__title {
  font-weight: 600;
}
.voice-test__intro {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: 0.78rem;
}
.voice-test__row {
  display: flex;
  align-items: center;
  gap: 0.8rem;
}
.voice-test__btn {
  font-size: 0.82rem;
  padding: 0.4rem 1rem;
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.2));
  border-radius: 8px;
  background: var(--color-accent, #7c6cf0);
  color: #fff;
  cursor: pointer;
}
.voice-test__btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.voice-test__btn--stop {
  background: var(--color-danger, #ff7a7a);
}
.voice-test__indicator {
  color: var(--color-text-secondary);
  font-size: 0.78rem;
}
.voice-test__indicator--speaking {
  opacity: 1;
  color: #4cd964;
}
.voice-test__transcript {
  padding: 0.55rem 0.7rem;
  border-radius: 8px;
  background: var(--color-bg-tertiary);
  color: var(--color-text);
  font-size: 0.85rem;
}
.voice-test__transcript--partial {
  color: var(--color-text-secondary);
  font-style: italic;
  opacity: 0.82;
}
.voice-test__transcript-label {
  margin-bottom: 0.2rem;
  color: var(--color-text-tertiary);
  font-size: 0.72rem;
}
.voice-test__error {
  font-size: 0.78rem;
  color: var(--color-danger, #ff7a7a);
  margin: 0;
}
</style>
