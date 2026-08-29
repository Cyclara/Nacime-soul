<script setup lang="ts">
import type { Live2dLoadError } from '@shared/live2d/types'

defineProps<{ error: Live2dLoadError | null; warnings?: readonly string[] }>()
</script>

<template>
  <div
    v-if="error || warnings?.length"
    class="validation"
    :class="{ 'validation--error': error }"
    role="status"
    aria-live="polite"
  >
    <strong>{{ error ? `模型需要处理（${error.code}）` : '模型已通过基础检查' }}</strong>
    <p v-if="error">
      {{
        error.suggestedAction === 'retry'
          ? '可以重试一次。'
          : error.suggestedAction === 'use-default'
            ? '将使用内置模型。'
            : error.suggestedAction === 'update-driver'
              ? '请检查显卡驱动或换一个模型。'
              : '请换一个模型包再试。'
      }}
    </p>
    <p v-if="warnings?.length">{{ warnings.join('、') }}</p>
  </div>
</template>

<style scoped>
.validation {
  margin-top: 0.8rem;
  padding: 0.7rem 0.8rem;
  border: 1px solid rgb(133 226 174 / 32%);
  border-radius: 0.7rem;
  background: rgb(133 226 174 / 8%);
  color: rgb(211 255 227 / 90%);
  font-size: 0.76rem;
  line-height: 1.45;
}
.validation--error {
  border-color: rgb(255 139 139 / 42%);
  background: rgb(255 139 139 / 8%);
  color: rgb(255 220 220 / 92%);
}
.validation strong {
  font-size: 0.78rem;
}
.validation p {
  margin: 0.25rem 0 0;
  color: inherit;
  opacity: 0.78;
}
</style>
