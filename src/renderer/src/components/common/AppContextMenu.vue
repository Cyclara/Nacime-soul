<script setup lang="ts">
// 验收反馈⑤：主题化右键菜单（替代 M-38 main 侧原生菜单——原生菜单纯黑不贴主题）。
//
// 菜单集合（沿用 M-38 验收标准）：
//   - 输入框（textarea/文本类 input）：剪切/复制/粘贴（按选中可用）+ 全选
//   - 只读区域有选中文本：复制 + 全选
//   - 聊天气泡（[data-message-id] 内）：额外出现「删除这轮对话」+「删除这条消息」+「选择」
//     （验收反馈⑥ 按轮删 / ⑥c 单条删 / ⑦ 进入选择模式批量删）；
//     无选中时点气泡也会单独出现这三项。流式进行中不显示（main 侧另有 CHAT_BUSY 兜底）。
//   - 无选中且非输入框、非气泡：不弹空菜单
//
// 行为说明：
//   - 剪贴板走 navigator.clipboard（异步）；粘贴总是可用，空剪贴板时点击无操作
//   - 输入框改值用 setRangeText + 派发 input 事件，v-model/@input 链路（Composer draft）正常感知
//   - 删除是两段式：点第一次该项变「确认删除这轮？」/「确认删除这条？」，3 秒内再点才真删
//     （防手滑；两项独立上膛，点另一项会自动换膛）；
//     确认点击后菜单立即关闭，删除在后台完成（不等 IPC 回包，点击即反馈）
//   - 关闭：点菜单外 / Esc / 滚动 / 窗口失焦 / 尺寸变化

import { onMounted, onBeforeUnmount, ref } from 'vue'
import { useChatStore } from '../../stores/chat'

type DeleteItemId = 'deleteTurn' | 'deleteMessage'

interface MenuItem {
  id: 'cut' | 'copy' | 'paste' | 'selectAll' | 'selectMode' | DeleteItemId
  label: string
  enabled: boolean
}

const chatStore = useChatStore()

const visible = ref(false)
const x = ref(0)
const y = ref(0)
const items = ref<MenuItem[]>([])

/** 本次菜单作用的输入框（只读区域菜单时为 null） */
let editableTarget: HTMLInputElement | HTMLTextAreaElement | null = null
/** 本次菜单作用的气泡 message id（非气泡菜单时为 null） */
let bubbleMessageId: string | null = null

// 验收反馈⑥/⑥c：删除两段式确认（两项独立上膛）
const DELETE_DEFAULT_LABEL: Record<DeleteItemId, string> = {
  deleteTurn: '删除这轮对话',
  deleteMessage: '删除这条消息'
}
const DELETE_CONFIRM_LABEL: Record<DeleteItemId, string> = {
  deleteTurn: '确认删除这轮？',
  deleteMessage: '确认删除这条？'
}
const armedItem = ref<DeleteItemId | null>(null)
const DELETE_ARM_MS = 3000
let armTimer: ReturnType<typeof setTimeout> | null = null

const MENU_WIDTH = 124
const ITEM_HEIGHT = 32
const MENU_PADDING = 10
const VIEWPORT_GAP = 8

function isTextEditable(el: EventTarget | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) return true
  return el instanceof HTMLInputElement && /^(text|search|url|tel|password)$/.test(el.type)
}

function restoreDeleteLabels(): void {
  items.value = items.value.map((it) =>
    it.id === 'deleteTurn' || it.id === 'deleteMessage'
      ? { ...it, label: DELETE_DEFAULT_LABEL[it.id] }
      : it
  )
}

function disarmDelete(): void {
  armedItem.value = null
  if (armTimer !== null) {
    clearTimeout(armTimer)
    armTimer = null
  }
  restoreDeleteLabels()
}

/** 上膛某个删除项（同时只有一项处于确认态；换项即换膛并重新计时） */
function armDelete(id: DeleteItemId): void {
  restoreDeleteLabels()
  armedItem.value = id
  items.value = items.value.map((it) =>
    it.id === id ? { ...it, label: DELETE_CONFIRM_LABEL[id] } : it
  )
  if (armTimer !== null) clearTimeout(armTimer)
  armTimer = setTimeout(disarmDelete, DELETE_ARM_MS)
}

