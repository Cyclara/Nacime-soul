<script setup lang="ts">
// 验收反馈⑦：选择模式工具条——批量按轮删除 + 清空会话。
// 布局（用户拍板 2026-08-21）：左=删除所选（N），中=全选/取消全选，右=删除所有对话 + 取消。
// 两个破坏性操作都是两段式：第一次点"上膛"（按钮变确认文案，3 秒未确认自动复位，
// 上膛期间点另一个 = 换膛），第二次点才真删。删除所选在没有勾选时禁用。
// 退出：取消按钮或 Esc。流式开始会被 store 自动退出选择模式（本组件随之卸载）。

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useChatStore } from '../../stores/chat'

const chatStore = useChatStore()

type DestructiveId = 'deleteSelected' | 'clearAll'

const ARM_MS = 3000
const armed = ref<DestructiveId | null>(null)
let armTimer: ReturnType<typeof setTimeout> | null = null

const deleteSelectedLabel = computed(() =>
  armed.value === 'deleteSelected' ? '你确定删除所选？' : `删除所选（${chatStore.selectedCount}）`
)
const clearAllLabel = computed(() =>
  armed.value === 'clearAll' ? '你确定删除所有对话？' : '删除所有对话'
)
const selectAllLabel = computed(() => (chatStore.allSelected ? '取消全选' : '全选'))

function disarm(): void {
  armed.value = null
  if (armTimer !== null) {
    clearTimeout(armTimer)
    armTimer = null
  }
}

/** 上膛某个破坏性操作（同时只有一项处于确认态；换项即换膛并重新计时） */
function arm(id: DestructiveId): void {
  armed.value = id
  if (armTimer !== null) clearTimeout(armTimer)
  armTimer = setTimeout(disarm, ARM_MS)
}

function onDeleteSelected(): void {
  if (chatStore.selectedCount === 0) return
  if (armed.value !== 'deleteSelected') {
    arm('deleteSelected')
    return
  }
  disarm()
  // 成功后 store 会退出选择模式；失败时 lastError 走错误条，选择模式保留可重试
  void chatStore.deleteSelected()
}

function onClearAll(): void {
  if (armed.value !== 'clearAll') {
    arm('clearAll')
    return
  }
  disarm()
  void chatStore.clearSession()
}

// 上膛期间把勾全取消了 → 复位并回到禁用态，避免"确认删除（0）"
watch(
  () => chatStore.selectedCount,
  (n) => {
    if (n === 0 && armed.value === 'deleteSelected') disarm()
  }
)

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  disarm()
  chatStore.exitSelection()
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  if (armTimer !== null) clearTimeout(armTimer)
})
</script>

<template>
  <div class="selection-toolbar" role="toolbar" aria-label="批量管理对话">
    <div class="tb-zone left">
      <button
        class="tb-btn danger"
        :class="{ armed: armed === 'deleteSelected' }"
        :disabled="chatStore.selectedCount === 0"
        type="button"
        @click="onDeleteSelected"
      >
        {{ deleteSelectedLabel }}
      </button>
    </div>
    <div class="tb-zone center">
      <button class="tb-btn" type="button" @click="chatStore.toggleSelectAll()">
        {{ selectAllLabel }}
      </button>
    </div>
    <div class="tb-zone right">
      <button
        class="tb-btn danger"
        :class="{ armed: armed === 'clearAll' }"
        type="button"
        @click="onClearAll"
      >
        {{ clearAllLabel }}
      </button>
      <button
        class="tb-btn ghost"
        type="button"
        title="退出选择（Esc）"
        @click="chatStore.exitSelection()"
      >
        取消
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 安静贴主题的长条：浮层表面 + 细边 + 小影，三段式布局（左/中/右） */
.selection-toolbar {
  display: flex;
  width: min(100%, 1040px);
  align-items: center;
  gap: 10px;
  margin: 0 auto 6px;
  padding: 6px 10px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius);
  background: var(--color-surface-elevated);
  box-shadow: var(--shadow-sm);
}

.tb-zone {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 8px;
}

.tb-zone.center {
  justify-content: center;
}

.tb-zone.right {
  justify-content: flex-end;
}

.tb-btn {
  min-height: 30px;
  padding: 5px 14px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-sm);
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.tb-btn:hover:not(:disabled) {
  background: var(--color-accent-soft);
  color: var(--color-text);
}

.tb-btn:disabled {
  cursor: default;
  opacity: 0.45;
}

.tb-btn:focus-visible {
  outline: 1px solid var(--color-border-focus, var(--color-accent));
  outline-offset: 1px;
}

/* 破坏性操作：静默时错误色文字；上膛后实心错误底——"再点一次就真删" */
.tb-btn.danger:not(:disabled) {
  color: var(--color-error);
}

.tb-btn.danger:hover:not(:disabled) {
  background: var(--color-error-bg);
  color: var(--color-error);
}

.tb-btn.danger.armed {
  border-color: transparent;
  background: var(--color-error);
  color: var(--color-text-on-accent);
}

.tb-btn.ghost {
  border-color: transparent;
  background: transparent;
  color: var(--color-text-muted);
}

.tb-btn.ghost:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
}

@media (max-width: 620px) {
  .selection-toolbar {
    flex-wrap: wrap;
  }

  .tb-zone {
    flex-basis: 100%;
    justify-content: center;
  }
}
</style>
