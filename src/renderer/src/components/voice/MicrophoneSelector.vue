<script setup lang="ts">
// P3B-14（功能版）：麦克风选择/权限/输入电平。只读 voice store 状态；
// 设备刷新与电平由测试录音编排驱动。视觉朴素待前端模型美化。
import { computed } from 'vue'
import { useVoiceStore } from '../../stores/voice'

const voice = useVoiceStore()

const permissionLabel = computed(() => {
  switch (voice.state.micPermission) {
    case 'granted':
      return '已授权'
    case 'denied':
      return '已拒绝（请在系统设置允许后重试）'
    case 'device-lost':
      return '设备不可用'
    default:
      return '未检测（点击下方「测试录音」会请求权限）'
  }
})

const levelPercent = computed(() => Math.round(voice.state.micLevel * 100))
</script>

<template>
  <div class="mic-selector">
    <div class="mic-selector__title">麦克风</div>
    <div class="mic-selector__row">
      <label class="mic-selector__label" for="mic-device">输入设备</label>
      <select
        id="mic-device"
        class="mic-selector__select"
        :value="voice.state.inputDeviceId ?? ''"
        @change="voice.setInputDevice(($event.target as HTMLSelectElement).value || null)"
      >
        <option value="">默认设备</option>
        <option v-for="device in voice.state.micDevices" :key="device.id" :value="device.id">
          {{ device.label }}
        </option>
      </select>
    </div>
    <div class="mic-selector__row">
      <span class="mic-selector__label">权限状态</span>
      <span class="mic-selector__permission">{{ permissionLabel }}</span>
    </div>
    <div class="mic-selector__row">
      <span class="mic-selector__label">输入电平</span>
      <div class="mic-selector__meter" aria-hidden="true">
        <div class="mic-selector__meter-fill" :style="{ width: `${levelPercent}%` }" />
      </div>
      <span class="mic-selector__level">{{ levelPercent }}%</span>
    </div>
  </div>
</template>

<style scoped>
.mic-selector {
  display: grid;
  gap: 0.55rem;
  padding: 0.85rem;
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.12));
  border-radius: 10px;
  background: var(--color-surface, rgba(255, 255, 255, 0.05));
}
.mic-selector__title {
  font-weight: 600;
}
.mic-selector__row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.mic-selector__label {
  font-size: 0.78rem;
  opacity: 0.7;
  min-width: 3.5rem;
}
.mic-selector__select {
  flex: 1;
  font-size: 0.8rem;
  padding: 0.3rem 0.5rem;
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.2));
  border-radius: 8px;
  background: var(--color-surface, rgba(255, 255, 255, 0.06));
  color: inherit;
}
.mic-selector__permission {
  font-size: 0.78rem;
}
.mic-selector__meter {
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.1);
  overflow: hidden;
}
.mic-selector__meter-fill {
  height: 100%;
  background: linear-gradient(90deg, #4cd964, #7c6cf0);
  transition: width 0.08s linear;
}
.mic-selector__level {
  font-size: 0.72rem;
  opacity: 0.7;
  min-width: 2.6rem;
  text-align: right;
}
</style>