function close(): void {
  visible.value = false
  editableTarget = null
  bubbleMessageId = null
  disarmDelete()
}

function onContextMenu(e: MouseEvent): void {
  const sel = window.getSelection()
  const next: MenuItem[] = []
  editableTarget = null
  bubbleMessageId = null

  const targetEl = e.target instanceof Element ? e.target : null
  const bubbleEl = targetEl?.closest('[data-message-id]') ?? null

  if (isTextEditable(e.target)) {
    const el = e.target
    const hasSelection = (el.selectionStart ?? 0) !== (el.selectionEnd ?? 0)
    next.push(
      { id: 'cut', label: '剪切', enabled: hasSelection },
      { id: 'copy', label: '复制', enabled: hasSelection },
      { id: 'paste', label: '粘贴', enabled: true },
      { id: 'selectAll', label: '全选', enabled: el.value.length > 0 }
    )
    editableTarget = el
  } else {
    if (sel && !sel.isCollapsed && sel.toString().length > 0) {
      next.push(
        { id: 'copy', label: '复制', enabled: true },
        { id: 'selectAll', label: '全选', enabled: true }
      )
    }
    // 气泡上的删除项：流式进行中不显示（删除被 CHAT_BUSY 拒绝，避免无效入口）。
    // 两项并列：整轮删除（⑥，常用）在前，单条删除（⑥c，粒度控制）在后；
    // 第三项「选择」进入选择模式（⑦ 批量按轮删除），并预勾被点气泡所在轮。
    if (bubbleEl && !chatStore.state.activeTurn) {
      bubbleMessageId = bubbleEl.getAttribute('data-message-id')
      if (bubbleMessageId) {
        next.push(
          { id: 'deleteTurn', label: DELETE_DEFAULT_LABEL.deleteTurn, enabled: true },
          { id: 'deleteMessage', label: DELETE_DEFAULT_LABEL.deleteMessage, enabled: true },
          { id: 'selectMode', label: '选择', enabled: true }
        )
      }
    }
  }

  // 无选中且非输入框、非气泡：不弹空菜单（交给浏览器默认——Electron 里即什么都不弹）
  if (next.length === 0) return

  e.preventDefault()
  items.value = next
  // 防溢出：贴边时向左/向上收
  const menuH = next.length * ITEM_HEIGHT + MENU_PADDING
  x.value = Math.max(
    VIEWPORT_GAP,
    Math.min(e.clientX, window.innerWidth - MENU_WIDTH - VIEWPORT_GAP)
  )
  y.value = Math.max(VIEWPORT_GAP, Math.min(e.clientY, window.innerHeight - menuH - VIEWPORT_GAP))
  visible.value = true
}

