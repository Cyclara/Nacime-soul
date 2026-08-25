<script setup lang="ts">
// M-50: 更新提示 toast（右下角卡片）。参考 stablyai/orca UpdateCard 的状态分呈现裁剪：
//   - downloaded：完整卡片（版本就绪 + 不中断对话安抚 + 立即更新按钮 + 按版本可关闭）
//   - available/downloading：细条进度（后台自动下载，不需要用户动作）
//   - checking/not-available/error：仅在用户手动触发检查时短暂反馈
// store 的 init/dispose 由本组件持有（常驻 App 根），不进入 bootstrap 编排。

import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useUpdateStore } from '../../stores/update'

const updateStore = useUpdateStore()
const { status, toastVisible } = storeToRefs(updateStore)

const installing = ref(false)
/** not-available 3s 自动隐去标志（本地 UI 态，不进 store） */
const autoHide = ref(false)
/** not-available 的自动隐去定时器 */
let autoHideTimer: ReturnType<typeof setTimeout> | undefined

watch(status, (s) => {
  clearTimeout(autoHideTimer)
  if (s.state === 'not-available' && s.userInitiated) {
    autoHideTimer = setTimeout(() => {
      // 自动隐去等价于回到 idle 观感：直接清掉手动标记的呈现即可
      autoHide.value = true
    }, 3000)
  } else {
    autoHide.value = false
  }
})

function onDismiss(): void {
  if (status.value.state === 'downloaded') {
    updateStore.dismiss(status.value.version)
  } else if (status.value.state === 'error') {
    // error 不关版本，直接本地隐去（下一次检查会带新状态回来）
    autoHide.value = true
  }
}

async function onInstall(): Promise<void> {
  if (installing.value) return
  installing.value = true
  try {
    await updateStore.install()
    // 若 quitAndInstall 成功，应用随即退出；走回这里说明被 no-op（状态漂移），解除按钮
  } finally {
    installing.value = false
  }
}

onMounted(() => {
  void updateStore.init()
})

onBeforeUnmount(() => {
  clearTimeout(autoHideTimer)
  updateStore.dispose()
})
</script>

<template>
  <!-- #app 使用 isolation:isolate，而设置抽屉 Teleport 到 body；toast 也必须 Teleport，
       否则即使 z-index 更高，手动检查结果仍会被抽屉遮住。 -->
  <Teleport to="body">
    <Transition name="update-rise">
      <aside
        v-if="toastVisible && !autoHide"
        class="update-toast"
        :class="`is-${status.state}`"
        role="status"
        aria-live="polite"
      >
        <!-- downloaded：完整卡片 -->
        <template v-if="status.state === 'downloaded'">
          <header class="toast-head">
            <strong>可用更新</strong>
            <button class="toast-close" aria-label="暂不更新" title="暂不更新" @click="onDismiss">
              ×
            </button>
          </header>
          <p class="toast-body">Nacime v{{ status.version }} 已准备就绪。</p>
          <p class="toast-sub">重启后完成安装，当前对话不会中断。</p>
          <button class="toast-action" :disabled="installing" @click="onInstall">
            {{ installing ? '正在重启…' : '更新' }}
          </button>
        </template>

        <!-- available / downloading：细条进度 -->
        <template v-else-if="status.state === 'available'">
          <p class="toast-slim">发现新版本 v{{ status.version }}，正在后台下载…</p>
        </template>
        <template v-else-if="status.state === 'downloading'">
          <p class="toast-slim">正在下载更新 v{{ status.version }}… {{ status.percent }}%</p>
          <div class="toast-progress" aria-hidden="true">
            <i :style="{ width: `${status.percent}%` }"></i>
          </div>
        </template>

        <!-- 手动检查的即时反馈 -->
        <template v-else-if="status.state === 'checking'">
          <p class="toast-slim">正在检查更新…</p>
        </template>
        <template v-else-if="status.state === 'not-available'">
          <p class="toast-slim">当前已是最新版本。</p>
        </template>
        <template v-else-if="status.state === 'error'">
          <header class="toast-head">
            <strong>更新检查未完成</strong>
            <button class="toast-close" aria-label="关闭提示" title="关闭提示" @click="onDismiss">
              ×
            </button>
          </header>
          <p class="toast-body">{{ status.message }}</p>
        </template>
      </aside>
    </Transition>
  </Teleport>
</template>

<style scoped>
.update-toast {
  position: fixed;
  z-index: 1250;
  right: 20px;
  bottom: 20px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 300px;
  padding: 14px 16px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--color-surface-elevated) 96%, transparent);
  box-shadow: var(--shadow-lg);
  backdrop-filter: blur(10px);
}

.toast-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.toast-head strong {
  color: var(--color-text);
  font-size: var(--font-size-sm);
  font-weight: 700;
}

.toast-close {
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  border-radius: 50%;
  color: var(--color-text-muted);
  font-size: 14px;
}

.toast-close:hover {
  background: var(--color-accent-soft);
  color: var(--color-text);
}

.toast-body {
  color: var(--color-text);
  font-size: var(--font-size-sm);
  line-height: 1.55;
}

.toast-sub {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  line-height: 1.5;
}

.toast-action {
  margin-top: 4px;
  padding: 9px 0;
  border-radius: var(--radius);
  background: var(--color-accent);
  color: var(--color-text-on-accent);
  font-size: var(--font-size-sm);
  font-weight: 700;
  transition: filter 0.15s ease;
}

.toast-action:hover:not(:disabled) {
  filter: brightness(1.06);
}

.toast-action:disabled {
  opacity: 0.6;
}

.toast-slim {
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  line-height: 1.5;
}

.toast-progress {
  height: 4px;
  overflow: hidden;
  border-radius: var(--radius-full);
  background: var(--color-bg-tertiary);
}

.toast-progress i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--color-accent);
  transition: width 0.25s ease;
}

.update-rise-enter-active,
.update-rise-leave-active {
  transition:
    opacity 0.22s ease,
    transform 0.22s ease;
}

.update-rise-enter-from,
.update-rise-leave-to {
  opacity: 0;
  transform: translateY(10px);
}
</style>
