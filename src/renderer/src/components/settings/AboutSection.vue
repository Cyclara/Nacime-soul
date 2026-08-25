<script setup lang="ts">
// M-50: 关于与更新分区。版本信息 + 手动检查更新。
// 自动检测由 main Updater 周期调度（打包环境启动 10s 后 + 每 4h），此处提供手动入口；
// 检查结果经 companion:event:update-status 回流，UpdateToast 同步呈现。

import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useAppStore } from '../../stores/app'
import { useUpdateStore } from '../../stores/update'

const appStore = useAppStore()
const updateStore = useUpdateStore()
const { status } = storeToRefs(updateStore)

const checking = ref(false)

const versionText = computed(() => appStore.state.appVersion ?? '未知')

const statusText = computed(() => {
  const s = status.value
  switch (s.state) {
    case 'checking':
      return '正在检查更新…'
    case 'available':
      return `发现新版本 v${s.version}，正在后台下载`
    case 'downloading':
      return `正在下载 v${s.version}… ${s.percent}%`
    case 'downloaded':
      return `v${s.version} 已就绪，重启即完成安装（也可点右下角弹窗的「更新」）`
    case 'not-available':
      return '当前已是最新版本'
    case 'error':
      return s.userInitiated ? s.message : '后台检查未成功，会自动重试'
    default:
      return '自动检查已开启（打包版本启动后 10 秒首次检查，之后每 4 小时一次）'
  }
})

async function checkNow(): Promise<void> {
  if (checking.value) return
  checking.value = true
  try {
    await updateStore.checkNow()
  } finally {
    checking.value = false
  }
}
</script>

<template>
  <section class="about-section" aria-labelledby="about-heading">
    <header class="section-heading">
      <p class="section-kicker">ABOUT · 关于</p>
      <h2 id="about-heading">版本与更新</h2>
      <p>更新在后台自动检测与下载；下载完成后右下角会弹出提示，重启即完成安装。</p>
    </header>

    <div class="version-card">
      <span class="version-seal" aria-hidden="true">N</span>
      <div class="version-copy">
        <strong>Nacime</strong>
        <small>v{{ versionText }}</small>
      </div>
    </div>

    <div class="update-row">
      <button class="check-button" :disabled="checking" @click="checkNow">
        {{ checking ? '正在检查…' : '检查更新' }}
      </button>
      <p class="update-status" role="status">{{ statusText }}</p>
    </div>

    <aside class="update-note">
      <span class="note-mark" aria-hidden="true">i</span>
      <div>
        <strong>开发环境不检查更新</strong>
        <p>只有打包安装后的版本才会连接发布源。若长时间未弹出过更新提示，可点上方按钮手动检查。</p>
      </div>
    </aside>
  </section>
</template>

<style scoped>
.about-section {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.section-heading {
  max-width: 640px;
}

.section-kicker {
  margin-bottom: 9px;
  color: var(--color-accent);
  font-size: 10px;
  font-weight: 750;
  letter-spacing: 0.19em;
}

.section-heading h2 {
  color: var(--color-text);
  font-family: var(--font-family-display);
  font-size: clamp(25px, 3.2vw, 36px);
  font-weight: 560;
  letter-spacing: -0.025em;
  line-height: 1.12;
}

.section-heading > p:last-child {
  max-width: 57ch;
  margin-top: 10px;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.72;
}

.version-card {
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 14px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
  background: var(--color-surface-elevated);
  box-shadow: var(--shadow-sm);
}

.version-seal {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  border-radius: 13px;
  background: var(--color-accent-soft);
  color: var(--color-accent);
  font-family: var(--font-family-display);
  font-size: 20px;
  font-weight: 700;
}

.version-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.version-copy strong {
  color: var(--color-text);
  font-weight: 680;
}

.version-copy small {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
}

.update-row {
  display: flex;
  align-items: center;
  gap: 14px;
}

.check-button {
  padding: 9px 22px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  background: var(--color-surface-elevated);
  color: var(--color-text);
  font-size: var(--font-size-sm);
  font-weight: 650;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.check-button:hover:not(:disabled) {
  border-color: var(--color-accent);
  box-shadow: var(--shadow-sm);
}

.check-button:disabled {
  opacity: 0.6;
}

.update-status {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  line-height: 1.5;
}

.update-note {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 15px;
  border: 1px dashed color-mix(in srgb, var(--color-accent) 30%, var(--color-border));
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--color-accent-soft) 58%, transparent);
}

.note-mark {
  display: grid;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--color-accent) 38%, var(--color-border));
  border-radius: 50%;
  color: var(--color-accent);
  font-size: 14px;
  font-weight: 700;
}

.update-note strong {
  color: var(--color-text);
  font-size: var(--font-size-sm);
}

.update-note p {
  margin-top: 4px;
  color: var(--color-text-muted);
  font-size: 11px;
  line-height: 1.6;
}
</style>
