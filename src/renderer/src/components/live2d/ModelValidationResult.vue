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
  border: 1px solid var(--color-success-border);
  border-radius: 0.7rem;
  background: var(--color-success-bg);
  color: var(--color-success);
  font-size: 0.76rem;
  line-height: 1.45;
}
.validation--error {
  border-color: var(--color-error-border);
  background: var(--color-error-bg);
  color: var(--color-error);
}
.validation strong {
  font-size: 0.78rem;
}
.validation p {
  margin: 0.25rem 0 0;
  color: inherit;
}
</style>