/** 输入框改值并通知 Vue 链路（v-model/@input 都监听 input 事件） */
function replaceEditableRange(
  el: HTMLInputElement | HTMLTextAreaElement,
  text: string,
  start: number,
  end: number,
  caret: 'start' | 'end' | 'select'
): void {
  el.setRangeText(text, start, end, caret)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

async function run(id: MenuItem['id']): Promise<void> {
  // 验收反馈⑦：进入选择模式（批量按轮删除）——预勾被点气泡所在轮
  if (id === 'selectMode') {
    const targetId = bubbleMessageId
    close()
    if (targetId) chatStore.enterSelection(targetId)
    return
  }

  // 验收反馈⑥/⑥c：删除两段式——第一次点击只"上膛"（菜单不关，3 秒未确认自动复位；
  // 上膛期间点另一项 = 换膛），第二次点击才真删
  if (id === 'deleteTurn' || id === 'deleteMessage') {
    if (armedItem.value !== id) {
      armDelete(id)
      return
    }
    // 删除确认：先关菜单再删——点击即反馈，删除在后台完成（⑥b 提速：此前在
    // finally 里等 IPC 回包才关菜单，同步日志写盘让菜单"挂"几百 ms）。
    const targetId = bubbleMessageId // close() 会清空，先捕获
    close()
    // 走 store action（S-002 铁律3：组件不直接调 window.companion）；
    // main 返回被删行 id，store 同步摘除气泡。失败（如竞态 CHAT_BUSY）静默——气泡保留可重试
    if (targetId) {
      void (id === 'deleteTurn'
        ? chatStore.deleteTurn(targetId)
        : chatStore.deleteMessage(targetId))
    }
    return
  }

  const el = editableTarget
  const sel = window.getSelection()
  try {
    if (el) {
      const start = el.selectionStart ?? 0
      const end = el.selectionEnd ?? 0
      if (id === 'cut' || id === 'copy') {
        await navigator.clipboard.writeText(el.value.slice(start, end))
        if (id === 'cut') replaceEditableRange(el, '', start, end, 'select')
      } else if (id === 'paste') {
        const text = await navigator.clipboard.readText()
        if (text.length > 0) replaceEditableRange(el, text, start, end, 'end')
      } else if (id === 'selectAll') {
        el.focus()
        el.setSelectionRange(0, el.value.length)
      }
    } else if (sel) {
      if (id === 'copy') {
        await navigator.clipboard.writeText(sel.toString())
      } else if (id === 'selectAll') {
        sel.selectAllChildren(document.body)
      }
    }
  } finally {
    close()
  }
}

function onGlobalPointerDown(e: PointerEvent): void {
  if (!visible.value) return
  if (e.target instanceof HTMLElement && e.target.closest('.app-context-menu')) return
  close()
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && visible.value) {
    e.stopPropagation()
    close()
  }
}

onMounted(() => {
  window.addEventListener('contextmenu', onContextMenu)
  window.addEventListener('pointerdown', onGlobalPointerDown, true)
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('blur', close)
  window.addEventListener('resize', close)
  // capture：菜单打开时页面滚动（聊天列表）也关闭
  window.addEventListener('scroll', close, true)
})

onBeforeUnmount(() => {
  if (armTimer !== null) clearTimeout(armTimer)
  window.removeEventListener('contextmenu', onContextMenu)
  window.removeEventListener('pointerdown', onGlobalPointerDown, true)
  window.removeEventListener('keydown', onKeyDown, true)
  window.removeEventListener('blur', close)
  window.removeEventListener('resize', close)
  window.removeEventListener('scroll', close, true)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="app-context-menu"
      :style="{ left: `${x}px`, top: `${y}px` }"
      role="menu"
      @contextmenu.stop.prevent
    >
      <button
        v-for="item in items"
        :key="item.id"
        class="app-context-menu-item"
        :class="{ danger: item.id === 'deleteTurn' || item.id === 'deleteMessage' }"
        :disabled="!item.enabled"
        role="menuitem"
        type="button"
        @click="run(item.id)"
      >
        {{ item.label }}
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
/* 安静贴主题：浮层表面 + 细边 + 中影，hover 只是一层淡淡的主题色 */
.app-context-menu {
  position: fixed;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  min-width: 124px;
  padding: 5px;
  background: var(--color-surface-elevated);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius);
  box-shadow: var(--shadow-md);
  animation: context-menu-in 0.12s ease-out;
}

.app-context-menu-item {
  padding: 6px 12px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text);
  font-size: var(--font-size-sm);
  text-align: left;
  cursor: pointer;
}

.app-context-menu-item:hover:not(:disabled) {
  background: var(--color-accent-soft);
}

.app-context-menu-item:active:not(:disabled) {
  background: var(--color-accent-soft-hover);
}

.app-context-menu-item:disabled {
  color: var(--color-text-muted);
  cursor: default;
}

.app-context-menu-item:focus-visible {
  outline: 1px solid var(--color-border-focus, var(--color-accent));
  outline-offset: -1px;
}

/* 删除项：静默时是错误色文字；上膛（确认删除？）后整行染错误底，明确"再点一次就真删" */
.app-context-menu-item.danger:not(:disabled) {
  color: var(--color-error);
}

.app-context-menu-item.danger:hover:not(:disabled),
.app-context-menu-item.danger:active:not(:disabled) {
  background: var(--color-error-bg);
}

@keyframes context-menu-in {
  from {
    opacity: 0;
    transform: translateY(-2px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
</style>
